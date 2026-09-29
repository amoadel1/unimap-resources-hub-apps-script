/*
 * platform.js — makes the unchanged Apps Script frontend code run on Cloudflare.
 * It provides the small part of the `google.script` client API that the app uses
 * (run, history, url) and maps each server function to a same-origin /api/* endpoint
 * served by the Cloudflare Worker. The browser never contacts Google.
 */
(function () {
  'use strict';

  function request(method, path, body) {
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { throw new Error('Unexpected response (' + res.status + ')'); });
    });
  }

  // Explicit mapping — nothing else can be called.
  var FUNCTIONS = {
    getPublicData: function () { return request('GET', '/api/public'); },
    submitResource: function (form) { return request('POST', '/api/submit', { form: form }); },
    adminLogin: function (email, password) { return request('POST', '/api/admin/login', { email: email, password: password }); },
    adminLogout: function () { return request('POST', '/api/admin/logout', {}); },
    // The token argument is ignored: the session is an HttpOnly cookie handled by the Worker.
    adminApi: function (_token, action, payload) { return request('POST', '/api/admin/call', { action: action, payload: payload || {} }); }
  };

  function runner(onSuccess, onFailure) {
    var r = {
      withSuccessHandler: function (fn) { return runner(fn, onFailure); },
      withFailureHandler: function (fn) { return runner(onSuccess, fn); },
      withUserObject: function () { return runner(onSuccess, onFailure); }
    };
    Object.keys(FUNCTIONS).forEach(function (name) {
      r[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        FUNCTIONS[name].apply(null, args).then(
          function (result) { if (onSuccess) onSuccess(result); },
          function (err) { if (onFailure) onFailure(err instanceof Error ? err : new Error(String(err))); }
        );
      };
    });
    return r;
  }

  function parseQuery() {
    var out = {}, all = {};
    new URLSearchParams(location.search).forEach(function (v, k) {
      if (!(k in out)) out[k] = v;
      (all[k] = all[k] || []).push(v);
    });
    return { parameter: out, parameters: all, hash: location.hash.replace(/^#/, '') };
  }
  function toSearch(params) {
    var usp = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== undefined && params[k] !== null && params[k] !== '') usp.set(k, params[k]); });
    var s = usp.toString();
    return s ? '?' + s : location.pathname;
  }

  var changeHandler = null;
  window.addEventListener('popstate', function (e) {
    if (changeHandler) changeHandler({ state: e.state, location: parseQuery() });
  });

  window.google = {
    script: {
      run: runner(null, null),
      history: {
        push: function (state, params) { history.pushState(state || null, '', toSearch(params)); },
        replace: function (state, params) { history.replaceState(state || null, '', toSearch(params)); },
        setChangeHandler: function (fn) { changeHandler = fn; }
      },
      url: { getLocation: function (cb) { cb(parseQuery()); } }
    }
  };
})();
