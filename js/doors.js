'use strict';
/*
 * doors.js — the door-opening mechanism for godworld.org pages.
 *
 * Henry's concierge design: the visitor asks out loud ("take me to the
 * Emily Webb agent page") and the avatar presents the door. Until now the
 * words existed and the machinery did not (zero navigation calls in the
 * page code). This module is the machinery.
 *
 * How it works: the page passes every recognized visitor utterance to
 * GodworldDoors.hear(text) (the same text it passes to the call client's
 * noteTurn). A match against the verified directory presents a door card;
 * tapping the card navigates. Matching is client-side on purpose: doors
 * work even when the drafting quota is parked and the brain is on its
 * floor. Presenting a door never auto-navigates — the visitor taps,
 * per Henry's rule: create the door, the user opens it.
 *
 * Directory = the real, verified godworld.org pages only.
 */
(function () {
  var DOORS = [
    { id: 'front-door', name: 'godworld.org — the front door',
      url: 'https://godworld.org/',
      keys: ['front door', 'home page', 'home', 'lobby', 'main page', 'start over'] },
    { id: 'si-designs', name: 'S.I. Designs — get a website built',
      url: 'https://godworld.org/si-designs/',
      keys: ['si designs', 's.i. designs', 'super intelligent designs', 'build a website', 'build my website', 'website builder', 'get a website'] },
    { id: 'emily', name: 'Emily Webb — AI agent',
      url: 'https://godworld.org/emilywebbaiagent/',
      keys: ['emily', 'emily webb', 'emily webbaiagent', 'emily webb agent', 'emily webb ai agent'] },
    { id: 'outreach', name: 'Emily — outreach & seller codes',
      url: 'https://godworld.org/outreach/',
      keys: ['outreach', 'seller code', 'seller codes', 'archangel code', 'rebate code'] },
    { id: 'portfolio', name: 'Portfolio — the first storefronts',
      url: 'https://godworld.org/portfolio/',
      keys: ['portfolio', 'storefronts', 'the stores', 'shops', 'mall'] },
    { id: 'atrium', name: 'Atrium — more storefronts',
      url: 'https://godworld.org/atrium/',
      keys: ['atrium', 'atrium to the future'] },
    { id: 'triphone', name: 'Archangel 8 TriPhone',
      url: 'https://godworld.org/triphone.html',
      keys: ['triphone', 'archangel 8', 'archangel eight', 'the phone', 'tri phone'] },
    { id: 'balance', name: 'BALANCE — the book',
      url: 'https://godworld.org/balance/',
      keys: ['balance', 'the book', 'your book', 'balance book'] }
  ];

  var INTENT = /\b(take me|go to|open|show me|bring me|get me to|visit|see the|see)\b/;

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9 .'-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Returns the matching door for an utterance, or null. */
  function find(text) {
    var t = normalize(text);
    if (!t) return null;
    var best = null, bestLen = 0;
    for (var i = 0; i < DOORS.length; i++) {
      for (var j = 0; j < DOORS[i].keys.length; j++) {
        var k = DOORS[i].keys[j];
        if (t.indexOf(k) !== -1 && k.length > bestLen) { best = DOORS[i]; bestLen = k.length; }
      }
    }
    if (!best) return null;
    // A bare mention in a question ("what is the portfolio?") is not a
    // request to go there; require either travel intent or a short,
    // command-shaped utterance ("emily's page", "portfolio").
    if (INTENT.test(t) || t.split(' ').length <= 4) return best;
    return null;
  }

  /** Present the door card. Returns the door, or null if already shown. */
  var shownFor = null;
  function present(door) {
    if (!door || shownFor === door.id) return null;
    shownFor = door.id;
    var card = document.createElement('a');
    card.href = door.url;
    card.className = 'gw-door-card';
    card.setAttribute('role', 'button');
    card.textContent = 'Enter — ' + door.name;
    card.style.cssText = 'position:fixed;left:50%;bottom:9%;transform:translateX(-50%);' +
      'z-index:60;padding:14px 26px;border-radius:999px;background:rgba(10,14,24,.92);' +
      'color:#fff;font:600 17px/1.2 system-ui,sans-serif;text-decoration:none;' +
      'border:1px solid rgba(255,255,255,.35);box-shadow:0 8px 30px rgba(0,0,0,.45)';
    document.body.appendChild(card);
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); if (shownFor === door.id) shownFor = null; }, 20000);
    return door;
  }

  /** Call with every recognized visitor utterance. Returns door or null. */
  function hear(text) {
    var door = find(text);
    if (door) present(door);
    return door;
  }

  var api = { DOORS: DOORS, find: find, present: present, hear: hear };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GodworldDoors = api;
})();
