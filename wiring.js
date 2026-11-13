// 23မောင်း player app — wiring layer.
//
// The v3.83 mockup (index.html, inline <script>) keeps its UI, layout and
// behaviour. This file, loaded AFTER it, replaces the mockup's stub data and
// stub actions with real PocketBase calls (see 23maung-schema.md).
//
// Rules honoured here (settled — do not re-decide):
// - Login on m23_players; balance is re-read from m23_players after every
//   bet/request. The frontend never trusts a local balance.
// - Sessions from m23_sessions (Admin-set open flag). 3D line = date only.
// - Limits/blocked from m23_settings (limit_2d/limit_3d/limit_fb,
//   blocked_2d/blocked_3d). Limit numbers are NEVER displayed. Blocked =
//   red, identical to over-limit red (no dark, no strikethrough, no label).
// - betAlready = the player's own bets in the current session.
// - Fixtures/odds from m23_fixtures + m23_odds; the stored Myanmar strings
//   (hcp, goal_line, over) are displayed exactly; body odds are NEVER
//   mirrored (only the goal-total under is mirrorOdds(over)).
// - Football auto-close: kickoff_utc - 5 min, computed in this app.
// - Bet placement order: create bet -> create m23_wallet_tx (negative) ->
//   update m23_players.balance. Any failure -> error toast, NO success
//   voucher. Wins are NEVER credited locally (settlement does that);
//   creditBallWins() is neutralised.
// - Vouchers = the player's bet records (2D/3D/1D tabs, never mixed);
//   NO.N = voucher_no. Money record = m23_wallet_tx rows, newest first.
// - Top-up/withdraw = m23_requests rows (screenshot upload for top-up).
//   No local wallet credit.
// - Password change = PocketBase auth password update on m23_players.
// - Notices = m23_notices (broadcasts + own). read_by is NOT updated:
//   the schema locks m23_notices updates for players, so this is display-only.
//
// If PocketBase is unreachable or a collection does not exist yet, the
// affected dataset keeps the mockup's sample data (display fallback) and
// the action that needs the server fails with a toast instead of a fake
// success. Collections do NOT exist yet (parent creates them) — see WIRING.md.
(function () {
  'use strict';

  if (typeof PB === 'undefined') {
    if (typeof console !== 'undefined') console.warn('[23maung] pb.js not loaded — PocketBase wiring disabled.');
    return;
  }

  var M23 = {
    player: null,
    settings: null,
    sessions: [],
    session2d: null,
    session3d: null,
    fixtures: [],       // scheduled fixtures (mapped MATCHES shape + ids)
    finished: [],       // finished fixtures (for results)
    oddsByFixture: {},
    bets2d: [],
    bets3d: [],
    betsFb: [],
    walletTx: [],
    notices: [],
    requests: [],
    mmByEn: {},
    blocked2d: [],
    blocked3d: [],
    minFb: 500,
    min2d3d: 100,
    limitFb: 8000,
    loaded: false,
    flags: { bets: false, tx: false, fixtures: false, finished: false, notices: false, sessions: false, settings: false },
    meta2d: [],         // parallel to placed['2d']: {voucher_no,status,win_amount,session}
    meta3d: [],
    metaFb: [],         // parallel to placed.fb: {voucher_no,status,payout,profit}
    winBadgeByFixture: {} // fixture id -> '✅ အနိုင် X ကျပ်' (first winning leg of a settled bet)
  };
  window.M23 = M23;

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function pad2(n) { return ('0' + n).slice(-2); }
  function fmtDateOnly(d) {
    if (!d) return '';
    var p = String(d).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(d);
  }
  function fmtDateTimeYangon(iso) {
    try {
      var dt = new Date(iso);
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
      }).formatToParts(dt);
      var g = {};
      parts.forEach(function (p) { g[p.type] = p.value; });
      var h = parseInt(g.hour, 10);
      var ap = (g.dayPeriod || '').toLowerCase();
      return g.year + '-' + g.month + '-' + g.day + ' ' + h + ':' + g.minute + ':' + g.second + ap;
    } catch (e) { return String(iso || ''); }
  }
  function dateTimeFromKickoff(kickoffUtc) {
    // Returns {date:'DD-MM-YY', time:'h:mm AM/PM'} in Asia/Yangon.
    try {
      var dt = new Date(kickoffUtc);
      var d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', day: '2-digit', month: '2-digit', year: '2-digit' }).format(dt);
      var t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Yangon', hour: 'numeric', minute: '2-digit', hour12: true }).format(dt);
      return { date: d.split('/').join('-'), time: t };
    } catch (e) { return { date: '', time: '' }; }
  }
  function reverse2d(n) { return n[1] + n[0]; }

  // Myanmar odds mirror — goal-total under only (mockup's mirrorOdds, verbatim).
  function mirrorOdds(o) {
    if (o.indexOf('+') >= 0) return o.replace('+', '-');
    if (o.indexOf('-') >= 0) return o.replace('-', '+');
    return o;
  }
  M23.mirrorOdds = mirrorOdds;

  // Parlay payout (Pho Nov 12, settled): stake x product(leg factors) x
  // (1 - commission). Full win x2, partial win x(1+pyar/100), partial loss
  // x(1-pyar/100), push x1, full loss = 0. Commission from m23_settings
  // (defaults 15/20/30). Display/settlement formula only — the frontend
  // never credits winnings itself.
  function parlayPayout(stake, legs) {
    var mult = 1;
    for (var i = 0; i < legs.length; i++) {
      var lg = legs[i];
      if (lg.res === 'loss') return 0;
      if (lg.res === 'win') mult *= 2;
      else if (lg.res === 'halfWin') mult *= (1 + lg.pyar / 100);
      else if (lg.res === 'halfLoss') mult *= (1 - lg.pyar / 100);
    }
    var s = M23.settings || {};
    var comm = legs.length <= 3 ? (s.comm_23 != null ? s.comm_23 : 15)
      : (legs.length <= 7 ? (s.comm_47 != null ? s.comm_47 : 20)
      : (s.comm_810 != null ? s.comm_810 : 30));
    return Math.round(stake * mult * (1 - comm / 100));
  }
  M23.parlayPayout = parlayPayout;

  function periodName(period, label) {
    if (period === 'am') return 'မနက်ပိုင်း';
    if (period === 'pm') return 'ညနေပိုင်း';
    if (period === 'round') return 'ပွဲစဉ်';
    if (label) return String(label).replace(/^\d{2}\.\d{2}\.\d{4}\s*/, '');
    return 'မနက်ပိုင်း';
  }

  function isBlocked(game, n) {
    var list = game === '2d' ? M23.blocked2d : M23.blocked3d;
    return list.indexOf(String(n)) !== -1;
  }
  M23.isBlocked = isBlocked;

  function limitFor(game) {
    if (game === '2d') return (typeof LIMIT2D !== 'undefined') ? LIMIT2D : null;
    return (typeof LIMIT3D !== 'undefined') ? LIMIT3D : null;
  }

  // Per-number totals from the player's own bets in one session.
  // 2D lines: {n, amt, rev} — direct amt counts for n, reverse rev for reverse(n).
  // 3D lines: {n, amt}.
  function aggregateBetAlready(bets, sessionId, game) {
    var out = {};
    (bets || []).forEach(function (b) {
      if (sessionId && b.session && b.session !== sessionId) return;
      (b.lines || []).forEach(function (ln) {
        if (game === '2d') {
          if (ln.amt > 0) out[ln.n] = (out[ln.n] || 0) + ln.amt;
          if (ln.rev > 0) { var r = reverse2d(ln.n); out[r] = (out[r] || 0) + ln.rev; }
        } else {
          if (ln.amt > 0) out[ln.n] = (out[ln.n] || 0) + ln.amt;
        }
      });
    });
    return out;
  }
  M23.aggregateBetAlready = aggregateBetAlready;

  function recomputeBetAlready() {
    // Replace the mockup globals with fresh per-session aggregates (the
    // assignment replaces the whole object, so no stale numbers survive).
    if (typeof betAlready2d !== 'undefined') {
      betAlready2d = aggregateBetAlready(M23.bets2d, M23.session2d ? M23.session2d.id : null, '2d');
    }
    if (typeof betAlready3d !== 'undefined') {
      betAlready3d = aggregateBetAlready(M23.bets3d, M23.session3d ? M23.session3d.id : null, '3d');
    }
    if (typeof syncGrid2d === 'function') { try { syncGrid2d(); } catch (e) { /* grid not built yet */ } }
    if (typeof syncGrid3d === 'function') { try { syncGrid3d(); } catch (e) { /* grid not built yet */ } }
  }
  M23.recomputeBetAlready = recomputeBetAlready;

  // ------------------------------------------------------- settings/sessions
  function applySettings() {
    var s = M23.settings;
    if (!s) return;
    if (typeof LIMIT2D !== 'undefined') LIMIT2D = (s.limit_2d != null) ? s.limit_2d : null;
    if (typeof LIMIT3D !== 'undefined') LIMIT3D = (s.limit_3d != null) ? s.limit_3d : null;
    M23.blocked2d = Array.isArray(s.blocked_2d) ? s.blocked_2d.map(String) : [];
    M23.blocked3d = Array.isArray(s.blocked_3d) ? s.blocked_3d.map(String) : [];
    M23.minFb = (s.min_fb != null) ? s.min_fb : 500;
    M23.min2d3d = (s.min_2d3d != null) ? s.min_2d3d : 100;
    M23.limitFb = (s.limit_fb != null) ? s.limit_fb : 8000;
  }
  M23.applySettings = applySettings;

  function pickSessions() {
    function pick(game) {
      var rows = M23.sessions.filter(function (r) { return r.game === game; });
      if (!rows.length) return null;
      rows.sort(function (a, b) {
        var d = String(b.date || '').localeCompare(String(a.date || ''));
        if (d !== 0) return d;
        return (b.open ? 1 : 0) - (a.open ? 1 : 0);
      });
      return rows[0];
    }
    M23.session2d = pick('2d');
    M23.session3d = pick('3d');
  }

  // ---------------------------------------------------------------- fixtures
  function mapFixture(f) {
    var o = M23.oddsByFixture[f.id] || {};
    var dt = (f.date && f.time) ? { date: f.date, time: f.time } : dateTimeFromKickoff(f.kickoff_utc);
    return {
      id: f.id, api_id: f.api_id, league: f.league,
      home: f.home, away: f.away,
      home_mm: f.home_mm || null, away_mm: f.away_mm || null,
      kickoff_utc: f.kickoff_utc, date: dt.date, time: dt.time,
      status: f.status, home_goals: f.home_goals, away_goals: f.away_goals,
      hcpSide: o.hcp_side || 'h', hcp: o.hcp || '=', goalLine: o.goal_line || '',
      over: o.over || '=', ah_line: (o.ah_line != null ? o.ah_line : null),
      gl_line: (o.gl_line != null ? o.gl_line : null)
    };
  }

  function replaceMatches(mapped) {
    if (typeof MATCHES === 'undefined') return;
    MATCHES.length = 0;
    Array.prototype.push.apply(MATCHES, mapped);
    M23.fixtures = mapped;
    M23.mmByEn = {};
    mapped.forEach(function (m) {
      if (m.home_mm) M23.mmByEn[m.home] = m.home_mm;
      if (m.away_mm) M23.mmByEn[m.away] = m.away_mm;
    });
    var mc = document.getElementById('maungCount'); if (mc) mc.textContent = String(mapped.length);
    var bc = document.getElementById('bodyCount'); if (bc) bc.textContent = String(mapped.length);
    if (typeof renderMatches === 'function') {
      try { renderMatches('maungList', 'maung'); renderMatches('bodyList', 'body'); } catch (e) { /* lists not in DOM yet */ }
    }
  }

  async function refreshFixtures() {
    try {
      var fx = await PB.getList('m23_fixtures', { filter: "status='scheduled'", sort: 'kickoff_utc', perPage: 200 });
      var od = await PB.listAll('m23_odds', { perPage: 200 });
      M23.oddsByFixture = {};
      (od || []).forEach(function (r) { M23.oddsByFixture[r.fixture] = r; });
      replaceMatches((fx.items || []).map(mapFixture));
      M23.flags.fixtures = true;
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[23maung] fixtures load failed (kept sample data):', e && e.message);
    }
    try {
      var fin = await PB.getList('m23_fixtures', { filter: "status='finished'", sort: '-kickoff_utc', perPage: 50 });
      M23.finished = (fin.items || []).map(mapFixture);
      M23.flags.finished = true;
      renderResults();
    } catch (e) { /* keep sample results */ }
  }
  M23.refreshFixtures = refreshFixtures;

  // ------------------------------------------------------------- bet mapping
  function linesToBatch2d(lines) {
    var batch = [];
    (lines || []).forEach(function (ln) {
      if (ln.amt > 0) batch.push({ num: ln.n, amt: ln.amt });
      if (ln.rev > 0) batch.push({ num: reverse2d(ln.n), amt: ln.rev });
    });
    return batch;
  }
  function linesToBatch3d(lines) {
    var batch = [];
    (lines || []).forEach(function (ln) { if (ln.amt > 0) batch.push({ num: ln.n, amt: ln.amt }); });
    return batch;
  }

  // Rebuild a voucher label for one stored leg (same wording as toggleOdd).
  function buildFbLabel(leg) {
    var hh = teamMM(leg.home), aa = teamMM(leg.away);
    var side = leg.hcp_side || null;
    var hOdds = '', aOdds = '';
    if (leg.kind === 'body') {
      if (side === 'h') hOdds = ' <span class="ro">' + esc(leg.hcp || '') + '</span>';
      else if (side === 'a') aOdds = ' <span class="ro">' + esc(leg.hcp || '') + '</span>';
      else if (leg.pick === 'h') hOdds = ' <span class="ro">' + esc(leg.hcp || '') + '</span>';
      else aOdds = ' <span class="ro">' + esc(leg.hcp || '') + '</span>';
      if (leg.pick === 'h') return '<span class="pk">' + hh + '</span>' + hOdds + ' VS ' + aa + aOdds;
      return hh + hOdds + ' VS ' + '<span class="pk">' + aa + '</span>' + aOdds;
    }
    if (leg.pick === 'over') return hh + ' VS ' + aa + ' · <span class="pk">ဂိုးပေါ် <span class="ro">' + esc(leg.over || '') + '</span></span>';
    return hh + ' VS ' + aa + ' · <span class="pk">ဂိုးအောက် <span class="ro">' + esc(mirrorOdds(leg.over || '')) + '</span></span>';
  }
  M23.buildFbLabel = buildFbLabel;

  function rebuildPlaced() {
    if (typeof placed === 'undefined') return;
    var b2 = M23.bets2d.slice().sort(function (a, b) { return (a.voucher_no || 0) - (b.voucher_no || 0); });
    var b3 = M23.bets3d.slice().sort(function (a, b) { return (a.voucher_no || 0) - (b.voucher_no || 0); });
    var bf = M23.betsFb.slice().sort(function (a, b) { return (a.voucher_no || 0) - (b.voucher_no || 0); });
    placed['2d'] = b2.map(function (r) { return linesToBatch2d(r.lines); });
    placed['3d'] = b3.map(function (r) { return linesToBatch3d(r.lines); });
    placed.fb = bf.map(function (r) {
      var legs = r.legs || [];
      if (r.type === 'body') {
        return { kind: 'ဘော်ဒီ', picks: legs.map(function (lg) { return { label: buildFbLabel(lg), amt: lg.stake || 0 }; }), amt: r.stake || 0 };
      }
      return { kind: 'မောင်း', picks: legs.map(function (lg) { return buildFbLabel(lg); }), amt: r.stake || 0 };
    });
    M23.meta2d = b2.map(function (r) { return { voucher_no: r.voucher_no, status: r.status, win_amount: r.win_amount || 0, session: r.session }; });
    M23.meta3d = b3.map(function (r) { return { voucher_no: r.voucher_no, status: r.status, win_amount: r.win_amount || 0, session: r.session }; });
    M23.metaFb = bf.map(function (r) {
      return { voucher_no: r.voucher_no, status: r.status, payout: r.payout || 0, profit: (r.profit != null ? r.profit : ((r.payout || 0) - (r.stake || 0))) };
    });
    // Win badges for the results screen: one badge per settled winning bet,
    // attached to its first winning leg's fixture.
    M23.winBadgeByFixture = {};
    bf.forEach(function (r) {
      var profit = (r.profit != null ? r.profit : ((r.payout || 0) - (r.stake || 0)));
      if (!profit || profit <= 0) return;
      var legs = r.legs || [];
      for (var i = 0; i < legs.length; i++) {
        if (legs[i].res === 'win' || legs[i].res === 'halfWin') {
          var fid = legs[i].fixture;
          if (fid && !M23.winBadgeByFixture[fid]) M23.winBadgeByFixture[fid] = '✅ အနိုင် ' + fmt(profit) + ' ကျပ်';
          break;
        }
      }
    });
  }
  M23.rebuildPlaced = rebuildPlaced;

  // -------------------------------------------------------------- data loads
  async function safe(p) {
    try { return await p; } catch (e) { return null; }
  }

  async function refreshData() {
    var me = M23.player;
    if (!me) return;
    var pf = 'player="' + me.id + '"';
    var results = await Promise.all([
      safe(PB.getList('m23_bets_2d', { filter: pf, sort: 'voucher_no', perPage: 200 })),
      safe(PB.getList('m23_bets_3d', { filter: pf, sort: 'voucher_no', perPage: 200 })),
      safe(PB.getList('m23_bets_fb', { filter: pf, sort: 'voucher_no', perPage: 200 })),
      safe(PB.getList('m23_wallet_tx', { filter: pf, sort: '-created', perPage: 200 })),
      safe(PB.getList('m23_notices', { filter: pf + ' || player=null', sort: '-created', perPage: 100 }))
    ]);
    if (results[0]) { M23.bets2d = results[0].items || []; }
    if (results[1]) { M23.bets3d = results[1].items || []; }
    if (results[2]) { M23.betsFb = results[2].items || []; }
    if (results[0] || results[1] || results[2]) M23.flags.bets = true;
    if (results[3]) { M23.walletTx = results[3].items || []; M23.flags.tx = true; }
    if (results[4]) { M23.notices = results[4].items || []; M23.flags.notices = true; }
    rebuildPlaced();
    recomputeBetAlready();
    renderTotals();
    renderBallLog();
    renderResults();
    renderMoneyHist();
    if (M23.flags.notices) renderNotices();
  }
  M23.refreshData = refreshData;

  // Auto-refresh (Pho Nov 13): poll the server so new records (approvals,
  // settlements, odds) appear without a manual refresh. Every 30s, only
  // while the tab is visible; also refreshes once when the tab becomes
  // visible again.
  function startAutoRefresh() {
    if (M23._autoTimer) return;
    M23._autoTimer = setInterval(function () {
      if (!M23.player || document.hidden) return;
      refreshData();
      refreshFixtures();
    }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && M23.player) { refreshData(); refreshFixtures(); }
    });
  }

  async function loadAll() {
    var me = PB.getModel();
    if (!me) return false;
    // Re-read the player record: balance is the server-side source of truth.
    try { me = await PB.getOne('m23_players', me.id); M23.player = me; } catch (e) { M23.player = me; }
    if (typeof balance !== 'undefined') balance = M23.player.balance || 0;
    var s = await safe(PB.getList('m23_settings', { filter: "key='main'", perPage: 1 }));
    if (s && s.items && s.items[0]) { M23.settings = s.items[0]; M23.flags.settings = true; }
    applySettings();
    var sess = await safe(PB.listAll('m23_sessions', { sort: '-date', perPage: 200 }));
    if (sess) { M23.sessions = sess; M23.flags.sessions = true; pickSessions(); }
    applySession();
    await refreshFixtures();
    await refreshData();
    M23.loaded = true;
    updateUserDisplays();
    renderTotals();
    startAutoRefresh();
    return true;
  }
  M23.loadAll = loadAll;

  function updateUserDisplays() {
    var me = M23.player;
    if (!me) return;
    document.querySelectorAll('.uname').forEach(function (el) { el.textContent = me.name || ''; });
    var avs = document.querySelectorAll('.userbar .avatar');
    avs.forEach(function (el) { el.textContent = (me.name || 'U').charAt(0); });
    document.querySelectorAll('.ribbon').forEach(function (el) { el.textContent = me.name || ''; });
    // Profile rows show the name twice (user code + name); keep the code row
    // untouched and update only the name row's <b>.
    var prows = document.querySelectorAll('#scr-user .prow');
    prows.forEach(function (row) {
      var spans = row.querySelectorAll('span');
      if (spans.length && spans[0].textContent.indexOf('အမည်') === 0) {
        var b = row.querySelector('b'); if (b) b.textContent = me.name || '';
      }
    });
  }
  M23.updateUserDisplays = updateUserDisplays;

  // ------------------------------------------------------- placement (shared)
  // Order (schema §Settlement step 1): create bet -> create wallet tx
  // (negative) -> update player balance. Any failure throws; the caller
  // shows an error toast and NO success voucher.
  async function placeBetFlow(opts) {
    var me = M23.player;
    if (!me) throw new Error('အရင် လော့ဂ်အင် ဝင်ပါ');
    var top = await PB.getList(opts.collection, {
      filter: 'player="' + me.id + '"', sort: '-voucher_no', perPage: 1, fields: 'voucher_no'
    });
    var no = ((top.items && top.items[0] && top.items[0].voucher_no) || 0) + 1;
    var body = Object.assign({}, opts.betBody, { voucher_no: no });
    var bet = await PB.create(opts.collection, body);
    var newBalance = (typeof balance === 'number' ? balance : (me.balance || 0)) - opts.total;
    try {
      await PB.create('m23_wallet_tx', {
        player: me.id, kind: opts.kind, amount: -opts.total,
        ref_id: bet.id, note: opts.note || '', balance_after: newBalance
      });
    } catch (e) {
      throw new Error('ဘောက်ချာ ရပြီ၊ ငွေစာရင်း မှတ်လို့ မရဘူး — admin ကို ဆက်သွယ်ပါ');
    }
    try {
      var upd = await PB.update('m23_players', me.id, { balance: newBalance });
      M23.player = upd;
      if (typeof balance !== 'undefined') balance = upd.balance;
    } catch (e) {
      throw new Error('လက်ကျန်ငွေ ပြင်လို့ မရဘူး — admin ကို ဆက်သွယ်ပါ');
    }
    return bet;
  }
  M23.placeBetFlow = placeBetFlow;

  function legFromSelection(idx, type, stake) {
    var m = MATCHES[idx];
    var kind = (type === 'hcp-h' || type === 'hcp-a') ? 'body' : 'goal';
    var pick = type === 'hcp-h' ? 'h' : (type === 'hcp-a' ? 'a' : type);
    return {
      fixture: m.id || ('idx:' + idx), home: m.home, away: m.away,
      kind: kind, pick: pick, hcp: m.hcp, hcp_side: m.hcpSide, over: m.over,
      ah_line: (m.ah_line != null ? m.ah_line : null),
      gl_line: (m.gl_line != null ? m.gl_line : null),
      stake: stake, res: null, pyar: 0
    };
  }
  M23.legFromSelection = legFromSelection;

  // ============================================================ OVERRIDES ===
  // Save the mockup originals where a fallback is still useful.
  var _orig = {};
  ['nowSession', 'applySession', 'isFull2d', 'isFull3d', 'toggleSel', 'toggleSel3d',
   'matchCloseTime', 'creditBallWins', 'doLogin', 'showLogin', 'confirmBet2d',
   'confirmBet3d', 'placeBet2d', 'placeFb', 'confirmBetBody', 'renderTotals',
   'renderBallLog', 'renderResults', 'renderMoneyHist', 'setLogTab',
   'requestTopup', 'requestWithdraw', 'changePw', 'go', 'teamMM'
  ].forEach(function (name) {
    if (typeof window[name] === 'function') _orig[name] = window[name];
  });

  // --- sessions ------------------------------------------------------------
  window.nowSession = function () {
    if (!M23.session2d) return { name: 'မနက်ပိုင်း', open: false };
    return { name: periodName(M23.session2d.period, M23.session2d.label), open: !!M23.session2d.open };
  };

  window.applySession = function () {
    var s = nowSession();
    var hb = document.getElementById('homeBtn2d');
    if (hb) hb.textContent = s.open ? ('ဒီနေ့ ' + s.name) : 'ဒီနေ့ ပိတ်ပြီ';
    var b2 = document.getElementById('badge2d');
    if (b2) { b2.textContent = s.open ? 'ဖွင့်နေတယ်' : 'ပိတ်ပြီ'; b2.className = 'badge ' + (s.open ? 'open' : 'closed'); }
    var bet2 = document.getElementById('bet2d');
    if (bet2) bet2.disabled = !s.open;
    var b3 = document.getElementById('badge3d');
    if (b3) {
      var o3 = M23.session3d ? !!M23.session3d.open : true;
      b3.textContent = o3 ? 'ဖွင့်နေတယ်' : 'ပိတ်ပြီ';
      b3.className = 'badge ' + (o3 ? 'open' : 'closed');
    }
    var l3 = document.getElementById('sess3dLine');
    if (l3 && M23.session3d) l3.textContent = fmtDateOnly(M23.session3d.date);
  };

  // --- limits / blocked (red = at-limit OR blocked, identical) ------------
  window.isFull2d = function (n) {
    if (isBlocked('2d', n)) return true;
    return (typeof LIMIT2D !== 'undefined' && LIMIT2D != null) && (betAlready2d[n] || 0) >= LIMIT2D;
  };
  window.isFull3d = function (n) {
    if (isBlocked('3d', n)) return true;
    return (typeof LIMIT3D !== 'undefined' && LIMIT3D != null) && (betAlready3d[n] || 0) >= LIMIT3D;
  };
  if (_orig.toggleSel) {
    window.toggleSel = function (n) {
      if (isBlocked('2d', n)) { toast('ပိတ်ဂဏန်း ' + n); return; }
      _orig.toggleSel(n);
    };
  }
  if (_orig.toggleSel3d) {
    window.toggleSel3d = function (n) {
      if (isBlocked('3d', n)) { toast('ပိတ်ဂဏန်း ' + n); return; }
      _orig.toggleSel3d(n);
    };
  }

  // --- football auto-close: kickoff_utc - 5 min ---------------------------
  if (_orig.matchCloseTime) {
    window.matchCloseTime = function (m) {
      if (m && m.kickoff_utc) return new Date(new Date(m.kickoff_utc).getTime() - 5 * 60000);
      return _orig.matchCloseTime(m);
    };
  }

  // --- team names: prefer the feed's Burmese names ------------------------
  if (_orig.teamMM) {
    window.teamMM = function (name) {
      if (M23.mmByEn[name]) return M23.mmByEn[name];
      return _orig.teamMM(name);
    };
  }

  // --- NEVER credit wins locally -------------------------------------------
  // Settlement (Admin/feed) credits wins. The mockup's creditBallWins()
  // added settled profits to the local balance on first Ball-tab open —
  // neutralised: display only.
  window.creditBallWins = function () { /* no-op by design (see WIRING.md) */ };

  // --- login ---------------------------------------------------------------
  function showLoginScreen() {
    var box = document.getElementById('phoneBox');
    if (box) box.classList.add('logged-out');
    go('scr-login');
  }
  function showAppHome() {
    var box = document.getElementById('phoneBox');
    if (box) box.classList.remove('logged-out');
    go('scr-home');
  }

  window.doLogin = async function () {
    var accEl = document.getElementById('loginAcc');
    var pwEl = document.getElementById('loginPw');
    var acc = accEl ? accEl.value.trim() : '';
    var pw = pwEl ? pwEl.value : '';
    if (!acc) { toast('Account ထည့်ပါ'); return; }
    if (!pw) { toast('Password ထည့်ပါ'); return; }
    var rem = document.getElementById('loginRem');
    PB.setPersist(!rem || !!rem.checked);
    try {
      var data = await PB.authWithPassword('m23_players', acc, pw);
      if (data.record && data.record.status === 'disabled') {
        PB.clearAuth();
        toast('အကောင့် ပိတ်ထားတယ် — admin ကို ဆက်သွယ်ပါ');
        return;
      }
      M23.player = data.record;
      await loadAll();
      updateUserDisplays();
      showAppHome();
      toast('ကြိုဆိုပါတယ် ' + (data.record.name || acc));
    } catch (e) {
      PB.clearAuth();
      if (e && e.status === 0) toast(e.message || 'ကွန်နက်ရှင် မရဘူး');
      else toast('အကောင့် (သို့) စကားဝှက် မှားနေတယ်');
    }
  };

  window.showLogin = function () {
    PB.clearAuth();
    M23.player = null;
    M23.loaded = false;
    showLoginScreen();
  };

  // --- 2D placement ----------------------------------------------------------
  window.confirmBet2d = async function () {
    if (!M23.session2d || !nowSession().open) { toast('ဒီပွဲ ပိတ်သွားပြီ'); return; }
    var total = 0;
    sel2d.forEach(function (n) { total += amt2dMap[n] || 0; });
    if (!total) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (total > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    var min = M23.min2d3d || 100;
    var badMin = null, blocked = null, over = null;
    sel2d.forEach(function (n) {
      var a = amt2dMap[n] || 0;
      if (a <= 0) return;
      if (a < min && !badMin) badMin = n;
      if (isBlocked('2d', n) && !blocked) blocked = n;
      else if (LIMIT2D != null && (betAlready2d[n] || 0) + a > LIMIT2D && !over) over = n;
    });
    if (badMin) { toast('အနည်းဆုံး ' + fmt(min) + ' ကျပ်'); return; }
    if (blocked) { toast('ပိတ်ဂဏန်း ' + blocked); return; }
    if (over) { toast(over + ' လီမစ်ပြည့်ပြီ — ထိုးမရတော့ဘူး'); return; }
    var lines = [];
    sel2d.forEach(function (n) {
      var a = amt2dMap[n] || 0;
      if (a > 0) lines.push({ n: n, amt: a, rev: 0 });
    });
    if (!lines.length) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    try {
      await placeBetFlow({
        collection: 'm23_bets_2d', kind: 'bet_2d', total: total, note: '2D ထိုး',
        betBody: { player: M23.player.id, session: M23.session2d.id, lines: lines, total: total, status: 'placed' }
      });
      sel2d = [];
      amt2dMap = {};
      inp2d.num = ''; inp2d.amt = ''; inp2d.revAmt = ''; inp2d.r = false; inp2d.active = 'num';
      updatePreview2d();
      await refreshData();
      toast('လုပ်ဆောင်ချက်အောင်မြင်');
      go('scr-2d');
    } catch (e) { toast((e && e.message) || 'ထိုးလို့ မရဘူး'); }
  };

  // Old direct path (bet3/pad are temp-hidden in v3.83, but kept wired).
  window.placeBet2d = async function () {
    if (!M23.session2d || !nowSession().open) { toast('ဒီပွဲ ပိတ်သွားပြီ'); return; }
    if (!sel2d.length) { toast('ဂဏန်း နှိပ်ပါ'); return; }
    var per = parseInt(inp2d.amt, 10) || 0;
    if (!per) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    var revPer = parseInt(inp2d.revAmt, 10) || 0;
    var nonPair = sel2d.filter(function (n) { return n[0] !== n[1]; });
    if (inp2d.r && nonPair.length && !revPer) { toast('အပြန် ငွေ ထည့်ပါ'); return; }
    var total = sel2d.length * per + (inp2d.r ? nonPair.length * revPer : 0);
    if (total > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    var min = M23.min2d3d || 100;
    if (per < min || (inp2d.r && nonPair.length && revPer < min)) { toast('အနည်းဆုံး ' + fmt(min) + ' ကျပ်'); return; }
    var blocked = null, over = null;
    sel2d.forEach(function (n) {
      if (!blocked && isBlocked('2d', n)) blocked = n;
      if (!blocked && inp2d.r && n[0] !== n[1] && isBlocked('2d', reverse2d(n))) blocked = reverse2d(n);
      if (!over && LIMIT2D != null && (betAlready2d[n] || 0) + per > LIMIT2D) over = n;
      if (!over && inp2d.r && n[0] !== n[1] && LIMIT2D != null && (betAlready2d[reverse2d(n)] || 0) + revPer > LIMIT2D) over = reverse2d(n);
    });
    if (blocked) { toast('ပိတ်ဂဏန်း ' + blocked); return; }
    if (over) { toast(over + ' လီမစ်ပြည့်ပြီ — ထိုးမရတော့ဘူး'); return; }
    var lines = sel2d.map(function (n) {
      return { n: n, amt: per, rev: (inp2d.r && n[0] !== n[1]) ? revPer : 0 };
    });
    try {
      await placeBetFlow({
        collection: 'm23_bets_2d', kind: 'bet_2d', total: total, note: '2D ထိုး',
        betBody: { player: M23.player.id, session: M23.session2d.id, lines: lines, total: total, status: 'placed' }
      });
      sel2d = [];
      inp2d.num = ''; inp2d.amt = ''; inp2d.revAmt = ''; inp2d.r = false; inp2d.active = 'num';
      setActive2d('num');
      await refreshData();
      toast('ထိုးပြီးပြီ — ' + fmt(total) + ' ကျပ်');
    } catch (e) { toast((e && e.message) || 'ထိုးလို့ မရဘူး'); }
  };

  // --- 3D placement ----------------------------------------------------------
  window.confirmBet3d = async function () {
    if (!M23.session3d || !M23.session3d.open) { toast('ဒီပွဲ ပိတ်သွားပြီ'); return; }
    var total = 0;
    sel3d.forEach(function (n) { total += amt3dMap[n] || 0; });
    if (!total) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (total > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    var min = M23.min2d3d || 100;
    var badMin = null, blocked = null, over = null;
    sel3d.forEach(function (n) {
      var a = amt3dMap[n] || 0;
      if (a <= 0) return;
      if (a < min && !badMin) badMin = n;
      if (isBlocked('3d', n) && !blocked) blocked = n;
      else if (LIMIT3D != null && (betAlready3d[n] || 0) + a > LIMIT3D && !over) over = n;
    });
    if (badMin) { toast('အနည်းဆုံး ' + fmt(min) + ' ကျပ်'); return; }
    if (blocked) { toast('ပိတ်ဂဏန်း ' + blocked); return; }
    if (over) { toast(over + ' လီမစ်ပြည့်ပြီ — ထိုးမရတော့ဘူး'); return; }
    var lines = [];
    sel3d.forEach(function (n) {
      var a = amt3dMap[n] || 0;
      if (a > 0) lines.push({ n: n, amt: a });
    });
    if (!lines.length) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    try {
      await placeBetFlow({
        collection: 'm23_bets_3d', kind: 'bet_3d', total: total, note: '3D ထိုး',
        betBody: { player: M23.player.id, session: M23.session3d.id, lines: lines, total: total, status: 'placed' }
      });
      sel3d = [];
      amt3dMap = {};
      rOn3d = false;
      updateSelCount3d();
      syncGrid3d();
      await refreshData();
      toast('လုပ်ဆောင်ချက်အောင်မြင်');
      go('scr-3d');
    } catch (e) { toast((e && e.message) || 'ထိုးလို့ မရဘူး'); }
  };

  // --- football: parlay ------------------------------------------------------
  window.placeFb = async function (kind) {
    var sel = fbSel.maung;
    var keys = Object.keys(sel);
    var amtInput = document.getElementById('fbAmt');
    var v = parseInt(amtInput ? amtInput.value : '', 10);
    if (!keys.length) { toast('ကြေး အရင် ရွေးပါ'); return; }
    if (!v || v <= 0) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (v < (M23.minFb || 500)) { toast('ဘောပွဲ ၅၀၀ အောက် လောင်းမရ'); return; }
    if (v > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    if (keys.length < 2) { toast('မောင်း အနည်းဆုံး ၂ ပွဲ ရွေးပါ'); return; }
    var maxLegs = (M23.settings && M23.settings.max_legs) || 10;
    if (keys.length > maxLegs) { toast('မောင်း အများဆုံး ၁၀ သင်း ပဲ ထိုးလို့ရတယ်'); return; }
    if (v > (M23.limitFb || 8000)) { toast('လီမစ်ပြည့်ပြီ — ထိုးမရတော့ဘူး'); return; }
    var seenMatch = {};
    var legs = [];
    for (var i = 0; i < keys.length; i++) {
      var parts = keys[i].split(':');
      var idx = +parts[1], type = parts[2];
      if (seenMatch[idx]) { toast('တစ်ပွဲမှာ တစ်ကွက်ပဲ ရွေးလို့ရတယ်'); return; }
      seenMatch[idx] = true;
      var m = MATCHES[idx];
      if (!m) { toast('ပွဲ မတွေ့ဘူး'); return; }
      if (isMatchClosed(m)) { toast('ပိတ်သွားပြီ'); return; }
      legs.push(legFromSelection(idx, type, v));
    }
    try {
      await placeBetFlow({
        collection: 'm23_bets_fb', kind: 'bet_fb', total: v, note: 'မောင်း ထိုး',
        betBody: { player: M23.player.id, type: 'parlay', stake: v, legs: legs, status: 'open' }
      });
      keys.forEach(function (k) { delete sel[k]; });
      document.querySelectorAll('#maungList .odd.on, #maungList .gcell.on').forEach(function (b) { b.classList.remove('on'); });
      document.querySelectorAll('#maungList .mteam.on').forEach(function (r) { r.classList.remove('on'); });
      var chip = document.getElementById('fbSelChip'); if (chip) chip.textContent = '0 မောင်း';
      if (amtInput) amtInput.value = '';
      await refreshData();
      toast('ထိုးပြီးပြီ — ' + (kind || 'မောင်း') + ' ' + keys.length + ' ပွဲ, ' + fmt(v) + ' ကျပ်');
      renderTotals();
    } catch (e) { toast((e && e.message) || 'ထိုးလို့ မရဘူး'); }
  };

  // --- football: body --------------------------------------------------------
  window.confirmBetBody = async function () {
    var keys = Object.keys(amtBodyMap);
    var total = 0;
    keys.forEach(function (k) { total += amtBodyMap[k] || 0; });
    if (!total) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (total > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    var picks = keys.map(function (k) { return { key: k, label: fbSel.body[k], amt: amtBodyMap[k] || 0 }; })
      .filter(function (x) { return x.amt > 0; });
    if (!picks.length) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (picks.some(function (x) { return x.amt < (M23.minFb || 500); })) { toast('ဘောပွဲ ၅၀၀ အောက် လောင်းမရ'); return; }
    // Per-leg limit (schema): each leg's stake vs limit_fb.
    if (picks.some(function (x) { return x.amt > (M23.limitFb || 8000); })) { toast('လီမစ်ပြည့်ပြီ — ထိုးမရတော့ဘူး'); return; }
    var legs = [];
    for (var i = 0; i < picks.length; i++) {
      var parts = picks[i].key.split(':');
      var idx = +parts[1], type = parts[2];
      var m = MATCHES[idx];
      if (!m) { toast('ပွဲ မတွေ့ဘူး'); return; }
      if (isMatchClosed(m)) { toast('ပိတ်သွားပြီ'); return; }
      legs.push(legFromSelection(idx, type, picks[i].amt));
    }
    try {
      await placeBetFlow({
        collection: 'm23_bets_fb', kind: 'bet_fb', total: total, note: 'ဘော်ဒီ ထိုး',
        betBody: { player: M23.player.id, type: 'body', stake: total, legs: legs, status: 'open' }
      });
      keys.forEach(function (k) { delete fbSel.body[k]; });
      document.querySelectorAll('#bodyList .odd.on, #bodyList .gcell.on, #bodyList .mteam.on').forEach(function (b) { b.classList.remove('on'); });
      var chip = document.getElementById('fbBodyChip'); if (chip) chip.textContent = '0 ကွက်';
      amtBodyMap = {};
      await refreshData();
      toast('လုပ်ဆောင်ချက်အောင်မြင်');
      renderTotals();
      go('scr-body');
    } catch (e) { toast((e && e.message) || 'ထိုးလို့ မရဘူး'); }
  };

  // --- vouchers / totals -----------------------------------------------------
  window.renderTotals = function () {
    if (!M23.flags.bets) { if (_orig.renderTotals) _orig.renderTotals(); return; }
    var cur2 = M23.session2d ? M23.session2d.id : null;
    var cur3 = M23.session3d ? M23.session3d.id : null;
    var t2 = 0, t3 = 0;
    M23.bets2d.forEach(function (b) { if (!cur2 || b.session === cur2) t2 += b.total || 0; });
    M23.bets3d.forEach(function (b) { if (!cur3 || b.session === cur3) t3 += b.total || 0; });
    var wTop = document.getElementById('walletTop'); if (wTop) wTop.textContent = fmt(balance);
    document.querySelectorAll('.fb-bal-amt').forEach(function (el) { el.textContent = fmt(balance); });
    var wBig = document.getElementById('walletBig'); if (wBig) wBig.textContent = fmt(balance);
    var wProf = document.getElementById('walletProf'); if (wProf) wProf.textContent = fmt(balance) + ' ကျပ်';
    var tot2 = document.getElementById('tot2d'); if (tot2) tot2.textContent = fmt(t2) + ' ကျပ်';
    var tot3 = document.getElementById('tot3d'); if (tot3) tot3.textContent = fmt(t3) + ' ကျပ်';
    // Hide the mockup's hardcoded sample slips once real records are loaded.
    ['vouchSample2d', 'vouchSample3d', 'vouchSample1d'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    var wrap = document.getElementById('liveVouchWrap');
    var emptyBox = document.getElementById('vouchEmpty');
    var items, metas;
    if (vouchTab === '2d') { items = placed['2d']; metas = M23.meta2d; }
    else if (vouchTab === '3d') { items = placed['3d']; metas = M23.meta3d; }
    else { items = placed.fb; metas = M23.metaFb; }
    if (!items.length) {
      if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
      if (emptyBox) emptyBox.style.display = '';
    } else {
      if (wrap) wrap.style.display = '';
      if (emptyBox) emptyBox.style.display = 'none';
      var out = '';
      if (vouchTab === '1d') {
        out = items.map(function (p, i) {
          var meta = metas[i] || {};
          var rows = '<div class="vno">NO.' + (meta.voucher_no || (i + 1)) + '</div>';
          if (p.kind === 'ဘော်ဒီ') {
            rows += p.picks.map(function (pk) {
              return '<div class="vrow"><span>' + pk.label + '</span><span>' + fmt(pk.amt) + ' ကျပ်</span></div>';
            }).join('');
          } else {
            rows += p.picks.map(function (pk) {
              return '<div class="vrow"><span>' + pk + '</span><span></span></div>';
            }).join('');
            if (p.kind === 'မောင်း') rows += '<div class="vrow" style="font-weight:bold"><span>' + p.picks.length + 'မောင်း</span><span>' + fmt(p.amt) + '</span></div>';
          }
          rows += '<div class="vtot"><span>Total</span><span>' + fmt(p.amt) + ' ကျပ်</span></div>';
          if (meta.profit > 0) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(meta.profit) + ' ကျပ်</b></div>';
          return '<div class="vouch">' + rows + '</div>';
        }).join('');
      } else {
        out = items.map(function (batch, i) {
          var meta = metas[i] || {};
          var t = 0;
          var rows = '<div class="vno">NO.' + (meta.voucher_no || (i + 1)) + '</div>';
          rows += batch.map(function (p) {
            t += p.amt;
            return '<div class="vrow"><span>' + p.num + '</span><span>' + fmt(p.amt) + ' ကျပ်</span></div>';
          }).join('');
          rows += '<div class="vtot"><span>Total</span><span>' + fmt(t) + ' ကျပ်</span></div>';
          if (meta.win_amount > 0) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(meta.win_amount) + ' ကျပ်</b></div>';
          return '<div class="vouch">' + rows + '</div>';
        }).join('');
      }
      if (wrap) wrap.innerHTML = out;
    }
    // 2D / 3D screens' own voucher lists (same records, NO.N from voucher_no).
    var v2 = document.getElementById('vouch2d');
    if (v2) {
      v2.innerHTML = placed['2d'].length ? placed['2d'].map(function (batch, i) {
        var meta = M23.meta2d[i] || {};
        var tb = 0;
        var rows = '<div class="vno">NO.' + (meta.voucher_no || (i + 1)) + '</div>';
        rows += batch.map(function (p) { tb += p.amt; return '<div class="vrow"><span>' + p.num + '</span><span>' + fmt(p.amt) + ' ကျပ်</span></div>'; }).join('');
        rows += '<div class="vtot"><span>Total</span><span>' + fmt(tb) + ' ကျပ်</span></div>';
        if (meta.win_amount > 0) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(meta.win_amount) + ' ကျပ်</b></div>';
        return '<div class="vouch">' + rows + '</div>';
      }).join('') : '';
    }
    var v3 = document.getElementById('vouch3d');
    if (v3) {
      v3.innerHTML = placed['3d'].length ? placed['3d'].map(function (batch, i) {
        var meta = M23.meta3d[i] || {};
        var tb = 0;
        var rows = '<div class="vno">NO.' + (meta.voucher_no || (i + 1)) + '</div>';
        rows += batch.map(function (p) { tb += p.amt; return '<div class="vrow"><span>' + p.num + '</span><span>' + fmt(p.amt) + ' ကျပ်</span></div>'; }).join('');
        rows += '<div class="vtot"><span>Total</span><span>' + fmt(tb) + ' ကျပ်</span></div>';
        if (meta.win_amount > 0) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(meta.win_amount) + ' ကျပ်</b></div>';
        return '<div class="vouch">' + rows + '</div>';
      }).join('') : '';
    }
  };

  // --- results + settled ball log --------------------------------------------
  window.renderResults = function () {
    if (!M23.flags.finished) { if (_orig.renderResults) _orig.renderResults(); return; }
    var box = document.getElementById('resultsList');
    if (!box) return;
    var byLeague = {};
    var order = [];
    M23.finished.forEach(function (m) {
      if (!byLeague[m.league]) { byLeague[m.league] = []; order.push(m.league); }
      byLeague[m.league].push(m);
    });
    var html = '';
    var n = 0;
    order.forEach(function (league) {
      html += '<div class="res-league">' + leagueFlag(league) + ' ' + esc(league) + '</div>';
      byLeague[league].forEach(function (m) {
        n++;
        var hn = n, an = n + 1; n++;
        html += '<div class="res-match"><div class="res-teams"><span class="rn">' + hn + '.</span><span class="tn">' + esc(teamMM(m.home)) + '</span><span class="res-score">' + m.home_goals + ' - ' + m.away_goals + '</span><span class="tn" style="text-align:right">' + esc(teamMM(m.away)) + '</span><span class="rn" style="text-align:right">' + an + '.</span></div>';
        html += '<div class="res-odds"><span class="ro">' + (m.hcpSide === 'h' ? esc(m.hcp) : '') + '</span><span class="gp">Gp' + esc(m.over) + '</span><span class="ro" style="text-align:right">' + (m.hcpSide === 'a' ? esc(m.hcp) : '') + '</span></div>';
        var badge = M23.winBadgeByFixture[m.id];
        if (badge) html += '<div class="res-win">' + esc(badge) + '</div>';
        html += '</div>';
      });
    });
    box.innerHTML = html;
    var title = document.getElementById('resultsTitle');
    if (title && M23.finished.length) {
      var d = fmtDateOnly(M23.finished[0].kickoff_utc);
      title.textContent = 'မနေ့က ပွဲရလဒ် — ' + d;
    }
  };

  window.renderBallLog = function () {
    if (!M23.flags.bets) { if (_orig.renderBallLog) _orig.renderBallLog(); return; }
    var el = document.getElementById('logBall');
    if (!el) return;
    var settled = M23.betsFb.filter(function (b) { return b.status && b.status !== 'open'; })
      .slice().sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
    if (!settled.length) { el.innerHTML = '<div class="hist-row"><span class="muted">ပွဲပြီးတဲ့ ဘောပွဲ ထိုးကြေး မရှိသေးပါ</span></div>'; return; }
    var fixById = {};
    M23.finished.forEach(function (f) { fixById[f.id] = f; });
    M23.fixtures.forEach(function (f) { if (!fixById[f.id]) fixById[f.id] = f; });
    var out = '';
    settled.forEach(function (b) {
      var kind = b.type === 'body' ? 'ဘော်ဒီ' : 'မောင်း';
      var profit = (b.profit != null ? b.profit : ((b.payout || 0) - (b.stake || 0)));
      var won = profit > 0;
      var n = 0;
      var rows = (b.legs || []).map(function (l) {
        var hn = ++n, an = ++n;
        var hh = teamMM(l.home), aa = teamMM(l.away);
        var game = hn + '.' + hh + '(<span class="ro">' + esc(l.hcp || l.over || '') + '</span>) VS ' + an + '.' + aa;
        var f = fixById[l.fixture];
        var score = (f && f.home_goals != null) ? (f.home_goals + ':' + f.away_goals) : '-';
        var sel;
        if (l.kind === 'goal') sel = l.pick === 'over' ? 'ဂိုးပေါ်' : 'ဂိုးအောက်';
        else sel = (l.pick === 'h') ? hn + '.' + hh : an + '.' + aa;
        return '<tr><td>' + game + '</td><td>' + score + '</td><td>' + sel + '</td><td>-</td></tr>';
      }).join('');
      var mark = won ? '✅' : '✖️';
      out += '<div class="ball-time"><span>' + esc(fmtDateTimeYangon(b.created)) + '</span><span>⌃</span></div>'
        + '<table class="ball-tbl"><tr><th>Game<br>' + kind + '</th><th>Result</th><th>Selected</th><th></th></tr>'
        + rows + '</table>'
        + '<div class="ball-tot"><span>Total:</span><span>' + fmt(b.stake || 0) + ' <span class="mk">' + mark + '</span></span></div>';
    });
    el.innerHTML = out;
  };

  // --- money record ------------------------------------------------------------
  var TX_LABEL = {
    topup: 'ငွေသွင်း', withdraw: 'ငွေထုတ်', bet_2d: '2D ထိုး', win_2d: '2D အနိုင်',
    bet_3d: '3D ထိုး', win_3d: '3D အနိုင်', bet_fb: 'ဘောပွဲ ထိုး', win_fb: 'ဘောပွဲ အနိုင်'
  };
  function txRow(t) {
    var label = t.note || TX_LABEL[t.kind] || t.kind;
    var date = fmtDateOnly(t.created);
    var amt = t.amount || 0;
    var sign = amt >= 0 ? '+' : '-';
    var col = amt >= 0 ? '#166534' : '#991b1b';
    return '<div class="hist-row"><span>' + esc(date + ' — ' + label) + '</span><b style="color:' + col + '">' + sign + fmt(Math.abs(amt)) + '</b></div>';
  }
  window.renderMoneyHist = function () {
    if (!M23.flags.tx) return; // keep the mockup's static rows until PB data loads
    var all = M23.walletTx.slice().sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
    var lm = document.getElementById('logMoney');
    if (lm) lm.innerHTML = all.length ? all.map(txRow).join('') : '<div class="hist-row"><span class="muted">ငွေစာရင်း မရှိသေးပါ</span></div>';
    var l2 = document.getElementById('log2d');
    if (l2) {
      var r2 = all.filter(function (t) { return t.kind === 'bet_2d' || t.kind === 'win_2d'; });
      l2.innerHTML = r2.length ? r2.map(txRow).join('') : '<div class="hist-row"><span class="muted">2D ငွေစာရင်း မရှိသေးပါ</span></div>';
    }
    var l3 = document.getElementById('log3d');
    if (l3) {
      var r3 = all.filter(function (t) { return t.kind === 'bet_3d' || t.kind === 'win_3d'; });
      l3.innerHTML = r3.length ? r3.map(txRow).join('') : '<div class="hist-row"><span class="muted">3D ငွေစာရင်း မရှိသေးပါ</span></div>';
    }
    // Keep the mockup's moneyHist array in sync (compat; nothing reads it now).
    if (typeof moneyHist !== 'undefined') {
      moneyHist.length = 0;
      all.forEach(function (t) {
        moneyHist.push({ t: fmtDateOnly(t.created) + ' — ' + (t.note || TX_LABEL[t.kind] || t.kind), amt: Math.abs(t.amount || 0), dir: (t.amount || 0) >= 0 ? 1 : -1 });
      });
    }
  };

  window.setLogTab = function (t) {
    logTab = t;
    document.querySelectorAll('.ltab').forEach(function (b) { b.classList.toggle('on', b.dataset.lt === t); });
    var show = function (id, on) { var el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('logBall', t === 'ball');
    show('log2d', t === '2d');
    show('log3d', t === '3d');
    show('logMoney', t === 'money');
    if (t === 'ball') renderBallLog();
    else renderMoneyHist();
    // NOTE: the mockup called creditBallWins() here. That local credit is
    // removed — wins are credited by settlement only (see WIRING.md).
  };

  // --- notices -----------------------------------------------------------------
  function renderNotices() {
    if (!M23.flags.notices) return; // keep mockup samples until PB data loads
    var card = document.querySelector('#scr-noti .card');
    if (!card) return;
    if (!M23.notices.length) {
      card.innerHTML = '<div class="hist-row"><span class="muted">အသိပေးချက် မရှိပါ။</span></div>';
      return;
    }
    card.innerHTML = M23.notices.map(function (n) {
      return '<div class="hist-row"><span>' + esc(n.title || '') + (n.body ? ' — ' + esc(n.body) : '') + '</span><span class="muted">' + esc(fmtDateOnly(n.created)) + '</span></div>';
    }).join('');
  }
  M23.renderNotices = renderNotices;

  // --- top-up / withdraw --------------------------------------------------------
  window.requestTopup = async function () {
    var amtEl = document.getElementById('topupAmt');
    var v = parseInt(amtEl ? amtEl.value : '', 10);
    if (!v || v <= 0) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    var method = 'KBPay';
    var on = document.querySelector('#payIn .on');
    if (on) method = on.textContent.trim();
    var file = null;
    var shot = document.getElementById('topupShot');
    if (shot && shot.files && shot.files[0]) file = shot.files[0];
    var fields = { player: M23.player ? M23.player.id : '', kind: 'topup', amount: v, method: method, status: 'pending' };
    try {
      if (file) await PB.createWithFile('m23_requests', fields, 'screenshot', file);
      else await PB.create('m23_requests', fields);
      var msg = 'တောင်းဆိုမှု ပို့ပြီးပြီ — ' + fmt(v) + ' ကျပ် (' + method + ') — admin အတည်ပြုရင် လက်ကျန်ထဲ ရောက်မယ်';
      var mEl = document.getElementById('topupMsg'); if (mEl) mEl.textContent = msg;
      if (amtEl) amtEl.value = '';
      if (shot) shot.value = '';
      var sn = document.getElementById('topupShotName'); if (sn) sn.textContent = '';
      toast(msg);
    } catch (e) { toast((e && e.message) || 'တောင်းဆိုမှု ပို့လို့ မရဘူး'); }
  };

  window.requestWithdraw = async function () {
    var v = parseInt((document.getElementById('wdAmt') || {}).value, 10);
    var acc = (document.getElementById('wdAcc') || {}).value || '';
    var phone = (document.getElementById('wdPhone') || {}).value || '';
    var name = (document.getElementById('wdName') || {}).value || '';
    acc = acc.trim(); phone = phone.trim(); name = name.trim();
    if (!v || v <= 0) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (!phone) { toast('ဖုန်းနံပါတ် ထည့်ပါ'); return; }
    if (!name) { toast('အမည် ထည့်ပါ'); return; }
    if (!acc) { toast('လက်ခံမယ့် နံပါတ် ထည့်ပါ'); return; }
    if (v > balance) { toast('လက်ကျန်ငွေ မလောက်ဘူး'); return; }
    try {
      await PB.create('m23_requests', {
        player: M23.player ? M23.player.id : '', kind: 'withdraw', amount: v,
        method: wdBank || 'KBPay', phone: phone, name: name, account: acc, status: 'pending'
      });
      var msg = 'တောင်းဆိုမှု ပို့ပြီးပြီ — ' + fmt(v) + ' ကျပ် (' + (wdBank || 'KBPay') + ', ' + name + ', ' + phone + ', ' + acc + ') — admin အတည်ပြုရင် လွှဲပေးမယ်';
      var mEl = document.getElementById('wdMsg'); if (mEl) mEl.textContent = msg;
      document.getElementById('wdAmt').value = '';
      document.getElementById('wdAcc').value = '';
      document.getElementById('wdPhone').value = '';
      document.getElementById('wdName').value = '';
      toast(msg);
    } catch (e) { toast((e && e.message) || 'တောင်းဆိုမှု ပို့လို့ မရဘူး'); }
  };

  // --- password change -----------------------------------------------------------
  window.changePw = async function () {
    var oldPw = document.getElementById('pwOld').value;
    var nw = document.getElementById('pwNew').value;
    var nw2 = document.getElementById('pwNew2').value;
    var msg = document.getElementById('pwMsg');
    if (!oldPw || !nw || !nw2) { msg.textContent = 'အကွက် အားလုံး ဖြည့်ပါ။'; return; }
    if (nw !== nw2) { msg.textContent = 'စကားဝှက် အသစ် ၂ ခု မတူဘူး။'; return; }
    if (nw === oldPw) { msg.textContent = 'စကားဝှက် အသစ်က အဟောင်းနဲ့ တူတယ်။'; return; }
    if (!M23.player) { msg.textContent = 'အရင် လော့ဂ်အင် ဝင်ပါ။'; return; }
    try {
      await PB.update('m23_players', M23.player.id, { oldPassword: oldPw, password: nw, passwordConfirm: nw2 });
      document.getElementById('pwOld').value = '';
      document.getElementById('pwNew').value = '';
      document.getElementById('pwNew2').value = '';
      msg.textContent = '';
      toast('စကားဝှက် ပြောင်းပြီ');
      go('scr-user');
    } catch (e) {
      msg.textContent = (e && e.message) ? e.message : 'စကားဝှက် ပြောင်းလို့ မရဘူး';
    }
  };

  // --- nav refresh ---------------------------------------------------------------
  if (_orig.go) {
    window.go = function (id) {
      _orig.go(id);
      if (!M23.loaded || !M23.player) return;
      if (id === 'scr-noti') renderNotices();
      else if (id === 'scr-maung' || id === 'scr-body') refreshFixtures();
      else if (id === 'scr-vouch' || id === 'scr-log' || id === 'scr-money' || id === 'scr-results') {
        refreshData().catch(function () { /* keep current view on failure */ });
      }
    };
  }

  // ------------------------------------------------------------------ init
  var inited = false;
  async function initOnce() {
    if (inited) return;
    inited = true;
    if (!PB.isLoggedIn()) { showLoginScreen(); return; }
    try {
      var data = await PB.authRefresh();
      M23.player = data.record;
      await loadAll();
      updateUserDisplays();
      showAppHome();
    } catch (e) {
      PB.clearAuth();
      showLoginScreen();
    }
  }
  M23.initOnce = initOnce;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOnce);
    else initOnce();
  }
})();
