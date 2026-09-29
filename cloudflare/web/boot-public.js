/*
 * boot-public.js — starts the public site on Cloudflare.
 * 1. Parses the deep-link route exactly like initialRoute_() in Code.gs.
 * 2. Renders instantly from the last copy kept in this browser (if any, ≤ 7 days old),
 *    then refreshes from /api/public (served by the Worker, which caches it briefly).
 */
(function () {
  'use strict';
  var CACHE_KEY = 'urh_public_v1';
  var MAX_AGE = 7 * 24 * 3600 * 1000;

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '');
  }
  function cleanLine(s) {
    return String(s || '').replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function parseRoute() {
    var q = new URLSearchParams(location.search);
    var p = String(q.get('p') || 'home').toLowerCase();
    if (['home', 'programme', 'official', 'submit', 'about', 'search', 'contact'].indexOf(p) === -1) p = 'home';
    var lang = q.get('lang');
    return {
      p: p === 'contact' ? 'about' : p,
      s: slugify(q.get('s')).slice(0, 120),
      c: slugify(q.get('c')).slice(0, 120),
      q: cleanLine(q.get('q')).slice(0, 120),
      lang: lang === 'ar' || lang === 'en' ? lang : ''
    };
  }

  window.__ROUTE__ = parseRoute();

  var started = false;
  function startWith(bundle) {
    window.__BOOT__ = bundle;
    started = true;
    PublicApp.start();
  }

  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
  if (cached && cached.bundle && cached.bundle.ok && Date.now() - (cached.saved_at || 0) < MAX_AGE) {
    startWith(cached.bundle);
  }

  UI.rpc('getPublicData').then(function (res) {
    if (res && res.ok) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ saved_at: Date.now(), bundle: res })); } catch (e) {}
      if (!started) startWith(res); else PublicApp.refresh(res);
    } else if (!started) {
      startWith(res && res.error ? res : { ok: false, error: { code: 'SERVER_ERROR' } });
    }
  }).catch(function () {
    if (!started) startWith({ ok: false, error: { code: 'OFFLINE' } });
  });
})();
