// liveness-client.js — page-side EZ Peasy liveness-at-touch module.
// LIVE 2026-11-17 (Henry's go-live word) — browser form of the staged
// module (~/workspace/ezpeasy-liveness-staging/src/liveness-client.js),
// logic identical; only the module wrapper differs (classic script,
// window.GodworldLiveness, same pattern as connection.js).
//
// Slots into the front door's connection handshake (connection.js) at
// exactly one point: the tap. Today's flow is tap -> nonce ->
// exchange -> session token. With this module it becomes:
//   tap -> nonce -> LIVENESS CHECK (this module, on the visitor's
//   device, BEFORE any session/RTC connection opens) -> exchange
//   with the CAT -> session token carrying the liveness claim.
// Any failure anywhere in the check leaves the page exactly where it
// is today without a token: the graceful scripted fallback. Nothing
// here can freeze the page — every adapter call is awaited inside a
// try/catch and every failure resolves to { passed: false }.
//
// Adapters (injected so the module is testable outside a browser):
//   api.post(path, body) -> Promise<{ status, body }>
//     Page implementation: fetch() to the Worker routes
//     (/api/session-nonce, /api/liveness-challenge,
//     /api/liveness-verify, /api/session-exchange,
//     /api/session-liveness-refresh — the Worker relays each to the
//     brain node's *-local mounts, same as today's session routes).
//   screen.setBrightness(level01) / screen.restore()
//     Page implementation: the full-screen flash overlay. Refresh
//     checks use the low-amplitude variant (setBrightnessQuiet).
//   camera.sampleStepLuminance(stepIndex) -> Promise<number 0..1>
//     Page implementation: getUserMedia + canvas sampling of the
//     face region DURING the step. Frames are processed on-device
//     and discarded; only the per-step average number ever leaves
//     this function. camera.sourceKind() classifies the source for
//     the separate injection layer ('device-camera' in production).
//   prompt.ask(question) -> Promise<string>
//     The avatar chat prompt (speech in the real page).

const FRESH_WINDOW_MS = 150 * 1000; // matches the gateway's LIVENESS_FRESH_MS
const RENEW_MARGIN_MS = 30 * 1000; // renew on a turn when the claim is this close to stale

function createLivenessClient({ api, screen, camera, prompt }) {
  /**
   * Run one check bound to { nonce } (initial) or { sessionToken }
   * (in-flow renewal / re-check). kind 'full' (default) runs flash +
   * the GENERATED cognitive prompt through the avatar chat; kind
   * 'flash' is the quiet per-turn renewal (no prompt). Resolves
   * { passed: true, cat, claim } or { passed: false, reason,
   * detail? } — never rejects.
   */
  async function runCheck(bind, { kind = 'full' } = {}) {
    try {
      const chRes = await api.post('/api/liveness-challenge', { ...bind, kind });
      if (chRes.status !== 200 || !chRes.body || !chRes.body.challengeId) {
        return { passed: false, reason: 'challenge-unavailable' };
      }
      const challenge = chRes.body;
      const setLevel = kind === 'flash' && typeof screen.setBrightnessQuiet === 'function'
        ? screen.setBrightnessQuiet.bind(screen)
        : screen.setBrightness.bind(screen);
      const series = [];
      try {
        for (let i = 0; i < challenge.flashPattern.length; i++) {
          await setLevel(challenge.flashPattern[i]);
          series.push(await camera.sampleStepLuminance(i));
        }
      } finally {
        await screen.restore();
      }
      const cognitiveAnswer =
        challenge.cognitive && challenge.cognitive.question
          ? await prompt.ask(challenge.cognitive.question)
          : '';
      const vRes = await api.post('/api/liveness-verify', {
        ...bind,
        challengeId: challenge.challengeId,
        flashSeries: series,
        cognitiveAnswer,
        injectionSource: typeof camera.sourceKind === 'function' ? camera.sourceKind() : 'unknown',
      });
      if (vRes.status !== 200 || !vRes.body || !vRes.body.cat) {
        return { passed: false, reason: 'verify-failed', detail: vRes.body || null };
      }
      return { passed: true, cat: vRes.body.cat, claim: vRes.body.claim };
    } catch (err) {
      return { passed: false, reason: 'check-error', detail: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * The full tap handshake: nonce -> check -> exchange with CAT.
   * On any liveness failure returns { ok: false, reason } and NO
   * exchange is attempted — the page stays in tokenless fallback.
   */
  async function livenessHandshake({ mode } = {}) {
    try {
      const nRes = await api.post('/api/session-nonce', {});
      if (nRes.status !== 200 || !nRes.body || !nRes.body.nonce) {
        return { ok: false, reason: 'nonce-unavailable' };
      }
      const { nonce } = nRes.body;
      const check = await runCheck({ nonce });
      if (!check.passed) return { ok: false, reason: 'liveness', detail: check };
      const xRes = await api.post('/api/session-exchange', { nonce, mode, cat: check.cat });
      if (xRes.status !== 200 || !xRes.body || !xRes.body.sessionToken) {
        return { ok: false, reason: 'exchange-failed', detail: xRes.body || null };
      }
      return { ok: true, session: xRes.body };
    } catch (err) {
      return { ok: false, reason: 'handshake-error', detail: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Flow rider (Henry's refinement, 2026-11-17): there is NO timer
   * process. Renewal rides the conversation itself —
   *   prepareTurn(): the conversation layer calls this before each
   *     outgoing turn. While the attestation is comfortably fresh it
   *     returns {} (the turn goes out as-is). When the claim is
   *     within RENEW_MARGIN_MS of stale, it runs a quiet flash check
   *     and returns { livenessCat } to attach to the turn body; the
   *     server consumes it at the chat gate and the turn renews the
   *     attestation as it flows.
   *   handleRecheck(): when a turn comes back flagged
   *     recheckRequired (the conversation went quiet past the
   *     freshness window), this runs a FULL check — flash plus the
   *     fresh generated cognitive prompt through the avatar chat —
   *     and lands it via the refresh mount. The agent continues on
   *     the next turn; the current turn already got the graceful
   *     scripted fallback from the gate. Never a freeze.
   * `now` is injectable for tests.
   */
  function createFlowRider({ sessionToken, now = () => Date.now(), initialAttestedAt = null }) {
    let attestedAt = initialAttestedAt;
    const noteAttested = (atMs) => {
      if (typeof atMs === 'number' && Number.isFinite(atMs)) attestedAt = atMs;
    };
    async function prepareTurn() {
      if (attestedAt !== null && now() - attestedAt <= FRESH_WINDOW_MS - RENEW_MARGIN_MS) {
        return {};
      }
      const check = await runCheck({ sessionToken }, { kind: 'flash' });
      if (!check.passed) return {};
      return { livenessCat: check.cat };
    }
    async function handleRecheck() {
      const check = await runCheck({ sessionToken }, { kind: 'full' });
      if (!check.passed) return false;
      const rRes = await api.post('/api/session-liveness-refresh', { sessionToken, cat: check.cat });
      if (rRes.status !== 200) return false;
      noteAttested(now());
      return true;
    }
    return { prepareTurn, handleRecheck, noteAttested, _attestedAt: () => attestedAt };
  }

  return { runCheck, livenessHandshake, createFlowRider };
}

const livenessApi = { createLivenessClient, FRESH_WINDOW_MS, RENEW_MARGIN_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = livenessApi;
if (typeof window !== 'undefined') window.GodworldLiveness = livenessApi;
