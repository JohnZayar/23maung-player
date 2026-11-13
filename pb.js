// 23မောင်း player app — minimal fetch-based PocketBase client (no CDN).
// Backend: https://api.23ledger.com (PocketBase). Collections are m23_*.
// No password, token, or API key is hardcoded here. The auth token lives in
// localStorage (remember-me) or sessionStorage, and is sent as
// `Authorization: Bearer <token>` on every call.
// Classic script: exposes window.PB. Also works under Node (module.exports)
// so the test harness can load it in a vm with a stubbed fetch.
(function () {
  'use strict';

  var BASE_URL = 'https://api.23ledger.com';
  var TOKEN_KEY = 'm23_token';
  var MODEL_KEY = 'm23_player';
  var COLLECTION_KEY = 'm23_auth_collection';

  // In-memory fallback when neither storage exists (e.g. Node vm tests
  // without a localStorage stub).
  var memStore = {};
  function storage(persist) {
    try {
      if (persist === false) {
        if (typeof sessionStorage !== 'undefined') return sessionStorage;
      } else {
        if (typeof localStorage !== 'undefined') return localStorage;
      }
    } catch (e) { /* storage unavailable (private mode, etc.) */ }
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null; },
      setItem: function (k, v) { memStore[k] = String(v); },
      removeItem: function (k) { delete memStore[k]; }
    };
  }

  var persistToken = true; // remember-me default; setPersist(false) -> sessionStorage

  function getToken() { return storage(persistToken).getItem(TOKEN_KEY); }
  function getModel() {
    try { return JSON.parse(storage(persistToken).getItem(MODEL_KEY) || 'null'); } catch (e) { return null; }
  }
  function getAuthCollection() { return storage(persistToken).getItem(COLLECTION_KEY); }

  function saveAuth(collection, token, record) {
    var s = storage(persistToken);
    if (token) s.setItem(TOKEN_KEY, token); else s.removeItem(TOKEN_KEY);
    if (record) s.setItem(MODEL_KEY, JSON.stringify(record)); else s.removeItem(MODEL_KEY);
    if (collection) s.setItem(COLLECTION_KEY, collection);
  }

  function clearAuth() {
    // Clear from both stores so a remember-me change cannot leave a stale token.
    [true, false].forEach(function (p) {
      var s = storage(p);
      s.removeItem(TOKEN_KEY); s.removeItem(MODEL_KEY); s.removeItem(COLLECTION_KEY);
    });
  }

  function url(path) { return BASE_URL + path; }

  function errFrom(status, body) {
    var msg = 'PocketBase error ' + status;
    if (body && body.message) msg = body.message;
    else if (body && body.data) {
      try {
        var first = Object.keys(body.data)[0];
        if (first && body.data[first] && body.data[first].message) msg = body.data[first].message;
      } catch (e) { /* keep generic message */ }
    }
    var err = new Error(msg);
    err.status = status;
    err.body = body;
    return err;
  }

  function isFormData(v) {
    return typeof FormData !== 'undefined' && v instanceof FormData;
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var payload;
    if (body !== undefined && body !== null) {
      if (isFormData(body)) {
        payload = body; // browser sets the multipart boundary itself
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    var res;
    try {
      res = await fetch(url(path), { method: method, headers: headers, body: payload });
    } catch (e) {
      var net = new Error('ကွန်နက်ရှင် မရဘူး — အင်တာနက် စစ်ပါ');
      net.status = 0;
      net.cause = e;
      throw net;
    }
    var data = null;
    var text = '';
    try { text = await res.text(); } catch (e) { /* empty body */ }
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    if (!res.ok) throw errFrom(res.status, data);
    return data;
  }

  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  // --- Auth ---------------------------------------------------------------
  async function authWithPassword(collection, email, password) {
    var data = await request('POST',
      '/api/collections/' + encodeURIComponent(collection) + '/auth-with-password',
      { identity: email, password: password });
    saveAuth(collection, data.token, data.record);
    return data;
  }

  async function authRefresh(collection) {
    var coll = collection || getAuthCollection() || 'm23_players';
    var data = await request('POST',
      '/api/collections/' + encodeURIComponent(coll) + '/auth-refresh', {});
    saveAuth(coll, data.token, data.record);
    return data;
  }

  // --- Records ------------------------------------------------------------
  // opts: { page, perPage, filter, sort, expand, fields }
  async function getList(collection, opts) {
    opts = opts || {};
    var params = {
      page: opts.page || 1,
      perPage: opts.perPage || 200,
      filter: opts.filter || '',
      sort: opts.sort || '',
      expand: opts.expand || '',
      fields: opts.fields || ''
    };
    return request('GET', '/api/collections/' + encodeURIComponent(collection) + '/records' + qs(params));
  }

  // Fetch every page of a list (PocketBase caps perPage at 500).
  async function listAll(collection, opts) {
    opts = opts || {};
    var out = [];
    var page = 1;
    for (;;) {
      var res = await getList(collection, Object.assign({}, opts, { page: page, perPage: opts.perPage || 200 }));
      out = out.concat(res.items || []);
      if (!res.totalPages || page >= res.totalPages) break;
      page++;
    }
    return out;
  }

  async function getOne(collection, id, opts) {
    opts = opts || {};
    var params = { expand: opts.expand || '', fields: opts.fields || '' };
    return request('GET', '/api/collections/' + encodeURIComponent(collection) + '/records/' + encodeURIComponent(id) + qs(params));
  }

  // body: plain object (JSON) or FormData (multipart, for file uploads).
  async function create(collection, body) {
    return request('POST', '/api/collections/' + encodeURIComponent(collection) + '/records', body);
  }

  async function update(collection, id, body) {
    return request('PATCH', '/api/collections/' + encodeURIComponent(collection) + '/records/' + encodeURIComponent(id), body);
  }

  async function remove(collection, id) {
    return request('DELETE', '/api/collections/' + encodeURIComponent(collection) + '/records/' + encodeURIComponent(id));
  }

  // Multipart create for a single file field (e.g. top-up screenshot).
  // fields: plain object; fileField/file: the File/Blob to attach.
  async function createWithFile(collection, fields, fileField, file) {
    var fd = new FormData();
    Object.keys(fields || {}).forEach(function (k) {
      var v = fields[k];
      if (v === undefined || v === null) return;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    if (file) fd.append(fileField, file);
    return create(collection, fd);
  }

  var PB = {
    BASE_URL: BASE_URL,
    setPersist: function (persist) { persistToken = !!persist; },
    isLoggedIn: function () { return !!getToken(); },
    getToken: getToken,
    getModel: getModel,
    getAuthCollection: getAuthCollection,
    clearAuth: clearAuth,
    authWithPassword: authWithPassword,
    authRefresh: authRefresh,
    getList: getList,
    listAll: listAll,
    getOne: getOne,
    create: create,
    update: update,
    remove: remove,
    createWithFile: createWithFile
  };

  if (typeof window !== 'undefined') window.PB = PB;
  if (typeof module !== 'undefined' && module.exports) module.exports = PB;
})();
