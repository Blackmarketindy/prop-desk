/* Prop Desk projection model.
 * Shared by the web page (index.html) and the backtest (scripts/backtest.js) so both run
 * exactly the same math. No dependencies; works in the browser and in Node.
 *
 * PropModel.create(data, {now, calib}) prepares one data snapshot (the data.json shape) and
 * returns functions that project a player's next game as of time `now` (ms since epoch).
 */
(function (root) {
  'use strict';

  const fantasy = g => 0.04 * g.pyd + 4 * g.ptd - g.int + 0.1 * g.ryd + 6 * g.rtd + g.rec + 0.1 * g.recyd + 6 * g.rectd - g.fl + 2 * g.two + 6 * g.sttd;
  const ALL = ['QB', 'RB', 'WR', 'TE'];
  const MARKETS = [
    {k: 'pyd',   label: 'Pass Yards',       pos: ['QB'], f: g => g.pyd, cv: .28, kind: 'cont', env: .25},
    {k: 'ptd',   label: 'Pass TDs',         pos: ['QB'], f: g => g.ptd, kind: 'pois', env: .5},
    {k: 'cmp',   label: 'Pass Completions', pos: ['QB'], f: g => g.cmp, cv: .22, kind: 'cont', env: .15},
    {k: 'att',   label: 'Pass Attempts',    pos: ['QB'], f: g => g.att, cv: .18, kind: 'cont', env: .1},
    {k: 'int',   label: 'Interceptions',    pos: ['QB'], f: g => g.int, kind: 'pois', env: 0},
    {k: 'pry',   label: 'Pass+Rush Yds',    pos: ['QB'], f: g => g.pyd + g.ryd, cv: .26, kind: 'cont', env: .25},
    {k: 'ryd',   label: 'Rush Yards',       pos: ['QB', 'RB', 'WR'], f: g => g.ryd, cv: .5, kind: 'cont', env: .25},
    {k: 'car',   label: 'Rush Attempts',    pos: ['QB', 'RB'], f: g => g.car, cv: .33, kind: 'cont', env: .15},
    {k: 'recyd', label: 'Receiving Yards',  pos: ['RB', 'WR', 'TE'], f: g => g.recyd, cv: .55, kind: 'cont', env: .25},
    {k: 'rec',   label: 'Receptions',       pos: ['RB', 'WR', 'TE'], f: g => g.rec, cv: .4, kind: 'cont', env: .15},
    {k: 'rry',   label: 'Rush+Rec Yds',     pos: ['RB', 'WR', 'TE'], f: g => g.ryd + g.recyd, cv: .4, kind: 'cont', env: .25},
    {k: 'td',    label: 'Rush+Rec TDs',     pos: ALL, f: g => g.rtd + g.rectd, kind: 'pois', env: .5},
    {k: 'fan',   label: 'Fantasy Score',    pos: ALL, f: fantasy, cv: .42, kind: 'cont', env: .4},
  ];
  const MK = Object.fromEntries(MARKETS.map(m => [m.k, m]));

  // ---- math ----
  function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  function poisPmf(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
  const clip = (v, a, b) => Math.min(b, Math.max(a, v));
  function probs(m, mu, sd, line) {
    const whole = Math.abs(line - Math.round(line)) < 1e-9;
    if (m.kind === 'pois') {
      const lam = Math.max(mu, 0.02), k = Math.floor(line);
      let cdf = 0; for (let i = 0; i <= k; i++) cdf += poisPmf(i, lam);
      const push = whole ? poisPmf(k, lam) : 0;
      return {more: 1 - cdf, less: cdf - push, push};
    }
    if (whole) {
      const hi = Phi((line + .5 - mu) / sd), lo = Phi((line - .5 - mu) / sd);
      return {more: 1 - hi, less: lo, push: hi - lo};
    }
    const c = Phi((line - mu) / sd);
    return {more: 1 - c, less: c, push: 0};
  }
  // Pull a probability toward 50% by factor k (k = 1 leaves it alone). Fitted by the backtest.
  function shrink(p, k) {
    if (k == null || k === 1) return p;
    const t = p.more + p.less; if (t <= 0) return p;
    const pm = clip(0.5 + k * (p.more / t - 0.5), 0.01, 0.99);
    return {more: pm * t, less: (1 - pm) * t, push: p.push, raw: p};
  }
  // Platt scaling fitted by the backtest: P(more) = sigmoid(a + b * logit(p)).
  function platt(p, c) {
    if (!c) return p;
    const t = p.more + p.less; if (t <= 0) return p;
    const x = clip(p.more / t, 1e-6, 1 - 1e-6), q = clip(1 / (1 + Math.exp(-(c.a + c.b * Math.log(x / (1 - x))))), 0.01, 0.99);
    return {more: q * t, less: (1 - q) * t, push: p.push, raw: p};
  }
  function invPhi(p) {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) return -invPhi(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // ---- kickoff times (schedule times are US Eastern) ----
  function nthSunday(y, month, n) { const d = new Date(Date.UTC(y, month, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return first + 7 * (n - 1); }
  function easternOffsetHours(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const start = nthSunday(y, 2, 2), end = nthSunday(y, 10, 1); // 2nd Sunday of March, 1st Sunday of November
    const md = m * 100 + d;
    return (md >= 300 + start && md < 1100 + end) ? -4 : -5;
  }
  function kickoffMs(g) {
    if (!g || !g.date) return Infinity;
    const [y, m, d] = g.date.split('-').map(Number);
    const [h, mi] = (g.time || '12:00').split(':').map(Number);
    return Date.UTC(y, m - 1, d, h, mi) - easternOffsetHours(g.date) * 3600e3;
  }

  function create(data, opts = {}) {
    const now = opts.now ?? Date.now();
    const plattBy = (opts.calib && opts.calib.platt) || null;
    const shrinkBy = (!plattBy && opts.calib && opts.calib.shrink) || {};
    const scaleBy = (opts.calib && opts.calib.scale) || {};
    const calibrate = (p, m) => plattBy ? platt(p, plattBy[m.k]) : shrink(p, shrinkBy[m.k]);
    const F = data.meta.fields;
    const players = data.players.map(pl => {
      const games = pl.g.map(r => { const o = {wk: r[0], opp: r[1], home: r[2]}; F.forEach((f, i) => o[f] = r[3 + i]); return o; });
      let prevObj = null, prevN = 0;
      if (pl.prev) { prevN = pl.prev[0]; prevObj = {}; F.forEach((f, i) => { if (f !== 'snp') prevObj[f] = pl.prev[1 + i]; }); }
      return {id: pl.id, n: pl.n, p: pl.p, t: pl.t, games, prevObj, prevN};
    });
    const def = {};
    Object.entries(data.def).forEach(([t, d]) => {
      def[t] = {gp: d.gp};
      ALL.forEach(pos => { if (Array.isArray(d[pos])) { const o = {}; F.forEach((f, i) => { if (f !== 'snp') o[f] = d[pos][i] ?? 0; }); def[t][pos] = o; } });
    });
    const defAvg = {};
    MARKETS.forEach(m => ALL.forEach(pos => {
      const vals = Object.values(def).map(d => d[pos] ? m.f(d[pos]) : 0);
      defAvg[pos + '|' + m.k] = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    }));
    const sched = data.sched;
    const unplayed = sched.filter(s => s.hs == null);
    const curWeek = unplayed.length ? Math.min(...unplayed.map(s => s.wk)) : null;
    const wkGames = unplayed.filter(s => s.wk === curWeek && s.total != null);
    const impAvg = wkGames.length ? wkGames.reduce((a, s) => a + s.total, 0) / wkGames.length / 2 : 22;

    // The team's next game that is not final. `started` means kickoff has passed: lines are locked.
    function nextGame(team) {
      const up = sched.filter(s => s.hs == null && (s.home === team || s.away === team)).sort((a, b) => a.wk - b.wk || kickoffMs(a) - kickoffMs(b));
      const g = up[0]; if (!g) return null;
      const home = g.home === team, opp = home ? g.away : g.home;
      let imp = null;
      if (g.total != null && g.spread != null) imp = home ? (g.total + g.spread) / 2 : (g.total - g.spread) / 2;
      const ko = kickoffMs(g);
      return {g, home, opp, imp, kickoff: ko, started: now >= ko, bye: g.wk !== curWeek};
    }
    function defFor(opp, pos, m) { const d = def[opp]; if (!d || !d[pos]) return null; return {val: m.f(d[pos]), gp: d.gp}; }

    function project(pl, m) {
      const xs = pl.games.map(g => m.f(g));
      const n = xs.length;
      let sw = 0, swx = 0;
      xs.forEach((x, i) => { const w = Math.pow(0.82, n - 1 - i); sw += w; swx += w * x; });
      const recent = n ? swx / sw : null;
      let base = recent, prior = null, k = 0;
      if (pl.prevObj) {
        prior = m.f(pl.prevObj); k = Math.min(3, pl.prevN / 5);
        base = n ? (swx + k * prior) / (sw + k) : prior;
      }
      if (base == null) return null;
      const ng = nextGame(pl.t);
      let fMatch = 1, mRank = null, allowed = null;
      if (ng) {
        const d = defFor(ng.opp, pl.p, m), avg = defAvg[pl.p + '|' + m.k];
        if (d && avg > 0) {
          allowed = d.val;
          const ratio = d.val / avg, w = m.k === 'int' ? 0.4 : 0.6;
          fMatch = clip(1 + (ratio - 1) * w * d.gp / (d.gp + 6), 0.85, 1.15);
          const all = Object.keys(def).map(t => defFor(t, pl.p, m)?.val ?? 0).sort((a, b) => b - a);
          mRank = all.indexOf(d.val) + 1;
        }
      }
      let fEnv = 1;
      if (ng && ng.imp != null && m.env) fEnv = clip(1 + (ng.imp / impAvg - 1) * m.env, 0.88, 1.12);
      const muRaw = base * fMatch * fEnv;
      let sd = null;
      if (m.kind === 'cont') {
        const mean = n ? xs.reduce((a, b) => a + b, 0) / n : muRaw;
        const s2 = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
        const t2 = (m.cv * Math.max(muRaw, 1)) ** 2;
        sd = Math.max(Math.sqrt((Math.max(n - 1, 0) * s2 + 4 * t2) / (Math.max(n - 1, 0) + 4)), 0.8);
      }
      // History adjustment from the backtest: the raw model ran high, so scale it to match results.
      const fHist = scaleBy[m.k] ?? 1, mu = muRaw * fHist;
      return {mu, muRaw, sd, xs, n, m26: recent, prior, k, base, fMatch, fEnv, fHist, ng, mRank, allowed};
    }

    function evaluate(pl, m, line) {
      const pr = project(pl, m); if (!pr) return null;
      const p = calibrate(probs(m, pr.mu, pr.sd, line), m);
      const over = pr.xs.filter(x => x > line).length, under = pr.xs.filter(x => x < line).length;
      const l5 = pr.xs.slice(-5), l5o = l5.filter(x => x > line).length;
      const side = p.more >= p.less ? 'more' : 'less';
      return {...pr, p, side, pSide: Math.max(p.more, p.less), over, under, l5n: l5.length, l5o};
    }

    // The worst x.5 line at which `side` still reaches probability `be` (after calibration).
    function targetLine(pr, m, side, be) {
      const ok = L => { const p = calibrate(probs(m, pr.mu, pr.sd, L), m); return (side === 'more' ? p.more : p.less) >= be; };
      const spread = m.kind === 'pois' ? 5 : Math.max(4 * (pr.sd || 1), 6);
      const top = Math.floor(pr.mu + spread) + 0.5;
      if (side === 'more') { for (let L = top; L >= 0.5; L -= 1) if (ok(L)) return L; return null; }
      for (let L = 0.5; L <= top; L += 1) if (ok(L)) return L; return null;
    }

    return {players, def, defAvg, sched, curWeek, impAvg, now, nextGame, project, evaluate, targetLine, calibrated: !!(plattBy || Object.keys(shrinkBy).length)};
  }

  const PropModel = {MARKETS, MK, ALL, fantasy, probs, shrink, platt, invPhi, kickoffMs, easternOffsetHours, create};
  if (typeof module !== 'undefined' && module.exports) module.exports = PropModel;
  root.PropModel = PropModel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
