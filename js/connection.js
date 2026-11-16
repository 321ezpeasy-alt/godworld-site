'use strict';
/*
 * connection.js — the live CONNECTION client for the godworld.org front door.
 *
 * Henry's framing governs: this is a CONNECTION, not a call. Touching the
 * site opens it; the agent (theTruth AI) is in it in the background; Henry
 * is not in it.
 *
 * Transports, in order (mode 'live-first', Henry's dictated setup):
 *   1. live     — Gemini Live API over WebSocket, authorized by a
 *                 short-lived ephemeral token minted by OUR backend
 *                 (backend/live-token.js). Mic audio streams up as PCM
 *                 chunks; model audio streams down into a jitter-buffered
 *                 playback queue; an AnalyserNode on that queue drives
 *                 the avatar's mouth from real audio levels.
 *   2. verified — the ARCHITECTURE.md pipeline: page -> Worker /api/chat
 *                 (NDJSON sentence stream) -> BrainHub -> brain node
 *                 (reservoir -> draft -> Claudia verify -> speak, with
 *                 the scripted floor inside the pipeline). Replies are
 *                 spoken by the page via speechSynthesis.
 *   3. scripted — a small local floor of grounded answers, spoken via
 *                 speechSynthesis, when both network paths are down.
 *                 The avatar never goes silent.
 *
 * The module is environment-injectable (WebSocket, fetch, AudioContext,
 * getUserMedia are passed in) so the exact shipping code is testable
 * outside a browser. No keys appear here — the page only ever holds a
 * single-use ephemeral token, fetched at connect time.
 */

const LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-latest';
const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const DEFAULT_WORKER_URL = 'https://godworld-storefront.321ezpeasy.workers.dev';
const MIC_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const JITTER_BUFFER_MS = 120; // hardening #2: absorb network stalls
const OUTPUT_CEILING = 0.9; // hardening #8: playback level ceiling

const INTRO_LINE =
  "Hi, I'm theTruth AI, the digital twin of Henry theTruth Kennemore, founder of godworld.org.";

const LIVE_SYSTEM_INSTRUCTION = [
  'You are theTruth AI, the digital twin of Henry theTruth Kennemore, founder of godworld.org.',
  'You host the Super Intelligent Designs website builder. You speak warmly, plainly, and briefly — one or two short sentences at a time, like a person talking, never a list.',
  'Facts you may state: a business\'s first website is free; turning on the interactive version is a one-time $100 activation — no subscription and no monthly fee; hosting and maintenance are free while the site stays unchanged; the interactive version launches in January 2027 and pre-launch reservations are refundable until a site is delivered live; the Archangel 8 TriPhone costs $750.',
  'Never invent prices, features, dates, or policies beyond those facts. If you do not know something, say you would rather connect them with Henry than give them the wrong answer.',
  'The owner always stays in charge: you gather details and never finalize a commitment on anyone\'s behalf.',
].join(' ');

