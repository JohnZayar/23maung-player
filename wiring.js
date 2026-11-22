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
// - 2D auto-schedule (Pho Nov 15): Mon-Fri only, am 10:00-close_at (default
//   11:55), pm 14:00-close_at (default 15:55); Sat/Sun closed. Open times
//   are fixed constants, NOT in Settings. The gate lives in
//   nowSession()/is2dOpenNow() and never re-opens a manual Admin close.
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
    requests: [],
    mmByEn: {},
    blocked2d: [],
    blocked3d: [],
    minFb: 500,
    min2d3d: 100,
    limitFb: 8000,
    loaded: false,
    flags: { bets: false, tx: false, fixtures: false, finished: false, sessions: false, settings: false },
    meta2d: [],         // parallel to placed['2d']: {voucher_no,status,win_amount,session,created}
    meta3d: [],
    metaFb: [],         // parallel to placed.fb: {voucher_no,status,payout,profit,created}
    vouchDate: null,    // voucher date picker (Pho Nov 17, Player v2.10): 'YYYY-MM-DD' Yangon; null until set
    vouchDateInit: false, // true once the default date was computed from loaded data
    vouchDateManual: false, // true when the user picked the date by hand (calendar / Today / Yesterday)
    vouchDateManualDay: null, // Yangon date the manual pick was made on (v2.16: a manual pick never carries to a new day)
    vouchCalView: null // calendar popup viewed month {y, m} (m 0-based)
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
  function normalizeKickoff(value) {
    // Accepts a unix-seconds number or an ISO datetime string (PocketBase
    // DateTime), returns unix seconds or null — same as the Admin app.
    if (typeof value === 'number' && isFinite(value)) return Math.floor(value);
    if (typeof value === 'string') {
      var ms = Date.parse(value);
      if (!isNaN(ms)) return Math.floor(ms / 1000);
    }
    return null;
  }
  M23.normalizeKickoff = normalizeKickoff;

  function dateTimeFromKickoff(kickoffUtc) {
    // Returns {date:'DD-MM-YY', time:'h:mm AM/PM'} in Asia/Yangon.
    try {
      var s = normalizeKickoff(kickoffUtc);
      var dt = (s != null) ? new Date(s * 1000) : new Date(kickoffUtc);
      var d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', day: '2-digit', month: '2-digit', year: '2-digit' }).format(dt);
      var t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Yangon', hour: 'numeric', minute: '2-digit', hour12: true }).format(dt);
      return { date: d.split('/').join('-'), time: t };
    } catch (e) { return { date: '', time: '' }; }
  }
  M23.dateTimeFromKickoff = dateTimeFromKickoff;
  function reverse2d(n) { return n[1] + n[0]; }

  // Myanmar odds mirror — goal-total under only (mockup's mirrorOdds, verbatim).
  function mirrorOdds(o) {
    if (o.indexOf('+') >= 0) return o.replace('+', '-');
    if (o.indexOf('-') >= 0) return o.replace('-', '+');
    return o;
  }
  M23.mirrorOdds = mirrorOdds;

  // Parlay payout — balanced table (Pho Nov 17, APPROVED): a little above
  // the outside paper bookie's printed sheet, balanced across every draw
  // cell. Same table as Admin logic.js, ported verbatim. The old formula
  // (legs x2, then 15/20/30% commission) paid far above the sheet at high
  // legs (8 legs: 179.2x vs sheet 100x). The table IS the net return
  // multiplier (stake included); commission no longer applies to parlays.
  // All-win by legs (sheet 4-8: 13/21/32/50/100, +~10%):
  var PARLAY_ALLWIN = { 2: 3.5, 3: 7, 4: 14, 5: 23, 6: 35, 7: 55, 8: 110, 9: 200, 10: 350 };
  // Draw rows, legs 4-8, draws 1-4 (sheet values x1.1, cleaned to .5 steps).
  var PARLAY_DRAWS = {
    4: { 1: 5.5, 2: 2.5, 3: 2, 4: 1 },
    5: { 1: 11, 2: 4.5, 3: 3.5, 4: 1.1 },
    6: { 1: 18, 2: 7, 3: 4.5, 4: 2.5 },
    7: { 1: 33, 2: 13.5, 3: 8, 4: 8 },
    8: { 1: 44, 2: 24.5, 3: 13.5, 4: 9 }
  };
  function parlayTableMult(nLegs, nDraws) {
    var row = PARLAY_DRAWS[nLegs];
    if (row && row[nDraws] !== undefined) return row[nDraws];
    var base = PARLAY_ALLWIN[nLegs];
    if (base === undefined) return 1;
    return Math.max(1, base / Math.pow(2, nDraws));
  }
  M23.parlayTableMult = parlayTableMult;
  // Display/settlement formula only — the frontend never credits winnings
  // itself. Full win contributes x2 (scale 1), partial win x(1+pyar/100),
  // partial loss x(1-pyar/100), push counts as a draw, full loss = 0.
  function parlayPayout(stake, legs) {
    var ls = legs || [];
    if (!ls.length) return 0;
    var draws = 0, scale = 1;
    for (var i = 0; i < ls.length; i++) {
      var lg = ls[i];
      if (lg.res === 'loss') return 0;
      if (lg.res === 'push') { draws++; continue; }
      var f = lg.res === 'win' ? 2 : lg.res === 'halfWin' ? (1 + lg.pyar / 100) : lg.res === 'halfLoss' ? (1 - lg.pyar / 100) : 0;
      scale *= f / 2;
    }
    return Math.round(stake * parlayTableMult(ls.length, draws) * scale);
  }
  M23.parlayPayout = parlayPayout;

  // ------------------------------------------- voucher win/loss marks (Pho
  // Nov 16, Player v2.5; DISPLAY ONLY — this never settles or pays anything).
  // 2D/3D: a line wins when its number equals the session's win_number
  // (set by Admin in the results screen). 1D: a pick wins when the finished
  // fixture settles it as win/halfWin, using the same rule as Admin
  // settleLeg (ported verbatim below; pyarFromLine/evalLine). A voucher
  // shows ✅/❌ only once its result is fully known; before that it renders
  // exactly as before (no mark, no highlight).
  // Pho Nov 22 ("အတိုမဟုတ်ဘူး"): the pyar is the fraction digits AS
  // WRITTEN — 2+5 = 5 pyar, NOT 50. Hundredths, with 50 mapped to 5.
  function pyarFromLine(line) { var p = Math.round((Math.abs(line) % 1) * 100); return p === 50 ? 5 : p; }
  // Pho Nov 17 (CORRECTED — "စျေးဖွင့်တဲ့ မိန်း ၁ဂိုး ၂ဂိုး ကိုတည်ရမှာပြီးမှ
  // ပြားယူ"): the MAIN line (integer part) is the base; the pyar applies
  // ONLY when the result lands exactly ON the main, IN THE LINE'S
  // DIRECTION (line < 0 -> margin == +main; line > 0 -> margin == -main).
  // A result that deviates from the main is a FULL win / FULL loss. The
  // LINE SIGN decides who wins the pyar: line < 0 -> halfWin, line > 0 ->
  // halfLoss — EXCEPT at main 0 (Pho Nov 22): the pyar goes to the
  // RECEIVING side (Villa =75 draws 0:0 -> Villa loses 75, Sunderland
  // wins 75). BODY legs only — goal legs use evalGoalLine below. Ported
  // verbatim from Admin logic.js evalLine; DISPLAY ONLY.
  function evalLine(line, margin) {
    var pyar = pyarFromLine(line);
    var frac = Math.abs(line) % 1;
    var main = Math.trunc(Math.abs(line));
    var adj = margin + line;
    if (frac > 0) {
      var pyarMargin = line < 0 ? main : -main;
      if (margin === pyarMargin) {
        var win = main === 0 ? line > 0 : line < 0;
        return { res: win ? 'halfWin' : 'halfLoss', pyar: pyar };
      }
    }
    return { res: adj > 0 ? 'win' : adj < 0 ? 'loss' : 'push', pyar: pyar };
  }
  // Goal-total evaluation (Pho Nov 17, "3-45" example): "+" goal line ->
  // OVER wins the pyar at the main; "-" goal line ("3 goals, 45 lose") ->
  // OVER loses it, UNDER wins it. At main 0 (Pho Nov 22, same rule as
  // evalLine by analogy): the over needs goals and got none, so the over
  // loses the pyar and the under wins it. Away from the main, total vs
  // |gl_line| decides. Ported verbatim from Admin logic.js evalGoalLine;
  // DISPLAY ONLY.
  function evalGoalLine(glLine, total, pick) {
    var g = Math.abs(glLine);
    var frac = g % 1;
    var main = Math.trunc(g);
    var pyar = pyarFromLine(glLine);
    if (frac > 0 && total === main) {
      var overWinsPyar = main === 0 ? glLine < 0 : glLine > 0;
      var won = pick === 'over' ? overWinsPyar : !overWinsPyar;
      return { res: won ? 'halfWin' : 'halfLoss', pyar: pyar };
    }
    if (total > g) return { res: pick === 'over' ? 'win' : 'loss', pyar: pyar };
    if (total < g) return { res: pick === 'over' ? 'loss' : 'win', pyar: pyar };
    return { res: 'push', pyar: pyar };
  }
  // Evaluate one football leg against the finished fixtures. Returns
  // {res, pyar} when the fixture is finished, else null (undecided).
  function evalFbLeg(leg) {
    var fx = null;
    (M23.finished || []).forEach(function (m) { if (m.id === leg.fixture) fx = m; });
    if (!fx || fx.status !== 'finished') return null;
    var hg = fx.home_goals, ag = fx.away_goals;
    if (hg == null || ag == null) return null;
    if (leg.kind === 'body') {
      var line = leg.ah_line;
      if (line == null) return null;
      if (leg.pick === 'h') return evalLine(line, hg - ag);
      if (leg.pick === 'a') return evalLine(-line, ag - hg);
      return null;
    }
    if (leg.kind === 'goal') {
      var gl = leg.gl_line;
      if (gl == null) return null;
      var total = hg + ag;
      if (leg.pick === 'over') return evalGoalLine(gl, total, 'over');
      if (leg.pick === 'under') return evalGoalLine(gl, total, 'under');
      return null;
    }
    return null;
  }
  // Winning number of a session (Admin saveWins writes win_number to the
  // m23_sessions row); null when the result is not known yet.
  function winNumberForSession(sessionId) {
    var win = null;
    (M23.sessions || []).forEach(function (s) { if (s.id === sessionId) win = s.win_number; });
    return (win === null || win === undefined || String(win) === '') ? null : String(win);
  }
  // Latest session of a game/period by date (same pick as the Admin app's
  // latestSession). Used to show the winning numbers in the စာရင်း view.
  function latestSessionBy(game, period) {
    var rows = (M23.sessions || []).filter(function (r) { return r.game === game && (!period || r.period === period); });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    return rows[0];
  }
  M23.latestSessionBy = latestSessionBy;
  // Winning numbers for the စာရင်း view: '2D မနက် 65 · 2D ညနေ 31 · 3D 654'
  // (only the sessions whose result is known). '' when nothing is decided.
  // winNumsText stays PLAIN text — its exact output is asserted by
  // test-3d-close. winNumsHtml is the same parts with the numbers in green
  // (Pho Nov 19, Player v2.22) for the "ပေါက်ဂဏန်း:" line.
  function winNumsParts() {
    var parts = [];
    var w;
    var am = latestSessionBy('2d', 'am');
    var pm = latestSessionBy('2d', 'pm');
    var r3 = latestSessionBy('3d', 'round');
    if (am && (w = winNumberForSession(am.id))) parts.push(['2D မနက်', w]);
    if (pm && (w = winNumberForSession(pm.id))) parts.push(['2D ညနေ', w]);
    if (r3 && (w = winNumberForSession(r3.id))) parts.push(['3D', w]);
    return parts;
  }
  function winNumsText() {
    return winNumsParts().map(function (p) { return p[0] + ' ' + p[1]; }).join(' · ');
  }
  M23.winNumsText = winNumsText;
  function winNumsHtml() {
    return winNumsParts().map(function (p) { return p[0] + ' <b style="color:#166534">' + p[1] + '</b>'; }).join(' · ');
  }
  M23.winNumsHtml = winNumsHtml;
  // 2D/3D voucher: decided when the session win_number is set; winIdx =
  // indexes of batch lines whose number equals it.
  function evalVoucher2d3d(batch, meta) {
    var win = meta ? winNumberForSession(meta.session) : null;
    if (win === null) return { decided: false, won: false, winIdx: [] };
    var idx = [];
    (batch || []).forEach(function (p, i) { if (String(p.num) === win) idx.push(i); });
    return { decided: true, won: idx.length > 0, winIdx: idx };
  }
  // 1D voucher: decided when every leg's fixture is finished. Body: a leg
  // wins on res win/halfWin. Parlay: wins only as a whole — no leg lost
  // and the parlay payout (same formula as settlement) beats the stake;
  // when it wins, every leg row is highlighted (winIdx = all legs).
  function evalVoucherFb(bet) {
    var legs = (bet && bet.legs) || [];
    if (!legs.length) return { decided: false, won: false, winIdx: [] };
    var evaled = legs.map(function (lg) { return evalFbLeg(lg); });
    for (var i = 0; i < evaled.length; i++) if (!evaled[i]) return { decided: false, won: false, winIdx: [] };
    if (bet.type === 'body') {
      var idx = [];
      evaled.forEach(function (r, i) { if (r.res === 'win' || r.res === 'halfWin') idx.push(i); });
      return { decided: true, won: idx.length > 0, winIdx: idx };
    }
    var withRes = legs.map(function (lg, i) { return { res: evaled[i].res, pyar: evaled[i].pyar }; });
    if (parlayPayout(bet.stake || 0, withRes) > (bet.stake || 0)) {
      return { decided: true, won: true, winIdx: legs.map(function (_, i) { return i; }) };
    }
    return { decided: true, won: false, winIdx: [] };
  }
  M23.evalFbLeg = evalFbLeg;
  M23.evalVoucher2d3d = evalVoucher2d3d;
  M23.evalVoucherFb = evalVoucherFb;
  M23.winNumberForSession = winNumberForSession;
  // ' ✅' / ' ❌' suffix for a voucher Total row; '' while undecided.
  function voucherMark(ev) {
    if (!ev || !ev.decided) return '';
    return ev.won ? ' ✅' : ' ❌';
  }
  M23.voucherMark = voucherMark;
  // Football results slip (Pho Nov 17, Player v2.14; DISPLAY ONLY).
  // The 1D voucher shows the slip layout in both states — when betting
  // and after results; only the +/- (scores/ticks) is missing before
  // results. Per leg: league + kickoff sub-line, the existing
  // buildFbLabel line, and on the right the final score + tick once
  // that leg is decided ('–' while undecided). The whole-voucher ✅/❌
  // in the Total row still waits until every leg is decided (v2.5
  // rule, unchanged).
  function evalFbLegs(bet) {
    var legs = (bet && bet.legs) || [];
    return legs.map(function (lg) { return evalFbLeg(lg); });
  }
  M23.evalFbLegs = evalFbLegs;
  // One leg of the slip: league + kickoff time from the joined fixture,
  // score + tick from the leg's own evaluation. fx may be null (fixture
  // not loaded — the 50-cap window in refreshFixtures) → '–', no tick.
  function fbSlipLeg(leg, fx) {
    var league = (fx && fx.league) || '';
    var kickoffTime = (fx && fx.time) || '';
    var score = '–';
    if (fx && fx.status === 'finished' && fx.home_goals != null && fx.away_goals != null) {
      score = fx.home_goals + ':' + fx.away_goals;
    }
    var tick = '';
    var ev = leg ? evalFbLeg(leg) : null;
    if (ev) {
      if (ev.res === 'win' || ev.res === 'halfWin') tick = '✅';
      else if (ev.res === 'loss' || ev.res === 'halfLoss') tick = '❌';
      else if (ev.res === 'push') tick = '–';
    }
    return { league: league, kickoffTime: kickoffTime, score: score, tick: tick };
  }
  M23.fbSlipLeg = fbSlipLeg;
  // Slip header line (v2.14): time · code · name · leg count · total
  // stake. Skips any part that is unknown; the date stays in the tab
  // top bar. The code is the player's short account name (email
  // prefix, e.g. 23M002); the name is shown only when it differs.
  function fbSlipHeader(p, meta) {
    var parts = [];
    var t = fmtDateTimeYangon(meta && meta.created);
    if (t && t.indexOf(' ') >= 0) t = t.slice(t.indexOf(' ') + 1).replace(/:\d\d([ap]m)$/i, '$1');
    if (t) parts.push('အချိန် ' + t);
    var me = M23.player || {};
    var code = '';
    if (me.email && String(me.email).indexOf('@') >= 0) code = String(me.email).slice(0, String(me.email).indexOf('@'));
    if (!code) code = me.name || '';
    if (code) parts.push('ကုတ် ' + code);
    if (me.name && me.name !== code) parts.push(me.name);
    var n = (p && p.picks) ? p.picks.length : 0;
    parts.push(n + ' ပွဲ');
    parts.push('ငွေပေါင်း ' + fmt((p && p.amt) || 0) + ' ကျပ်');
    return parts.join(' · ');
  }
  M23.fbSlipHeader = fbSlipHeader;
  // One 2D/3D voucher (main tab + the 2D/3D screens' own lists share this).
  // kind is '2d' | '3d': only 2D vouchers get a period line (Pho Nov 17,
  // Player v2.12) — 3D has one round per date, so no period line there.
  // dispNo (Player v2.13) is the per-session display number from
  // voucherDisplayNos; when a caller does not pass one (direct calls in
  // tests), the stored voucher_no is shown as before.
  function voucher2d3dHtml(batch, meta, i, kind, dispNo) {
    var ev = evalVoucher2d3d(batch, meta || {});
    var t = 0;
    var rows = '<div class="vno">NO.' + (dispNo || meta.voucher_no || (i + 1)) + '</div>';
    if (kind === '2d') {
      var per = voucherPeriodOf(meta);
      if (per) rows += '<div class="vper">' + periodName(per) + '</div>';
    }
    rows += batch.map(function (p, j) {
      t += p.amt;
      // v2.22 (Pho Nov 19): the winning NUMBER itself is green + bold — the
      // pale row (vwin, since v2.18) was too faint to spot the hit at a
      // glance. Only the number span is green; the amount stays plain.
      var isWin = ev.winIdx.indexOf(j) >= 0;
      var cls = isWin ? 'vrow vwin' : 'vrow';
      var num = isWin ? '<span style="color:#166534;font-weight:bold">' + p.num + '</span>' : '<span>' + p.num + '</span>';
      return '<div class="' + cls + '">' + num + '<span>' + fmt(p.amt) + ' ကျပ်</span></div>';
    }).join('');
    rows += '<div class="vtot"><span>Total</span><span>' + fmt(t) + ' ကျပ်' + voucherMark(ev) + '</span></div>';
    if (meta.win_amount > 0) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(meta.win_amount) + ' ကျပ်</b></div>';
    return '<div class="vouch">' + rows + '</div>';
  }
  M23.voucher2d3dHtml = voucher2d3dHtml;

  // ------------------------------------------- voucher date picker (Pho
  // Nov 17, Player v2.10; MOUNG556-style calendar popup). The voucher tab
  // shows ALL of the player's vouchers across all days in one list, so a
  // date picker in the top bar filters the current tab to one Yangon date.
  // 2D/3D vouchers resolve their date from their session (M23.sessions);
  // when the session cannot be resolved, the bet's `created` date is used.
  // 1D (football) vouchers use the bet's `created` date. The picker is ONE
  // shared state across the three tabs; the chosen date survives the 30s
  // auto-refresh (only the first data load computes the default).
  var CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function ymdAdd(ymd, days) {
    var p = String(ymd || '').split('-');
    if (p.length !== 3) return ymd;
    var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + days));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  M23.ymdAdd = ymdAdd;
  // Yangon date (YYYY-MM-DD) of one voucher: session date for 2D/3D,
  // bet `created` date for 1D and as the 2D/3D fallback. Null when neither
  // resolves — such vouchers are shown, never hidden by the filter.
  function voucherDateOf(meta, kind) {
    if (!meta) return null;
    if (kind !== '1d' && meta.session) {
      var s = null;
      (M23.sessions || []).forEach(function (r) { if (r.id === meta.session) s = r; });
      if (s) { var d = yangonDateOf(s.date); if (d) return d; }
    }
    return meta.created ? yangonDateOf(meta.created) : null;
  }
  M23.voucherDateOf = voucherDateOf;
  // Period ('am'/'pm') of one 2D voucher's session (Pho Nov 17, Player
  // v2.12): a morning and an evening voucher on the same date are otherwise
  // identical — the period line tells them apart. STRICT, same safety rule
  // as the date: only 'am'/'pm' from the resolved session ever count;
  // anything else (no session, session not found, period not am/pm)
  // returns null and the voucher shows NO period line — never invented,
  // and the voucher is never hidden.
  function voucherPeriodOf(meta) {
    if (!meta || !meta.session) return null;
    var s = null;
    (M23.sessions || []).forEach(function (r) { if (r.id === meta.session) s = r; });
    if (!s) return null;
    if (s.period === 'am' || s.period === 'pm') return s.period;
    return null;
  }
  M23.voucherPeriodOf = voucherPeriodOf;
  // Per-session voucher numbering (Pho Nov 17, Player v2.13): the
  // displayed 'NO.N' restarts at 1 for every session — morning 2D
  // vouchers are NO.1, NO.2…, evening 2D vouchers restart at NO.1,
  // 3D restarts per round, 1D restarts per Yangon day. DISPLAY-ONLY:
  // the stored voucher_no (a global per-player counter assigned in
  // placeBetFlow) is untouched and stays the chronological sort key.
  // Group key: the session id for 2D/3D when the session resolves;
  // otherwise the voucher's date group (same fallback idea as
  // voucherDateOf — a voucher whose session cannot be resolved falls
  // back to its date; 1D always groups by its created Yangon date).
  // A voucher is never hidden and no two vouchers share a number
  // inside one group (positions are 1-based and unique by construction).
  function voucherGroupKey(meta, kind) {
    if (!meta) return 'd:unknown';
    if (kind !== '1d' && meta.session) {
      var found = false;
      (M23.sessions || []).forEach(function (r) { if (r.id === meta.session) found = true; });
      if (found) return 's:' + meta.session;
    }
    var d = voucherDateOf(meta, kind);
    return 'd:' + (d || 'unknown');
  }
  M23.voucherGroupKey = voucherGroupKey;
  // Display numbers for a meta list, aligned with the list order:
  // each voucher's 1-based position inside its own group, ordered by
  // stored voucher_no (then created) so the sequence is chronological
  // even if the list arrives unsorted. The list a caller passes is a
  // date-filtered one, and a whole session shares one date, so every
  // group in the list is complete.
  function voucherDisplayNos(metas, kind) {
    var list = metas || [];
    var order = list.map(function (m, idx) { return idx; });
    order.sort(function (a, b) {
      var na = (list[a] && list[a].voucher_no) || 0;
      var nb = (list[b] && list[b].voucher_no) || 0;
      if (na !== nb) return na - nb;
      var ca = (list[a] && list[a].created) || '';
      var cb = (list[b] && list[b].created) || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a - b;
    });
    var counts = {};
    var out = [];
    order.forEach(function (idx) {
      var k = voucherGroupKey(list[idx], kind);
      counts[k] = (counts[k] || 0) + 1;
      out[idx] = counts[k];
    });
    return out;
  }
  M23.voucherDisplayNos = voucherDisplayNos;
  function vouchDatesAll() {
    var out = [];
    (M23.meta2d || []).forEach(function (m) { var d = voucherDateOf(m, '2d'); if (d) out.push(d); });
    (M23.meta3d || []).forEach(function (m) { var d = voucherDateOf(m, '3d'); if (d) out.push(d); });
    (M23.metaFb || []).forEach(function (m) { var d = voucherDateOf(m, '1d'); if (d) out.push(d); });
    return out;
  }
  M23.vouchDatesAll = vouchDatesAll;
  // Default: today (Yangon), ALWAYS (Pho Nov 18, Player v2.16). The old
  // v2.10 fallback (most recent voucher date when none today) showed
  // yesterday's date on a fresh morning — the date must auto-change to
  // today. An empty list when nothing was bet today yet is correct;
  // the calendar still reaches earlier dates.
  function defaultVouchDate(now) {
    return yangonParts(now).ymd;
  }
  M23.defaultVouchDate = defaultVouchDate;
  function syncVouchDateText() {
    var el = document.getElementById('vouchDateText');
    if (el && M23.vouchDate) el.textContent = fmtDateOnly(M23.vouchDate);
  }
  M23.syncVouchDateText = syncVouchDateText;
  // Ball log date (Pho Nov 19, Player v2.18): the Ball log shares the voucher
  // date — Yesterday / Today buttons on the Ball section switch it.
  function syncBallDateText() {
    var el = document.getElementById('ballDateText');
    if (el && M23.vouchDate) el.textContent = fmtDateOnly(M23.vouchDate);
  }
  M23.syncBallDateText = syncBallDateText;
  window.setBallDate = function (off) {
    // off 0 = today, -1 = yesterday (Yangon has no DST, so 24h steps are exact).
    var t = new Date(Date.now() + (off || 0) * 86400000);
    setVouchDate(yangonParts(t).ymd);
    syncBallDateText();
    renderBallLog();
  };
  function ensureVouchDate(now) {
    // Auto (Pho Nov 18, Player v2.16): the date is today unless the user
    // picked one by hand — and a hand pick survives re-renders only
    // within the same Yangon day, never across days (the date must
    // auto-change when the day changes, even if the app stayed open).
    var today = yangonParts(now).ymd;
    if (M23.vouchDateManual && M23.vouchDateManualDay === today) return;
    M23.vouchDateManual = false;
    M23.vouchDateManualDay = null;
    M23.vouchDateInit = true;
    M23.vouchDate = defaultVouchDate(now);
    syncVouchDateText();
  }
  M23.ensureVouchDate = ensureVouchDate;
  function setVouchDate(ymd) {
    if (!ymd) return;
    M23.vouchDate = ymd;
    M23.vouchDateInit = true;
    M23.vouchDateManual = true;
    M23.vouchDateManualDay = yangonParts().ymd;
    syncVouchDateText();
    syncBallDateText();
    renderTotals();
  }
  M23.setVouchDate = setVouchDate;
  // Current 2D session for the VOUCHER lists (Pho Nov 18, Player v2.16):
  // same AM/PM pick as pickSessionForNow, but the AM -> PM switch happens
  // at the PM OPEN time (14:00 Yangon), NOT at the AM close time —
  // Pho's choice (Nov 18 10:50): morning vouchers stay visible until
  // 14:00, then the evening session takes over. Before 14:00 -> today's
  // am session; from 14:00 -> today's pm session. One session for today
  // -> that one. None for today -> null (no session filter; the date
  // filter alone applies).
  function voucherSession2dCurrent(now) {
    var today = yangonParts(now).ymd;
    if (!today) return null;
    var todays = (M23.sessions || []).filter(function (r) {
      return r.game === '2d' && yangonDateOf(r.date) === today;
    });
    if (!todays.length) return null;
    if (todays.length === 1) return todays[0];
    var am = null, pm = null;
    todays.forEach(function (r) {
      if (r.period === 'am' && !am) am = r;
      if (r.period === 'pm' && !pm) pm = r;
    });
    if (am && pm) return yangonParts(now).minutes < SCHED_OPEN_PM_MIN ? am : pm;
    return sortSessionsLatest(todays)[0];
  }
  M23.voucherSession2dCurrent = voucherSession2dCurrent;
  // Filter one voucher list to the SHARED selected date (Pho Nov 17,
  // Player v2.11): the main voucher tab AND the 2D/3D screens' own lists
  // (vouch2d / vouch3d) all follow the same M23.vouchDate. A voucher whose
  // date cannot be resolved at all is SHOWN, never hidden — only a
  // known-different date hides a voucher.
  function filterByVouchDate(items, metas, kind, now) {
    ensureVouchDate(now);
    if (!M23.vouchDate) return { items: items, metas: metas };
    // 2D session filter (Pho Nov 18, Player v2.16): when the picked date
    // is today, show only the current session's vouchers — morning
    // vouchers disappear once the evening session opens (14:00). A
    // voucher whose session cannot be resolved is SHOWN, never hidden
    // (same safety rule as the date). A picked past date shows the whole
    // day (both sessions), as before. 3D and 1D are untouched.
    var today = yangonParts(now).ymd;
    var cur2d = null;
    if (kind === '2d' && M23.vouchDate === today) cur2d = voucherSession2dCurrent(now);
    var kept = [];
    (items || []).forEach(function (it, i) {
      var d = voucherDateOf((metas || [])[i] || {}, kind);
      if (d !== null && d !== M23.vouchDate) return;
      if (cur2d) {
        var meta = (metas || [])[i] || {};
        if (meta.session) {
          var found = false;
          (M23.sessions || []).forEach(function (r) { if (r.id === meta.session) found = true; });
          if (found && meta.session !== cur2d.id) return;
        }
      }
      kept.push(i);
    });
    return { items: kept.map(function (i) { return items[i]; }), metas: kept.map(function (i) { return metas[i]; }) };
  }
  M23.filterByVouchDate = filterByVouchDate;
  // Calendar grid cells for month (y, m 0-based): leading blanks are null;
  // each day is {d, ymd, we (Sat/Sun), future, today, sel}. Pure — the
  // popup renderer below only turns these into HTML.
  function calCells(y, m, todayYmd, selYmd) {
    var first = new Date(Date.UTC(y, m, 1)).getUTCDay(); // 0 = Sunday
    var dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var cells = [];
    for (var i = 0; i < first; i++) cells.push(null);
    for (var d = 1; d <= dim; d++) {
      var ymd = y + '-' + pad2(m + 1) + '-' + pad2(d);
      var wd = new Date(Date.UTC(y, m, d)).getUTCDay();
      cells.push({ d: d, ymd: ymd, we: (wd === 0 || wd === 6), future: !!(todayYmd && ymd > todayYmd), today: (ymd === todayYmd), sel: (ymd === selYmd) });
    }
    return cells;
  }
  M23.calCells = calCells;
  function renderVouchCal() {
    var card = document.getElementById('vouchCalCard');
    if (!card) return;
    var today = yangonParts().ymd;
    var ty = parseInt(today.slice(0, 4), 10), tm = parseInt(today.slice(5, 7), 10) - 1;
    var view = M23.vouchCalView || { y: ty, m: tm };
    var isCur = (view.y === ty && view.m === tm);
    var cells = calCells(view.y, view.m, today, M23.vouchDate);
    var h = '<div class="vcal-nav">'
      + '<button onclick="M23.vouchCalMove(-1)" aria-label="prev month">‹</button>'
      + '<div class="vcal-title">' + CAL_MONTHS[view.m] + ' &nbsp; ' + view.y + '</div>'
      + '<button onclick="M23.vouchCalMove(1)"' + (isCur ? ' disabled' : '') + ' aria-label="next month">›</button>'
      + '</div>';
    h += '<div class="vcal-grid">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (d) { return '<div class="vcal-dow">' + d + '</div>'; }).join('') + '</div>';
    h += '<div class="vcal-grid">';
    cells.forEach(function (c) {
      if (!c) { h += '<div></div>'; return; }
      var cls = 'vcal-day';
      if (c.we) cls += ' cal-we';
      if (c.future) cls += ' cal-future';
      if (c.today) cls += ' cal-today';
      if (c.sel && !c.today) cls += ' cal-sel';
      if (c.future) h += '<div class="' + cls + '">' + c.d + '</div>';
      else h += '<div class="' + cls + '" onclick="M23.vouchCalPick(\'' + c.ymd + '\')">' + c.d + '</div>';
    });
    h += '</div>';
    h += '<div class="vcal-quick"><button onclick="M23.vouchCalQuick(\'yesterday\')">Yesterday</button><button onclick="M23.vouchCalQuick(\'today\')">Today</button></div>';
    card.innerHTML = h;
  }
  M23.renderVouchCal = renderVouchCal;
  function openVouchCal() {
    ensureVouchDate();
    var sel = M23.vouchDate || yangonParts().ymd;
    M23.vouchCalView = { y: parseInt(sel.slice(0, 4), 10), m: parseInt(sel.slice(5, 7), 10) - 1 };
    renderVouchCal();
    var ov = document.getElementById('vouchCalOverlay');
    if (ov) ov.style.display = 'flex';
  }
  M23.openVouchCal = openVouchCal;
  function closeVouchCal() {
    var ov = document.getElementById('vouchCalOverlay');
    if (ov) ov.style.display = 'none';
  }
  M23.closeVouchCal = closeVouchCal;
  function vouchCalMove(dir) {
    var view = M23.vouchCalView || { y: parseInt(yangonParts().ymd.slice(0, 4), 10), m: parseInt(yangonParts().ymd.slice(5, 7), 10) - 1 };
    var m = view.m + dir, y = view.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    // Never into a future month beyond the current month.
    var today = yangonParts().ymd;
    var ty = parseInt(today.slice(0, 4), 10), tm = parseInt(today.slice(5, 7), 10) - 1;
    if (y > ty || (y === ty && m > tm)) return;
    M23.vouchCalView = { y: y, m: m };
    renderVouchCal();
  }
  M23.vouchCalMove = vouchCalMove;
  function vouchCalPick(ymd) {
    setVouchDate(ymd);
    closeVouchCal();
  }
  M23.vouchCalPick = vouchCalPick;
  function vouchCalQuick(which) {
    var today = yangonParts().ymd;
    vouchCalPick(which === 'yesterday' ? ymdAdd(today, -1) : today);
  }
  M23.vouchCalQuick = vouchCalQuick;

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
    M23.footballOn = (s.football_enabled !== false);
    applyFootballEnabled();
  }
  M23.applySettings = applySettings;

  // Football on/off (Pho Nov 14 22:30): when Admin turns football OFF,
  // the home မောင်း/ဘော်ဒီ buttons DISAPPEAR entirely (no grey, no label).
  // Results and vouchers stay visible. Default ON when the field is missing.
  function applyFootballEnabled() {
    var on = !M23.settings || M23.settings.football_enabled !== false;
    M23.footballOn = on;
    var m = document.getElementById('homeBtnMaung');
    var b = document.getElementById('homeBtnBody');
    if (m) {
      m.classList.toggle('fb-hidden', !on);
      if (on) m.innerHTML = 'မောင်း';
    }
    if (b) {
      b.classList.toggle('fb-hidden', !on);
      if (on) b.innerHTML = 'ဘော်ဒီ';
    }
  }

  // Re-read m23_settings (football on/off) on the 30s auto-refresh, so an
  // Admin toggle flip reaches the player without a reload.
  async function refreshSettings() {
    var s = await safe(PB.getList('m23_settings', { filter: "key='main'", perPage: 1 }));
    if (s && s.items && s.items[0]) { M23.settings = s.items[0]; M23.flags.settings = true; applySettings(); }
  }
  M23.refreshSettings = refreshSettings;

  // Re-fetch m23_sessions on the 30s auto-refresh, so a player who keeps the
  // app open past 14:00 picks up the pm session without a reload (the pm
  // session exists from the morning but only becomes current in the
  // afternoon). Light: only sessions, not a full reload. A failed fetch
  // keeps the old sessions. Optional `now` is for tests; live call sites
  // pass nothing (real time).
  async function refreshSessions(now) {
    var sess = await safe(PB.listAll('m23_sessions', { sort: '-date', perPage: 200 }));
    if (!sess) return;
    M23.sessions = sess; M23.flags.sessions = true;
    pickSessions(now);
    applySession();
  }
  M23.refreshSessions = refreshSessions;

  // --------------------------------------------- 2D auto-schedule (Pho Nov 15
  // 18:31-18:47, settled): 2D opens Mon-Fri only, morning AND evening.
  // Open times are FIXED constants (hardcoded, NOT in Settings): am 10:00,
  // pm 14:00 (Yangon). Auto-close at the session's close_at (the Settings
  // close times Pho sets in Admin; defaults am 11:55 / pm 15:55 when
  // close_at is missing). Sat/Sun closed every week. A manual Admin close
  // (session.open=false, e.g. holiday) is NEVER undone here — the gate only
  // ever narrows the Admin flag, never widens it. Windows are [open, close):
  // open AT 10:00/14:00, closed AT the close time. 3D and football untouched.
  var SCHED_OPEN_AM_MIN = 10 * 60;  // 10:00 Yangon
  var SCHED_OPEN_PM_MIN = 14 * 60;  // 14:00 Yangon
  var SCHED_CLOSE_AM = '11:55';
  var SCHED_CLOSE_PM = '15:55';

  function yangonParts(now) {
    // {ymd:'YYYY-MM-DD', weekday:0-6 (Sun=0), minutes:0-1439} in Asia/Yangon.
    var d = (now instanceof Date) ? now : new Date(now == null ? Date.now() : now);
    var out = { ymd: '', weekday: -1, minutes: -1 };
    try { out.ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); } catch (e) { /* leave blank */ }
    try {
      var w = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Yangon', weekday: 'short' }).format(d);
      var map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      out.weekday = (map[w] != null) ? map[w] : -1;
    } catch (e) { /* leave -1 */ }
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yangon', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
      var h = 0, m = 0;
      parts.forEach(function (p) { if (p.type === 'hour') h = parseInt(p.value, 10) || 0; if (p.type === 'minute') m = parseInt(p.value, 10) || 0; });
      if (h === 24) h = 0; // some ICU builds render midnight as 24 with h23
      out.minutes = h * 60 + m;
    } catch (e) { /* leave -1 */ }
    return out;
  }
  M23.yangonParts = yangonParts;

  function isWeekdayYangon(now) {
    var wd = yangonParts(now).weekday;
    return wd >= 1 && wd <= 5; // Mon-Fri in Asia/Yangon
  }
  M23.isWeekdayYangon = isWeekdayYangon;

  function hhmmToMinutes(hhmm) {
    var p = String(hhmm || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  M23.hhmmToMinutes = hhmmToMinutes;

  function yangonDateOf(value) {
    // Yangon calendar date (YYYY-MM-DD) of a PocketBase DateTime value —
    // same as the Admin app (logic.js v1.9). m23_sessions.date is stored as
    // 00:00 Yangon in UTC ("2026-11-15 17:30:00.000Z" = 2026-11-16 Yangon),
    // so the date part of the string is NOT the Yangon date: parse it.
    var s = normalizeKickoff(value);
    if (s == null) return null;
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s * 1000)); } catch (e) { return null; }
  }
  M23.yangonDateOf = yangonDateOf;

  function sessionCloseTime(session, period) {
    // HH:MM from the session's close_at (PocketBase DateTime, Yangon wall
    // time as Admin saved it: "2026-11-16 12:00:00" or its ISO form
    // "2026-11-16T12:00:00.000Z"). Regex identical to the Admin app
    // (logic.js closeTimeOf). Missing/unreadable -> period default.
    var def = (period === 'pm') ? SCHED_CLOSE_PM : SCHED_CLOSE_AM;
    var raw = session ? session.close_at : null;
    if (raw) {
      var m = String(raw).match(/(\d{2}):(\d{2})/);
      if (m) {
        var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
        if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return pad2(h) + ':' + pad2(mi);
      }
    }
    return def;
  }
  M23.sessionCloseTime = sessionCloseTime;

  function isInWindow(now, period, closeTime) {
    var t = yangonParts(now).minutes;
    if (t < 0) return false;
    var close = hhmmToMinutes(closeTime || ((period === 'pm') ? SCHED_CLOSE_PM : SCHED_CLOSE_AM));
    if (period === 'am') return t >= SCHED_OPEN_AM_MIN && t < close;
    if (period === 'pm') return t >= SCHED_OPEN_PM_MIN && t < close;
    return false;
  }
  M23.isInWindow = isInWindow;

  function is2dOpenNow(session, now) {
    if (!session || !session.open) return false; // Admin manual close wins
    if (!isWeekdayYangon(now)) return false;     // Sat/Sun closed
    // The picked session must be TODAY's (Yangon date). Without this, a
    // stale latest session from a previous day (no session for today yet)
    // would show open during window hours and bets would land in the wrong
    // session. yangonDateOf parses the stored ISO date — the string prefix
    // is the UTC day, not the Yangon day ("2026-11-15 17:30:00.000Z" is
    // 2026-11-16 Yangon). An unreadable date fails closed (null != today).
    if (yangonDateOf(session.date) !== yangonParts(now).ymd) return false;
    return isInWindow(now, session.period, sessionCloseTime(session, session.period));
  }
  M23.is2dOpenNow = is2dOpenNow;

  // --- 2D not-open message (Pho Nov 20, Player v2.30): 'ဒီပွဲ ပိတ်သွားပြီ' is
  // WRONG before the open time — the morning session hasn't opened yet, it
  // isn't closed. now < open time → 'ဒီပွဲ မဖွင့်သေးပါ'. Every other
  // not-open state (manual Admin close, past close time, weekend, no
  // session, stale session) keeps 'ဒီပွဲ ပိတ်သွားပြီ'.
  function closedMsg2d(now) {
    var s = M23.session2d;
    if (s && s.open && isWeekdayYangon(now) && yangonDateOf(s.date) === yangonParts(now).ymd) {
      var t = yangonParts(now).minutes;
      var openMin = s.period === 'pm' ? SCHED_OPEN_PM_MIN : SCHED_OPEN_AM_MIN;
      if (t >= 0 && t < openMin) return 'ဒီပွဲ မဖွင့်သေးပါ';
    }
    return 'ဒီပွဲ ပိတ်သွားပြီ';
  }
  M23.closedMsg2d = closedMsg2d;

  function rawCloseTime(session) {
    // HH:MM from the session's close_at, or null when missing/unreadable.
    // Unlike sessionCloseTime (2D), there is NO default here: the App must
    // never invent a close time. A null means manual-close-only.
    var raw = session ? session.close_at : null;
    if (!raw) return null;
    var m = String(raw).match(/(\d{2}):(\d{2})/);
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }
  M23.rawCloseTime = rawCloseTime;

  function is3dOpenNow(session, now) {
    // 3D clock gate (Pho Nov 16 17:48: the Settings close times MUST be
    // enforced, each game on its own time). The 3D session is one round
    // whose date is the draw date (Yangon); it stays open until the draw
    // date, then closes at the Admin-set close_at time. Manual Admin close
    // (open=false) always wins. Close is NEVER tied to the winning number
    // (win_number is not read here). Missing/unreadable close_at means
    // manual-close-only — the App never invents a time.
    if (!session || !session.open) return false;
    var drawYmd = yangonDateOf(session.date);
    if (!drawYmd) return true; // unreadable date -> manual-close-only
    var parts = yangonParts(now);
    var today = parts.ymd;
    if (!today) return true; // unreadable now -> manual-close-only
    if (today < drawYmd) return true;  // before the draw date: open
    if (today > drawYmd) return false; // after the draw date: closed
    // Draw date: open until the Admin-set close time.
    var close = rawCloseTime(session);
    if (!close) return true; // no close time set -> manual-close-only
    if (parts.minutes < 0) return false; // unreadable clock -> fail closed
    return parts.minutes < hhmmToMinutes(close);
  }
  M23.is3dOpenNow = is3dOpenNow;

  // 3D session for the CURRENT round (Pho Nov 17, Player v2.11 option B —
  // "ဟောင်းပွဲပဲ ဖျောက်၊ ကြိုထိုးလို့ရ"): the nearest round whose Yangon
  // draw date is today or in the future. A round stays bettable from when
  // its session exists until the draw (v2.7 gate: is3dOpenNow returns
  // true before the draw date), so a future round (e.g. the Dec 1 round
  // already in the data) counts and its screen shows it. A PAST round
  // never counts — once the latest round is past and no future round
  // exists, the 3D bet screen shows "ဒီနေ့ ပွဲမရှိပါ" like football
  // instead of the old round. Today's draw wins over a future round on
  // the draw day itself.
  function session3dCurrent(now) {
    var today = yangonParts(now).ymd;
    if (!today) return null;
    var rows = (M23.sessions || []).filter(function (r) {
      var d = yangonDateOf(r.date);
      return r.game === '3d' && d && d >= today;
    });
    if (!rows.length) return null;
    rows.sort(function (a, b) {
      var d = String(yangonDateOf(a.date)).localeCompare(String(yangonDateOf(b.date)));
      if (d !== 0) return d;
      return (b.open ? 1 : 0) - (a.open ? 1 : 0);
    });
    return rows[0];
  }
  M23.session3dCurrent = session3dCurrent;

  function sortSessionsLatest(rows) {
    // The old pick order, unchanged: newest date first, open rows first on
    // a date tie. Used by the 3D pick and as the 2D fallback.
    return (rows || []).slice().sort(function (a, b) {
      var d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return (b.open ? 1 : 0) - (a.open ? 1 : 0);
    });
  }

  function pickSessionForNow(sessions, now) {
    // Period-aware 2D pick: morning -> am session, afternoon -> pm session.
    // One session for today -> that one. None for today -> fall back to the
    // latest session overall (the clock/weekend gates show it closed).
    var rows = (sessions || []).filter(function (r) { return r.game === '2d'; });
    if (!rows.length) return null;
    var today = yangonParts(now).ymd;
    // Match by Yangon calendar date (Admin logic.js yangonDateOf) — the
    // stored ISO date's string prefix is the UTC day, not the Yangon day.
    var todays = rows.filter(function (r) { return yangonDateOf(r.date) === today; });
    if (todays.length === 1) return todays[0];
    if (todays.length > 1) {
      var am = null, pm = null;
      todays.forEach(function (r) {
        if (r.period === 'am' && !am) am = r;
        if (r.period === 'pm' && !pm) pm = r;
      });
      if (am && pm) {
        // Before the am close time -> morning; otherwise -> evening. When
        // the am session has no close time of its own, noon is the cut.
        var cutoff = am.close_at ? sessionCloseTime(am, 'am') : '12:00';
        return yangonParts(now).minutes < hhmmToMinutes(cutoff) ? am : pm;
      }
      return sortSessionsLatest(todays)[0];
    }
    return sortSessionsLatest(rows)[0];
  }
  M23.pickSessionForNow = pickSessionForNow;

  function pickSessions(now) {
    now = (now == null) ? new Date() : now;
    function pick(game) {
      var rows = M23.sessions.filter(function (r) { return r.game === game; });
      if (!rows.length) return null;
      return sortSessionsLatest(rows)[0];
    }
    M23.session2d = pickSessionForNow(M23.sessions, now);
    M23.session3d = pick('3d');
  }
  M23.pickSessions = pickSessions;

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
    // Counts show today's matches only (Pho Nov 15 — future matches hidden).
    var todayN = (typeof todayMatches === 'function') ? todayMatches(mapped).length : mapped.length;
    var mc = document.getElementById('maungCount'); if (mc) mc.textContent = String(todayN);
    var bc = document.getElementById('bodyCount'); if (bc) bc.textContent = String(todayN);
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
    M23.meta2d = b2.map(function (r) { return { voucher_no: r.voucher_no, status: r.status, win_amount: r.win_amount || 0, session: r.session, created: r.created }; });
    M23.meta3d = b3.map(function (r) { return { voucher_no: r.voucher_no, status: r.status, win_amount: r.win_amount || 0, session: r.session, created: r.created }; });
    M23.metaFb = bf.map(function (r) {
      return { voucher_no: r.voucher_no, status: r.status, payout: r.payout || 0, profit: (r.profit != null ? r.profit : ((r.payout || 0) - (r.stake || 0))), created: r.created };
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
      safe(PB.getList('m23_wallet_tx', { filter: pf, sort: '-created', perPage: 200 }))
    ]);
    if (results[0]) { M23.bets2d = results[0].items || []; }
    if (results[1]) { M23.bets3d = results[1].items || []; }
    if (results[2]) { M23.betsFb = results[2].items || []; }
    if (results[0] || results[1] || results[2]) M23.flags.bets = true;
    if (results[3]) { M23.walletTx = results[3].items || []; M23.flags.tx = true; }
    rebuildPlaced();
    recomputeBetAlready();
    renderTotals();
    renderBallLog();
    renderResults();
    renderMoneyHist();
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
      refreshSettings();
      refreshSessions();
    }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && M23.player) { refreshData(); refreshFixtures(); refreshSettings(); refreshSessions(); }
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
    // v2.17 (Pho Nov 19): the userbar stays hidden until a real login, so the
    // login screen never shows the mockup name/balance.
    document.querySelectorAll('.userbar').forEach(function (el) { el.style.display = ''; });
    document.querySelectorAll('.uname').forEach(function (el) { el.textContent = me.name || ''; });
    // v2.17 (Pho Nov 19): the userbar avatar ALWAYS stays the logo. The old
    // code replaced it with the name's first letter on login — every player
    // name starts with '2', so it showed a faint '2' on dark blue (looked
    // like a plain blue circle) and flipped logo/blue between loads.
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
    // v2.41 (Pho Nov 21 — balance must never go negative): re-read the
    // server balance JUST BEFORE saving. The local `balance` can be stale
    // (another save in flight on a slow link passes its local check, then
    // this save writes newBalance from the stale value — 23M002 went to
    // -3,600 this way). Block on the fresh value. Fail closed: if the
    // re-read fails, do not save on a stale balance — the user retries.
    var fresh;
    try { fresh = await PB.getOne('m23_players', me.id); }
    catch (e) { throw new Error('လက်ကျန်ငွေ စစ်လို့ မရဘူး — ထပ်ကြိုးစားပါ'); }
    var curBal = (fresh && typeof fresh.balance === 'number') ? fresh.balance : 0;
    if (typeof balance !== 'undefined') balance = curBal;
    M23.player = fresh;
    if (opts.total > curBal) throw new Error('ငွေမလုံလောက်ပါ');
    var top = await PB.getList(opts.collection, {
      filter: 'player="' + me.id + '"', sort: '-voucher_no', perPage: 1, fields: 'voucher_no'
    });
    var no = ((top.items && top.items[0] && top.items[0].voucher_no) || 0) + 1;
    var body = Object.assign({}, opts.betBody, { voucher_no: no });
    var bet = await PB.create(opts.collection, body);
    var newBalance = curBal - opts.total;
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
    // v2.17 (Pho Nov 19): dismiss the keyboard/cursor after a successful Save.
    if (typeof document !== 'undefined' && document.activeElement) document.activeElement.blur();
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
  // 2D auto-schedule gate (Pho Nov 15): the effective open state is the
  // Admin flag AND the clock (Mon-Fri, am 10:00-close / pm 14:00-close).
  // Every UI surface and bet guard reads nowSession().open, so gating here
  // covers all of them. The gate never re-opens a manual Admin close.
  // Optional `now` is for tests; live call sites pass nothing (real time).
  window.nowSession = function (now) {
    if (!M23.session2d) return { name: 'မနက်ပိုင်း', open: false };
    return { name: periodName(M23.session2d.period, M23.session2d.label), open: is2dOpenNow(M23.session2d, now) };
  };

  window.applySession = function () {
    var s = nowSession();
    var hb = document.getElementById('homeBtn2d');
    if (hb) hb.textContent = s.open ? ('ဒီနေ့ ' + s.name) : 'ဒီနေ့ ပိတ်ပြီ';
    var b2 = document.getElementById('badge2d');
    if (b2) { b2.textContent = s.open ? 'ဖွင့်နေတယ်' : 'ပိတ်ပြီ'; b2.className = 'badge ' + (s.open ? 'open' : 'closed'); }
    var bet2 = document.getElementById('bet2d');
    if (bet2) bet2.disabled = !s.open;
    // 3D badge + date line follow the CURRENT round (Pho Nov 17, Player
    // v2.11 option B): the nearest round dated today or in the future.
    // Only when the latest round is past (no current round) does the
    // badge read closed and the screen show "ဒီနေ့ ပွဲမရှိပါ" instead of
    // the old round.
    var s3c = session3dCurrent();
    var b3 = document.getElementById('badge3d');
    if (b3) {
      var o3 = s3c ? is3dOpenNow(s3c) : false;
      b3.textContent = o3 ? 'ဖွင့်နေတယ်' : 'ပိတ်ပြီ';
      b3.className = 'badge ' + (o3 ? 'open' : 'closed');
    }
    var l3 = document.getElementById('sess3dLine');
    // 3D date is the Yangon calendar date (Pho Nov 15: 3D rounds are the
    // 1st + 16th). The stored value is 00:00 Yangon as UTC ISO
    // ("2026-11-15 17:30:00.000Z" = 2026-11-16 Yangon), so slicing the raw
    // string shows the wrong day (15.11.2026). Use yangonDateOf; fall back
    // to the old slice if the date is unreadable. The winning number is
    // appended next to the date once decided (Pho Nov 16 17:48).
    if (l3) {
      if (s3c) {
        var ymd3 = yangonDateOf(s3c.date);
        var dateTxt = ymd3 ? fmtDateOnly(ymd3) : fmtDateOnly(s3c.date);
        var win3 = winNumberForSession(s3c.id);
        // v2.23 (Pho Nov 19): the winning number is green on this line.
        l3.innerHTML = win3 ? (dateTxt + ' · ပေါက်ဂဏန်း <b style="color:#166534">' + win3 + '</b>') : dateTxt;
        l3.style.display = '';
      } else {
        l3.style.display = 'none';
      }
    }
    // 3D empty state: no current round -> hide the round's grid + bet bar
    // and show the football-style "ဒီနေ့ ပွဲမရှိပါ". The winning number
    // stays visible in စာရင်း (winNumsCard below) — untouched.
    var no3 = document.getElementById('no3dToday');
    if (no3) no3.style.display = s3c ? 'none' : '';
    var card3 = document.querySelector('#scr-3d .card');
    if (card3) card3.style.display = s3c ? '' : 'none';
    var bar3 = document.querySelector('#scr-3d .betbar');
    if (bar3) bar3.style.display = s3c ? '' : 'none';
    // Winning numbers (Pho Nov 16 17:48: the Admin-entered winning numbers
    // MUST show in the Player app, or the accounts cannot be shown).
    // 2D: the current session's win_number, shown only once decided.
    var w2 = document.getElementById('sess2dWinLine');
    if (w2) {
      var win2 = M23.session2d ? winNumberForSession(M23.session2d.id) : null;
      // v2.23 (Pho Nov 19): the winning number is green on this line.
      w2.innerHTML = win2 ? ('ပေါက်ဂဏန်း <b style="color:#166534">' + win2 + '</b>') : '';
      w2.style.display = win2 ? '' : 'none';
    }
    // စာရင်း view: winning numbers for 2D am/pm + 3D (latest sessions).
    var wnCard = document.getElementById('winNumsCard');
    var wnLine = document.getElementById('winNumsLine');
    if (wnCard && wnLine) {
      var wn = winNumsText();
      // v2.22 (Pho Nov 19): the winning NUMBERS are green on this line.
      wnLine.innerHTML = wn ? ('ပေါက်ဂဏန်း: ' + winNumsHtml()) : '';
      wnCard.style.display = wn ? '' : 'none';
    }
    // v2.23 (Pho Nov 19): re-sync the bet grids so the winning number's
    // button turns light green once the session is decided.
    if (typeof syncGrid2d === 'function') { try { syncGrid2d(); } catch (e) { /* grid not built yet */ } }
    if (typeof syncGrid3d === 'function') { try { syncGrid3d(); } catch (e) { /* grid not built yet */ } }
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
    // Short-name login (Pho): player types only the short name; PocketBase
    // still needs a full email, so normalise before auth:
    // "005" -> "005@23maung.local"; "005@23maung" -> "005@23maung.local";
    // a full email (e.g. test001@23maung.local) is used as-is.
    if (acc.indexOf('@') < 0) acc = acc + '@23maung.local';
    else if (acc.slice(-8) === '@23maung') acc = acc + '.local';
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
    // v2.17 (Pho Nov 19): hide the userbar again on logout.
    document.querySelectorAll('.userbar').forEach(function (el) { el.style.display = 'none'; });
    showLoginScreen();
  };

  // --- 2D placement ----------------------------------------------------------
  window.confirmBet2d = async function () {
    if (!M23.session2d || !nowSession().open) { toast(closedMsg2d()); return; }
    var total = 0;
    sel2d.forEach(function (n) { total += amt2dMap[n] || 0; });
    if (!total) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (total > balance) { toast('ငွေမလုံလောက်ပါ'); return; }
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
    if (!M23.session2d || !nowSession().open) { toast(closedMsg2d()); return; }
    if (!sel2d.length) { toast('ဂဏန်း နှိပ်ပါ'); return; }
    var per = parseInt(inp2d.amt, 10) || 0;
    if (!per) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    var revPer = parseInt(inp2d.revAmt, 10) || 0;
    var nonPair = sel2d.filter(function (n) { return n[0] !== n[1]; });
    if (inp2d.r && nonPair.length && !revPer) { toast('အပြန် ငွေ ထည့်ပါ'); return; }
    var total = sel2d.length * per + (inp2d.r ? nonPair.length * revPer : 0);
    if (total > balance) { toast('ငွေမလုံလောက်ပါ'); return; }
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
    // 3D bets are possible on the current round from when its session
    // exists until the draw (Pho Nov 17, Player v2.11 option B — v2.7
    // gate kept): bettable before the draw date, on the draw day until
    // the Admin-set close_at, closed after the draw date. A past round
    // can never be bet on.
    var s3 = session3dCurrent();
    if (!s3 || !is3dOpenNow(s3)) { toast('ဒီပွဲ ပိတ်သွားပြီ'); return; }
    var total = 0;
    sel3d.forEach(function (n) { total += amt3dMap[n] || 0; });
    if (!total) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (total > balance) { toast('ငွေမလုံလောက်ပါ'); return; }
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
        betBody: { player: M23.player.id, session: s3.id, lines: lines, total: total, status: 'placed' }
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
    if (M23.settings && M23.settings.football_enabled === false) { toast('ဘောပွဲ ပိတ်ထားတယ်'); return; }
    var sel = fbSel.maung;
    var keys = Object.keys(sel);
    var amtInput = document.getElementById('fbAmt');
    var v = parseInt(amtInput ? amtInput.value : '', 10);
    if (!keys.length) { toast('ကြေး အရင် ရွေးပါ'); return; }
    if (!v || v <= 0) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (v < (M23.minFb || 500)) { toast('ဘောပွဲ ' + fmt(M23.minFb || 500) + ' အောက် လောင်းမရ'); return; }
    if (v > balance) { toast('ငွေမလုံလောက်ပါ'); return; }
    if (keys.length < 2) { toast('မောင်း အနည်းဆုံး ၂ ပွဲ ရွေးပါ'); return; }
    var maxLegs = (M23.settings && M23.settings.max_legs) || 10;
    if (keys.length > maxLegs) { toast('မောင်း အများဆုံး ၁၀ သင်း ပဲ ထိုးလို့ရတယ်'); return; }
    // Pho Nov 21 (v2.39): football limit is display-only (red) — never blocks the bet.
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
    if (total > balance) { toast('ငွေမလုံလောက်ပါ'); return; }
    var picks = keys.map(function (k) { return { key: k, label: fbSel.body[k], amt: amtBodyMap[k] || 0 }; })
      .filter(function (x) { return x.amt > 0; });
    if (!picks.length) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (picks.some(function (x) { return x.amt < (M23.minFb || 500); })) { toast('ဘောပွဲ ' + fmt(M23.minFb || 500) + ' အောက် လောင်းမရ'); return; }
    // Pho Nov 21 (v2.39): football limit is display-only (red) — never blocks the bet.
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
    var wTop = document.getElementById('walletTop'); if (wTop) wTop.textContent = fmt(Math.max(0, balance));
    document.querySelectorAll('.fb-bal-amt').forEach(function (el) { el.textContent = fmt(Math.max(0, balance)); });
    var wBig = document.getElementById('walletBig'); if (wBig) wBig.textContent = fmt(Math.max(0, balance));
    var wProf = document.getElementById('walletProf'); if (wProf) wProf.textContent = fmt(Math.max(0, balance)) + ' ကျပ်';
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
    // Voucher date picker (Pho Nov 17, Player v2.10 + v2.11; v2.16 adds
    // the 2D session filter): filter the current tab to the shared
    // selected Yangon date; other dates are hidden, not deleted. The
    // 2D/3D screens' own lists (vouch2d / vouch3d below) follow the SAME
    // shared date — and for 2D on today's date, only the current session.
    var vf = filterByVouchDate(items, metas, vouchTab);
    items = vf.items; metas = vf.metas;
    // Per-session display numbers (Pho Nov 17, Player v2.13): NO.N
    // restarts at 1 per session / per day — computed once for the
    // filtered list, which holds every voucher of each shown group.
    var dispNos = voucherDisplayNos(metas, vouchTab);
    if (!items.length) {
      if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
      if (emptyBox) emptyBox.style.display = '';
    } else {
      if (wrap) wrap.style.display = '';
      if (emptyBox) emptyBox.style.display = 'none';
      var out = '';
      if (vouchTab === '1d') {
        // Slip fixtures (v2.14): finished first (scores), then scheduled
        // (league + kickoff for legs not decided yet).
        var fxById = {};
        (M23.finished || []).forEach(function (f) { fxById[f.id] = f; });
        (M23.fixtures || []).forEach(function (f) { if (!fxById[f.id]) fxById[f.id] = f; });
        var slipSub = function (slip) {
          if (!slip || (!slip.league && !slip.kickoffTime)) return '';
          var bits = [];
          if (slip.league) bits.push(slip.league);
          if (slip.kickoffTime) bits.push(slip.kickoffTime);
          return '<div class="vslip-league">' + esc(bits.join(' · ')) + '</div>';
        };
        out = items.map(function (p, i) {
          var meta = metas[i] || {};
          var bet = null;
          (M23.betsFb || []).forEach(function (b) { if (String(b.voucher_no) === String(meta.voucher_no || (i + 1))) bet = b; });
          var ev = bet ? evalVoucherFb(bet) : { decided: false, won: false, winIdx: [] };
          var legs = (bet && bet.legs) || [];
          var slipOf = function (j) {
            var lg = legs[j];
            return lg ? fbSlipLeg(lg, fxById[lg.fixture]) : { league: '', kickoffTime: '', score: '–', tick: '' };
          };
          var rows = '<div class="vno">NO.' + (dispNos[i] || meta.voucher_no || (i + 1)) + '</div>';
          rows += '<div class="vslip-head">' + esc(fbSlipHeader(p, meta)) + '</div>';
          if (p.kind === 'ဘော်ဒီ') {
            rows += p.picks.map(function (pk, j) {
              var cls = ev.winIdx.indexOf(j) >= 0 ? 'vrow vwin' : 'vrow';
              var slip = slipOf(j);
              var right = fmt(pk.amt) + ' ကျပ် · ' + slip.score + (slip.tick ? ' ' + slip.tick : '');
              return slipSub(slip) + '<div class="' + cls + '"><span>' + pk.label + '</span><span>' + right + '</span></div>';
            }).join('');
          } else {
            rows += p.picks.map(function (pk, j) {
              var cls = ev.winIdx.indexOf(j) >= 0 ? 'vrow vwin' : 'vrow';
              var slip = slipOf(j);
              var right = slip.score + (slip.tick ? ' ' + slip.tick : '');
              return slipSub(slip) + '<div class="' + cls + '"><span>' + pk + '</span><span>' + right + '</span></div>';
            }).join('');
            if (p.kind === 'မောင်း') rows += '<div class="' + (ev.won ? 'vrow vwin' : 'vrow') + '" style="font-weight:bold"><span>' + p.picks.length + 'မောင်း</span><span>' + fmt(p.amt) + '</span></div>';
          }
          rows += '<div class="vtot"><span>Total</span><span>' + fmt(p.amt) + ' ကျပ်' + voucherMark(ev) + '</span></div>';
          if (ev.decided) rows += '<div class="vrow"><span>အနိုင်ရငွေ</span><b style="color:#166534">' + fmt(Math.max(0, meta.profit || 0)) + ' ကျပ်</b></div>';
          return '<div class="vouch">' + rows + '</div>';
        }).join('');
      } else {
        out = items.map(function (batch, i) {
          return voucher2d3dHtml(batch, metas[i] || {}, i, vouchTab, dispNos[i]);
        }).join('');
      }
      if (wrap) wrap.innerHTML = out;
    }
    // 2D / 3D screens' own voucher lists (same records, NO.N is the
    // per-session display number, Player v2.13) — filtered by the SAME
    // shared date as the main voucher tab (Pho Nov 17, Player v2.11):
    // today's list is empty when the player has no vouchers on the
    // selected date.
    var v2 = document.getElementById('vouch2d');
    if (v2) {
      var f2 = filterByVouchDate(placed['2d'], M23.meta2d, '2d');
      var d2 = voucherDisplayNos(f2.metas, '2d');
      v2.innerHTML = f2.items.length ? f2.items.map(function (batch, i) {
        return voucher2d3dHtml(batch, f2.metas[i] || {}, i, '2d', d2[i]);
      }).join('') : '';
    }
    var v3 = document.getElementById('vouch3d');
    if (v3) {
      var f3 = filterByVouchDate(placed['3d'], M23.meta3d, '3d');
      var d3 = voucherDisplayNos(f3.metas, '3d');
      v3.innerHTML = f3.items.length ? f3.items.map(function (batch, i) {
        return voucher2d3dHtml(batch, f3.metas[i] || {}, i, '3d', d3[i]);
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
    // Per-day (Pho Nov 19, Player v2.18): the Ball log shows ONE Yangon day
    // only — the shared voucher date (Yesterday / Today) — never all days
    // mixed. A bet whose date cannot be resolved is SHOWN, never hidden
    // (same safety rule as the voucher lists).
    ensureVouchDate();
    syncBallDateText();
    var settled = M23.betsFb.filter(function (b) { return b.status && b.status !== 'open'; })
      .filter(function (b) {
        var d = b.created ? yangonDateOf(b.created) : null;
        return d === null || d === M23.vouchDate;
      })
      .slice().sort(function (a, b) { return String(b.created || '').localeCompare(String(a.created || '')); });
    if (!settled.length) {
      var anySettled = (M23.betsFb || []).some(function (b) { return b.status && b.status !== 'open'; });
      el.innerHTML = '<div class="hist-row"><span class="muted">' + (anySettled ? 'ဒီရက် ပွဲပြီးတဲ့ ဘောပွဲ ထိုးကြေး မရှိသေးပါ' : 'ပွဲပြီးတဲ့ ဘောပွဲ ထိုးကြေး မရှိသေးပါ') + '</span></div>';
      return;
    }
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
        // Same per-leg tick as the voucher slip (v2.14); '-' while undecided.
        var tick = fbSlipLeg(l, f).tick || '-';
        return '<tr><td>' + game + '</td><td>' + score + '</td><td>' + sel + '</td><td>' + tick + '</td></tr>';
      }).join('');
      var mark = won ? '✅' : '❌';
      out += '<div class="ball-time"><span>' + esc(fmtDateTimeYangon(b.created)) + '</span><span>⌃</span></div>'
        + '<table class="ball-tbl"><tr><th>Game<br>' + kind + '</th><th>Result</th><th>Selected</th><th></th></tr>'
        + rows + '</table>'
        + '<div class="ball-tot"><span>Total: ' + fmt(b.stake || 0) + ' <span class="mk">' + mark + '</span></span><span>အနိုင်ရငွေ ' + fmt(Math.max(0, profit)) + ' ကျပ်</span></div>';
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
    show('ballDateRow', t === 'ball');
    show('log2d', t === '2d');
    show('log3d', t === '3d');
    show('logMoney', t === 'money');
    if (t === 'ball') renderBallLog();
    else renderMoneyHist();
    // NOTE: the mockup called creditBallWins() here. That local credit is
    // removed — wins are credited by settlement only (see WIRING.md).
  };

  // --- top-up / withdraw --------------------------------------------------------
  // FIX #6 (v1.7): in-flight guard — a double-tap on Submit used to send 2
  // top-up requests ("1 sent → 2 arrive"). While one is pending, further
  // submits are ignored and the submit button is disabled.
  var topupInFlight = false;
  window.requestTopup = async function () {
    var amtEl = document.getElementById('topupAmt');
    var v = parseInt(amtEl ? amtEl.value : '', 10);
    if (!v || v <= 0) { toast('ငွေပမာဏ ထည့်ပါ'); return; }
    if (topupInFlight) return; // already sending — ignore this tap
    topupInFlight = true;
    var topupBtn = document.querySelector('button[onclick="requestTopup()"]');
    if (topupBtn) topupBtn.disabled = true;
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
    finally { topupInFlight = false; if (topupBtn) topupBtn.disabled = false; }
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
      // Football OFF: block entering the မောင်း/ဘော်ဒီ bet screens.
      if ((id === 'scr-maung' || id === 'scr-body') && M23.settings && M23.settings.football_enabled === false) {
        toast('ဘောပွဲ ပိတ်ထားတယ်');
        return;
      }
      _orig.go(id);
      if (!M23.loaded || !M23.player) return;
      if (id === 'scr-maung' || id === 'scr-body') refreshFixtures();
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

  // --- home banner slideshow (Pho Nov 19, Player v2.17): 3 photos, auto-rotate.
  var homeSlideIdx = 0, homeSlideTimer = null;
  window.homeSlide = function (i) {
    var imgs = document.querySelectorAll('#homeBanner img');
    var dots = document.querySelectorAll('#homeDots button');
    if (!imgs.length) return;
    homeSlideIdx = ((i % imgs.length) + imgs.length) % imgs.length;
    imgs.forEach(function (im, j) { im.classList.toggle('on', j === homeSlideIdx); });
    dots.forEach(function (d, j) { d.classList.toggle('on', j === homeSlideIdx); });
  };
  function startHomeSlideshow() {
    if (homeSlideTimer || typeof document === 'undefined') return;
    if (!document.querySelectorAll('#homeBanner img').length) return;
    homeSlideTimer = setInterval(function () { window.homeSlide(homeSlideIdx + 1); }, 4000);
  }

  // --- login banner slideshow (Pho Nov 20, Player v2.28): 4 posters, auto-rotate.
  var loginSlideIdx = 0, loginSlideTimer = null;
  window.loginSlide = function (i) {
    var imgs = document.querySelectorAll('#loginBanner img');
    if (!imgs.length) return;
    loginSlideIdx = ((i % imgs.length) + imgs.length) % imgs.length;
    imgs.forEach(function (im, j) { im.classList.toggle('on', j === loginSlideIdx); });
  };
  function startLoginSlideshow() {
    if (loginSlideTimer || typeof document === 'undefined') return;
    if (!document.querySelectorAll('#loginBanner img').length) return;
    loginSlideTimer = setInterval(function () { window.loginSlide(loginSlideIdx + 1); }, 4000);
  }

  // Voucher date picker placeholder (Pho Nov 17, Player v2.10; Nov 18
  // v2.16: the default is today, always): today until the first data
  // load computes the real default.
  M23.vouchDate = yangonParts().ymd;
  syncVouchDateText();
  startHomeSlideshow();
  startLoginSlideshow();
})();
