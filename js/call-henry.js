'use strict';
/*
 * call-henry.js — the phone fallback for godworld.org pages.
 *
 * Henry's rule: either the agent takes the call or Henry takes the call.
 * The script is never the conversationalist. This module is what the page
 * fires when the live agent cannot take the conversation, when a spoken
 * answer would repeat, or when the visitor taps "Call Henry".
 *
 * It does three honest things, in order:
 *   1. ALERT — POST /api/call-start to the Worker, once per session
 *      (deduped here and in the record layer). Henry's side surfaces it.
 *   2. MESSENGER HANDOFF — a card opening Henry's Messenger conversation
 *      (m.me). Inside Messenger the visitor taps Messenger's own call
 *      button and Henry's phone rings with a real Messenger call. Meta
 *      provides NO API for the website to place that call itself; this is
 *      a handoff and is labeled as one.
 *   3. PHONE CARD — "Call Henry — (314) 202-4304", a tel: link. The
 *      visitor's own device dials Henry's TextNow number.
 *
 * It never claims the website rang Henry's phone. A website tap cannot do
 * that without a telephony bridge account, which this system does not have.
 */
(function () {
  var CONFIG = {
    workerUrl: 'https://godworld-storefront.321ezpeasy.workers.dev',
    henryPhoneDisplay: '(314) 202-4304',
    henryTelUrl: 'tel:+13142024304',
    // VERIFIED 2026-11-17 ~21:25 CST via facebook-cli `me`: the account
    // connected to this Muse seat is "Archangel Seveng", fb_user_id
    // 61593681734935 — the Messenger route Henry ordered for website
    // calls (nobody else calls it; free to receive all day). The old
    // value (…036187) was Henry's MAIN account — wrong target.
    messengerUrl: 'https://m.me/61593681734935'
  };

  var alertedFor = null;

  /** Fire the alert once per session. Returns a promise for the POST. */
  function alert(sessionId, page) {
    if (!sessionId || alertedFor === sessionId) return Promise.resolve(false);
    alertedFor = sessionId;
    return fetch(CONFIG.workerUrl + '/api/call-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, page: page || location.pathname, kind: 'phone-fallback' })
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  function card(href, label, id) {
    var existing = document.getElementById(id);
    if (existing) return existing;
    var a = document.createElement('a');
    a.id = id;
    a.href = href;
    a.textContent = label;
    a.style.cssText = 'display:block;margin:10px auto;padding:14px 26px;max-width:320px;' +
      'border-radius:999px;background:rgba(10,14,24,.92);color:#fff;text-align:center;' +
      'font:600 17px/1.2 system-ui,sans-serif;text-decoration:none;' +
      'border:1px solid rgba(255,255,255,.35);box-shadow:0 8px 30px rgba(0,0,0,.45)';
    return a;
  }

  /** Show the fallback cards (Messenger + phone) in a fixed container. */
  function showCards() {
    var box = document.getElementById('gw-call-henry');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'gw-call-henry';
    box.style.cssText = 'position:fixed;left:50%;bottom:9%;transform:translateX(-50%);z-index:61;text-align:center';
    box.appendChild(card(CONFIG.messengerUrl, 'Message Henry on Messenger — call from there', 'gw-messenger-card'));
    box.appendChild(card(CONFIG.henryTelUrl, 'Call Henry — ' + CONFIG.henryPhoneDisplay, 'gw-phone-card'));
    document.body.appendChild(box);
    return box;
  }

  /** The full fallback: alert Henry, then offer the visitor the two real paths. */
  function phoneFallback(sessionId, page) {
    alert(sessionId, page);
    showCards();
  }

  /*
   * No-repeat guard. The page routes every sentence it is about to speak
   * through guard(text): true = speak it; false = it is a repeat — the
   * sentence is suppressed, the phone fallback fires, and the avatar goes
   * quiet instead of looping (the 2026-11-17 17:52 failure).
   */
  var spoken = Object.create(null);
  function norm(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function makeGuard(sessionId, page) {
    return function guard(text) {
      var key = norm(text);
      if (!key) return false;
      if (spoken[key]) { phoneFallback(sessionId, page); return false; }
      spoken[key] = 1;
      return true;
    };
  }

  var api = { CONFIG: CONFIG, alert: alert, showCards: showCards, phoneFallback: phoneFallback, makeGuard: makeGuard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GodworldCallHenry = api;
})();