/* ---------------- base64 / PCM helpers ---------------- */

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Float32 samples [-1,1] -> base64 PCM16 little-endian (mic uplink). */
function floatToPcm16Base64(float32) {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

/** base64 PCM16 little-endian -> Float32 samples (playback downlink). */
function pcm16Base64ToFloat32(b64) {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

function rmsLevel(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

/** Map an audio level to a mouth-open amount, eased (hardening #6). */
function mouthOpenFromLevel(level, prev) {
  const target = Math.max(0, Math.min(1, level * 2.6));
  return prev + (target - prev) * 0.55;
}

/* ---------------- playback queue (hardening #2 + #6 + #8) ---------------- */

class PlaybackQueue {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain = audioContext.createGain();
    this.gain.gain.value = OUTPUT_CEILING;
    this.compressor = audioContext.createDynamicsCompressor();
    // chain: sources -> analyser -> gain -> compressor -> destination
    this.analyser.connect(this.gain);
    this.gain.connect(this.compressor);
    this.compressor.connect(audioContext.destination);
    this.nextStartTime = 0;
    this.scheduledSamples = 0;
    this.underruns = 0;
    this._levelBuf = new Uint8Array(this.analyser.fftSize);
  }

  pushPcmBase64(b64, sampleRate = PLAYBACK_SAMPLE_RATE) {
    const samples = pcm16Base64ToFloat32(b64);
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const now = this.ctx.currentTime;
    if (this.nextStartTime <= now) {
      // underrun (or first chunk): re-fill the jitter buffer before playing
      if (this.scheduledSamples > 0) this.underruns++;
      this.nextStartTime = now + JITTER_BUFFER_MS / 1000;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
    this.scheduledSamples += samples.length;
  }

  /** True while scheduled audio is still sounding. */
  isPlaying() {
    return this.nextStartTime > this.ctx.currentTime + 0.02;
  }

  /** Current output level 0..1 from the analyser (drives the mouth). */
  getLevel() {
    if (!this.isPlaying()) return 0;
    this.analyser.getByteTimeDomainData(this._levelBuf);
    let sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) {
      const v = (this._levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._levelBuf.length);
  }

  flush() {
    this.nextStartTime = 0;
  }
}

/* ---------------- Live transport (Gemini Live via ephemeral token) ---------------- */

class LiveTransport {
  constructor(env, callbacks) {
    this.env = env;
    this.cb = callbacks;
    this.ws = null;
    this.playback = null;
    this.micStream = null;
    this.micContext = null;
    this.intentionalClose = false;
    this.setupComplete = false;
  }

  async fetchToken(tokenEndpoint) {
    const res = await this.env.fetch(tokenEndpoint, { method: 'POST' });
    if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
    const payload = await res.json();
    if (!payload || typeof payload.token !== 'string') throw new Error('token endpoint returned no token');
    return payload.token;
  }

  async connect(tokenEndpoint) {
    const token = await this.fetchToken(tokenEndpoint);
    const url = `${LIVE_WS_URL}?access_token=${encodeURIComponent(token)}`;
    const ws = this.env.createWebSocket(url);
    this.ws = ws;
    this.playback = new PlaybackQueue(this.env.createAudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE }));

    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('live setup timeout')), 15000);
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: LIVE_MODEL,
              generationConfig: { responseModalities: ['AUDIO'] },
              systemInstruction: { parts: [{ text: LIVE_SYSTEM_INSTRUCTION }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          })
        );
      });
      ws.addEventListener('message', async (ev) => {
        const msg = await this._parseMessage(ev);
        if (!msg) return;
        if (msg.setupComplete !== undefined && !this.setupComplete) {
          this.setupComplete = true;
          clearTimeout(timer);
          resolve();
        }
        this._handleMessage(msg);
      });
      ws.addEventListener('error', () => {
        if (!this.setupComplete) {
          clearTimeout(timer);
          reject(new Error('live socket error'));
        }
      });
      ws.addEventListener('close', () => {
        if (!this.intentionalClose) this.cb.onDrop && this.cb.onDrop('live-socket-closed');
      });
    });

    await opened;
    const micOk = await this._startMic();
    return { transport: 'live', micOk };
  }

  async _parseMessage(ev) {
    let text = ev.data;
    if (typeof text !== 'string') {
      if (text && typeof text.text === 'function') text = await text.text();
      else if (text instanceof ArrayBuffer) text = new TextDecoder().decode(text);
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(text)) text = text.toString('utf8');
      else return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  _handleMessage(msg) {
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      this.playback.flush();
      this.cb.onInterrupted && this.cb.onInterrupted();
    }
    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        this.playback.pushPcmBase64(part.inlineData.data, PLAYBACK_SAMPLE_RATE);
        this.cb.onAudioChunk && this.cb.onAudioChunk(part.inlineData.data);
      }
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      this.cb.onText && this.cb.onText(sc.outputTranscription.text, 'avatar');
    }
    if (sc.inputTranscription && sc.inputTranscription.text) {
      this.cb.onText && this.cb.onText(sc.inputTranscription.text, 'visitor');
    }
    if (sc.turnComplete) this.cb.onTurnComplete && this.cb.onTurnComplete();
  }

  async _startMic() {
    if (!this.env.getUserMedia) {
      this.cb.onMicUnavailable && this.cb.onMicUnavailable('getUserMedia unsupported');
      return false;
    }
    try {
      // hardening #5: echo cancellation, noise suppression, auto-gain ON
      this.micStream = await this.env.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.cb.onMicUnavailable && this.cb.onMicUnavailable(String((e && e.name) || e));
      return false;
    }
    const ctx = this.env.createAudioContext({ sampleRate: MIC_SAMPLE_RATE });
    this.micContext = ctx;
    const source = ctx.createMediaStreamSource(this.micStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const levelBuf = new Uint8Array(analyser.fftSize);
    this._micLevel = () => {
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) {
        const v = (levelBuf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / levelBuf.length);
    };
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination);
    processor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const samples = e.inputBuffer.getChannelData(0);
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}`, data: floatToPcm16Base64(samples) }],
          },
        })
      );
    };
    this._micProcessor = processor;
    return true;
  }

  getPlaybackLevel() {
    return this.playback ? this.playback.getLevel() : 0;
  }

  getMicLevel() {
    return this._micLevel ? this._micLevel() : 0;
  }

  isSpeaking() {
    return this.playback ? this.playback.isPlaying() : false;
  }

  /** Ask the model to say a line (used for the standing introduction). */
  sayLine(line) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: `Greet me by saying exactly this, word for word, and nothing before it: "${line}" Then ask what you can help with today.` }],
            },
          ],
          turnComplete: true,
        },
      })
    );
  }

  sendText(text) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } })
    );
  }

  close() {
    this.intentionalClose = true;
    try {
      if (this._micProcessor) this._micProcessor.disconnect();
    } catch {}
    try {
      if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      if (this.micContext) this.micContext.close();
    } catch {}
    try {
      if (this.ws) this.ws.close();
    } catch {}
  }
}

/* ---------------- Verified transport (ARCHITECTURE.md pipeline) ---------------- */

class VerifiedTransport {
  constructor(env, { workerUrl, sessionId, onSentence, onDone, onError }) {
    this.env = env;
    this.workerUrl = workerUrl;
    this.sessionId = sessionId;
    this.onSentence = onSentence;
    this.onDone = onDone;
    this.onError = onError;
  }

  /** Reachability probe so a dead pipeline fails at connect, not mid-chat. */
  async connect() {
    const res = await this.env.fetch(`${this.workerUrl}/api/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`worker health HTTP ${res.status}`);
    return { transport: 'verified' };
  }

  async send(message) {
    let res;
    try {
      res = await this.env.fetch(`${this.workerUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId: this.sessionId }),
      });
    } catch (e) {
      this.onError && this.onError(e);
      throw e;
    }
    if (!res.ok || !res.body) {
      const err = new Error(`chat HTTP ${res.status}`);
      this.onError && this.onError(err);
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === 'sentence' && obj.text) this.onSentence && this.onSentence(obj.text);
        if (obj.type === 'done') this.onDone && this.onDone();
      }
    }
    // A final line without a trailing newline still counts.
    const tail = buf.trim();
    if (tail) {
      try {
        const obj = JSON.parse(tail);
        if (obj.type === 'sentence' && obj.text) this.onSentence && this.onSentence(obj.text);
        if (obj.type === 'done') this.onDone && this.onDone();
      } catch {}
    }
  }
}

/* ---------------- Scripted floor (local, grounded) ---------------- */

const FLOOR_ANSWERS = [
  {
    patterns: [/price|cost|much|activation|activate/i],
    answer:
      "Your first website is free. When you are ready to turn on the interactive version, activation is a one-time $100 — no subscription, no monthly fee, and hosting and maintenance are free while your site stays unchanged.",
  },
  {
    patterns: [/triphone|archangel|phone/i],
    answer:
      'The Archangel 8 TriPhone is $750, from the Archangel 8 TriPhone DevLab Studio here at godworld.org.',
  },
  {
    patterns: [/when|launch|available|start/i],
    answer:
      'The interactive version launches in January 2027. Pre-launch reservations are refundable until your site is delivered live and your own agent is connected.',
  },
  {
    patterns: [/website|site|business|build/i],
    answer:
      'Super Intelligent Designs builds a free website for your business first. You look it over, and only if you want the interactive version do you activate it for a one-time $100.',
  },
];

const FLOOR_DEFAULT =
  "I'd rather connect you with Henry than give you the wrong answer. Ask me about a free website for your business, or about the Archangel 8 TriPhone.";

function scriptedAnswer(text) {
  for (const entry of FLOOR_ANSWERS) {
    if (entry.patterns.some((p) => p.test(text))) return entry.answer;
  }
  return FLOOR_DEFAULT;
}

/* ---------------- Orchestrator ---------------- */

class AvatarConnection {
  constructor(env, options = {}) {
    this.env = env;
    this.tokenEndpoint = options.tokenEndpoint || '/api/live-token';
    this.workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
    this.mode = options.mode || 'live-first';
    this.cb = options.callbacks || {};
    this.state = 'idle'; // idle | connecting | connected | dropped | blocked
    this.transport = null; // live | verified | scripted
    this.sessionId =
      options.sessionId ||
      'gw-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.record = [];
    this.live = null;
    this.verified = null;
    this._liveDroppedOnce = false;
    this._note('created', { mode: this.mode });
  }

  _note(event, detail = {}) {
    const entry = { t: new Date().toISOString(), event, ...detail };
    this.record.push(entry);
    this.cb.onRecord && this.cb.onRecord(entry);
    if (this.env.postSessionRecord) {
      Promise.resolve(this.env.postSessionRecord({ sessionId: this.sessionId, ...entry })).catch(() => {});
    }
  }

  _setState(state, transport) {
    this.state = state;
    if (transport !== undefined) this.transport = transport;
    this.cb.onState && this.cb.onState(this.state, this.transport);
  }

  async connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    if (this.live) {
      // stale transport from a dropped/blocked attempt: close before reopening
      try {
        this.live.close();
      } catch {}
      this.live = null;
    }
    this._setState('connecting');
    const order =
      this.mode === 'verified-first' || this._liveDroppedOnce ? ['verified', 'live'] : ['live', 'verified'];
    for (const which of order) {
      try {
        if (which === 'live') {
          const outcome = await this._connectLive();
          if (outcome === 'blocked') return; // mic blocked: status text guides the fix; a re-tap retries
        } else await this._connectVerified();
        this._note('connected', { transport: this.transport });
        return;
      } catch (e) {
        this._note('transport-failed', { transport: which, error: String((e && e.message) || e) });
      }
    }
    // Both network paths failed: the scripted floor still answers.
    this._setState('connected', 'scripted');
    this._note('connected', { transport: 'scripted' });
    this.cb.onSpeakText && this.cb.onSpeakText(INTRO_LINE);
  }

  async _connectLive() {
    const live = new LiveTransport(this.env, {
      onText: (text, who) => this.cb.onText && this.cb.onText(text, who),
      onTurnComplete: () => this.cb.onTurnComplete && this.cb.onTurnComplete(),
      onAudioChunk: () => {},
      onInterrupted: () => this._note('interrupted'),
      onMicUnavailable: (why) => {
        this._note('mic-unavailable', { why });
      },
      onDrop: (why) => this._handleDrop('live', why),
    });
    const { micOk } = await live.connect(this.tokenEndpoint);
    this.live = live;
    if (!micOk) {
      // The session is open but the visitor cannot be heard: say so
      // honestly instead of pretending a conversation is running.
      this._setState('blocked', 'live');
      this._note('blocked', { transport: 'live', why: 'mic-unavailable' });
      return 'blocked';
    }
    this._setState('connected', 'live');
    live.sayLine(INTRO_LINE);
    return 'connected';
  }

  async _connectVerified() {
    this.verified = new VerifiedTransport(this.env, {
      workerUrl: this.workerUrl,
      sessionId: this.sessionId,
      onSentence: (text) => this.cb.onSpeakText && this.cb.onSpeakText(text),
      onDone: () => this.cb.onTurnComplete && this.cb.onTurnComplete(),
      onError: (e) => this._note('verified-error', { error: String((e && e.message) || e) }),
    });
    await this.verified.connect();
    this._setState('connected', 'verified');
    this.cb.onSpeakText && this.cb.onSpeakText(INTRO_LINE);
    // The verified pipeline takes its first real message via hear().
  }

  /** A visitor utterance (speech-recognition text, or a test turn). */
  async hear(text) {
    if (!text || !text.trim()) return;
    this._note('visitor-turn', { chars: text.length });
    if (this.transport === 'live' && this.live) {
      this.live.sendText(text);
    } else if (this.transport === 'verified' && this.verified) {
      try {
        await this.verified.send(text);
      } catch {
        // Pipeline dropped mid-conversation: fall to the scripted floor.
        this._setState('connected', 'scripted');
        this._note('fell-to-scripted');
        this.cb.onSpeakText && this.cb.onSpeakText(scriptedAnswer(text));
      }
    } else {
      this.cb.onSpeakText && this.cb.onSpeakText(scriptedAnswer(text));
    }
  }

  _handleDrop(which, why) {
    if (this.state !== 'connected') return;
    // hardening #7: note the drop in the session record, re-offer the trigger.
    this._note('drop', { transport: which, why });
    if (which === 'live') this._liveDroppedOnce = true;
    this._setState('dropped');
    this.cb.onDropped && this.cb.onDropped(which, why);
  }

  getPlaybackLevel() {
    return this.live ? this.live.getPlaybackLevel() : 0;
  }

  getMicLevel() {
    return this.live ? this.live.getMicLevel() : 0;
  }

  isSpeaking() {
    return this.live ? this.live.isSpeaking() : false;
  }

  end() {
    this._note('ended', { transport: this.transport });
    if (this.live) this.live.close();
    this._setState('idle', null);
  }
}

const api = {
  LIVE_MODEL,
  LIVE_WS_URL,
  DEFAULT_WORKER_URL,
  INTRO_LINE,
  LIVE_SYSTEM_INSTRUCTION,
  PlaybackQueue,
  LiveTransport,
  VerifiedTransport,
  AvatarConnection,
  scriptedAnswer,
  floatToPcm16Base64,
  pcm16Base64ToFloat32,
  rmsLevel,
  mouthOpenFromLevel,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.GodworldConnection = api;
