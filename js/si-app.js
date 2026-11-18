'use strict';
/*
 * si-app.js — page glue for godworld.org/si-designs/ (FIX ORDER,
 * 2026-11-17): the S.I. Designs avatar runs the SAME connection stack
 * as the front door — gateway handshake -> EZ Peasy liveness ->
 * session token -> RTC authorize -> live agent endpoint — instead of
 * the baked-in script this page used to carry.
 *
 * Page-specific wiring on top of the shared stack:
 *   - Every spoken sentence passes the no-repeat guard
 *     (GodworldCallHenry.makeGuard): a repeat is suppressed and the
 *     phone fallback fires — the avatar never loops (Henry's rule).
 *   - If the live agent cannot take the conversation, the fallback
 *     is the PHONE PATH (GodworldCallHenry): a deduped /api/call-start
 *     alert record for Henry + a Messenger handoff card + a tel: card
 *     to (314) 202-4304. There is no scripted conversationalist.
 *   - Every recognized visitor utterance also goes to
 *     GodworldDoors.hear() (door-opening, client-side), and — while
 *     the RTC call is live — to the call client's noteTurn(), per the
 *     handoff architecture. Brain-emitted directory links arrive via
 *     onLink and are presented through GodworldDoors.present().
 *   - The page's own avatar renderer (window.SIAvatar, inline in the
 *     page) owns the face: page-voice lip envelope while the pipeline
 *     transports speak, the agent's real call audio level once the
 *     call is live.
 */
