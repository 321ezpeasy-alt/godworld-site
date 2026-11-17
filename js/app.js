'use strict';
/*
 * app.js — page glue for the from-scratch godworld.org front door.
 *
 * The screen itself is the trigger: one tap anywhere powers the page on
 * and opens the connection (Henry's locked entry shape — no buttons).
 * The same gesture unlocks browser audio (hardening #4). While connected
 * the conversation is continuous and hands-free; the session ends on
 * page-leave, and a dropped connection re-offers the tap (hardening #7).
 */
(function () {
  const C = window.GodworldConnection;

  const stage = document.getElementById('stage');
  const cue = document.getElementById('cue');
  const status = document.getElementById('status');
  const jawImg = document.getElementById('jawImg');
  const portrait = document.getElementById('portrait');
  const frame = document.getElementById('frame');
  const doorCard = document.getElementById('doorCard');
  let activeDoorUrl = null;

  // The jaw layer is a duplicate of the portrait, clipped by #jaw to the
  // lower face only (see index.html). Feed it the same image the visitor
  // sees — in the live single-file build that is the inlined data URI.
  if (jawImg && portrait) jawImg.src = portrait.src;

  const env = {
    fetch: window.fetch.bind(window),
    createWebSocket: (url) => new WebSocket(url),
    createAudioContext: (opts) => new (window.AudioContext || window.webkitAudioContext)(opts),
    getUserMedia: navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null,
    postSessionRecord: (record) =>
      fetch(C.DEFAULT_WORKER_URL + '/api/session-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
        keepalive: true,
      }),
  };

  /* ---------- speech output for the claude / verified / scripted transports ----------
   * The project's existing speech route: the prior builds speak pipeline
   * replies with the browser's speechSynthesis (there is no project TTS
   * endpoint), so the Muse connection uses it too. */
  const typedForm = document.getElementById('typedForm');
  const typedInput = document.getElementById('typedInput');
  const tts = {
    queue: [],
    speaking: false,
    speak(text) {
      if (!('speechSynthesis' in window)) return;
      this.queue.push(text);
      this._pump();
    },
    _pump() {
      if (this.speaking || !this.queue.length) return;
      const text = this.queue.shift();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      this.speaking = true;
      u.onend = u.onerror = () => {
        this.speaking = false;
        recognition.arm();
        this._pump();
      };
      recognition.suspend();
      window.speechSynthesis.speak(u);
    },
    cancel() {
      this.queue = [];
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      this.speaking = false;
    },
  };

  /* ---------- speech input for the claude / verified / scripted transports ----------
   * Browser speech recognition where available (no cost, no key). Where
   * it is unavailable, start() returns false and the page degrades to
   * typed input through the exact same hear() path. */
  const recognition = {
    rec: null,
    wanted: false,
    arm() {
      if (!this.wanted || !this.rec || tts.speaking) return;
      try {
        this.rec.start();
      } catch {}
    },
    suspend() {
      if (this.rec) {
        try {
          this.rec.stop();
        } catch {}
      }
    },
    start(conn) {
      if (this.rec) return true;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return false;
      this.wanted = true;
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = 'en-US';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const text = e.results[i][0].transcript;
            // A pending liveness cognitive prompt consumes the
            // answer instead of treating it as a chat turn.
            if (promptResolver) {
              const resolve = promptResolver;
              promptResolver = null;
              resolve(text);
            } else {
              conn.hear(text);
            }
          }
        }
      };
      rec.onend = () => this.arm();
      this.rec = rec;
      this.arm();
      return true;
    },
    stop() {
      this.wanted = false;
      this.suspend();
      this.rec = null;
    },
  };

  /* ---------- EZ Peasy liveness-at-touch adapters (go-live
   * 2026-11-17, Henry's word) ----------
   * The REAL device adapters for js/liveness-client.js, wired at
   * connection time per the staged package's plan:
   *   screen — a full-screen white flash overlay; the challenge
   *     pattern drives its opacity (quiet variant for renewals).
   *   camera — getUserMedia on the visitor's own device; each flash
   *     step samples the CENTER region's average luminance from a
   *     64x64 canvas. Frames are processed on-device and discarded —
   *     only the per-step number ever leaves the device. The stream
   *     stops as soon as a check's verify call returns.
   *   prompt — the generated cognitive question is SPOKEN by the
   *     avatar and the visitor's spoken (or typed) answer resolves
   *     it, through the same recognition path as the conversation.
   * Any adapter failure fails the check closed: the page stays on
   * the tokenless graceful fallback, never frozen. */
  let promptResolver = null;

  let flashEl = null;
  function flashOverlay() {
    if (!flashEl) {
      flashEl = document.createElement('div');
      flashEl.style.cssText =
        'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:60;transition:opacity 60ms linear;';
      document.body.appendChild(flashEl);
    }
    return flashEl;
  }
  const screenAdapter = {
    async setBrightness(level) {
      flashOverlay().style.opacity = String(Math.max(0, Math.min(1, level)) * 0.9);
    },
    async setBrightnessQuiet(level) {
      flashOverlay().style.opacity = String(Math.max(0, Math.min(1, level)) * 0.4);
    },
    async restore() {
      if (flashEl) flashEl.style.opacity = '0';
    },
  };

  const cameraAdapter = {
    stream: null,
    video: null,
    canvas: null,
    async _ensure() {
      if (this.stream) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      this.video = document.createElement('video');
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.srcObject = this.stream;
      await this.video.play();
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64;
      this.canvas.height = 64;
      return true;
    },
    async sampleStepLuminance() {
      let ok = false;
      try {
        ok = await this._ensure();
      } catch {
        ok = false;
      }
      if (!ok || !this.video) return 0.5; // no camera: flat series — the check fails honestly to fallback
      await new Promise((r) => setTimeout(r, 350));
      try {
        const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(this.video, 0, 0, 64, 64);
        const d = ctx.getImageData(16, 16, 32, 32).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          n++;
        }
        return n ? sum / n : 0;
      } catch {
        return 0.5;
      }
    },
    sourceKind() {
      return 'device-camera';
    },
    stop() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video = null;
    },
  };

  const livenessApiAdapter = {
    async post(path, body) {
      const res = await fetch(C.DEFAULT_WORKER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => null);
      if (path === '/api/liveness-verify') cameraAdapter.stop();
      return { status: res.status, body: data };
    },
  };

  const promptAdapter = {
    ask(question) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          if (promptResolver === done) promptResolver = null;
          resolve(value || '');
        };
        promptResolver = done;
        tts.speak(question);
        if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) showTypedInput();
        setTimeout(() => done(''), 30000);
      });
    },
  };

  const livenessClient =
    window.GodworldLiveness && typeof window.GodworldLiveness.createLivenessClient === 'function'
      ? window.GodworldLiveness.createLivenessClient({
          api: livenessApiAdapter,
          screen: screenAdapter,
          camera: cameraAdapter,
          prompt: promptAdapter,
        })
      : null;

  /* ---------- door card helpers ---------- */
  function hideDoorCard() {
    if (!doorCard) return;
    doorCard.classList.add('hidden');
    doorCard.textContent = '';
    activeDoorUrl = null;
  }

  function showDoorCard(name, url) {
    if (!doorCard || !name || !url) return;
    activeDoorUrl = url;
    doorCard.textContent = name;
    doorCard.classList.remove('hidden');
  }

  if (doorCard) {
    doorCard.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeDoorUrl) {
        window.open(activeDoorUrl, '_blank', 'noopener,noreferrer');
      }
    });
  }

  /* ---------- the connection ---------- */
  let mouthOpen = 0;
  // Syllable-rate mouth driver for the TTS transports (see connection.js):
  // speechSynthesis gives no analysable audio stream, so while the
  // claude/verified/scripted voice talks, the jaw runs on this driver's
  // open/close cycle instead of a level.
  const ttsMouth = C.createSyllableMouth ? C.createSyllableMouth() : null;

  /* ---------- the RTC call (from-scratch call leg, 2026-11-17) ----------
   * On a connected gateway session, the call client asks the Worker to
   * authorize the call (established gate), publishes the visitor's mic
   * to the Cloudflare Calls SFU, and pulls the agent endpoint's audio.
   * When the agent's track is live, ITS audio drives the jaw (callMouth
   * below takes priority in the render loop) and the page-side voice
   * transports stand down so there is exactly one voice: the agent on
   * the call. If the call cannot be established, onFallback leaves the
   * existing conversation exactly as it was. */
  let callClient = null;
  let callMouth = null;
  let callLive = false;
  let callStartedFor = null;
  function maybeStartCall() {
    if (!window.GodworldCall || !conn.sessionToken || !conn.sessionId) return;
    if (callStartedFor === conn.sessionId) return;
    callStartedFor = conn.sessionId;
    callClient = window.GodworldCall.createCallClient({
      workerUrl: C.DEFAULT_WORKER_URL,
      remoteAudio: document.getElementById('remoteAudio'),
      callbacks: {
        onMouth(v) { callMouth = v; },
        onState(st) { document.body.dataset.callState = st; },
        onEvent(ev) {
          if (ev && ev.type === 'agent-track-live') {
            callLive = true;
            document.body.dataset.call = 'live';
            try { recognition.stop(); } catch {}
            try { tts.cancel(); } catch {}
            setStatus('Connected — speak any time');
          }
        },
        onFallback(reason) {
          document.body.dataset.call = 'fallback:' + reason;
          callLive = false;
        },
      },
    });
    callClient.start({ sessionToken: conn.sessionToken, sessionId: conn.sessionId }).catch(() => {});
  }

  const conn = new C.AvatarConnection(env, {
    tokenEndpoint: C.DEFAULT_WORKER_URL + '/api/live-token',
    workerUrl: C.DEFAULT_WORKER_URL,
    // Henry's ordered connection is the DEFAULT voice path: the Muse
    // agent (verified brain pipeline) powers the avatar. Gemini Live is
    // legacy-only and is not selected here.
    mode: 'claude-first',
    // Session gateway (Henry's locked flow, 2026-11-16): nonce ->
    // short-lived session token before the pipeline connects. This is
    // Henry's OWN front door, so the session mode is 'audible'
    // (owner-join: the audio leg can terminate at Henry's phone);
    // client storefronts default to 'background' (sub-agent session).
    sessionGateway: true,
    sessionMode: 'audible',
    // LIVENESS (go-live 2026-11-17): the EZ Peasy liveness-at-touch
    // check runs inside the gateway handshake, on this device,
    // before the session connects (adapters above).
    livenessClient,
    callbacks: {
      onState(state, transport) {
        document.body.dataset.state = state;
        document.body.dataset.transport = transport || '';
        if (state === 'connecting') setStatus('Connecting…');
        if (state === 'connected') {
          maybeStartCall();
          cue.classList.add('hidden');
          setStatus(
            transport === 'scripted' ? 'Connected — basic mode' : 'Connected — speak any time'
          );
          if (transport !== 'live') {
            const heard = recognition.start(conn);
            if (!heard) showTypedInput();
          }
        }
        if (state === 'dropped') {
          recognition.stop();
          tts.cancel();
          hideDoorCard();
          if (typedForm) typedForm.classList.add('hidden');
          cue.classList.remove('hidden');
          setStatus('Connection dropped — tap to reconnect');
        }
        if (state === 'blocked') {
          setStatus('Microphone is blocked — allow access, then tap again');
          cue.classList.remove('hidden');
        }
      },
      onSpeakText(text) {
        tts.speak(text);
      },
      onLink(linkObj) {
        if (linkObj && linkObj.name && linkObj.url) {
          showDoorCard(linkObj.name, linkObj.url);
        }
      },
      onDropped() {},
      onRecord() {},
    },
  });

  function setStatus(text) {
    status.textContent = text;
  }

  /* ---------- typed input: the degrade path when speech recognition
   * is unavailable. Same hear() path as speech — the words reach the
   * Muse agent's pipeline identically, and answers are spoken back. */
  function showTypedInput() {
    if (!typedForm || !typedInput) return;
    typedForm.classList.remove('hidden');
    setStatus('Voice input is not available in this browser — type to talk');
    typedInput.focus();
  }
  if (typedForm) {
    typedForm.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = typedInput.value.trim();
      if (!text) return;
      typedInput.value = '';
      // A pending liveness cognitive prompt consumes the typed
      // answer instead of treating it as a chat turn.
      if (promptResolver) {
        const resolve = promptResolver;
        promptResolver = null;
        resolve(text);
        return;
      }
      conn.hear(text);
    });
    // Taps inside the form must not retrigger the screen-tap connect.
    typedForm.addEventListener('click', (e) => e.stopPropagation());
  }

  /* ---------- the tap: the screen is the trigger ---------- */
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      ctx.close();
    } catch {}
    if ('speechSynthesis' in window) {
      const prime = new SpeechSynthesisUtterance('');
      prime.volume = 0;
      window.speechSynthesis.speak(prime);
    }
  }

  stage.addEventListener('click', () => {
    unlockAudio();
    hideDoorCard();
    if (conn.state === 'idle' || conn.state === 'dropped' || conn.state === 'blocked') {
      // Start listening BEFORE the handshake: the liveness check's
      // generated cognitive prompt is answered by voice during it.
      recognition.start(conn);
      conn.connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && conn.state === 'connected') conn.end();
  });
  window.addEventListener('pagehide', () => {
    if (conn.state === 'connected') conn.end();
  });

  /* ---------- jaw + presence render loop (hardening #6) ---------- */
  function render(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : 0;
    if (callLive && callMouth !== null) {
      // The agent's real call audio drives the jaw.
      mouthOpen = callMouth;
      if (ttsMouth) ttsMouth.update(now, false);
    } else if (conn.transport === 'live') {
      const level = conn.isSpeaking() ? conn.getPlaybackLevel() : conn.getMicLevel() * 0.6;
      mouthOpen = C.mouthOpenFromLevel(level, mouthOpen);
      if (ttsMouth) ttsMouth.update(now, false);
    } else if (tts.speaking && ttsMouth) {
      // speechSynthesis exposes no audio stream to analyse; the jaw is
      // driven by the syllable mouth driver's open/close cycle while
      // the claude/verified/scripted voice talks.
      mouthOpen = ttsMouth.update(now, true);
    } else {
      if (ttsMouth) ttsMouth.update(now, false);
      mouthOpen = C.mouthOpenFromLevel(0, mouthOpen);
    }
    // mouthOpen now drives ONLY the jaw layer: the clipped portrait copy
    // drops by up to 10px. #jaw's clip-path (top edge at 54% of the frame)
    // makes it impossible for this transform to alter anything near the
    // eyes (~40-42%). No dark overlay is drawn anywhere on the face.
    const jawPx = mouthOpen * 10;
    if (jawImg) jawImg.style.transform = `translateY(${jawPx.toFixed(1)}px)`;
    frame.style.transform = `scale(${(1 + mouthOpen * 0.006).toFixed(4)})`;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  if (!window.isSecureContext) {
    setStatus('This page needs a secure (HTTPS) connection for voice.');
  }
})();
