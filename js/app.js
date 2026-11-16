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
  const mouth = document.getElementById('mouth');
  const portrait = document.getElementById('portrait');
  const frame = document.getElementById('frame');

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

  /* ---------- speech output for the verified + scripted transports ---------- */
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

  /* ---------- speech input for the verified + scripted transports ---------- */
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
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return;
      this.wanted = true;
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = 'en-US';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) conn.hear(e.results[i][0].transcript);
        }
      };
      rec.onend = () => this.arm();
      this.rec = rec;
      this.arm();
    },
    stop() {
      this.wanted = false;
      this.suspend();
      this.rec = null;
    },
  };

  /* ---------- the connection ---------- */
  let mouthOpen = 0;
  let ttsPhase = 0;

  const conn = new C.AvatarConnection(env, {
    tokenEndpoint: C.DEFAULT_WORKER_URL + '/api/live-token',
    workerUrl: C.DEFAULT_WORKER_URL,
    mode: 'live-first',
    callbacks: {
      onState(state, transport) {
        document.body.dataset.state = state;
        document.body.dataset.transport = transport || '';
        if (state === 'connecting') setStatus('Connecting…');
        if (state === 'connected') {
          cue.classList.add('hidden');
          setStatus(
            transport === 'live'
              ? 'Connected — speak any time'
              : transport === 'verified'
                ? 'Connected — speak any time'
                : 'Connected — basic mode'
          );
          if (transport !== 'live') recognition.start(conn);
        }
        if (state === 'dropped') {
          recognition.stop();
          tts.cancel();
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
      onDropped() {},
      onRecord() {},
    },
  });

  function setStatus(text) {
    status.textContent = text;
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
    if (conn.state === 'idle' || conn.state === 'dropped' || conn.state === 'blocked') {
      conn.connect();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && conn.state === 'connected') conn.end();
  });
  window.addEventListener('pagehide', () => {
    if (conn.state === 'connected') conn.end();
  });

  /* ---------- mouth + presence render loop (hardening #6) ---------- */
  function render() {
    let level = 0;
    if (conn.transport === 'live') {
      level = conn.isSpeaking() ? conn.getPlaybackLevel() : conn.getMicLevel() * 0.6;
    } else if (tts.speaking) {
      // speechSynthesis exposes no audio stream to analyse; the mouth is
      // driven by a speech-envelope while the verified/scripted voice talks.
      ttsPhase += 0.35;
      level = 0.35 + 0.3 * Math.abs(Math.sin(ttsPhase)) * Math.random();
    }
    mouthOpen = C.mouthOpenFromLevel(level, mouthOpen);
    const openPx = 2 + mouthOpen * 16;
    mouth.style.height = openPx.toFixed(1) + 'px';
    mouth.style.opacity = (0.25 + mouthOpen * 0.75).toFixed(2);
    frame.style.transform = `scale(${(1 + mouthOpen * 0.006).toFixed(4)})`;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  if (!window.isSecureContext) {
    setStatus('This page needs a secure (HTTPS) connection for voice.');
  }
})();
