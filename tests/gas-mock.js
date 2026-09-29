/**
 * gas-mock.js
 * A small, faithful-enough emulation of the Google Apps Script services used by
 * the hub (SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities,
 * Session, HtmlService, ScriptApp, Logger). It lets the REAL .gs source files run
 * unchanged in Node for automated testing.
 *
 * Deliberate fidelity points:
 *  - setValues() of a string starting with "=" becomes a FORMULA (counted in
 *    mock.stats.formulas) unless prefixed with "'" — mirrors Sheets behaviour.
 *  - CacheService enforces the 100 KB value limit, 250-char keys and 6 h TTL.
 *  - Functions whose names end with "_" cannot be called through the RPC shim.
 *  - Every spreadsheet API call is counted so tests can assert on efficiency.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function toSigned(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }
function toBuf(v) {
  if (Array.isArray(v)) return Buffer.from(v.map((b) => (b < 0 ? b + 256 : b)));
  return Buffer.from(String(v), 'utf8');
}

function createMock(opts = {}) {
  const stats = { calls: 0, reads: 0, writes: 0, formulas: 0, sleeps: 0 };
  const logs = [];
  let now = () => Date.now();

  // ------------------------------------------------------------------ Sheets
  class Range {
    constructor(sheet, row, col, nr, nc) {
      if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`Invalid range ${row},${col},${nr},${nc}`);
      Object.assign(this, { sheet, row, col, nr, nc });
    }
    getValues() {
      stats.calls++; stats.reads++;
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const src = this.sheet.data[this.row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < this.nc; c++) {
          const v = src[this.col - 1 + c];
          line.push(v === undefined || v === null ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    setValues(values) {
      stats.calls++; stats.writes++;
      if (!Array.isArray(values) || values.length !== this.nr) throw new Error(`setValues: expected ${this.nr} rows, got ${values.length}`);
      values.forEach((line, r) => {
        if (line.length !== this.nc) throw new Error(`setValues: expected ${this.nc} columns, got ${line.length}`);
        const target = this.sheet.row(this.row + r);
        line.forEach((v, c) => { target[this.col - 1 + c] = this.sheet.store(v); });
      });
      return this;
    }
    setNumberFormat() { stats.calls++; return this; }
    setFontWeight() { stats.calls++; return this; }
    setBackground() { stats.calls++; return this; }
    setDataValidation() { stats.calls++; return this; }
  }

  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
    row(n) { while (this.data.length < n) this.data.push([]); return this.data[n - 1]; }
    store(v) {
      if (typeof v === 'string') {
        if (/^'/.test(v)) return v.slice(1); // leading apostrophe forces text
        if (/^[=]/.test(v)) { stats.formulas++; return '#FORMULA(' + v + ')'; }
        if (/^[+\-@]/.test(v) && /^[+\-@][A-Za-z(]/.test(v)) { stats.formulas++; return '#FORMULA(' + v + ')'; }
      }
      if (v instanceof Date) return new Date(v.getTime());
      return v;
    }
    isEmptyRow(line) { return !line || line.every((v) => v === '' || v === null || v === undefined); }
    getName() { return this.name; }
    _lastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) if (!this.isEmptyRow(this.data[i])) return i + 1;
      return 0;
    }
    _lastCol() {
      let m = 0;
      this.data.forEach((line) => { for (let i = line.length - 1; i >= 0; i--) if (line[i] !== '' && line[i] !== undefined && line[i] !== null) { m = Math.max(m, i + 1); break; } });
      return m;
    }
    getLastRow() { stats.calls++; return this._lastRow(); }
    getLastColumn() { stats.calls++; return this._lastCol(); }
    getMaxRows() { return Math.max(this.maxRows, this.data.length); }
    getDataRange() { return new Range(this, 1, 1, Math.max(this._lastRow(), 1), Math.max(this._lastCol(), 1)); }
    getRange(row, col, nr = 1, nc = 1) { return new Range(this, row, col, nr, nc); }
    appendRow(values) {
      stats.calls++; stats.writes++;
      const r = this._lastRow() + 1;
      const target = this.row(r);
      values.forEach((v, c) => { target[c] = this.store(v); });
      return this;
    }
    deleteRow(r) { return this.deleteRows(r, 1); }
    deleteRows(r, n) { stats.calls++; stats.writes++; this.data.splice(r - 1, n); return this; }
    setFrozenRows() { stats.calls++; return this; }
    setTabColor() { return this; }
    clear() { this.data = []; }
  }

  class Spreadsheet {
    constructor(name, id) { this.name = name; this.id = id; this.sheets = [new Sheet('Sheet1')]; }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
    getSheetByName(n) { stats.calls++; return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) { stats.calls++; const s = new Sheet(n); this.sheets.push(s); return s; }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
    setSpreadsheetTimeZone() {}
  }

  const spreadsheets = {};
  let failOpen = false;
  const SpreadsheetApp = {
    openById(id) { stats.calls++; if (failOpen || !spreadsheets[id]) throw new Error('Spreadsheet not found'); return spreadsheets[id]; },
    getActiveSpreadsheet() { return opts.bound ? (spreadsheets.bound || (spreadsheets.bound = new Spreadsheet('Bound', 'bound'))) : null; },
    create(name) { const id = 'ss_' + crypto.randomBytes(6).toString('hex'); spreadsheets[id] = new Spreadsheet(name, id); return spreadsheets[id]; },
    flush() {},
    newDataValidation() {
      const b = { requireValueInList() { return b; }, setAllowInvalid() { return b; }, build() { return {}; } };
      return b;
    }
  };

  // ------------------------------------------------------------------ Cache
  const cacheStore = new Map();
  function cacheCheck(k, v) {
    if (String(k).length > 250) throw new Error('Cache key too long');
    if (v !== undefined && Buffer.byteLength(String(v), 'utf8') > 100 * 1024) throw new Error('Argument too large: value');
  }
  const scriptCache = {
    get(k) { const e = cacheStore.get(k); if (!e) return null; if (e.exp < now()) { cacheStore.delete(k); return null; } return e.v; },
    put(k, v, ttl = 600) { cacheCheck(k, v); cacheStore.set(k, { v: String(v), exp: now() + Math.min(ttl, 21600) * 1000 }); },
    getAll(keys) { const o = {}; keys.forEach((k) => { const v = scriptCache.get(k); if (v !== null) o[k] = v; }); return o; },
    putAll(map, ttl) { Object.keys(map).forEach((k) => scriptCache.put(k, map[k], ttl)); },
    remove(k) { cacheStore.delete(k); },
    removeAll(keys) { keys.forEach((k) => cacheStore.delete(k)); }
  };
  const CacheService = { getScriptCache: () => scriptCache };

  // ------------------------------------------------------------------ Lock
  const lockState = { held: false, externallyHeld: false, acquisitions: 0 };
  const LockService = {
    getScriptLock() {
      return {
        tryLock() { if (lockState.held || lockState.externallyHeld) return false; lockState.held = true; lockState.acquisitions++; return true; },
        waitLock(ms) { if (!this.tryLock(ms)) throw new Error('Lock timeout'); },
        releaseLock() { lockState.held = false; },
        hasLock() { return lockState.held; }
      };
    }
  };

  // ------------------------------------------------------------------ Properties
  const props = {};
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      };
    }
  };

  // ------------------------------------------------------------------ Utilities
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5', SHA_1: 'sha1' },
    Charset: { UTF_8: 'utf8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest(alg, value) { return toSigned(crypto.createHash(alg).update(toBuf(value)).digest()); },
    computeHmacSha256Signature(value, key) { return toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()); },
    newBlob(s) { return { getBytes: () => toSigned(Buffer.from(String(s), 'utf8')), getDataAsString: () => String(s) }; },
    sleep() { stats.sleeps++; },
    formatDate: (d) => new Date(d).toISOString()
  };

  // ------------------------------------------------------------------ Session / Script
  const session = { active: opts.activeUser || '', effective: opts.effectiveUser || 'owner@example.com' };
  const Session = {
    getActiveUser: () => ({ getEmail: () => session.active }),
    getEffectiveUser: () => ({ getEmail: () => session.effective })
  };
  const ScriptApp = { getService: () => ({ getUrl: () => opts.url || 'https://script.google.com/macros/s/TESTDEPLOYMENT/exec' }) };
  const Logger = { log: (m) => { logs.push(String(m)); } };
  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(text) {
      const o = { text: String(text), mime: 'text/plain', getContent: () => o.text, getMimeType: () => o.mime,
        setMimeType: (m) => { o.mime = m; return o; } };
      return o;
    }
  };

  // ------------------------------------------------------------------ HtmlService
  const srcDir = opts.srcDir || path.join(__dirname, '..', 'src');
  function readHtml(name) { return fs.readFileSync(path.join(srcDir, name + '.html'), 'utf8'); }
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function compileTemplate(src) {
    let code = 'var __o = "";\n';
    const re = /<\?(!?=)?([\s\S]*?)\?>/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
      code += '__o += ' + JSON.stringify(src.slice(last, m.index)) + ';\n';
      const expr = m[2].trim().replace(/;\s*$/, '');
      if (m[1] === '=') code += '__o += __esc(' + expr + ');\n';
      else if (m[1] === '!=') code += '__o += (' + expr + ');\n';
      else code += m[2] + '\n';
      last = re.lastIndex;
    }
    code += '__o += ' + JSON.stringify(src.slice(last)) + ';\nreturn __o;';
    return code;
  }
  function htmlOutput(content) {
    const out = {
      content, title: '', meta: {}, xfo: null,
      getContent: () => out.content,
      setTitle: (t) => { out.title = t; return out; },
      addMetaTag: (k, v) => { out.meta[k] = v; return out; },
      setXFrameOptionsMode: (m) => { out.xfo = m; return out; },
      setFaviconUrl: () => out
    };
    return out;
  }
  let context; // assigned below
  const HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile: (name) => htmlOutput(readHtml(name)),
    createHtmlOutput: (s) => htmlOutput(String(s || '')),
    createTemplateFromFile(name) {
      const tpl = {};
      tpl.evaluate = function () {
        const body = compileTemplate(readHtml(name));
        const vars = Object.keys(tpl).filter((k) => k !== 'evaluate');
        const fn = vm.runInContext('(function(__esc,' + vars.join(',') + '){' + body + '})', context);
        return htmlOutput(fn(escapeHtml, ...vars.map((k) => tpl[k])));
      };
      return tpl;
    }
  };

  // ------------------------------------------------------------------ Context
  const sandbox = {
    SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities, Session,
    ScriptApp, Logger, HtmlService, ContentService, console, JSON, Math, Date
  };
  context = vm.createContext(sandbox);
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.gs')).sort();
  const source = files.map((f) => '// ---- ' + f + '\n' + fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n\n');
  vm.runInContext(source, context, { filename: 'apps-script-bundle.js' });

  /** Mimics google.script.run: only public functions, JSON-serialisable args/results. */
  function run(fnName, ...args) {
    if (typeof fnName !== 'string' || /_$/.test(fnName) || typeof context[fnName] !== 'function') {
      throw new Error('Script function not found: ' + fnName);
    }
    vm.runInContext('DB_SS_ = null; DB_MEMO_ = {}; DB_DELTA_ = null; DB_LOCK_DEPTH_ = 0; SETTINGS_MEMO_ = null; DB_LOG_HEADER_ = null; API_CLIENT_ = null;', context);
    const safeArgs = JSON.parse(JSON.stringify(args));
    const result = context[fnName](...safeArgs);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  }

  return {
    context, run, stats, logs, props, lockState, session, cacheStore, spreadsheets,
    setNow(fn) { now = fn; },
    setFailOpen(v) { failOpen = v; },
    get ss() { return spreadsheets[props.SPREADSHEET_ID]; },
    sheet(name) { return spreadsheets[props.SPREADSHEET_ID].getSheetByName(name); },
    resetStats() { Object.keys(stats).forEach((k) => { stats[k] = 0; }); },
    /** Simulates a brand-new server execution (globals persist in Node, not in GAS). */
    newExecution() {
      vm.runInContext('DB_SS_ = null; DB_MEMO_ = {}; DB_DELTA_ = null; DB_LOCK_DEPTH_ = 0; SETTINGS_MEMO_ = null; DB_LOG_HEADER_ = null; API_CLIENT_ = null;', context);
    },
    /** Simulates an HTTP POST to the web app (doPost) and returns the parsed JSON body. */
    post(body) {
      this.newExecution();
      const out = context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'application/json' }, parameter: {} });
      return { mime: out.getMimeType(), json: JSON.parse(out.getContent()) };
    }
  };
}

module.exports = { createMock };
