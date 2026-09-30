/**
 * dev-server.js — runs the REAL Apps Script code locally on top of gas-mock.js.
 *   node tests/dev-server.js [port]
 * Serves doGet() output and emulates google.script.run / google.script.history.
 * Prints the temporary owner password created by setup().
 */
'use strict';
const http = require('http');
const { createMock } = require('./gas-mock');

function createDevApp(opts = {}) {
  const m = createMock({ activeUser: 'owner@example.com', effectiveUser: 'owner@example.com' });
  m.context.setup();
  const pwLine = m.logs.find((l) => /Temporary password:/.test(l)) || '';
  const tempPassword = pwLine.split('Temporary password:')[1].trim();
  if (opts.seed !== false) m.context.seedInitialData();
  m.session.active = ''; // after setup, behave like an anonymous web visitor
  const latency = opts.latency || 0;

  const SHIM = `<script>
  (function(){
    function qs(o){return Object.keys(o||{}).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(o[k]);}).join('&');}
    function parse(){var o={};location.search.replace(/^\\?/,'').split('&').filter(Boolean).forEach(function(p){var a=p.split('=');o[decodeURIComponent(a[0])]=decodeURIComponent(a[1]||'');});return o;}
    function runner(s,f){return new Proxy({},{get:function(_,prop){
      if(prop==='withSuccessHandler')return function(h){return runner(h,f);};
      if(prop==='withFailureHandler')return function(h){return runner(s,h);};
      if(prop==='withUserObject')return function(){return runner(s,f);};
      return function(){var args=Array.prototype.slice.call(arguments);
        window.__rpcCount=(window.__rpcCount||0)+1;
        fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fn:prop,args:args})})
          .then(function(r){return r.json();}).then(function(j){ if(j.error){f&&f(new Error(j.error));} else {s&&s(j.result);} })
          .catch(function(e){f&&f(e);});};
    }});}
    var handler=null;
    window.google={script:{run:runner(null,null),
      history:{push:function(st,p){history.pushState(st,'','?'+qs(p));},replace:function(st,p){history.replaceState(st,'','?'+qs(p));},
        setChangeHandler:function(fn){handler=fn;}},
      url:{getLocation:function(cb){cb({parameter:parse(),hash:location.hash.slice(1)});}}}};
    window.addEventListener('popstate',function(e){if(handler)handler({state:e.state,location:{parameter:parse()}});});
  })();
  </script>`;

  const echoes = new Map();
  // Fault injection for tests: the next N requests of each kind never get an answer
  // (the script still runs, like the stalls seen on Google's front end).
  const faults = { stallPost: 0, stallEcho: 0, posts: 0 };
  if (opts.proxySecret) m.props.PROXY_SHARED_SECRET = opts.proxySecret;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let out;
        try {
          const { fn, args } = JSON.parse(body);
          out = { result: m.run(fn, ...(args || [])) };
        } catch (e) {
          out = { error: String(e.message || e) };
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out === undefined ? {} : out));
        }, latency);
      });
      return;
    }
    // ---- Emulation of the Apps Script web app HTTP API (doPost) including Google's
    //      documented redirect to a one-time script.googleusercontent.com URL.
    if (req.method === 'POST' && url.pathname === '/exec') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        faults.posts++;
        m.newExecution();
        let content;
        try {
          const out = m.context.doPost({ postData: { contents: body, type: req.headers['content-type'] || '' }, parameter: {} });
          content = out.getContent();
        } catch (e) {
          content = '<html><body>Script error</body></html>';
        }
        const key = require('crypto').randomBytes(12).toString('hex');
        echoes.set(key, content);
        if (faults.stallPost > 0) { faults.stallPost--; return; }
        setTimeout(() => {
          res.writeHead(302, { Location: 'http://localhost:' + (req.socket.localPort) + '/echo?user_content_key=' + key });
          res.end();
        }, latency);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/echo') {
      const key = url.searchParams.get('user_content_key');
      if (faults.stallEcho > 0) { faults.stallEcho--; return; }
      const content = echoes.get(key);
      echoes.delete(key); // one-time URL, like Google's
      if (content === undefined) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(content);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/exec')) {
      const parameter = {};
      url.searchParams.forEach((v, k) => { parameter[k] = v; });
      m.newExecution();
      const out = m.context.doGet({ parameter });
      let content = out.getContent();
      const meta = Object.keys(out.meta).map((k) => `<meta name="${k}" content="${out.meta[k]}">`).join('');
      content = content.replace('<head>', '<head>' + meta + '<title>' + out.title + '</title>' + SHIM);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return { m, server, tempPassword, faults };
}

if (require.main === module) {
  const port = parseInt(process.argv[2] || '8787', 10);
  const app = createDevApp({ latency: 120, proxySecret: process.env.GAS_PROXY_SECRET || 'local-development-secret-0123456789abcdef0123456789' });
  app.server.listen(port, () => {
    console.log('Dev server on http://localhost:' + port);
    console.log('Owner login: owner@example.com / ' + app.tempPassword);
  });
}
module.exports = { createDevApp };
