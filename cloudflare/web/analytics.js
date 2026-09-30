/*
 * analytics.js — anonymous, privacy-friendly usage counts (Cloudflare site only).
 *
 * Sends small events to the same-origin Worker (/api/collect): page shown, programme page,
 * resource link opened, a search was made (never the search text). No cookies, no
 * localStorage, no identifiers: "visit" is a one-time flag in sessionStorage (cleared when the
 * tab closes). Respects Do Not Track / Global Privacy Control. Events are queued and sent in
 * one small request every few seconds or when the page is hidden, so nothing waits for it.
 */
(function () {
  'use strict';
  var off = false;
  try {
    off = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  } catch (e) { off = false; }

  var queue = [];
  var timer = null;

  function send() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, 30);
    try {
      fetch('/api/collect', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch })
      }).catch(function () {});
    } catch (e) { /* analytics must never break the site */ }
    if (queue.length) send();
  }
  function schedule() { if (!timer) timer = setTimeout(send, 5000); }

  function push(ev) {
    if (off) return;
    queue.push(ev);
    if (queue.length >= 20) send(); else schedule();
  }

  function refHost() {
    try {
      if (!document.referrer) return '';
      var h = new URL(document.referrer).hostname;
      return h === location.hostname ? '' : h;
    } catch (e) { return ''; }
  }

  // One "visit" per browser tab session.
  var firstInTab = true;
  try {
    if (sessionStorage.getItem('urh_v')) firstInTab = false;
    else sessionStorage.setItem('urh_v', '1');
  } catch (e) { firstInTab = true; }
  if (firstInTab) push({ t: 'visit', ref: refHost() });

  window.addEventListener('pagehide', send);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); });

  window.URHAnalytics = {
    /** type: 'pv' {p, id?} | 'click' {id} | 'search' {empty} */
    track: function (type, data) {
      var ev = { t: type };
      if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) ev[k] = data[k];
      push(ev);
    },
    flush: send
  };
})();
