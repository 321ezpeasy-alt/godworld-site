'use strict';
/*
 * call.js — the RTC CALL client for the godworld.org front door.
 * NEW code for the from-scratch call leg (2026-11-17, Henry's order);
 * it does not layer onto connection.js's text-pipeline transports.
 *
 * The call, in order:
 *   1. ADMISSION — the session already exists from the tap: nonce ->
 *      EZ Peasy liveness check (CAT) -> session exchange (see
 *      liveness-client.js). This client takes that session and asks
 *      the Worker to authorize the CALL: POST /api/rtc/authorize.
 *      The brain node runs the established gateway gate (CAT-bound
 *      liveness claim + route claim + startup security scan). No
 *      authorization, no call — and no ad-hoc auth is invented here:
 *      the only credential this client ever holds is the short-lived
 *      gateway session token.
 *   2. SIGNALING/MEDIA — Cloudflare Calls (SFU). The browser publishes
 *      its mic track through a server-side signaling adapter (the
 *      Calls app secret never reaches the page) and pulls the agent's
 *      audio track. The agent endpoint is the sub-agent process that
 *      takes the call (agent_endpoint.py on the brain side).
 *   3. SYNC — the agent's REAL audio drives the avatar: the remote
 *      stream runs through an AnalyserNode; its level maps to the
 *      mouth-open value (same easing contract as the existing jaw
 *      layer) and the state machine (idle/listening/thinking/talking)
 *      follows the actual streams — visitor mic energy, the gap while
 *      the agent's verified turn is produced, agent audio energy.
 *   4. TURNS — while media is live, recognized visitor speech is
 *      posted to POST /api/rtc/turn as a record of the turn; the
 *      agent endpoint independently runs the same turn through the
 *      verified pipeline (Re-Search gate, via:'rtc-call' in the
 *      verification log) and speaks ONLY what passes. This client
 *      NEVER speaks pipeline text itself — if the media leg is not
 *      live, it reports 'degraded' and hands control back to the
 *      page's existing graceful fallback instead of faking a call.
 */

function mouthOpenFromLevel(level, prev) {
  const target = Math.max(0, Math.min(1, level * 2.6));
  return prev + (target - prev) * 0.55;
}

