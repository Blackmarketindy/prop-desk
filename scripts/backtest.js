#!/usr/bin/env node
/* Walk-forward backtest of the Prop Desk model.
 *
 * Usage: node scripts/backtest.js <snapshots.jsonl> <out backtest.json>
 *
 * For every snapshot (data as of the start of week W) the model projects each player's week-W
 * game with model.js, exactly as the app would have. Past PrizePicks lines are not available, so
 * each prop is tested against a stand-in line at the player's season-to-date average
 * (floor(avg) + 0.5), which is roughly where lines tend to open. Real lines are usually sharper.
 *
 * Output: accuracy by stat, a calibration table, and a per-stat shrink factor k that the app
 * uses to pull its probabilities toward 50% by however much the history says they run too hot.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PropModel = require(path.join(__dirname, '..', 'model.js'));
const {MARKETS} = PropModel;

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: backtest.js <snapshots.jsonl> <out.json>'); process.exit(2); }

// Minimum season-to-date average for a prop to be realistic enough to test.
const FLOOR = {pyd: 160, ptd: 0.6, cmp: 14, att: 22, int: 0.3, pry: 170, ryd: 25, car: 8, recyd: 25, rec: 2.5, rry: 40, td: 0.25, fan: 7};
const lineFor = (m, avg) => m.kind === 'pois' ? (avg >= 1.4 ? 1.5 : 0.5) : Math.floor(avg) + 0.5;

const records = [];
const lines = fs.readFileSync(inFile, 'utf8').split('\n').filter(Boolean);
for (const ln of lines) {
  const {season, week, data, actual} = JSON.parse(ln);
  const weekGames = data.sched.filter(g => g.wk === week);
  const now = Math.min(...weekGames.map(PropModel.kickoffMs)) - 3600e3; // an hour before the week's first kickoff
  const model = PropModel.create(data, {now});
  const F = data.meta.fields;
  for (const pl of model.players) {
    const a = actual[pl.id];
    if (!a || pl.games.length < 3) continue;           // must have history and have played in week W
    const [team, gid] = a;
    if (team !== pl.t) continue;                       // changed teams: skip
    const ng = model.nextGame(pl.t);
    if (!ng || ng.g.id !== gid) continue;
    const act = {}; F.forEach((f, i) => { if (f !== 'snp') act[f] = a[2 + i]; });
    for (const m of MARKETS) {
      if (!m.pos.includes(pl.p)) continue;
      const xs = pl.games.map(g => m.f(g)), avg = xs.reduce((s, x) => s + x, 0) / xs.length;
      if (avg < FLOOR[m.k]) continue;
      const pr = model.project(pl, m); if (!pr) continue;
      const line = lineFor(m, avg);
      const p = PropModel.probs(m, pr.mu, pr.sd, line);
      const y = m.f(act);
      if (y === line) continue;                         // x.5 lines never push; whole-number guard
      records.push({season, week, mk: m.k, kind: m.kind, line, sd: pr.sd, rawMu: pr.mu, p: p.more / (p.more + p.less), y: y > line ? 1 : 0, mu: pr.mu, actual: y, naive: avg});
    }
  }
}

const clamp = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const shrinkP = (p, k) => Math.min(0.99, Math.max(0.01, 0.5 + k * (p - 0.5)));
const logloss = (rs, k) => rs.reduce((s, r) => { const q = clamp(shrinkP(r.p, k)); return s - (r.y ? Math.log(q) : Math.log(1 - q)); }, 0) / (rs.length || 1);
const brier = (rs, k) => rs.reduce((s, r) => s + (shrinkP(r.p, k) - r.y) ** 2, 0) / (rs.length || 1);
function fitK(rs) {
  let best = 1, bestL = Infinity;
  for (let k = 0; k <= 1.5001; k += 0.01) { const l = logloss(rs, k); if (l < bestL) { bestL = l; best = k; } }
  return Math.round(best * 100) / 100;
}
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const logit = p => Math.log(clamp(p) / (1 - clamp(p)));
const sig = z => 1 / (1 + Math.exp(-z));
// Platt scaling: P(more) = sigmoid(a + b * logit(p)). `a` corrects a lean toward More or Less
// (for example skewed yardage), `b` < 1 pulls overconfident probabilities toward 50%.
function fitPlatt(rs) {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {           // Newton's method on the log loss
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of rs) { const x = logit(r.p), q = sig(a + b * x), w = q * (1 - q); ga += q - r.y; gb += (q - r.y) * x; haa += w; hab += w * x; hbb += w * x * x; }
    const det = haa * hbb - hab * hab; if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db; if (Math.abs(da) + Math.abs(db) < 1e-7) break;
  }
  if (b > 1) {                                // never let calibration make the model more confident
    b = 1; a = 0;
    for (let it = 0; it < 50; it++) { let g = 0, h = 0; for (const r of rs) { const q = sig(a + logit(r.p)); g += q - r.y; h += q * (1 - q); } if (h < 1e-12) break; const d = g / h; a -= d; if (Math.abs(d) < 1e-8) break; }
  }
  return {a: +a.toFixed(4), b: +b.toFixed(4)};
}
const plattP = (p, c) => sig(c.a + c.b * logit(p));
const brierPl = (rs, c) => rs.reduce((s, r) => s + (plattP(r.p, c) - r.y) ** 2, 0) / (rs.length || 1);

// Stage 1: per-stat scale so projections match actual results on average (the model ran high).
function fitScale(rs) { const a = rs.reduce((s, r) => s + r.actual, 0), m = rs.reduce((s, r) => s + r.rawMu, 0); return m > 0 ? Math.round(a / m * 1000) / 1000 : 1; }
function rescale(rs, scaleOf) {
  return rs.map(r => { const k = scaleOf(r), mu = r.rawMu * k, q = PropModel.probs({kind: r.kind}, mu, r.sd, r.line); return {...r, mu, p: q.more / (q.more + q.less)}; });
}
// Fit on everything except the current season, test on the current season (out of sample).
const seasons = [...new Set(records.map(r => r.season))].sort();
const testSeason = seasons.at(-1);
const scale = {}, scaleTrain = {};
for (const m of MARKETS) {
  const all = records.filter(r => r.mk === m.k); if (all.length < 40) continue;
  scale[m.k] = fitScale(all);
  const tr = all.filter(r => r.season !== testSeason); scaleTrain[m.k] = tr.length >= 40 ? fitScale(tr) : scale[m.k];
}
const rawRecords = records;
const scaled = rescale(records.filter(r => scale[r.mk]), r => scale[r.mk]);           // for the deployed fit
const scaledOos = rescale(records.filter(r => scale[r.mk]), r => scaleTrain[r.mk]);   // train-season scale only
const train = scaledOos.filter(r => r.season !== testSeason), test = scaledOos.filter(r => r.season === testSeason);

const markets = {}, shrink = {}, platt = {};
for (const m of MARKETS) {
  const all = scaled.filter(r => r.mk === m.k); if (all.length < 40) continue;
  const raw = rawRecords.filter(r => r.mk === m.k);
  const tr = train.filter(r => r.mk === m.k), te = test.filter(r => r.mk === m.k);
  const kTrain = tr.length >= 40 ? fitK(tr) : null, kAll = fitK(all);
  shrink[m.k] = kAll;
  const pAll = fitPlatt(all), pTrain = tr.length >= 40 ? fitPlatt(tr) : null;
  platt[m.k] = pAll;
  markets[m.k] = {
    label: m.label, n: all.length,
    scale: scale[m.k],
    maeModelRaw: +mean(raw.map(r => Math.abs(r.actual - r.rawMu))).toFixed(2),
    maeModel: +mean(all.map(r => Math.abs(r.actual - r.mu))).toFixed(2),
    maeNaive: +mean(all.map(r => Math.abs(r.actual - r.naive))).toFixed(2),
    biasRaw: +mean(raw.map(r => r.actual - r.rawMu)).toFixed(2),
    bias: +mean(all.map(r => r.actual - r.mu)).toFixed(2),
    overRate: +mean(all.map(r => r.y)).toFixed(3),
    brierUncalibrated: +brier(raw, 1).toFixed(4),
    brierRaw: +brier(all, 1).toFixed(4), brierCalibrated: +brier(all, kAll).toFixed(4), brierCoinFlip: 0.25,
    k: kAll, platt: pAll, brierPlatt: +brierPl(all, pAll).toFixed(4),
    outOfSample: te.length && kTrain != null ? {season: testSeason, n: te.length, kFromPriorSeasons: kTrain, brierRaw: +brier(te, 1).toFixed(4), brierCalibrated: +brier(te, kTrain).toFixed(4), plattFromPriorSeasons: pTrain, brierPlatt: pTrain ? +brierPl(te, pTrain).toFixed(4) : null} : null,
  };
}

// Calibration of the side the app would lean to. `cal(r)` returns the calibrated P(more).
function sideOf(rs, cal) { return rs.map(r => { const q = cal(r); const more = q >= 0.5; return {q: more ? q : 1 - q, hit: more ? r.y : 1 - r.y}; }); }
function buckets(rs, cal) {
  const edges = [0.5, 0.55, 0.6, 0.65, 0.7, 1.01];
  const all = sideOf(rs, cal);
  return edges.slice(0, -1).map((lo, i) => {
    const sel = all.filter(x => x.q >= lo && x.q < edges[i + 1]);
    return {from: lo, to: Math.min(edges[i + 1], 1), n: sel.length, predicted: +mean(sel.map(x => x.q)).toFixed(3), actual: +mean(sel.map(x => x.hit)).toFixed(3)};
  });
}
function clearing(rs, cal, be) {
  const sel = sideOf(rs, cal).filter(x => x.q >= be);
  return {threshold: +be.toFixed(3), n: sel.length, hitRate: +mean(sel.map(x => x.hit)).toFixed(3), predicted: +mean(sel.map(x => x.q)).toFixed(3)};
}
const usable = scaled.filter(r => platt[r.mk] != null);
const testUsable = test.filter(r => markets[r.mk] && markets[r.mk].outOfSample && markets[r.mk].outOfSample.plattFromPriorSeasons);
const oosCal = r => plattP(r.p, markets[r.mk].outOfSample.plattFromPriorSeasons);
const be2 = Math.sqrt(1 / 3);
let oosN = 0, oosRaw = 0, oosPl = 0;
const rawById = new Map(rawRecords.map((r, i) => [r, i]));
for (const r of testUsable) { oosN++; oosPl += (oosCal(r) - r.y) ** 2; }
for (const r of rawRecords.filter(r => r.season === testSeason && markets[r.mk])) { oosRaw += (r.p - r.y) ** 2; }
const out = {
  generated: new Date().toISOString(),
  method: 'Walk-forward: the data as it stood before each week, projected with model.js, tested against a stand-in line at floor(season-to-date average) + 0.5 because past PrizePicks lines are not available. Probabilities are calibrated per stat with Platt scaling: P(more) = sigmoid(a + b * logit(p)).',
  seasons, weeks: new Set(lines.map(l => { const o = JSON.parse(l); return `${o.season}-${o.week}`; })).size,
  n: usable.length,
  scale, platt, shrink,
  markets,
  calibration: {raw: buckets(rawRecords.filter(r => markets[r.mk]), r => r.p), calibrated: buckets(usable, r => plattP(r.p, platt[r.mk]))},
  breakEven2Pick: clearing(usable, r => plattP(r.p, platt[r.mk]), be2),
  outOfSample: {
    season: testSeason, n: oosN,
    note: `Calibration fitted on ${seasons.filter(x => x !== testSeason).join(', ')} only, then applied to ${testSeason} games it never saw.`,
    brierRaw: oosN ? +(oosRaw / oosN).toFixed(4) : null, brierCalibrated: oosN ? +(oosPl / oosN).toFixed(4) : null, brierCoinFlip: 0.25,
    calibration: buckets(testUsable, oosCal),
    breakEven2Pick: clearing(testUsable, oosCal, be2),
  },
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('scale', JSON.stringify(scale));
console.log(`records ${records.length}, usable ${usable.length}, weeks ${out.weeks}, seasons ${seasons.join(',')}`);
for (const [k, v] of Object.entries(markets)) console.log(k.padEnd(6), 'n', String(v.n).padStart(5), 'MAE raw', v.maeModelRaw, 'scaled', v.maeModel, 'vs avg', v.maeNaive, 'bias', v.bias, 'over%', v.overRate, 'brier raw', v.brierRaw, 'platt', v.brierPlatt, v.outOfSample ? `| oos raw ${v.outOfSample.brierRaw} platt ${v.outOfSample.brierPlatt} (n ${v.outOfSample.n})` : '');
console.log('calibrated (in-sample)', JSON.stringify(out.calibration.calibrated));
console.log('out of sample', JSON.stringify({n: oosN, brierRaw: out.outOfSample.brierRaw, brierCal: out.outOfSample.brierCalibrated}));
console.log('oos buckets', JSON.stringify(out.outOfSample.calibration));
console.log('2-pick clear (in-sample)', JSON.stringify(out.breakEven2Pick), 'oos', JSON.stringify(out.outOfSample.breakEven2Pick));