(function () {
  const C = window.GodworldConnection;
  const A = window.SIAvatar;
  const PAGE_PATH = '/si-designs/';

  const status = document.getElementById('status');
  const typedForm = document.getElementById('typedForm');
  const typedInput = document.getElementById('typedInput');

  function setStatus(text) {
    if (status) status.textContent = text;
  }

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

  /* ---------- speech input ---------- */
  let promptResolver = null;
  let agentTalking = false;

  const recognition = {
    rec: null,
    wanted: false,
    arm() {
      if (!this.wanted || !this.rec || (A && A.isSpeaking())) return;
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
    start() {
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
            if (promptResolver) {
              const resolve = promptResolver;
              promptResolver = null;
              resolve(text);
            } else {
              routeUtterance(text);
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

  // The avatar renderer's speech drives recognition suspension: while
  // the page voice talks, the mic is not listening to itself.
  if (A && typeof A.onSpeakState === 'function') {
    A.onSpeakState((speakingNow) => {
      if (speakingNow) recognition.suspend();
      else recognition.arm();
    });
  }

  /* ---------- EZ Peasy liveness-at-touch adapters ----------
   * The front door's real device adapters, unchanged: flash overlay
   * (screen), on-device camera luminance sampling (frames never leave
   * the device), spoken cognitive prompt (prompt). The api adapter
   * also presents this page's path so the hub binds the session's
   * route from the page the visitor is actually on. */
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
        body: JSON.stringify({ ...(body || {}), page: PAGE_PATH }),
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
        if (A) A.speak(question);
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

  /* ---------- the RTC call ---------- */
  let callClient = null;
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
        onMouth(v) {
          if (A) A.setCallMouth(v);
        },
        onState(st) {
          document.body.dataset.callState = st;
          agentTalking = st === 'talking';
        },
        onEvent(ev) {
          if (ev && ev.type === 'agent-track-live') {
            callLive = true;
            document.body.dataset.call = 'live';
            if (A) {
              A.setCallLive(true);
              A.cancel();
            }
            setStatus('Connected — speak any time');
          }
          if (ev && ev.type === 'henry-track-live') {
            document.body.dataset.henry = 'live';
            setStatus('Henry has joined the call');
          }
        },
        onFallback(reason) {
          document.body.dataset.call = 'fallback:' + reason;
          callLive = false;
          if (A) A.setCallLive(false);
        },
      },
    });
    callClient.start({ sessionToken: conn.sessionToken, sessionId: conn.sessionId }).catch(() => {});
  }

  /* ---------- utterance routing: doors + conversation ----------
   * Every recognized (or typed) visitor utterance is offered to the
   * door mechanism first-hand, then routed to the live conversation:
   * on the RTC call it rides noteTurn (the agent hears the visitor
   * through the call itself; this is the page-side turn record);
   * otherwise it goes to the connection's verified pipeline. */
  function routeUtterance(text) {
    const t = String(text || '').trim();
    if (!t) return;
    if (window.GodworldDoors) window.GodworldDoors.hear(t);
    if (callLive) {
      // While the agent is audibly talking, a transcript is most
      // likely the page hearing the agent — not a visitor turn.
      if (!agentTalking && callClient) callClient.noteTurn(t);
    } else {
      conn.hear(t);
    }
  }

  /* ---------- spoken output: the no-repeat guard ----------
   * Henry's fallback rule, wired exactly as call-henry.js specifies:
   * every sentence the page is about to speak passes the guard; a
   * repeat is suppressed, the phone fallback fires, the avatar goes
   * quiet. The guard is created against the live session id. */
  let guard = null;
  function speakGuarded(text) {
    if (!A) return;
    if (!guard && window.GodworldCallHenry) {
      guard = window.GodworldCallHenry.makeGuard(conn.sessionId, PAGE_PATH);
    }
    if (guard && !guard(text)) return;
    A.speak(text);
  }

  function phonePath() {
    if (window.GodworldCallHenry) {
      window.GodworldCallHenry.phoneFallback(conn.sessionId, PAGE_PATH);
    }
  }

  /* ---------- the connection ---------- */
  const conn = new C.AvatarConnection(env, {
    tokenEndpoint: C.DEFAULT_WORKER_URL + '/api/live-token',
    workerUrl: C.DEFAULT_WORKER_URL,
    mode: 'claude-first',
    sessionGateway: true,
    sessionMode: 'audible',
    livenessClient,
    callbacks: {
      onState(state, transport) {
        document.body.dataset.state = state;
        document.body.dataset.transport = transport || '';
        if (state === 'connecting') setStatus('Connecting…');
        if (state === 'connected') {
          maybeStartCall();
          setStatus(transport === 'scripted' ? 'Connected — basic mode' : 'Connected — speak any time');
          if (transport !== 'live') {
            const heard = recognition.start();
            if (!heard) showTypedInput();
          }
        }
        if (state === 'dropped') {
          recognition.stop();
          if (A) A.cancel();
          if (typedForm) typedForm.classList.add('hidden');
          setStatus('Connection dropped — tap to reconnect');
        }
        if (state === 'blocked') {
          setStatus('Microphone is blocked — allow access, then tap again');
        }
      },
      onSpeakText(text) {
        speakGuarded(text);
      },
      onLink(linkObj) {
        // Directory answers from the verified pipeline arrive as
        // link events; present the real door (visitor taps to open).
        if (linkObj && linkObj.name && linkObj.url && window.GodworldDoors) {
          window.GodworldDoors.present({
            id: 'brain:' + linkObj.url,
            name: linkObj.name,
            url: linkObj.url,
          });
        }
      },
      onPhoneFallback() {
        // The live agent could not take this visitor: fire the
        // phone path — alert record + Messenger handoff + tel: card.
        setStatus('Live agent unavailable — call Henry directly');
        phonePath();
      },
      onDropped() {},
      onRecord() {},
    },
  });

  /* ---------- typed input (degrade path, same routing) ---------- */
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
      if (promptResolver) {
        const resolve = promptResolver;
        promptResolver = null;
        resolve(text);
        return;
      }
      routeUtterance(text);
    });
    typedForm.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ---------- the tap: the screen is the trigger ----------
   * Taps on links (the order button, door cards, the Call Henry
   * cards) and the typed form are theirs; any other tap powers the
   * page on, exactly like the front door. */
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

  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('a, form, input, button')) return;
    unlockAudio();
    if (conn.state === 'idle' || conn.state === 'dropped' || conn.state === 'blocked') {
      recognition.start();
      conn.connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && conn.state === 'connected') conn.end();
  });
  window.addEventListener('pagehide', () => {
    if (conn.state === 'connected') conn.end();
  });

  if (!window.isSecureContext) {
    setStatus('This page needs a secure (HTTPS) connection for voice.');
  }
})();