function createCallClient(options) {
  const opts = options || {};
  const workerUrl = opts.workerUrl || 'https://godworld-storefront.321ezpeasy.workers.dev';
  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(window) : null);
  const callbacks = opts.callbacks || {};
  const onState = typeof callbacks.onState === 'function' ? callbacks.onState : () => {};
  const onMouth = typeof callbacks.onMouth === 'function' ? callbacks.onMouth : () => {};
  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : () => {};
  const onFallback = typeof callbacks.onFallback === 'function' ? callbacks.onFallback : () => {};

  let pc = null;
  let audioCtx = null;
  let remoteAnalyser = null;
  let micAnalyser = null;
  let raf = 0;
  let mouth = 0;
  let state = 'idle';
  let thinkingUntil = 0;
  let session = null;
  let remoteLive = false;

  function setState(next) {
    if (next === state) return;
    state = next;
    onState(next);
    onEvent({ type: 'state', state: next });
  }

  async function postJson(path, body) {
    const res = await fetchImpl(workerUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  function levelOf(analyser, buf) {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  function renderLoop() {
    const remoteBuf = new Uint8Array(1024);
    const micBuf = new Uint8Array(1024);
    const tick = () => {
      const remoteLevel = levelOf(remoteAnalyser, remoteBuf);
      const micLevel = levelOf(micAnalyser, micBuf);
      mouth = mouthOpenFromLevel(remoteLive ? remoteLevel : 0, mouth);
      onMouth(mouth);
      if (remoteLevel > 0.02) setState('talking');
      else if (Date.now() < thinkingUntil) setState('thinking');
      else if (micLevel > 0.03) setState('listening');
      else setState('idle');
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function start(sess) {
    session = sess;
    if (!session || !session.sessionToken || !session.sessionId) {
      onFallback('no-session');
      return { ok: false, reason: 'no-session' };
    }
    // 1) Admission: the established gateway gate decides.
    let auth;
    try {
      auth = await postJson('/api/rtc/authorize', {
        sessionToken: session.sessionToken,
        sessionId: session.sessionId,
      });
    } catch {
      onFallback('authorize-unreachable');
      return { ok: false, reason: 'authorize-unreachable' };
    }
    if (auth.status !== 200 || !auth.data || auth.data.authorized !== true) {
      onEvent({ type: 'authorize-denied', status: auth.status, action: auth.data && auth.data.action });
      onFallback(auth.data && auth.data.action === 'recheck' ? 'liveness-recheck' : 'not-authorized');
      return { ok: false, reason: 'not-authorized', action: auth.data && auth.data.action };
    }
    onEvent({ type: 'authorized', route: auth.data.route, mode: auth.data.mode, liveness: auth.data.liveness });

    // 2) Media: mic -> SFU (server-side signaling) -> agent track.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micAnalyser = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(stream).connect(micAnalyser);

      pc = new RTCPeerConnection({ iceServers: opts.iceServers || auth.data.iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }] });
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      pc.ontrack = (e) => {
        const remoteStream = e.streams[0];
        if (opts.remoteAudio) opts.remoteAudio.srcObject = remoteStream;
        remoteAnalyser = audioCtx.createAnalyser();
        audioCtx.createMediaStreamSource(remoteStream).connect(remoteAnalyser);
        remoteLive = true;
        onEvent({ type: 'agent-track-live' });
      };
      pc.onconnectionstatechange = () => {
        onEvent({ type: 'pc-state', state: pc.connectionState });
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          remoteLive = false;
          setState('degraded');
          onFallback('media-' + pc.connectionState);
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Signaling adapter: the Worker relays the offer to the
      // server-side SFU client (app secret stays server-side).
      const signaling = typeof opts.signaling === 'function'
        ? opts.signaling
        : (body) => postJson('/api/rtc/offer', body);
      const sig = await signaling({
        sessionToken: session.sessionToken,
        sessionId: session.sessionId,
        sdp: pc.localDescription.sdp,
        tracks: [{ location: 'local', trackName: 'visitor-audio', mid: '0' }],
      });
      if (!sig || sig.status !== 200 || !sig.data || !sig.data.answerSdp) {
        throw new Error('signaling-failed');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: sig.data.answerSdp });
      renderLoop();
      // 3) Pull the agent's track onto this PeerConnection: the SFU
      // answers the pull with its own offer; we answer it and relay
      // the answer back for PUT /renegotiate. Until the agent
      // endpoint has joined and published, the pull reports pending —
      // poll briefly, then let the agent track arrive via ontrack.
      const sfuSessionId = sig.data.sfuSessionId || null;
      (async () => {
        for (let i = 0; i < 15 && pc && pc.connectionState !== 'closed'; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          if (remoteLive) return;
          let pull;
          try {
            pull = await postJson('/api/rtc/pull-agent', {
              sessionToken: session.sessionToken,
              sessionId: session.sessionId,
            });
          } catch { continue; }
          if (!pull || pull.status !== 200 || !pull.data || !pull.data.offerSdp) continue;
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: pull.data.offerSdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await postJson('/api/rtc/renegotiate', {
              sessionToken: session.sessionToken,
              sessionId: session.sessionId,
              sdp: pc.localDescription.sdp,
            });
            onEvent({ type: 'agent-pull-answered' });
            return;
          } catch (err) {
            onEvent({ type: 'agent-pull-failed', error: String(err && err.message ? err.message : err) });
            return;
          }
        }
      })();
      return { ok: true, sfuSessionId };
    } catch (err) {
      onEvent({ type: 'media-failed', error: String(err && err.message ? err.message : err) });
      setState('degraded');
      onFallback('media-unavailable');
      return { ok: false, reason: 'media-unavailable' };
    }
  }

  // Records a visitor turn with the call's verified pipeline. The
  // agent endpoint runs the same turn for speech; this client's copy
  // is the page-side record + the thinking-state driver. It never
  // speaks the returned sentences itself.
  async function noteTurn(text) {
    if (!session) return null;
    thinkingUntil = Date.now() + 4000;
    setState('thinking');
    try {
      const res = await postJson('/api/rtc/turn', {
        sessionToken: session.sessionToken,
        sessionId: session.sessionId,
        message: text,
      });
      onEvent({ type: 'turn', status: res.status, verdict: res.data && res.data.verdict });
      return res.data;
    } catch {
      onEvent({ type: 'turn-failed' });
      return null;
    }
  }

  function end() {
    if (raf) cancelAnimationFrame(raf);
    if (pc) try { pc.close(); } catch {}
    if (audioCtx) try { audioCtx.close(); } catch {}
    remoteLive = false;
    mouth = 0;
    onMouth(0);
    setState('idle');
  }

  return { start, noteTurn, end, get state() { return state; } };
}

const GodworldCall = { createCallClient, mouthOpenFromLevel };
if (typeof module !== 'undefined' && module.exports) module.exports = GodworldCall;
if (typeof window !== 'undefined') window.GodworldCall = GodworldCall;
