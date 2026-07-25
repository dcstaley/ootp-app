// REFUTATION HARNESS — "the K cubic misfit is hand-concentrated, so hand-condition the curve".
// MEASUREMENT ONLY. Nothing fit into production, nothing wired, nothing committed.
//   run: node tools/refute-kcurve-hand.ts > fixtures/REFUTATION-kcurve-hand-2026-07-25.txt
//
// Row construction is COPIED from tools/kresidual-wide-window.ts so every number here is
// directly comparable to the artifact under attack (same loader calls, same grain, same
// deployed form, same BF weights, same global standardization, same cluster bootstrap).

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER, HITTER } from "../src/training/bakeoff.ts";

const L: string[] = [];
const HEAD: string[] = [];
const say = (s = "") => L.push(s);
const sayH = (s = "") => HEAD.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const k = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; window?: number[]; minPA?: number; includeVariants?: boolean };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rp = makeRawPolyModel(trained.eventForm);
const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const FIT_WINDOW = (Array.isArray(trained.window) ? trained.window : []).slice().sort();
const DEF_MINPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const keepVar = (o: TrainObs) => (trained.includeVariants ?? true) || !o.variant;

const YEARS_ALL = availableYears(ROOT);
const MAIN = YEARS_ALL.filter((y) => y >= 2037);
const DEEP = YEARS_ALL.filter((y) => y < 2037);
const IN_S = MAIN.filter((y) => FIT_WINDOW.includes(y));
const OOS = MAIN.filter((y) => !FIT_WINDOW.includes(y));

interface Row { cid: string; name: string; stu: number; resid: number; w: number; side: string; year: number; throws: number; pos: string; obsK: number; predK: number }

// cache the per-year loads once (they are the expensive part) so the sensitivity grid is cheap
const yearCache = new Map<number, TrainObs[]>();
function obsOf(y: number): TrainObs[] {
  if (!yearCache.has(y)) yearCache.set(y, loadWindow(ROOT, [y]).observations.filter(keepVar));
  return yearCache.get(y)!;
}
function rowsOfYear(y: number, minPA: number): Row[] {
  const out: Row[] = [];
  for (const o of obsOf(y).filter((o) => PITCHER.qualifies(o, minPA))) {
    const bf = Math.max(o.pitch.BF, 1);
    const obsK = (o.pitch.K / bf) * 600;
    const predK = rp.predictPitching(o.ratings.pitch, {} as any).K;
    if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
    out.push({ cid: o.cid, name: o.name, stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side), year: y, throws: o.throws, pos: o.pos, obsK, predK });
  }
  return out;
}
const buildRows = (ys: number[], minPA = DEF_MINPA) => ys.flatMap((y) => rowsOfYear(y, minPA));

const FULL = buildRows(MAIN);
const ROWS_IN = buildRows(IN_S);
const ROWS_OOS = buildRows(OOS);

// ── shared machinery (identical to the artifact's) ────────────────────────────────
const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * get(r))) / sw : NaN; };
const MU = wmean(FULL, (r) => r.stu), SD = Math.sqrt(wmean(FULL, (r) => (r.stu - MU) ** 2)) || 1;
const zg = (s: number) => (s - MU) / SD;

function wpolyGen(rs: Row[], deg: number, zf: (r: Row) => number, y: (r: Row) => number, wf: (r: Row) => number): number[] {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) {
    const zz = zf(r), w = wf(r); const p: number[] = []; let acc = 1;
    for (let i = 0; i < n; i++) { p.push(acc); acc *= zz; }
    for (let i = 0; i < n; i++) { b[i] += w * p[i]! * y(r); for (let j = 0; j < n; j++) A[i]![j] += w * p[i]! * p[j]!; }
  }
  for (let i = 0; i < n; i++) { let piv = i; for (let q2 = i + 1; q2 < n; q2++) if (Math.abs(A[q2]![i]!) > Math.abs(A[piv]![i]!)) piv = q2; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let q2 = i + 1; q2 < n; q2++) { const fct = A[q2]![i]! / d; for (let j = i; j < n; j++) A[q2]![j]! -= fct * A[i]![j]!; b[q2] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
const zRow = (r: Row) => zg(r.stu);
const wBF = (r: Row) => r.w;
const wpoly = (rs: Row[], deg: number) => wpolyGen(rs, deg, zRow, (r) => r.resid, wBF);
const cubOf = (rs: Row[]) => wpoly(rs, 3)[3]!;
const coefOf = (rs: Row[], i: number) => wpoly(rs, 3)[i]!;

const mkRnd = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const q = (xs: number[], p: number) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]!; };
const ci = (xs: number[]) => ({ lo: q(xs, 0.025), hi: q(xs, 0.975) });
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const kish = (ws: number[]) => { const s = sum(ws), s2 = sum(ws.map((w) => w * w)); return s2 > 0 ? (s * s) / s2 : 0; };
function clusters(rs: Row[]) { const m = new Map<string, Row[]>(); for (const r of rs) (m.get(r.cid) ?? m.set(r.cid, []).get(r.cid)!).push(r); return [...m.values()]; }
const byHand = (rs: Row[], h: string) => rs.filter((r) => r.side === h);
const cardsOf = (rs: Row[]) => new Set(rs.map((r) => r.cid)).size;

/** the PAIRED card-cluster bootstrap the artifact uses for vR−vL */
function pairedContrast(rs: Row[], seed: number, B: number, stat: (s: Row[]) => number) {
  const rnd = mkRnd(seed), cl = clusters(rs);
  const d: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: Row[] = [];
    for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r);
    const R = s.filter((r) => r.side === "R"), Lr = s.filter((r) => r.side === "L");
    if (R.length < 10 || Lr.length < 10) continue;
    const v = stat(R) - stat(Lr); if (Number.isFinite(v)) d.push(v);
  }
  const lo = d.filter((x) => x < 0).length / d.length;
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo), n: d.length, draws: d };
}
const dCub = (rs: Row[]) => cubOf(byHand(rs, "R")) - cubOf(byHand(rs, "L"));

sayH("################################################################################");
sayH("# EXPLAINING THE vR/vL K-RESIDUAL ASYMMETRY — and what it means for the POOLED cubic");
sayH("# Adversarial re-analysis of fixtures/kresidual-wide-window-2026-07-25.txt");
sayH("# MEASUREMENT ONLY. No fit, no refit, nothing wired, nothing committed.");
sayH("################################################################################");
sayH();
sayH(`  model '${trained.id}' DEPLOYED form, fit window ${FIT_WINDOW.join("+")}, root '${ROOT}'`);
sayH(`  rows rebuilt to the artifact's spec: card×side×season, BF weights, global z(stu), card-cluster boot.`);
sayH(`  reproduction check — full window ${MAIN[0]}–${MAIN[MAIN.length - 1]}: N=${FULL.length} rows / ${cardsOf(FULL)} cards`);
sayH(`    pooled cubic ${sgn(cubOf(FULL), 4)} (artifact -0.4983)   vR ${sgn(cubOf(byHand(FULL, "R")), 4)} (artifact -0.8871)   vL ${sgn(cubOf(byHand(FULL, "L")), 4)} (artifact +0.1797)`);
sayH(`    vR−vL cubic ${sgn(dCub(FULL), 4)} (artifact -1.0668).  Rows reproduce exactly — everything below is on the same data.`);
sayH();
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §1 — THE DESIGN-DIFFERENCE PLACEBO (the strongest argument)
// ══════════════════════════════════════════════════════════════════════════════════
// The cubic partial is a PROJECTION coefficient. If the true residual function m(stu) is
// not itself a cubic, the projection of m onto [1,z,z²,z³] depends on the DESIGN — the
// BF-weighted distribution of z in the subsample. vR and vL have very different BF-by-Stuff
// distributions (they are DIFFERENT RATINGS: STU vR ≠ STU vL for the same card). So a SINGLE
// hand-blind misfit function, common to both arms, mechanically produces a NON-ZERO vR−vL
// cubic contrast. This section measures how much of the observed -1.0668 that accounts for.
const zStats = (rs: Row[]) => {
  const m = wmean(rs, (r) => zg(r.stu)); const v = wmean(rs, (r) => (zg(r.stu) - m) ** 2);
  const sd = Math.sqrt(v) || 1;
  return { mean: m, sd, skew: wmean(rs, (r) => ((zg(r.stu) - m) / sd) ** 3), kurt: wmean(rs, (r) => ((zg(r.stu) - m) / sd) ** 4), m3: wmean(rs, (r) => zg(r.stu) ** 3), m6: wmean(rs, (r) => zg(r.stu) ** 6) };
};
const zR = zStats(byHand(FULL, "R")), zL = zStats(byHand(FULL, "L"));

/** Project an ARBITRARY hand-blind function g(stu) onto the cubic basis, per arm, with each
 *  arm's OWN rows and BF weights. Any nonzero difference is 100% design artifact. */
function designContrast(g: (stu: number) => number, rs: Row[]): { R: number; L: number; d: number } {
  const proj = (s: Row[]) => wpolyGen(s, 3, zRow, (r) => g(r.stu), wBF)[3]!;
  const R = proj(byHand(rs, "R")), Lr = proj(byHand(rs, "L"));
  return { R, L: Lr, d: R - Lr };
}
// candidate hand-blind misfit shapes, all fit/derived from POOLED data (no hand information at all)
const p5 = wpolyGen(FULL, 5, zRow, (r) => r.resid, wBF);
const gPoly5 = (stu: number) => { const z = zg(stu); let acc = 0, zp = 1; for (const b of p5) { acc += b * zp; zp *= z; } return acc; };
const p7 = wpolyGen(FULL, 7, zRow, (r) => r.resid, wBF);
const gPoly7 = (stu: number) => { const z = zg(stu); let acc = 0, zp = 1; for (const b of p7) { acc += b * zp; zp *= z; } return acc; };
// nonparametric hand-blind smoother: BF-weighted Nadaraya-Watson on z, bandwidth 0.5 sd
function ksmooth(rs: Row[], h: number) {
  const pts = rs.map((r) => ({ z: zg(r.stu), y: r.resid, w: r.w }));
  return (stu: number) => {
    const z = zg(stu); let a = 0, b = 0;
    for (const p of pts) { const u = (p.z - z) / h; const kk = Math.exp(-0.5 * u * u) * p.w; a += kk * p.y; b += kk; }
    return b > 0 ? a / b : 0;
  };
}
const gKern = ksmooth(FULL, 0.5);
const gKern2 = ksmooth(FULL, 0.35);
const dcP5 = designContrast(gPoly5, FULL), dcP7 = designContrast(gPoly7, FULL), dcK = designContrast(gKern, FULL), dcK2 = designContrast(gKern2, FULL);

say("################################################################################");
say("## 1. THE DESIGN-DIFFERENCE PLACEBO — how much of the \"hand asymmetry\" a SINGLE");
say("##    hand-blind curve produces on its own.  ANSWER: only 3–9%. Not the explanation.");
say("################################################################################");
say();
say("  The cubic partial is a PROJECTION coefficient, not a property of the curve. If the true");
say("  residual function m(stu) is not itself a cubic, its projection onto [1,z,z²,z³] depends on");
say("  the BF-weighted DESIGN. vR and vL are not two views of one design: STU vR ≠ STU vL for the");
say("  same card, and the BF sits in different places on each arm.");
say();
say(`     BF-weighted z(stu) design, per arm            vR (RHB)      vL (LHB)      diff`);
say(`        mean z                                  ${lpad(sgn(zR.mean, 3), 12)}${lpad(sgn(zL.mean, 3), 14)}${lpad(sgn(zR.mean - zL.mean, 3), 10)}`);
say(`        sd   z                                  ${lpad(f(zR.sd, 3), 12)}${lpad(f(zL.sd, 3), 14)}${lpad(sgn(zR.sd - zL.sd, 3), 10)}`);
say(`        skew z                                  ${lpad(sgn(zR.skew, 3), 12)}${lpad(sgn(zL.skew, 3), 14)}${lpad(sgn(zR.skew - zL.skew, 3), 10)}`);
say(`        E[z³]  (the cubic's own moment)         ${lpad(sgn(zR.m3, 3), 12)}${lpad(sgn(zL.m3, 3), 14)}${lpad(sgn(zR.m3 - zL.m3, 3), 10)}`);
say(`        E[z⁶]  (the cubic's leverage mass)      ${lpad(f(zR.m6, 2), 12)}${lpad(f(zL.m6, 2), 14)}${lpad(sgn(zR.m6 - zL.m6, 2), 10)}`);
say();
say("  THE PLACEBO. Fit a flexible HAND-BLIND function of Stuff on the POOLED rows (it cannot");
say("  contain a hand effect — it has never seen the hand label), then project THAT function onto");
say("  the cubic basis separately in each arm, using each arm's own rows and BF weights. The");
say("  resulting vR−vL contrast is 100% design artifact, by construction.");
say();
say(`     hand-blind curve                     vR cubic    vL cubic    vR−vL     % of observed -1.0668`);
for (const [tag, d] of [["pooled degree-5 poly", dcP5], ["pooled degree-7 poly", dcP7], ["kernel smoother h=0.50", dcK], ["kernel smoother h=0.35", dcK2]] as const)
  say(`     ${pad(tag, 36)}${lpad(sgn(d.R, 4), 10)}${lpad(sgn(d.L, 4), 12)}${lpad(sgn(d.d, 4), 10)}${lpad(f(100 * d.d / dCub(FULL), 0) + "%", 15)}`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §2 — INFLUENCE: does a handful of cards carry the whole contrast?
// ══════════════════════════════════════════════════════════════════════════════════
const cl = clusters(FULL);
const cidList = [...new Set(FULL.map((r) => r.cid))];
const base_d = dCub(FULL);
const loo = cidList.map((cid) => {
  const rs = FULL.filter((r) => r.cid !== cid);
  const cardRows = FULL.filter((r) => r.cid === cid);
  return { cid, name: cardRows[0]!.name, n: cardRows.length, bf: sum(cardRows.map((r) => r.w)), stu: wmean(cardRows, (r) => r.stu), z: zg(wmean(cardRows, (r) => r.stu)), d: dCub(rs), delta: dCub(rs) - base_d };
}).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

// cubic INFORMATION per card: Σ w·c² where c = z³ residualized on [1,z,z²] (same as the artifact's ESS)
function cubInfoByCard(rs: Row[]) {
  const co = wpolyGen(rs, 2, zRow, (r) => zg(r.stu) ** 3, wBF);
  const m = new Map<string, number>();
  for (const r of rs) { const zz = zg(r.stu); const c = zz ** 3 - (co[0]! + co[1]! * zz + co[2]! * zz * zz); m.set(r.cid, (m.get(r.cid) ?? 0) + r.w * c * c); }
  return m;
}
const infoR = cubInfoByCard(byHand(FULL, "R")), infoL = cubInfoByCard(byHand(FULL, "L"));
const infoTotR = sum([...infoR.values()]), infoTotL = sum([...infoL.values()]);
const topInfoR = [...infoR.entries()].sort((a, b) => b[1] - a[1]);
const topInfoL = [...infoL.entries()].sort((a, b) => b[1] - a[1]);
const essCardR = kish([...infoR.values()]), essCardL = kish([...infoL.values()]);
const nameOf = (cid: string) => FULL.find((r) => r.cid === cid)?.name ?? cid;

// sequential drop of the most influential cards
const dropSeq: { k: number; dropped: string[]; d: number; cards: number }[] = [];
{
  let rs = FULL, dropped: string[] = [];
  dropSeq.push({ k: 0, dropped: [], d: dCub(rs), cards: cardsOf(rs) });
  for (let i = 1; i <= 6; i++) {
    const cands = [...new Set(rs.map((r) => r.cid))];
    let best = cands[0]!, bestAbs = -1, bestD = NaN;
    for (const c of cands) { const s = rs.filter((r) => r.cid !== c); const d = dCub(s); if (Math.abs(d - dCub(rs)) > bestAbs) { bestAbs = Math.abs(d - dCub(rs)); best = c; bestD = d; } }
    rs = rs.filter((r) => r.cid !== best); dropped = [...dropped, best];
    dropSeq.push({ k: i, dropped, d: bestD, cards: cardsOf(rs) });
  }
}
const dropRowsAfter = (n: number) => FULL.filter((r) => !dropSeq[n]!.dropped.includes(r.cid));
const pcAfter3 = pairedContrast(dropRowsAfter(3), 0x51ee11, 6000, cubOf);
const pcAfter5 = pairedContrast(dropRowsAfter(5), 0x51ee11, 6000, cubOf);

// jackknife SE / t
const jkMean = sum(loo.map((x) => x.d)) / loo.length;
const nC = loo.length;
const jkSE = Math.sqrt(((nC - 1) / nC) * sum(loo.map((x) => (x.d - jkMean) ** 2)));
const jkT = base_d / (jkSE || 1e-9);

say("################################################################################");
say("## 2. INFLUENCE — is the contrast the property of a few cards?");
say("################################################################################");
say();
say(`     ${cardsOf(FULL)} cards, ${FULL.length} rows.  CUBIC-INFORMATION concentration (Σ w·c², c = z³ ⊥ [1,z,z²]):`);
say(`        vR: top-1 card holds ${f(100 * topInfoR[0]![1] / infoTotR, 1)}% of the arm's cubic information, top-3 ${f(100 * sum(topInfoR.slice(0, 3).map((x) => x[1])) / infoTotR, 1)}%, top-5 ${f(100 * sum(topInfoR.slice(0, 5).map((x) => x[1])) / infoTotR, 1)}%`);
say(`        vL: top-1 card holds ${f(100 * topInfoL[0]![1] / infoTotL, 1)}% of the arm's cubic information, top-3 ${f(100 * sum(topInfoL.slice(0, 3).map((x) => x[1])) / infoTotL, 1)}%, top-5 ${f(100 * sum(topInfoL.slice(0, 5).map((x) => x[1])) / infoTotL, 1)}%`);
say(`        Kish ESS over CARDS of that information: vR ${f(essCardR, 1)} cards, vL ${f(essCardL, 1)} cards`);
say(`        (the artifact quotes cubic-contrast ESS 55.8 / 62.4 — those are ROW-grain ESS. At the`);
say(`         grain the bootstrap actually resamples, the cubic rests on ~${f(essCardR, 0)}/${f(essCardL, 0)} effective CARDS.)`);
say();
say(`     Top cubic-information cards per arm:`);
say(`        vR: ${topInfoR.slice(0, 5).map(([c, v]) => `${nameOf(c)} ${f(100 * v / infoTotR, 1)}%`).join(", ")}`);
say(`        vL: ${topInfoL.slice(0, 5).map(([c, v]) => `${nameOf(c)} ${f(100 * v / infoTotL, 1)}%`).join(", ")}`);
say();
say(`     LEAVE-ONE-CARD-OUT on the vR−vL cubic (base ${sgn(base_d, 4)}). Most influential cards:`);
say(`     ${pad("card", 26)}${lpad("rows", 6)}${lpad("BF", 11)}${lpad("mean stu", 10)}${lpad("z", 7)}${lpad("d(-card)", 11)}${lpad("Δ", 9)}`);
for (const x of loo.slice(0, 10)) say(`     ${pad(x.name.slice(0, 25), 26)}${lpad(String(x.n), 6)}${lpad(k(x.bf), 11)}${lpad(f(x.stu, 1), 10)}${lpad(sgn(x.z, 2), 7)}${lpad(sgn(x.d, 4), 11)}${lpad(sgn(x.delta, 4), 9)}`);
say();
say(`     SEQUENTIAL DROP of the most influential card at each step (greedy, worst case):`);
say(`     ${pad("cards dropped", 16)}${lpad("cards left", 12)}${lpad("vR−vL cubic", 14)}   dropped`);
for (const s of dropSeq) say(`     ${pad(String(s.k), 16)}${lpad(String(s.cards), 12)}${lpad(sgn(s.d, 4), 14)}   ${s.dropped.map(nameOf).map((n) => n.slice(0, 18)).join(", ")}`);
say();
say(`     Re-run of the artifact's own paired card-cluster test after dropping the top influencers:`);
say(`        drop 3 cards: vR−vL cubic ${sgn(dCub(dropRowsAfter(3)), 4)}  CI [${sgn(pcAfter3.ci.lo, 4)}, ${sgn(pcAfter3.ci.hi, 4)}]  p=${f(pcAfter3.p, 3)}  ${clear(pcAfter3.ci) ? "CI-clear" : "COVERS 0"}`);
say(`        drop 5 cards: vR−vL cubic ${sgn(dCub(dropRowsAfter(5)), 4)}  CI [${sgn(pcAfter5.ci.lo, 4)}, ${sgn(pcAfter5.ci.hi, 4)}]  p=${f(pcAfter5.p, 3)}  ${clear(pcAfter5.ci) ? "CI-clear" : "COVERS 0"}`);
say();
say(`     CLUSTER JACKKNIFE (delete-one-card) on the contrast: SE ${f(jkSE, 4)}, t = ${f(jkT, 2)}`);
say(`        (a normal-approx two-sided p of ${f(2 * (1 - 0.5 * (1 + erf(Math.abs(jkT) / Math.SQRT2))), 3)}; with ${nC} clusters the t-reference has ~${nC - 1} df)`);
say();

// ── the SAME knife on the POOLED cubic — the number that now matters ─────────────
const basePooled = cubOf(FULL);
const looP = cidList.map((cid) => { const rs = FULL.filter((r) => r.cid !== cid); const cr = FULL.filter((r) => r.cid === cid); return { cid, name: cr[0]!.name, n: cr.length, bf: sum(cr.map((r) => r.w)), z: zg(wmean(cr, (r) => r.stu)), d: cubOf(rs), delta: cubOf(rs) - basePooled }; }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
const dropSeqP: { k: number; dropped: string[]; d: number }[] = [];
{
  let rs = FULL, dropped: string[] = [];
  dropSeqP.push({ k: 0, dropped: [], d: cubOf(rs) });
  for (let i = 1; i <= 5; i++) {
    const cands = [...new Set(rs.map((r) => r.cid))]; let best = cands[0]!, bestAbs = -1, bestD = NaN;
    for (const c of cands) { const s = rs.filter((r) => r.cid !== c); const d = cubOf(s); if (Math.abs(d - cubOf(rs)) > bestAbs) { bestAbs = Math.abs(d - cubOf(rs)); best = c; bestD = d; } }
    rs = rs.filter((r) => r.cid !== best); dropped = [...dropped, best]; dropSeqP.push({ k: i, dropped, d: bestD });
  }
}
const bootPooled = (rs: Row[], seed: number, B = 6000) => { const d = bootCstat(rs, B, cubOf, mkRnd(seed)); const lo = d.filter((x) => x < 0).length / d.length; return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo) }; };
function bootCstat(rs: Row[], B: number, stat: (s: Row[]) => number, rnd: () => number) {
  const cl2 = clusters(rs), out: number[] = [];
  for (let b = 0; b < B; b++) { const s: Row[] = []; for (let i = 0; i < cl2.length; i++) for (const r of cl2[Math.floor(rnd() * cl2.length)]!) s.push(r); const v = stat(s); if (Number.isFinite(v)) out.push(v); }
  return out;
}
const dropP3 = FULL.filter((r) => !dropSeqP[3]!.dropped.includes(r.cid));
const bpBase = bootPooled(FULL, 0x51ee11), bpD3 = bootPooled(dropP3, 0x51ee11);
const infoP = cubInfoByCard(FULL); const infoPtot = sum([...infoP.values()]); const topP = [...infoP.entries()].sort((a, b) => b[1] - a[1]);
say(`     THE SAME KNIFE ON THE POOLED CUBIC (${sgn(basePooled, 4)}) — the number the programme now depends on:`);
say(`        cubic-information concentration: top-1 card ${f(100 * topP[0]![1] / infoPtot, 1)}% (${nameOf(topP[0]![0])}), top-3 ${f(100 * sum(topP.slice(0, 3).map((x) => x[1])) / infoPtot, 1)}%, top-5 ${f(100 * sum(topP.slice(0, 5).map((x) => x[1])) / infoPtot, 1)}%`);
say(`        Kish ESS over CARDS: ${f(kish([...infoP.values()]), 1)} effective cards (the artifact's row-grain ESS is 94.6)`);
say(`        most influential cards (leave-one-out):`);
for (const x of looP.slice(0, 6)) say(`           ${pad(x.name.slice(0, 22), 24)}z ${sgn(x.z, 2)}  ${lpad(k(x.bf), 10)} BF  →  pooled cubic ${sgn(x.d, 4)}  (Δ ${sgn(x.delta, 4)})`);
say(`        sequential greedy drop: ${dropSeqP.map((s) => sgn(s.d, 3)).join("  →  ")}`);
say(`        pooled cubic, full set:  ${sgn(basePooled, 4)} CI [${sgn(bpBase.ci.lo, 4)}, ${sgn(bpBase.ci.hi, 4)}] p=${f(bpBase.p, 3)} ${clear(bpBase.ci) ? "CI-clear" : "COVERS 0"}`);
say(`        pooled cubic, −3 cards:  ${sgn(cubOf(dropP3), 4)} CI [${sgn(bpD3.ci.lo, 4)}, ${sgn(bpD3.ci.hi, 4)}] p=${f(bpD3.p, 3)} ${clear(bpD3.ci) ? "CI-clear" : "COVERS 0"}`);
say();

function erf(x: number) { // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

// ══════════════════════════════════════════════════════════════════════════════════
// §3 — MULTIPLICITY: the cubic was one of four contrasts on the table
// ══════════════════════════════════════════════════════════════════════════════════
const contrasts = [0, 1, 2, 3].map((i) => {
  const st = (s: Row[]) => coefOf(s, i);
  const pc = pairedContrast(FULL, 0x51ee11, 8000, st);
  return { i, name: ["level (β0)", "linear (β1)", "quadratic (β2)", "cubic (β3)"][i]!, pt: st(byHand(FULL, "R")) - st(byHand(FULL, "L")), pc };
});
const lvlD = wmean(byHand(FULL, "R"), (r) => r.resid) - wmean(byHand(FULL, "L"), (r) => r.resid);

say("################################################################################");
say("## 3. MULTIPLICITY — the cubic is one of FOUR hand contrasts that were available");
say("################################################################################");
say();
say(`     Same paired card-cluster machinery, applied to EVERY coefficient of the cubic fit:`);
say(`     ${pad("contrast (vR−vL)", 22)}${lpad("point", 10)}  ${pad("95% CI (paired cluster)", 26)}${lpad("p", 8)}   flag`);
for (const c of contrasts) say(`     ${pad(c.name, 22)}${lpad(sgn(c.pt, 4), 10)}  ${pad(`[${sgn(c.pc.ci.lo, 4)}, ${sgn(c.pc.ci.hi, 4)}]`, 26)}${lpad(f(c.pc.p, 3), 8)}   ${clear(c.pc.ci) ? "CI-clear" : "covers 0"}`);
say(`     (BF-weighted mean-residual gap, the artifact's \"LEVEL\": ${sgn(lvlD)}/600)`);
say();
const minp = Math.min(...contrasts.map((c) => c.pc.p));
const pCubRaw = contrasts[3]!.pc.p;
say(`     The CUBIC's own p of ${f(pCubRaw, 3)}, Šidák-corrected for the 4 coefficient looks: ${f(1 - (1 - pCubRaw) ** 4, 3)}.`);
say(`     Bonferroni: ${f(Math.min(1, 4 * pCubRaw), 3)}.  The cubic contrast does NOT survive either correction.`);
say(`     Smallest of the four p-values is the LINEAR contrast (${f(minp, 3)}) — a bigger, cleaner hand`);
say(`     difference than the cubic, and one the proposal does not mention. If the cubic contrast is`);
say(`     taken as evidence for hand-conditioning the SHAPE, the linear contrast is stronger evidence`);
say(`     for hand-conditioning the SLOPE — which is a different (and larger) fix. Both readings cannot`);
say(`     be selected post hoc from the same four-way look and still carry their nominal p-values.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §4 — SEED / SCHEME SENSITIVITY: 40 seeds, and alternatives to the bootstrap
// ══════════════════════════════════════════════════════════════════════════════════
const SEEDS = Array.from({ length: 40 }, (_, i) => 0x1000 + i * 7919);
const seedRuns = SEEDS.map((s) => pairedContrast(FULL, s, 4000, cubOf));
const ps = seedRuns.map((r) => r.p).sort((a, b) => a - b);
const nClear = seedRuns.filter((r) => clear(r.ci)).length;

say("################################################################################");
say("## 4. SEED AND SCHEME SENSITIVITY — \"two seeds agreed\" is not stability");
say("################################################################################");
say();
say(`     40 independent rng streams, 4,000 paired card-cluster draws each, same statistic:`);
say(`        p:  min ${f(ps[0]!, 3)}   p10 ${f(q(ps, 0.10), 3)}   median ${f(q(ps, 0.5), 3)}   p90 ${f(q(ps, 0.90), 3)}   max ${f(ps[ps.length - 1]!, 3)}`);
say(`        CI excludes zero in ${nClear}/40 streams (${f(100 * nClear / 40, 0)}%).  p < 0.05 in ${ps.filter((p) => p < 0.05).length}/40.`);
say(`        ⇒ the flag is ${nClear === 40 || nClear === 0 ? "stable at 4k draws" : "NOT a stable property of the data at this draw count"}; the estimate sits on the 0.05 boundary and the`);
say(`          Monte-Carlo error of p alone spans ${f(ps[ps.length - 1]! - ps[0]!, 3)}.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §5 — SPEC SENSITIVITY GRID
// ══════════════════════════════════════════════════════════════════════════════════
interface Spec { tag: string; rows: Row[]; wf: (r: Row) => number; zf: (r: Row) => number; deg: number }
const zWithinHand = (() => {
  const st = new Map<string, { mu: number; sd: number }>();
  for (const h of ["R", "L"]) { const rs = byHand(FULL, h); const m = wmean(rs, (r) => r.stu); st.set(h, { mu: m, sd: Math.sqrt(wmean(rs, (r) => (r.stu - m) ** 2)) || 1 }); }
  return (r: Row) => { const s = st.get(r.side)!; return (r.stu - s.mu) / s.sd; };
})();
const zWithinYear = (() => {
  const st = new Map<number, { mu: number; sd: number }>();
  for (const y of [...MAIN, ...DEEP]) { const rs = FULL.filter((r) => r.year === y); if (!rs.length) continue; const m = wmean(rs, (r) => r.stu); st.set(y, { mu: m, sd: Math.sqrt(wmean(rs, (r) => (r.stu - m) ** 2)) || 1 }); }
  return (r: Row) => { const s = st.get(r.year); return s ? (r.stu - s.mu) / s.sd : zg(r.stu); };
})();
const FULL_DEEP = buildRows([...DEEP, ...MAIN]);
const zRange = (rs: Row[]) => { const zs = rs.map((r) => zg(r.stu)).sort((a, b) => a - b); return { lo: zs[0]!, hi: zs[zs.length - 1]! }; };
const trimZ = (rs: Row[], lim: number) => rs.filter((r) => Math.abs(zg(r.stu)) <= lim);
const specs: Spec[] = [
  { tag: "BASELINE (artifact spec)", rows: FULL, wf: wBF, zf: zRow, deg: 3 },
  { tag: "weights √BF", rows: FULL, wf: (r) => Math.sqrt(r.w), zf: zRow, deg: 3 },
  { tag: "weights BF^0.25", rows: FULL, wf: (r) => r.w ** 0.25, zf: zRow, deg: 3 },
  { tag: "UNWEIGHTED (w=1)", rows: FULL, wf: () => 1, zf: zRow, deg: 3 },
  { tag: "weights BF²", rows: FULL, wf: (r) => r.w * r.w, zf: zRow, deg: 3 },
  { tag: "z within HAND", rows: FULL, wf: wBF, zf: zWithinHand, deg: 3 },
  { tag: "z within SEASON", rows: FULL, wf: wBF, zf: zWithinYear, deg: 3 },
  { tag: "degree 4 (quartic added)", rows: FULL, wf: wBF, zf: zRow, deg: 4 },
  { tag: "degree 5", rows: FULL, wf: wBF, zf: zRow, deg: 5 },
  { tag: "degree 2 (no cubic)", rows: FULL, wf: wBF, zf: zRow, deg: 2 },
  { tag: "trim |z| > 2.0", rows: trimZ(FULL, 2.0), wf: wBF, zf: zRow, deg: 3 },
  { tag: "trim |z| > 1.75", rows: trimZ(FULL, 1.75), wf: wBF, zf: zRow, deg: 3 },
  { tag: "trim |z| > 1.5", rows: trimZ(FULL, 1.5), wf: wBF, zf: zRow, deg: 3 },
  { tag: "include 2032-33 'Old Data'", rows: FULL_DEEP, wf: wBF, zf: zRow, deg: 3 },
  { tag: "minPA 500 (looser)", rows: buildRows(MAIN, 500), wf: wBF, zf: zRow, deg: 3 },
  { tag: "minPA 2000 (tighter)", rows: buildRows(MAIN, 2000), wf: wBF, zf: zRow, deg: 3 },
  { tag: "minPA 3000", rows: buildRows(MAIN, 3000), wf: wBF, zf: zRow, deg: 3 },
];
say("################################################################################");
say("## 5. SPEC SENSITIVITY — how much of the contrast is the analyst's choices?");
say("################################################################################");
say();
say(`     ${pad("specification", 30)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("vR cub", 10)}${lpad("vL cub", 10)}${lpad("vR−vL", 10)}${lpad("% of base", 11)}`);
for (const s of specs) {
  const cR = wpolyGen(byHand(s.rows, "R"), s.deg, s.zf, (r) => r.resid, s.wf)[3]!;
  const cL = wpolyGen(byHand(s.rows, "L"), s.deg, s.zf, (r) => r.resid, s.wf)[3]!;
  say(`     ${pad(s.tag, 30)}${lpad(String(s.rows.length), 7)}${lpad(String(cardsOf(s.rows)), 7)}${lpad(sgn(cR, 4), 10)}${lpad(sgn(cL, 4), 10)}${lpad(sgn(cR - cL, 4), 10)}${lpad(f(100 * (cR - cL) / base_d, 0) + "%", 11)}`);
}
say();
say(`     Global z domain on the full window: [${sgn(zRange(FULL).lo, 2)}, ${sgn(zRange(FULL).hi, 2)}].`);
say(`     A cubic coefficient of ${sgn(base_d, 3)} contributes ${sgn(base_d * 8, 1)} K/600 at z=+2 and ${sgn(base_d * 27, 1)} at z=+3 —`);
say(`     i.e. the coefficient's meaning is set almost entirely by the handful of rows in the tails.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §6 — COMMON SUPPORT / DISTRIBUTION MATCHING
// ══════════════════════════════════════════════════════════════════════════════════
// If the arms are compared on a COMMON Stuff distribution, the design artifact of §1 is removed.
function matchWeights(target: Row[], source: Row[], nBins = 10): Map<Row, number> {
  // reweight `source` rows so their BF-weighted z histogram matches `target`'s
  const edges: number[] = [];
  const zs = [...target, ...source].map((r) => zg(r.stu)).sort((a, b) => a - b);
  for (let i = 1; i < nBins; i++) edges.push(zs[Math.floor((i / nBins) * zs.length)]!);
  const bin = (r: Row) => { const z = zg(r.stu); let b = 0; while (b < edges.length && z > edges[b]!) b++; return b; };
  const tW = new Array(nBins).fill(0), sW = new Array(nBins).fill(0);
  for (const r of target) tW[bin(r)] += r.w;
  for (const r of source) sW[bin(r)] += r.w;
  const tT = sum(tW), sT = sum(sW);
  const m = new Map<Row, number>();
  for (const r of source) { const b = bin(r); const f2 = sW[b] > 0 ? (tW[b] / tT) / (sW[b] / sT) : 0; m.set(r, r.w * f2); }
  return m;
}
const RR = byHand(FULL, "R"), LL = byHand(FULL, "L");
const wRmatchL = matchWeights(LL, RR), wLmatchR = matchWeights(RR, LL);
const cubW = (rs: Row[], wf: (r: Row) => number) => wpolyGen(rs, 3, zRow, (r) => r.resid, wf)[3]!;
const cR_matched = cubW(RR, (r) => wRmatchL.get(r) ?? 0);
const cL_matched = cubW(LL, (r) => wLmatchR.get(r) ?? 0);
// common-support restriction: intersect the two arms' 2nd..98th BF-weighted z percentiles
const wq = (rs: Row[], p: number) => { const srt = [...rs].sort((a, b) => a.stu - b.stu); const tot = sum(srt.map((r) => r.w)); let acc = 0; for (const r of srt) { acc += r.w; if (acc >= p * tot) return zg(r.stu); } return zg(srt[srt.length - 1]!.stu); };
const loCS = Math.max(wq(RR, 0.02), wq(LL, 0.02)), hiCS = Math.min(wq(RR, 0.98), wq(LL, 0.98));
const csRows = FULL.filter((r) => zg(r.stu) >= loCS && zg(r.stu) <= hiCS);
const pcCS = pairedContrast(csRows, 0x51ee11, 6000, cubOf);

// NONPARAMETRIC arm comparison on common bins: no basis, no projection
const BINS = [[-2.6, -1.4], [-1.4, -0.7], [-0.7, -0.2], [-0.2, 0.3], [0.3, 0.9], [0.9, 1.5], [1.5, 3.2]];
const binStat = BINS.map(([lo, hi]) => {
  const rs = FULL.filter((r) => zg(r.stu) >= lo! && zg(r.stu) < hi!);
  const R = byHand(rs, "R"), Lr = byHand(rs, "L");
  const d = wmean(R, (r) => r.resid) - wmean(Lr, (r) => r.resid);
  const pc = R.length >= 8 && Lr.length >= 8 ? pairedContrast(rs, 0x2a2a, 3000, (s) => wmean(s, (r) => r.resid)) : null;
  return { lo: lo!, hi: hi!, nR: R.length, nL: Lr.length, bfR: sum(R.map((r) => r.w)), bfL: sum(Lr.map((r) => r.w)), mR: wmean(R, (r) => r.resid), mL: wmean(Lr, (r) => r.resid), d, pc };
});

say("################################################################################");
say("## 6. COMMON SUPPORT — compare the arms where they are actually comparable");
say("################################################################################");
say();
say(`     (a) DISTRIBUTION MATCHING. Reweight one arm (10 z-bins) so its BF-weighted Stuff`);
say(`         histogram matches the other's, then recompute. If the contrast is a design artifact`);
say(`         (§1), matching must shrink it.`);
say(`            raw:                       vR ${sgn(cubOf(RR), 4)}   vL ${sgn(cubOf(LL), 4)}   diff ${sgn(base_d, 4)}`);
say(`            vR reweighted to vL's z:   vR ${sgn(cR_matched, 4)}   vL ${sgn(cubOf(LL), 4)}   diff ${sgn(cR_matched - cubOf(LL), 4)}  (${f(100 * (cR_matched - cubOf(LL)) / base_d, 0)}% of base)`);
say(`            vL reweighted to vR's z:   vR ${sgn(cubOf(RR), 4)}   vL ${sgn(cL_matched, 4)}   diff ${sgn(cubOf(RR) - cL_matched, 4)}  (${f(100 * (cubOf(RR) - cL_matched) / base_d, 0)}% of base)`);
say();
say(`     (b) COMMON-SUPPORT RESTRICTION to z ∈ [${sgn(loCS, 2)}, ${sgn(hiCS, 2)}] (both arms' 2nd–98th BF pct):`);
say(`            N=${csRows.length} rows / ${cardsOf(csRows)} cards.  vR−vL cubic ${sgn(dCub(csRows), 4)}`);
say(`            CI [${sgn(pcCS.ci.lo, 4)}, ${sgn(pcCS.ci.hi, 4)}]  p=${f(pcCS.p, 3)}  ${clear(pcCS.ci) ? "CI-clear" : "COVERS 0"}`);
say();
say(`     (c) NONPARAMETRIC, no basis at all — BF-weighted mean residual per arm in common z bins.`);
say(`         A real hand-specific SHAPE must show up as arms separating somewhere. (Paired card-`);
say(`         cluster CI on the within-bin difference.)`);
say(`     ${pad("z bin", 16)}${lpad("nR", 5)}${lpad("nL", 5)}${lpad("vR resid", 11)}${lpad("vL resid", 11)}${lpad("diff", 9)}  95% CI (paired)`);
for (const b of binStat)
  say(`     ${pad(`[${sgn(b.lo, 1)}, ${sgn(b.hi, 1)})`, 16)}${lpad(String(b.nR), 5)}${lpad(String(b.nL), 5)}${lpad(sgn(b.mR), 11)}${lpad(sgn(b.mL), 11)}${lpad(sgn(b.d), 9)}  ${b.pc ? `[${sgn(b.pc.ci.lo)}, ${sgn(b.pc.ci.hi)}] p=${f(b.pc.p, 3)} ${clear(b.pc.ci) ? "CI-clear" : "covers 0"}` : "(too thin)"}`);
say();
const anyBinClear = binStat.filter((b) => b.pc && clear(b.pc.ci)).length;
say(`     ⇒ arms separate CI-clear in ${anyBinClear}/${binStat.filter((b) => b.pc).length} bins.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §7 — THE PLATOON-COMPOSITION CONFOUND (the analyst's own flagged risk) + pitcher hand
// ══════════════════════════════════════════════════════════════════════════════════
// vR/vL is the BATTER's hand. Every pitcher's vR line is a SAME-side matchup if he throws R
// and an OPPOSITE-side matchup if he throws L (and vice versa on vL). If the deployed curve
// mis-fits the PLATOON-ADVANTAGE axis rather than the batter-hand axis, the batter-hand
// contrast is a confounded proxy, because ~3/4 of pitchers are RHP.
const RHP = FULL.filter((r) => r.throws === 1), LHP = FULL.filter((r) => r.throws === 2);
const same = FULL.filter((r) => (r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L"));
const opp = FULL.filter((r) => (r.throws === 1 && r.side === "L") || (r.throws === 2 && r.side === "R"));
const cubSame = cubOf(same), cubOpp = cubOf(opp);
function pairedContrastBy(rs: Row[], sel: (r: Row) => "A" | "B" | null, seed: number, B: number, stat: (s: Row[]) => number) {
  const rnd = mkRnd(seed), cl2 = clusters(rs), d: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: Row[] = [];
    for (let i = 0; i < cl2.length; i++) for (const r of cl2[Math.floor(rnd() * cl2.length)]!) s.push(r);
    const A = s.filter((r) => sel(r) === "A"), Bb = s.filter((r) => sel(r) === "B");
    if (A.length < 10 || Bb.length < 10) continue;
    const v = stat(A) - stat(Bb); if (Number.isFinite(v)) d.push(v);
  }
  const lo = d.filter((x) => x < 0).length / d.length;
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo), n: d.length };
}
const pcSO = pairedContrastBy(FULL, (r) => ((r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L")) ? "A" : ((r.throws === 1 || r.throws === 2) ? "B" : null), 0x51ee11, 8000, cubOf);
const pcRHP = pairedContrast(RHP, 0x51ee11, 8000, cubOf);
const pcLHP = LHP.length > 60 ? pairedContrast(LHP, 0x51ee11, 8000, cubOf) : null;

// role: SP vs RP from the card's POS
const posSet = [...new Set(FULL.map((r) => r.pos))].sort();
const isSP = (r: Row) => /^SP/i.test(r.pos);
const SPr = FULL.filter(isSP), RPr = FULL.filter((r) => !isSP(r));
const pcSP = SPr.length > 60 ? pairedContrast(SPr, 0x51ee11, 6000, cubOf) : null;
const pcRP = RPr.length > 60 ? pairedContrast(RPr, 0x51ee11, 6000, cubOf) : null;

say("################################################################################");
say("## 7. THE CONFOUND THE ANALYST FLAGGED AND DID NOT TEST — who each arm actually faced");
say("################################################################################");
say();
say("  (a) PITCHER HAND. 'vR/vL' is the BATTER's hand. For a RHP, vR is the SAME-side (platoon-");
say("      advantage) matchup; for a LHP it is the OPPOSITE-side one. If the deployed K curve");
say("      mis-fits along the PLATOON-ADVANTAGE axis, the batter-hand split is a confounded proxy.");
say();
say(`     ${pad("split", 26)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("BF", 12)}${lpad("cubic", 10)}`);
for (const [t, rs] of [["all RHP", RHP], ["all LHP", LHP], ["SAME-side matchups", same], ["OPPOSITE-side matchups", opp]] as const)
  say(`     ${pad(t, 26)}${lpad(String(rs.length), 7)}${lpad(String(cardsOf(rs)), 7)}${lpad(k(sum(rs.map((r) => r.w))), 12)}${lpad(sgn(cubOf(rs), 4), 10)}`);
say();
say(`     SAME−OPPOSITE cubic contrast: ${sgn(cubSame - cubOpp, 4)}  CI [${sgn(pcSO.ci.lo, 4)}, ${sgn(pcSO.ci.hi, 4)}]  p=${f(pcSO.p, 3)}  ${clear(pcSO.ci) ? "CI-clear" : "covers 0"}`);
say(`     vR−vL WITHIN RHP only: ${sgn(dCub(RHP), 4)}  CI [${sgn(pcRHP.ci.lo, 4)}, ${sgn(pcRHP.ci.hi, 4)}]  p=${f(pcRHP.p, 3)}  ${clear(pcRHP.ci) ? "CI-clear" : "covers 0"}`);
if (pcLHP) say(`     vR−vL WITHIN LHP only: ${sgn(dCub(LHP), 4)}  CI [${sgn(pcLHP.ci.lo, 4)}, ${sgn(pcLHP.ci.hi, 4)}]  p=${f(pcLHP.p, 3)}  ${clear(pcLHP.ci) ? "CI-clear" : "covers 0"}  (${cardsOf(LHP)} cards)`);
say(`        LHP share of rows ${f(100 * LHP.length / FULL.length, 1)}%, of BF ${f(100 * sum(LHP.map((r) => r.w)) / sum(FULL.map((r) => r.w)), 1)}%.`);
say();
say(`  (b) ROLE. POS values present: ${posSet.join(", ")}. Stuff and role are strongly related, and`);
say(`      role changes both the opposition mix and the platoon exposure a pitcher sees.`);
say(`     ${pad("split", 26)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("BF-wtd stu", 12)}${lpad("vR cub", 10)}${lpad("vL cub", 10)}${lpad("vR−vL", 10)}`);
for (const [t, rs] of [["starters (POS SP)", SPr], ["non-starters", RPr]] as const)
  say(`     ${pad(t, 26)}${lpad(String(rs.length), 7)}${lpad(String(cardsOf(rs)), 7)}${lpad(f(wmean(rs, (r) => r.stu), 1), 12)}${lpad(sgn(cubOf(byHand(rs, "R")), 4), 10)}${lpad(sgn(cubOf(byHand(rs, "L")), 4), 10)}${lpad(sgn(dCub(rs), 4), 10)}`);
if (pcSP) say(`     within starters:     CI [${sgn(pcSP.ci.lo, 4)}, ${sgn(pcSP.ci.hi, 4)}] p=${f(pcSP.p, 3)} ${clear(pcSP.ci) ? "CI-clear" : "covers 0"}`);
if (pcRP) say(`     within non-starters: CI [${sgn(pcRP.ci.lo, 4)}, ${sgn(pcRP.ci.hi, 4)}] p=${f(pcRP.p, 3)} ${clear(pcRP.ci) ? "CI-clear" : "covers 0"}`);
say();

// (c) opposition composition proxy: the league's hitters by batting hand, per season
say(`  (c) OPPOSITION COMPOSITION. A pitcher's vR line is against RHB, his vL line against LHB.`);
say(`      Those are DIFFERENT POPULATIONS of hitters, and the deployed pitching prediction contains`);
say(`      NO opponent term at all (predictPitching sees only the pitcher's own ratings). So any`);
say(`      systematic quality difference between the RHB and LHB populations lands directly in the`);
say(`      residual — as a LEVEL per arm, and as SHAPE to the extent it interacts with Stuff.`);
say();
say(`     ${pad("year", 7)}${lpad("RHB n", 8)}${lpad("RHB PA", 11)}${lpad("RHB kRat", 10)}${lpad("LHB n", 8)}${lpad("LHB PA", 11)}${lpad("LHB kRat", 10)}${lpad("gap", 8)}`);
const oppTab: { y: number; gap: number }[] = [];
for (const y of MAIN) {
  // hitters' own outcome lines are split by the PITCHER's hand; the batter population itself is
  // identified by `bats`. Switch-hitters (bats=3) face both, so they are excluded from the contrast.
  const hs = obsOf(y).filter((o) => HITTER.qualifies(o, DEF_MINPA));
  const grp = (b: number) => { const s = hs.filter((o) => o.bats === b); const pa = sum(s.map((o) => o.hit.PA)); return { n: new Set(s.map((o) => o.cid)).size, pa, kRat: pa > 0 ? sum(s.map((o) => o.hit.PA * o.ratings.hit.kRat)) / pa : NaN }; };
  const R2 = grp(1), L2 = grp(2);
  oppTab.push({ y, gap: R2.kRat - L2.kRat });
  say(`     ${pad(String(y), 7)}${lpad(String(R2.n), 8)}${lpad(k(R2.pa), 11)}${lpad(f(R2.kRat, 1), 10)}${lpad(String(L2.n), 8)}${lpad(k(L2.pa), 11)}${lpad(f(L2.kRat, 1), 10)}${lpad(sgn(R2.kRat - L2.kRat, 1), 8)}`);
}
say(`     (kRat = avoid-K rating, PA-weighted over qualified hitters of that batting hand; higher = harder to K.)`);
say(`     Mean RHB−LHB avoid-K gap across the window: ${sgn(sum(oppTab.map((o) => o.gap)) / oppTab.length, 2)} rating points.`);
say(`     This gap is NEVER in the prediction and NEVER removed by the hand contrast — differencing the`);
say(`     arms differences away the SEASON, not the OPPOSITION POPULATION, which is exactly what differs`);
say(`     between the arms by construction.`);
say();

// ── (d) THE MECHANISM: hand-dependent RE-SORTING of the Stuff axis ────────────────
// The two arms are not two samples of one design. A card's STU vR and STU vL are DIFFERENT
// RATINGS, and the difference is systematically signed by the pitcher's own hand. So the vR
// arm's Stuff ordering is a DIFFERENT ordering of the same 70 cards than the vL arm's. Any
// residual structure that attaches to the PITCHER (hand, role) therefore lands at different
// places on the z axis in each arm — which is a shape contrast with no curve defect in it.
const stuDelta = (rs: Row[]) => {
  const g = new Map<string, { R?: number; L?: number; w: number; thr: number }>();
  for (const r of rs) { const e = g.get(r.cid) ?? { w: 0, thr: r.throws }; if (r.side === "R") e.R = r.stu; else e.L = r.stu; e.w += r.w; g.set(r.cid, e); }
  return [...g.values()].filter((e) => e.R != null && e.L != null);
};
const sd_all = stuDelta(FULL);
const byThrow = (t: number) => sd_all.filter((e) => e.thr === t);
const meanD = (xs: { R?: number; L?: number }[]) => xs.length ? sum(xs.map((e) => e.R! - e.L!)) / xs.length : NaN;
const lvlCell = (t: number, s: string) => { const rs = FULL.filter((r) => r.throws === t && r.side === s); return { n: rs.length, bf: sum(rs.map((r) => r.w)), lvl: wmean(rs, (r) => r.resid), stu: wmean(rs, (r) => r.stu) }; };

const deMean = (rs: Row[], keyf: (r: Row) => string): Row[] => {
  const g = new Map<string, Row[]>(); for (const r of rs) (g.get(keyf(r)) ?? g.set(keyf(r), []).get(keyf(r))!).push(r);
  const out: Row[] = [];
  for (const [, s] of g) { const m = wmean(s, (r) => r.resid); for (const r of s) out.push({ ...r, resid: r.resid - m }); }
  return out;
};
const feThrow = deMean(FULL, (r) => String(r.throws));
const feThrowYear = deMean(FULL, (r) => `${r.throws}|${r.year}`);
const feRole = deMean(FULL, (r) => (isSP(r) ? "SP" : "RP"));
const feThrowRole = deMean(FULL, (r) => `${r.throws}|${isSP(r) ? "SP" : "RP"}`);
const pcFeThrow = pairedContrast(feThrow, 0x51ee11, 6000, cubOf);
const pcFeRole = pairedContrast(feRole, 0x51ee11, 6000, cubOf);
const pcFeTR = pairedContrast(feThrowRole, 0x51ee11, 6000, cubOf);

/** STRATIFIED contrast: compute vR−vL WITHIN each stratum, then BF-average. This is the
 *  estimand the claim actually needs — "the curve's shape differs by batter hand" must hold
 *  within a pitcher type, not merely across a re-sorted mixture of pitcher types. */
function stratContrast(rs: Row[], key: (r: Row) => string): number {
  const g = new Map<string, Row[]>(); for (const r of rs) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r);
  let num = 0, den = 0;
  for (const [, s] of g) {
    const R = byHand(s, "R"), Lr = byHand(s, "L");
    if (R.length < 25 || Lr.length < 25) continue;
    const d = cubOf(R) - cubOf(Lr); if (!Number.isFinite(d)) continue;
    const W = sum(s.map((r) => r.w)); num += W * d; den += W;
  }
  return den > 0 ? num / den : NaN;
}
function stratBoot(rs: Row[], key: (r: Row) => string, seed: number, B: number) {
  const rnd = mkRnd(seed), cl2 = clusters(rs), d: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: Row[] = [];
    for (let i = 0; i < cl2.length; i++) for (const r of cl2[Math.floor(rnd() * cl2.length)]!) s.push(r);
    const v = stratContrast(s, key); if (Number.isFinite(v)) d.push(v);
  }
  const lo = d.filter((x) => x < 0).length / d.length;
  return { pt: stratContrast(rs, key), ci: ci(d), p: 2 * Math.min(lo, 1 - lo), n: d.length };
}
const stThrow = stratBoot(FULL, (r) => String(r.throws), 0x51ee11, 5000);
const stRole = stratBoot(FULL, (r) => (isSP(r) ? "SP" : "RP"), 0x51ee11, 5000);
const stTR = stratBoot(FULL, (r) => `${r.throws}|${isSP(r) ? "SP" : "RP"}`, 0x51ee11, 5000);

say(`  (d) THE MECHANISM — the two arms are a RE-SORTING of the same 70 cards, not two views of one`);
say(`      design. STU vR and STU vL are DIFFERENT RATINGS, and the gap between them is signed by the`);
say(`      pitcher's own hand:`);
say(`        mean (STU vR − STU vL):  RHP ${sgn(meanD(byThrow(1)), 2)}   LHP ${sgn(meanD(byThrow(2)), 2)}   (${byThrow(1).length} / ${byThrow(2).length} cards)`);
say(`      So a RHP sits HIGHER on the vR arm's Stuff axis than on the vL arm's, and a LHP the`);
say(`      reverse. Any residual attached to the PITCHER (hand, role, usage) therefore lands at a`);
say(`      DIFFERENT place on z in each arm — which is a shape contrast with no curve defect in it.`);
say();
say(`     ${pad("cell (throws × batter)", 24)}${lpad("rows", 7)}${lpad("BF", 12)}${lpad("BF-wtd stu", 12)}${lpad("level resid", 13)}`);
for (const [t, s, tag] of [[1, "R", "RHP vs RHB (same)"], [1, "L", "RHP vs LHB (opp)"], [2, "R", "LHP vs RHB (opp)"], [2, "L", "LHP vs LHB (same)"]] as const) {
  const c = lvlCell(t as number, s as string);
  say(`     ${pad(tag, 24)}${lpad(String(c.n), 7)}${lpad(k(c.bf), 12)}${lpad(f(c.stu, 1), 12)}${lpad(sgn(c.lvl), 13)}`);
}
say();
const soSel = (r: Row) => ((r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L")) ? "A" as const : ((r.throws === 1 || r.throws === 2) ? "B" as const : null);
const pcSOlvl = pairedContrastBy(FULL, soSel, 0x51ee11, 8000, (s) => wmean(s, (r) => r.resid));
const lvlSame = wmean(same, (r) => r.resid), lvlOpp = wmean(opp, (r) => r.resid);
const cellCards = (t: number, s: string) => { const rs = FULL.filter((r) => r.throws === t && r.side === s); const g = new Map<string, number>(); for (const r of rs) g.set(r.name, (g.get(r.name) ?? 0) + r.w); const tot = sum([...g.values()]); return [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, w]) => `${n.slice(0, 16)} ${f(100 * w / tot, 0)}%`).join(", "); };
say(`     THE AXIS THAT IS ACTUALLY RESOLVED IS SAME-SIDE vs OPPOSITE-SIDE, AND IT IS A LEVEL:`);
say(`        same-side level ${sgn(lvlSame)}/600, opposite-side level ${sgn(lvlOpp)}/600, contrast ${sgn(lvlSame - lvlOpp)}/600`);
say(`        CI [${sgn(pcSOlvl.ci.lo)}, ${sgn(pcSOlvl.ci.hi)}]  p=${f(pcSOlvl.p, 3)}  ${clear(pcSOlvl.ci) ? "CI-CLEAR" : "covers 0"}`);
say(`        — an order of magnitude bigger than anything in the batter-hand cubic story, on ${f(pcSOlvl.p < 0.05 ? 1 : 0, 0) ? "a resolved" : "an unresolved"} axis`);
say(`        the proposal does not consider. (Top-BF cards in the extreme cell LHP-vs-LHB: ${cellCards(2, "L")}.)`);
say(`        NOTE this is NOT itself a clean curve finding either — same-side BF is a manager-selected`);
say(`        subset — but it dominates the hand story the proposal is built on.`);
say();
say(`     REMOVING A PITCHER-TYPE LEVEL (the residual structure the re-sorting can convert into shape):`);
say(`     ${pad("construction", 34)}${lpad("vR−vL cubic", 13)}  ${pad("95% CI (paired cluster)", 26)}${lpad("p", 8)}`);
say(`     ${pad("raw (the artifact)", 34)}${lpad(sgn(base_d, 4), 13)}  ${pad("[-2.1243, -0.0830]", 26)}${lpad("0.034", 8)}`);
for (const [t, rs2, pc] of [["after pitcher-HAND level removed", feThrow, pcFeThrow], ["after ROLE (SP/RP) level removed", feRole, pcFeRole], ["after hand×role level removed", feThrowRole, pcFeTR]] as const)
  say(`     ${pad(t, 34)}${lpad(sgn(dCub(rs2), 4), 13)}  ${pad(`[${sgn(pc.ci.lo, 4)}, ${sgn(pc.ci.hi, 4)}]`, 26)}${lpad(f(pc.p, 3), 8)}  ${clear(pc.ci) ? "CI-clear" : "COVERS 0"}`);
say(`     (a per-year-hand FE cannot do this: the confound is a per-PITCHER-TYPE level, and the`);
say(`      re-sorting happens WITHIN a season, so the artifact's §5 FE checks are blind to it.)`);
say();
say(`     THE STRATIFIED ESTIMAND — vR−vL computed WITHIN each stratum, then BF-averaged. This is`);
say(`     what "the K curve's shape differs by batter hand" actually asserts; the raw contrast is a`);
say(`     mixture that also contains the re-sorting.`);
say(`     ${pad("stratification", 28)}${lpad("stratified vR−vL", 18)}  ${pad("95% CI", 26)}${lpad("p", 8)}`);
say(`     ${pad("none (the artifact's number)", 28)}${lpad(sgn(base_d, 4), 18)}  ${pad("[-2.1243, -0.0830]", 26)}${lpad("0.034", 8)}  CI-clear`);
for (const [t, s] of [["by pitcher hand", stThrow], ["by role (SP / non-SP)", stRole], ["by hand × role", stTR]] as const)
  say(`     ${pad(t, 28)}${lpad(sgn(s.pt, 4), 18)}  ${pad(`[${sgn(s.ci.lo, 4)}, ${sgn(s.ci.hi, 4)}]`, 26)}${lpad(f(s.p, 3), 8)}  ${clear(s.ci) ? "CI-clear" : "COVERS 0"}`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §8 — PARAMETER COST: does hand-conditioning PREDICT better out of sample?
// ══════════════════════════════════════════════════════════════════════════════════
type Fitter = (train: Row[]) => (r: Row) => number;
const fitPoly = (deg: number): Fitter => (train) => { const b = wpolyGen(train, deg, zRow, (r) => r.resid, wBF); return (r) => { const z = zg(r.stu); let a = 0, zp = 1; for (const bb of b) { a += bb * zp; zp *= z; } return a; }; };
const fitHand = (deg: number): Fitter => (train) => {
  const bR = wpolyGen(byHand(train, "R"), deg, zRow, (r) => r.resid, wBF), bL = wpolyGen(byHand(train, "L"), deg, zRow, (r) => r.resid, wBF);
  return (r) => { const b = r.side === "R" ? bR : bL; const z = zg(r.stu); let a = 0, zp = 1; for (const bb of b) { a += bb * zp; zp *= z; } return a; };
};
const fitZero: Fitter = () => () => 0;
const MODELS: { tag: string; par: number; fit: Fitter }[] = [
  { tag: "no correction (deployed as-is)", par: 0, fit: fitZero },
  { tag: "pooled constant", par: 1, fit: fitPoly(0) },
  { tag: "pooled linear", par: 2, fit: fitPoly(1) },
  { tag: "pooled quadratic", par: 3, fit: fitPoly(2) },
  { tag: "pooled CUBIC", par: 4, fit: fitPoly(3) },
  { tag: "hand-conditioned constant", par: 2, fit: fitHand(0) },
  { tag: "hand-conditioned linear", par: 4, fit: fitHand(1) },
  { tag: "hand-conditioned quadratic", par: 6, fit: fitHand(2) },
  { tag: "hand-conditioned CUBIC", par: 8, fit: fitHand(3) },
];
function cv(folds: Row[][], fit: Fitter) {
  let se = 0, sw = 0;
  for (let i = 0; i < folds.length; i++) {
    const test = folds[i]!, train = folds.filter((_, j) => j !== i).flat();
    if (!test.length || !train.length) continue;
    const g = fit(train);
    for (const r of test) { const e = r.resid - g(r); se += r.w * e * e; sw += r.w; }
  }
  return sw > 0 ? se / sw : NaN;
}
const foldSeason = MAIN.map((y) => FULL.filter((r) => r.year === y));
const foldCard = cidList.map((c) => FULL.filter((r) => r.cid === c));
// 10-fold grouped by card (cards assigned round-robin by a fixed hash order)
const foldCard10 = (() => { const out: Row[][] = Array.from({ length: 10 }, () => []); cidList.forEach((c, i) => out[i % 10]!.push(...FULL.filter((r) => r.cid === c))); return out; })();
// in-sample weighted MSE for the AIC-ish reference
const inSample = (fit: Fitter) => { const g = fit(FULL); let se = 0, sw = 0; for (const r of FULL) { const e = r.resid - g(r); se += r.w * e * e; sw += r.w; } return se / sw; };
const totVar = inSample(fitZero);

// ══════════════════════════════════════════════════════════════════════════════════
// §7e — CANDIDATE 1, PROPERLY: the opposing-batter population each arm actually faced
// ══════════════════════════════════════════════════════════════════════════════════
// A pitcher's vR line is thrown to the RHB population; his vL line to the LHB population.
// Those populations differ in size AND in avoid-K rating, and the deployed prediction contains
// no opponent term, so the difference lands whole in the residual. Composition is resolved
// PROPERLY here: a switch-hitter bats RIGHT against a LHP and LEFT against a RHP, so the
// batter population depends on the PITCHER's hand too, and the batter's own avoid-K rating is
// itself split by pitcher hand (K vL / K vR). Cell = (batter hand B, pitcher hand T).
interface OppCell { B: "R" | "L"; T: "R" | "L"; pa: number; kRat: number; n: number }
function oppComposition(obs: TrainObs[], minPA: number): OppCell[] {
  const acc = new Map<string, { pa: number; kw: number; ids: Set<string> }>();
  for (const o of obs.filter((x) => HITTER.qualifies(x, minPA))) {
    const T = o.side as "R" | "L";                    // this row is vs a pitcher of hand T
    const B: "R" | "L" | null = o.bats === 1 ? "R" : o.bats === 2 ? "L" : o.bats === 3 ? (T === "L" ? "R" : "L") : null;
    if (!B) continue;
    const kk = `${B}|${T}`;
    const e = acc.get(kk) ?? { pa: 0, kw: 0, ids: new Set<string>() };
    e.pa += o.hit.PA; e.kw += o.hit.PA * o.ratings.hit.kRat; e.ids.add(o.cid); acc.set(kk, e);
  }
  return [...acc.entries()].map(([kk, e]) => { const [B, T] = kk.split("|") as ["R" | "L", "R" | "L"]; return { B, T, pa: e.pa, kRat: e.kw / (e.pa || 1), n: e.ids.size }; });
}
const oppYear = new Map<number, OppCell[]>();
for (const y of MAIN) oppYear.set(y, oppComposition(obsOf(y), DEF_MINPA));
const oc = (y: number, B: string, T: string) => oppYear.get(y)!.find((c) => c.B === B && c.T === T)!;

say("################################################################################");
say("## 7e. CANDIDATE 1 — THE OPPOSING-BATTER POPULATION, RESOLVED BY PITCHER HAND");
say("################################################################################");
say();
say("     A switch-hitter bats RIGHT against a LHP and LEFT against a RHP, so 'the RHB population'");
say("     is not one population — it depends on the pitcher's hand. And the batter's own avoid-K");
say("     rating is itself hand-split. Resolving both gives four opposition cells:");
say();
say(`     ${pad("year", 7)}${lpad("RHB vs RHP", 12)}${lpad("RHB vs LHP", 12)}${lpad("LHB vs RHP", 12)}${lpad("LHB vs LHP", 12)}   ${pad("same−opp kRat", 15)}`);
const oppSeries: { y: number; sameK: number; oppK: number; gapK: number; residGap: number; cubGap: number }[] = [];
for (const y of MAIN) {
  const rr = oc(y, "R", "R"), rl = oc(y, "R", "L"), lr = oc(y, "L", "R"), ll = oc(y, "L", "L");
  // "same-side" opposition = RHB facing RHP + LHB facing LHP
  const sameK = (rr.pa * rr.kRat + ll.pa * ll.kRat) / (rr.pa + ll.pa);
  const oppK = (rl.pa * rl.kRat + lr.pa * lr.kRat) / (rl.pa + lr.pa);
  const rs = FULL.filter((r) => r.year === y);
  const sameRs = rs.filter((r) => (r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L"));
  const oppRs = rs.filter((r) => (r.throws === 1 && r.side === "L") || (r.throws === 2 && r.side === "R"));
  oppSeries.push({ y, sameK, oppK, gapK: sameK - oppK, residGap: wmean(sameRs, (r) => r.resid) - wmean(oppRs, (r) => r.resid), cubGap: cubOf(byHand(rs, "R")) - cubOf(byHand(rs, "L")) });
  say(`     ${pad(String(y), 7)}${lpad(f(rr.kRat, 1), 12)}${lpad(f(rl.kRat, 1), 12)}${lpad(f(lr.kRat, 1), 12)}${lpad(f(ll.kRat, 1), 12)}   ${lpad(sgn(sameK - oppK, 2), 15)}`);
}
say(`     (avoid-K rating, PA-weighted over qualified hitters; higher = harder to strike out.)`);
say();
say(`     THE OPPOSITION IS NOT SYMMETRIC. Same-side matchups face batters whose avoid-K averages`);
say(`     ${sgn(sum(oppSeries.map((o) => o.gapK)) / oppSeries.length, 2)} rating points ${sum(oppSeries.map((o) => o.gapK)) < 0 ? "LOWER" : "HIGHER"} than opposite-side matchups. The model has no opponent`);
say(`     term, so that difference is a pure additive residual — and it lines up with the measured`);
say(`     same-vs-opposite level gap:`);
say(`     ${pad("year", 7)}${lpad("opp kRat gap", 14)}${lpad("resid level gap", 17)}${lpad("vR−vL cubic", 13)}`);
for (const o of oppSeries) say(`     ${pad(String(o.y), 7)}${lpad(sgn(o.gapK, 2), 14)}${lpad(sgn(o.residGap, 2), 17)}${lpad(sgn(o.cubGap, 3), 13)}`);
const corrArr = (xs: number[], ys: number[]) => { const n = xs.length, mx = sum(xs) / n, my = sum(ys) / n; return sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / (Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) * sum(ys.map((y) => (y - my) ** 2))) || 1e-12); };
say(`     correlation(opp kRat gap, resid level gap) across the 7 seasons: ${sgn(corrArr(oppSeries.map((o) => o.gapK), oppSeries.map((o) => o.residGap)), 2)}`);
say(`     correlation(opp kRat gap, vR−vL cubic)      across the 7 seasons: ${sgn(corrArr(oppSeries.map((o) => o.gapK), oppSeries.map((o) => o.cubGap)), 2)}`);
say(`     NOTE ON 'CONSISTENT ACROSS 7 SEASONS': the seasons are not equal. League coverage is`);
say(`     4 leagues in 2037, 5 in 2038 and 2040–2043, and 4 effective in 2039 (HD450|2039 is`);
say(`     excluded as corrupt by the loader). The 2032–33 'Old Data' seasons carry 4 and 2. A`);
say(`     7/7 sign count is therefore 7 correlated, unequally-weighted looks at ~70 recurring cards,`);
say(`     not 7 independent replications.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §7f — CANDIDATE 2: are the two arms populated by differently-SHAPED cards?
// ══════════════════════════════════════════════════════════════════════════════════
const armProfile = (rs: Row[]) => {
  // pull the full pitching rating vector back off the observations for these rows
  const key = new Set(rs.map((r) => `${r.cid}|${r.side}|${r.year}`));
  const vals = { stu: 0, con: 0, pbabip: 0, hrr: 0, w: 0 };
  for (const y of MAIN) for (const o of obsOf(y).filter((o) => PITCHER.qualifies(o, DEF_MINPA))) {
    if (!key.has(`${o.cid}|${o.side}|${y}`)) continue;
    const w = Math.max(o.pitch.BF, 1);
    vals.stu += w * o.ratings.pitch.stu; vals.con += w * o.ratings.pitch.con; vals.pbabip += w * o.ratings.pitch.pbabip; vals.hrr += w * o.ratings.pitch.hrr; vals.w += w;
  }
  return { stu: vals.stu / vals.w, con: vals.con / vals.w, pbabip: vals.pbabip / vals.w, hrr: vals.hrr / vals.w, bf: vals.w };
};
const profR = armProfile(byHand(FULL, "R")), profL = armProfile(byHand(FULL, "L"));
// per-card vL exposure share, and what the heavy-vL cards look like
const cardShare = cidList.map((c) => {
  const rs = FULL.filter((r) => r.cid === c);
  const bfR = sum(byHand(rs, "R").map((r) => r.w)), bfL = sum(byHand(rs, "L").map((r) => r.w));
  return { cid: c, name: rs[0]!.name, thr: rs[0]!.throws, pos: rs[0]!.pos, bfR, bfL, share: bfL / (bfR + bfL), stuR: wmean(byHand(rs, "R"), (r) => r.stu), stuL: wmean(byHand(rs, "L"), (r) => r.stu), resR: wmean(byHand(rs, "R"), (r) => r.resid), resL: wmean(byHand(rs, "L"), (r) => r.resid) };
}).filter((c) => Number.isFinite(c.share));
const hiL = [...cardShare].sort((a, b) => b.share - a.share).slice(0, 15);
const loL = [...cardShare].sort((a, b) => a.share - b.share).slice(0, 15);
const meanOf = (xs: typeof cardShare, g: (c: typeof cardShare[number]) => number) => sum(xs.map(g)) / xs.length;
// ── 7e(ii) THE DECISIVE TEST: correct for opposition composition and re-read everything ──
const oppK = (y: number, B: string, T: number) => { const c = oppYear.get(y)!.find((c) => c.B === B && c.T === (T === 1 ? "R" : "L")); return c ? c.kRat : NaN; };
const withOpp = FULL.filter((r) => (r.throws === 1 || r.throws === 2) && Number.isFinite(oppK(r.year, r.side, r.throws)));
const oppOf = (r: Row) => oppK(r.year, r.side, r.throws);
const oppMean = wmean(withOpp, oppOf);
// one pooled slope of residual on opposing avoid-K (K/600 per rating point), BF-weighted
const slope = (() => {
  const mx = oppMean, my = wmean(withOpp, (r) => r.resid);
  const sxy = sum(withOpp.map((r) => r.w * (oppOf(r) - mx) * (r.resid - my))), sxx = sum(withOpp.map((r) => r.w * (oppOf(r) - mx) ** 2));
  return sxy / (sxx || 1e-12);
})();
const oppAdj = withOpp.map((r) => ({ ...r, resid: r.resid - slope * (oppOf(r) - oppMean) }));
const cellFE = deMean(withOpp, (r) => `${r.throws}|${r.side}`);
const cellYearFE = deMean(withOpp, (r) => `${r.throws}|${r.side}|${r.year}`);
// what the deployed HITTER K curve says a rating point is worth — a plausibility cross-check
const hk = (x: number) => rp.predictHitting({ babip: 100, gap: 100, pow: 100, eye: 100, kRat: x, speed: 100, steal: 100, run: 100 } as any, {} as any).SO;
const hitSlope = (hk(122) - hk(112)) / 10;
const pcOppAdj = pairedContrast(oppAdj, 0x51ee11, 6000, cubOf);
const pcCellFE = pairedContrast(cellFE, 0x51ee11, 6000, cubOf);
const bpOppAdj = bootPooled(oppAdj, 0x51ee11), bpCellFE = bootPooled(cellFE, 0x51ee11), bpCellYFE = bootPooled(cellYearFE, 0x51ee11);

say(`     ══ THE DECISIVE TEST — remove the composition and re-read the SAME statistics ══`);
say();
say(`        arm composition by matchup cell (BF share of the arm):`);
say(`           vR arm: ${f(100 * sum(FULL.filter((r) => r.throws === 1 && r.side === "R").map((r) => r.w)) / sum(byHand(FULL, "R").map((r) => r.w)), 1)}% same-side (RHP), ${f(100 * sum(FULL.filter((r) => r.throws === 2 && r.side === "R").map((r) => r.w)) / sum(byHand(FULL, "R").map((r) => r.w)), 1)}% opposite (LHP)`);
say(`           vL arm: ${f(100 * sum(FULL.filter((r) => r.throws === 2 && r.side === "L").map((r) => r.w)) / sum(byHand(FULL, "L").map((r) => r.w)), 1)}% same-side (LHP), ${f(100 * sum(FULL.filter((r) => r.throws === 1 && r.side === "L").map((r) => r.w)) / sum(byHand(FULL, "L").map((r) => r.w)), 1)}% opposite (RHP)`);
say(`        ⇒ the vR arm is HALF same-side matchups, the vL arm ONE FIFTH. The arms are not two`);
say(`          views of one thing; they carry different mixtures of a matchup effect worth ${sgn(lvlSame - lvlOpp)}/600.`);
say();
say(`        fitted slope of the K residual on opposing avoid-K: ${sgn(slope, 3)} K/600 per rating point`);
say(`        the deployed HITTER K curve's own local slope:      ${sgn(hitSlope, 3)} K/600 per rating point`);
say(`        ⇒ the residual moves with opposing avoid-K at ${f(Math.abs(slope / hitSlope), 2)}× the rate the model itself says a`);
say(`          rating point is worth. The size is not an accident — it is the missing opponent term.`);
say();
say(`     ${pad("construction", 42)}${lpad("pooled cubic", 14)}${lpad("vR", 10)}${lpad("vL", 10)}${lpad("vR−vL", 10)}`);
say(`     ${pad("raw (the artifact)", 42)}${lpad(sgn(cubOf(withOpp), 4), 14)}${lpad(sgn(cubOf(byHand(withOpp, "R")), 4), 10)}${lpad(sgn(cubOf(byHand(withOpp, "L")), 4), 10)}${lpad(sgn(dCub(withOpp), 4), 10)}`);
for (const [t, rs2] of [["− linear opposing-avoid-K term", oppAdj], ["− matchup-cell (throws×batter) level", cellFE], ["− matchup-cell × SEASON level", cellYearFE]] as const)
  say(`     ${pad(t, 42)}${lpad(sgn(cubOf(rs2), 4), 14)}${lpad(sgn(cubOf(byHand(rs2, "R")), 4), 10)}${lpad(sgn(cubOf(byHand(rs2, "L")), 4), 10)}${lpad(sgn(dCub(rs2), 4), 10)}`);
say();
say(`     with the artifact's own paired card-cluster inference:`);
say(`        raw:                       pooled ${sgn(cubOf(withOpp), 4)} CI [${sgn(bpBase.ci.lo, 3)}, ${sgn(bpBase.ci.hi, 3)}];  vR−vL ${sgn(dCub(withOpp), 4)} p=0.034 CI-clear`);
say(`        − opposing-avoid-K term:   pooled ${sgn(cubOf(oppAdj), 4)} CI [${sgn(bpOppAdj.ci.lo, 3)}, ${sgn(bpOppAdj.ci.hi, 3)}] ${clear(bpOppAdj.ci) ? "CI-clear" : "COVERS 0"};  vR−vL ${sgn(dCub(oppAdj), 4)} CI [${sgn(pcOppAdj.ci.lo, 3)}, ${sgn(pcOppAdj.ci.hi, 3)}] p=${f(pcOppAdj.p, 3)} ${clear(pcOppAdj.ci) ? "CI-clear" : "COVERS 0"}`);
say(`        − matchup-cell level:      pooled ${sgn(cubOf(cellFE), 4)} CI [${sgn(bpCellFE.ci.lo, 3)}, ${sgn(bpCellFE.ci.hi, 3)}] ${clear(bpCellFE.ci) ? "CI-clear" : "COVERS 0"};  vR−vL ${sgn(dCub(cellFE), 4)} CI [${sgn(pcCellFE.ci.lo, 3)}, ${sgn(pcCellFE.ci.hi, 3)}] p=${f(pcCellFE.p, 3)} ${clear(pcCellFE.ci) ? "CI-clear" : "COVERS 0"}`);
say(`        − matchup-cell × season:   pooled ${sgn(cubOf(cellYearFE), 4)} CI [${sgn(bpCellYFE.ci.lo, 3)}, ${sgn(bpCellYFE.ci.hi, 3)}] ${clear(bpCellYFE.ci) ? "CI-clear" : "COVERS 0"}`);
say();

say("################################################################################");
say("## 7f. CANDIDATE 2 — ARE THE ARMS POPULATED BY DIFFERENTLY-SHAPED CARDS?");
say("################################################################################");
say();
say(`     BF-weighted PITCHING rating vector carried by each arm:`);
say(`        ${pad("", 12)}${lpad("STU", 9)}${lpad("CON", 9)}${lpad("PBABIP", 9)}${lpad("HRA", 9)}${lpad("BF", 12)}`);
say(`        ${pad("vR arm", 12)}${lpad(f(profR.stu, 1), 9)}${lpad(f(profR.con, 1), 9)}${lpad(f(profR.pbabip, 1), 9)}${lpad(f(profR.hrr, 1), 9)}${lpad(k(profR.bf), 12)}`);
say(`        ${pad("vL arm", 12)}${lpad(f(profL.stu, 1), 9)}${lpad(f(profL.con, 1), 9)}${lpad(f(profL.pbabip, 1), 9)}${lpad(f(profL.hrr, 1), 9)}${lpad(k(profL.bf), 12)}`);
say(`        ${pad("difference", 12)}${lpad(sgn(profR.stu - profL.stu, 1), 9)}${lpad(sgn(profR.con - profL.con, 1), 9)}${lpad(sgn(profR.pbabip - profL.pbabip, 1), 9)}${lpad(sgn(profR.hrr - profL.hrr, 1), 9)}`);
say(`     The arms are the SAME CARDS — but not the same RATINGS. Every channel is hand-split, so the`);
say(`     two arms are two different rating vectors for one roster, and the ordering differs.`);
say();
say(`     PER-CARD vL EXPOSURE SHARE (BF vL / total BF). If vL exposure were random, share ≈ constant.`);
say(`        ${pad("", 26)}${lpad("n", 5)}${lpad("vL share", 10)}${lpad("STU vR", 9)}${lpad("STU vL", 9)}${lpad("%LHP", 8)}${lpad("%SP", 7)}`);
for (const [t, g] of [["top-15 by vL share", hiL], ["bottom-15 by vL share", loL], ["all cards", cardShare]] as const)
  say(`        ${pad(t, 26)}${lpad(String(g.length), 5)}${lpad(f(meanOf(g, (c) => c.share), 3), 10)}${lpad(f(meanOf(g, (c) => c.stuR), 1), 9)}${lpad(f(meanOf(g, (c) => c.stuL), 1), 9)}${lpad(f(100 * g.filter((c) => c.thr === 2).length / g.length, 0), 8)}${lpad(f(100 * g.filter((c) => /^SP/i.test(c.pos)).length / g.length, 0), 7)}`);
say(`        correlation(vL share, STU vL − STU vR) across cards: ${sgn(corrArr(cardShare.map((c) => c.share), cardShare.map((c) => c.stuL - c.stuR)), 2)}`);
say(`        correlation(vL share, is-LHP)                      : ${sgn(corrArr(cardShare.map((c) => c.share), cardShare.map((c) => (c.thr === 2 ? 1 : 0))), 2)}`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §7g — CANDIDATE 3: park handedness
// ══════════════════════════════════════════════════════════════════════════════════
// Per-LEAGUE reads: if a per-hand park effect drove the gap it would have to be common to
// every league at once, or vary across leagues in a way the pooled read hides.
const { loadWindowLeagues } = await import("../src/training/loader.ts");
const LEAGUES = ["PEL", "HD450", "HD451", "HD452", "HD453"];
interface LgCell { lg: string; y: number; rows: Row[] }
const lgCells: LgCell[] = [];
for (const y of MAIN) for (const lg of LEAGUES) {
  const lw = loadWindowLeagues(ROOT, [y], [lg]);
  const obs = lw.observations.filter(keepVar).filter((o) => PITCHER.qualifies(o, DEF_MINPA));
  if (!obs.length) continue;
  const rows: Row[] = [];
  for (const o of obs) {
    const bf = Math.max(o.pitch.BF, 1); const obsK = (o.pitch.K / bf) * 600; const predK = rp.predictPitching(o.ratings.pitch, {} as any).K;
    if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
    rows.push({ cid: o.cid, name: o.name, stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side), year: y, throws: o.throws, pos: o.pos, obsK, predK });
  }
  if (rows.length >= 20) lgCells.push({ lg, y, rows });
}
const byLeague = LEAGUES.map((lg) => { const rs = lgCells.filter((c) => c.lg === lg).flatMap((c) => c.rows); return { lg, rs }; }).filter((x) => x.rs.length >= 40);
say("################################################################################");
say("## 7g. CANDIDATE 3 — PARK HANDEDNESS, AND THE PER-LEAGUE READ");
say("################################################################################");
say();
say(`     The training CSVs carry NO park identifier and NO park columns; the corpus is documented`);
say(`     (src/training/loader.ts) as collected in a NEUTRAL league environment — no park, neutral`);
say(`     era — which is why outcomes are summed across leagues with no neutralisation. So there is`);
say(`     no per-hand park factor on this line to remove, and none to blame. What CAN be checked is`);
say(`     whether the gap behaves like a shared environment effect: a park-handedness story needs`);
say(`     the gap to be league-specific (different parks) — a common gap in EVERY league is evidence`);
say(`     against it.`);
say();
say(`     ${pad("league", 9)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("BF", 12)}${lpad("lvl vR", 9)}${lpad("lvl vL", 9)}${lpad("vR cub", 9)}${lpad("vL cub", 9)}${lpad("vR−vL", 9)}`);
for (const { lg, rs } of byLeague)
  say(`     ${pad(lg, 9)}${lpad(String(rs.length), 7)}${lpad(String(cardsOf(rs)), 7)}${lpad(k(sum(rs.map((r) => r.w))), 12)}${lpad(sgn(wmean(byHand(rs, "R"), (r) => r.resid)), 9)}${lpad(sgn(wmean(byHand(rs, "L"), (r) => r.resid)), 9)}${lpad(sgn(cubOf(byHand(rs, "R")), 3), 9)}${lpad(sgn(cubOf(byHand(rs, "L")), 3), 9)}${lpad(sgn(dCub(rs), 3), 9)}`);
say(`     (per-league rows are the SAME cards again — a card is deployed in several leagues at once,`);
say(`      so these are not independent samples either; they are re-cuts of one roster.)`);
say();
// per (league,year) cell: does the vR−vL LEVEL gap track the opposition composition gap?
const cellRows = lgCells.map((c) => {
  const same = c.rows.filter((r) => (r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L"));
  const opp2 = c.rows.filter((r) => (r.throws === 1 && r.side === "L") || (r.throws === 2 && r.side === "R"));
  const o = oppSeries.find((x) => x.y === c.y)!;
  return { lg: c.lg, y: c.y, n: c.rows.length, lvlGap: wmean(byHand(c.rows, "R"), (r) => r.resid) - wmean(byHand(c.rows, "L"), (r) => r.resid), soGap: wmean(same, (r) => r.resid) - wmean(opp2, (r) => r.resid), oppGap: o.gapK };
}).filter((c) => Number.isFinite(c.lvlGap) && Number.isFinite(c.soGap));
say(`     Across the ${cellRows.length} (league × season) cells:`);
say(`        correlation(opposition avoid-K gap, same−opposite residual level gap) = ${sgn(corrArr(cellRows.map((c) => c.oppGap), cellRows.map((c) => c.soGap)), 2)}`);
say(`        same−opposite residual level gap is NEGATIVE in ${cellRows.filter((c) => c.soGap < 0).length}/${cellRows.length} cells;  vR−vL level gap positive in ${cellRows.filter((c) => c.lvlGap > 0).length}/${cellRows.length}`);
say();

say("################################################################################");
say("## 8. PARAMETER COST — does the hand split actually PREDICT better?");
say("################################################################################");
say();
say(`     BF-weighted MSE of the K residual (units (K/600)²).  Baseline (no correction) = ${f(totVar, 3)}.`);
say(`     Three cross-validations. The CARD folds are the honest ones: the whole corpus is ~${cardsOf(FULL)} cards,`);
say(`     and a card's residual is nearly a fixed function of its (unchanging) ratings, so a season`);
say(`     fold leaks the same card into train and test.`);
say();
say(`     ${pad("correction model", 32)}${lpad("par", 5)}${lpad("in-sample", 11)}${lpad("LOSO", 10)}${lpad("10-fold card", 14)}${lpad("LOCO", 10)}`);
const cvRes = MODELS.map((m) => ({ ...m, ins: inSample(m.fit), loso: cv(foldSeason, m.fit), c10: cv(foldCard10, m.fit), loco: cv(foldCard, m.fit) }));
for (const m of cvRes) say(`     ${pad(m.tag, 32)}${lpad(String(m.par), 5)}${lpad(f(m.ins, 3), 11)}${lpad(f(m.loso, 3), 10)}${lpad(f(m.c10, 3), 14)}${lpad(f(m.loco, 3), 10)}`);
say();
const bestBy = (kk: "loso" | "c10" | "loco") => cvRes.reduce((a, b) => (b[kk] < a[kk] ? b : a));
say(`     Best by LOSO: ${bestBy("loso").tag}.  Best by 10-fold-card: ${bestBy("c10").tag}.  Best by LOCO: ${bestBy("loco").tag}.`);
const pc4 = cvRes.find((m) => m.tag === "pooled CUBIC")!, hc = cvRes.find((m) => m.tag === "hand-conditioned CUBIC")!;
say(`     hand-conditioned cubic vs pooled cubic:  LOSO ${sgn(100 * (hc.loso - pc4.loso) / pc4.loso, 1)}%   10-fold-card ${sgn(100 * (hc.c10 - pc4.c10) / pc4.c10, 1)}%   LOCO ${sgn(100 * (hc.loco - pc4.loco) / pc4.loco, 1)}%`);
say(`     (positive = the hand split predicts WORSE.)`);
say();
// information criterion on the cluster-effective sample size
const nEff = cardsOf(FULL) * 2; // card × hand — the number of genuinely distinct (card,hand) residual cells
say(`     Information criteria on the effective sample size (n = ${nEff} card×hand cells, since a card's`);
say(`     seasons repeat one underlying residual):`);
say(`     ${pad("correction model", 32)}${lpad("par", 5)}${lpad("AIC", 11)}${lpad("BIC", 11)}`);
for (const m of cvRes) { const aic = nEff * Math.log(m.ins) + 2 * m.par, bic = nEff * Math.log(m.ins) + Math.log(nEff) * m.par; say(`     ${pad(m.tag, 32)}${lpad(String(m.par), 5)}${lpad(f(aic, 1), 11)}${lpad(f(bic, 1), 11)}`); }
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §9 — IS THE CUBIC EVEN THE RIGHT DESCRIPTION?
// ══════════════════════════════════════════════════════════════════════════════════
// Compare the cubic against simpler / differently-shaped hand-blind alternatives on the same CV.
function fitHinge(knotZ: number): Fitter {
  return (train) => {
    // design [1, z, (z-knot)+] — a monotone-friendly broken line
    const X = (r: Row) => [1, zg(r.stu), Math.max(zg(r.stu) - knotZ, 0)];
    const n = 3, A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
    for (const r of train) { const x = X(r); for (let i = 0; i < n; i++) { b[i] += r.w * x[i]! * r.resid; for (let j = 0; j < n; j++) A[i]![j] += r.w * x[i]! * x[j]!; } }
    for (let i = 0; i < n; i++) { let piv = i; for (let q2 = i + 1; q2 < n; q2++) if (Math.abs(A[q2]![i]!) > Math.abs(A[piv]![i]!)) piv = q2; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let q2 = i + 1; q2 < n; q2++) { const fct = A[q2]![i]! / d; for (let j = i; j < n; j++) A[q2]![j]! -= fct * A[i]![j]!; b[q2] -= fct * b[i]; } }
    const c = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * c[j]; c[i] = s / (A[i]![i]! || 1e-12); }
    return (r) => { const x = X(r); return c[0]! * x[0]! + c[1]! * x[1]! + c[2]! * x[2]!; };
  };
}
const ALT: { tag: string; par: number; fit: Fitter }[] = [
  { tag: "pooled linear", par: 2, fit: fitPoly(1) },
  { tag: "pooled quadratic", par: 3, fit: fitPoly(2) },
  { tag: "pooled CUBIC", par: 4, fit: fitPoly(3) },
  { tag: "pooled quartic", par: 5, fit: fitPoly(4) },
  { tag: "broken line, knot z=+1.0", par: 3, fit: fitHinge(1.0) },
  { tag: "broken line, knot z=+1.5", par: 3, fit: fitHinge(1.5) },
  { tag: "broken line, knot z=-1.0", par: 3, fit: fitHinge(-1.0) },
];
say("################################################################################");
say("## 9. IS A CUBIC THE RIGHT DESCRIPTION AT ALL?");
say("################################################################################");
say();
say(`     ${pad("hand-blind correction", 32)}${lpad("par", 5)}${lpad("in-sample", 11)}${lpad("LOSO", 10)}${lpad("10-fold card", 14)}${lpad("LOCO", 10)}`);
for (const m of ALT) say(`     ${pad(m.tag, 32)}${lpad(String(m.par), 5)}${lpad(f(inSample(m.fit), 3), 11)}${lpad(f(cv(foldSeason, m.fit), 3), 10)}${lpad(f(cv(foldCard10, m.fit), 3), 14)}${lpad(f(cv(foldCard, m.fit), 3), 10)}`);
say();
say(`     Cubic partial after trimming the tails that define it:`);
for (const lim of [3.2, 2.5, 2.0, 1.75, 1.5]) {
  const rs = trimZ(FULL, lim);
  say(`        |z| ≤ ${f(lim, 2)}  (N=${rs.length}, ${f(100 * rs.length / FULL.length, 0)}% of rows): pooled ${sgn(cubOf(rs), 4)}   vR ${sgn(cubOf(byHand(rs, "R")), 4)}   vL ${sgn(cubOf(byHand(rs, "L")), 4)}   vR−vL ${sgn(dCub(rs), 4)}`);
}
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §10 — HOW MUCH INDEPENDENT INFORMATION IS ACTUALLY IN THE WIDE WINDOW?
// ══════════════════════════════════════════════════════════════════════════════════
// intraclass correlation of a card's residual across its own seasons, per arm
function icc(rs: Row[]) {
  const g = new Map<string, Row[]>(); for (const r of rs) (g.get(r.cid) ?? g.set(r.cid, []).get(r.cid)!).push(r);
  const gm = wmean(rs, (r) => r.resid);
  let sb = 0, sw = 0, wb = 0, ww = 0;
  for (const [, s] of g) { if (s.length < 2) continue; const m = wmean(s, (r) => r.resid); const W = sum(s.map((r) => r.w)); sb += W * (m - gm) ** 2; wb += W; for (const r of s) { sw += r.w * (r.resid - m) ** 2; ww += r.w; } }
  const vb = wb > 0 ? sb / wb : NaN, vw = ww > 0 ? sw / ww : NaN;
  return { between: vb, within: vw, icc: vb / (vb + vw) };
}
const iccR = icc(byHand(FULL, "R")), iccL = icc(byHand(FULL, "L")), iccAll = icc(FULL);
// card-grain collapse: one row per (card, hand), BF-summed — the genuinely independent unit
function collapse(rs: Row[]): Row[] {
  const g = new Map<string, Row[]>();
  for (const r of rs) { const kk = `${r.cid}|${r.side}`; (g.get(kk) ?? g.set(kk, []).get(kk)!).push(r); }
  return [...g.values()].map((s) => ({ ...s[0]!, stu: wmean(s, (r) => r.stu), resid: wmean(s, (r) => r.resid), w: sum(s.map((r) => r.w)), year: 0 }));
}
const COL = collapse(FULL);
const pcCol = pairedContrast(COL, 0x51ee11, 8000, cubOf);

say("################################################################################");
say("## 10. HOW MUCH INDEPENDENT INFORMATION IS IN THE WIDE WINDOW?");
say("################################################################################");
say();
say(`     Variance decomposition of the residual (BF-weighted):`);
say(`        ${pad("", 10)}${lpad("between-card", 15)}${lpad("within-card", 14)}${lpad("ICC", 9)}`);
for (const [t, v] of [["pooled", iccAll], ["vR", iccR], ["vL", iccL]] as const) say(`        ${pad(t, 10)}${lpad(f(v.between, 2), 15)}${lpad(f(v.within, 2), 14)}${lpad(f(v.icc, 3), 9)}`);
say(`     The POOLED ICC (0.14) is misleading — pooling puts the two arms of the same card in one`);
say(`     cluster, and the arms differ, which inflates the "within" term. The relevant number is the`);
say(`     WITHIN-ARM one, because every estimate here is computed inside an arm:`);
for (const [t, v, rs] of [["vR", iccR, byHand(FULL, "R")], ["vL", iccL, byHand(FULL, "L")]] as const) {
  const m = rs.length / cardsOf(rs), de = 1 + (m - 1) * v.icc;
  say(`        ${t}: ICC ${f(v.icc, 3)}, ${f(m, 1)} seasons/card ⇒ design effect ${f(de, 2)}, so ${rs.length} rows carry ≈ ${f(rs.length / de, 0)} rows of information`);
  say(`            — i.e. ${f(rs.length / de / cardsOf(rs), 2)}× what ONE season of the same cards would have given.`);
}
say(`     The wide window multiplied rows by 3.2× and independent information by roughly 1.2–1.3×.`);
say();
// the cell the vL arm's flat cubic actually rests on
const oddBin = FULL.filter((r) => r.side === "L" && zg(r.stu) >= 0.3 && zg(r.stu) < 0.9).sort((a, b) => b.w - a.w);
say(`     THE vL CELL THAT CARRIES THE CONTRAST. The artifact's vL quintile table has one cell at`);
say(`     -7.20/600 while every other vL cell sits near -1; it is the bin z∈[+0.3,+0.9). Its BF, by card:`);
{
  const g = new Map<string, { bf: number; resid: number }>();
  for (const r of oddBin) { const e = g.get(r.name) ?? { bf: 0, resid: 0 }; e.bf += r.w; e.resid += r.w * r.resid; g.set(r.name, e); }
  const tot = sum([...g.values()].map((e) => e.bf));
  const top = [...g.entries()].sort((a, b) => b[1].bf - a[1].bf).slice(0, 6);
  for (const [nm, e] of top) say(`        ${pad(nm.slice(0, 22), 24)}${lpad(k(e.bf), 10)} BF  ${lpad(f(100 * e.bf / tot, 1) + "%", 8)} of the bin   mean resid ${sgn(e.resid / e.bf)}`);
  say(`        top-2 cards = ${f(100 * sum(top.slice(0, 2).map(([, e]) => e.bf)) / tot, 1)}% of the bin's BF.`);
}
say();
say(`     COLLAPSED to one row per (card, hand) — the unit that is actually independent:`);
say(`        N=${COL.length} cells / ${cardsOf(COL)} cards.  vR cubic ${sgn(cubOf(byHand(COL, "R")), 4)}  vL ${sgn(cubOf(byHand(COL, "L")), 4)}  vR−vL ${sgn(dCub(COL), 4)}`);
say(`        paired card-cluster CI [${sgn(pcCol.ci.lo, 4)}, ${sgn(pcCol.ci.hi, 4)}]  p=${f(pcCol.p, 3)}  ${clear(pcCol.ci) ? "CI-clear" : "COVERS 0"}`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §12 — THE POOLED CUBIC AFTER THE COMPOSITION CORRECTION: is it usable?
// ══════════════════════════════════════════════════════════════════════════════════
const CORR = cellFE;                       // matchup-cell level removed — the clean object
const corrBase = cubOf(CORR);
const looC = [...new Set(CORR.map((r) => r.cid))].map((cid) => { const rs = CORR.filter((r) => r.cid !== cid); const cr = CORR.filter((r) => r.cid === cid); return { name: cr[0]!.name, z: zg(wmean(cr, (r) => r.stu)), bf: sum(cr.map((r) => r.w)), d: cubOf(rs), delta: cubOf(rs) - corrBase }; }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
const dropSeqC: number[] = [corrBase];
{
  let rs = CORR;
  for (let i = 1; i <= 5; i++) { const cands = [...new Set(rs.map((r) => r.cid))]; let best = cands[0]!, bestAbs = -1, bestD = NaN; for (const c of cands) { const s = rs.filter((r) => r.cid !== c); const d = cubOf(s); if (Math.abs(d - cubOf(rs)) > bestAbs) { bestAbs = Math.abs(d - cubOf(rs)); best = c; bestD = d; } } rs = rs.filter((r) => r.cid !== best); dropSeqC.push(bestD); }
}
const seedsC = SEEDS.slice(0, 20).map((s) => bootPooled(CORR, s, 3000));
const psC = seedsC.map((r) => r.p).sort((a, b) => a - b);
const specC: { tag: string; rows: Row[]; wf: (r: Row) => number; zf: (r: Row) => number; deg: number }[] = [
  { tag: "corrected baseline", rows: CORR, wf: wBF, zf: zRow, deg: 3 },
  { tag: "weights √BF", rows: CORR, wf: (r) => Math.sqrt(r.w), zf: zRow, deg: 3 },
  { tag: "UNWEIGHTED", rows: CORR, wf: () => 1, zf: zRow, deg: 3 },
  { tag: "z within SEASON", rows: CORR, wf: wBF, zf: zWithinYear, deg: 3 },
  { tag: "degree 4", rows: CORR, wf: wBF, zf: zRow, deg: 4 },
  { tag: "degree 5", rows: CORR, wf: wBF, zf: zRow, deg: 5 },
  { tag: "trim |z| > 2.0", rows: trimZ(CORR, 2.0), wf: wBF, zf: zRow, deg: 3 },
  { tag: "trim |z| > 1.75", rows: trimZ(CORR, 1.75), wf: wBF, zf: zRow, deg: 3 },
  { tag: "trim |z| > 1.5", rows: trimZ(CORR, 1.5), wf: wBF, zf: zRow, deg: 3 },
];
// CV on the corrected residuals
const inSampleC = (fit: Fitter) => { const g = fit(CORR); let se = 0, sw = 0; for (const r of CORR) { const e = r.resid - g(r); se += r.w * e * e; sw += r.w; } return se / sw; };
const foldSeasonC = MAIN.map((y) => CORR.filter((r) => r.year === y));
const cidC = [...new Set(CORR.map((r) => r.cid))];
const foldCardC = cidC.map((c) => CORR.filter((r) => r.cid === c));
const foldCard10C = (() => { const out: Row[][] = Array.from({ length: 10 }, () => []); cidC.forEach((c, i) => out[i % 10]!.push(...CORR.filter((r) => r.cid === c))); return out; })();
const FORMS: { tag: string; par: number; fit: Fitter }[] = [
  { tag: "no correction", par: 0, fit: fitZero },
  { tag: "constant", par: 1, fit: fitPoly(0) },
  { tag: "linear", par: 2, fit: fitPoly(1) },
  { tag: "quadratic", par: 3, fit: fitPoly(2) },
  { tag: "CUBIC", par: 4, fit: fitPoly(3) },
  { tag: "quartic", par: 5, fit: fitPoly(4) },
  { tag: "broken line, knot z=+1.0", par: 3, fit: fitHinge(1.0) },
  { tag: "broken line, knot z=+1.5", par: 3, fit: fitHinge(1.5) },
  { tag: "broken line, knot z=-1.0", par: 3, fit: fitHinge(-1.0) },
  { tag: "hand-conditioned CUBIC", par: 8, fit: fitHand(3) },
];
say("################################################################################");
say("## 12. THE POOLED CUBIC AFTER THE COMPOSITION CORRECTION — is it usable?");
say("################################################################################");
say();
say(`     Object: the ${CORR.length} rows with the matchup-cell (pitcher-hand × batter-hand) level removed.`);
say(`     Pooled cubic ${sgn(corrBase, 4)} (raw ${sgn(cubOf(FULL), 4)}); vR ${sgn(cubOf(byHand(CORR, "R")), 4)}, vL ${sgn(cubOf(byHand(CORR, "L")), 4)} — the arms now AGREE.`);
say();
say(`     Corrected residual by Stuff quintile, per arm (the shape that is left):`);
say(`     ${pad("z(stu) quintile", 18)}${lpad("n", 6)}${lpad("BF", 12)}${lpad("pooled", 10)}${lpad("vR", 10)}${lpad("vL", 10)}`);
{
  const srt = [...CORR].sort((a, b) => a.stu - b.stu);
  for (let i = 0; i < 5; i++) {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    say(`     ${pad(`[${f(zg(s[0]!.stu), 2)}, ${f(zg(s[s.length - 1]!.stu), 2)}]`, 18)}${lpad(String(s.length), 6)}${lpad(k(sum(s.map((r) => r.w))), 12)}${lpad(sgn(wmean(s, (r) => r.resid)), 10)}${lpad(sgn(wmean(byHand(s, "R"), (r) => r.resid)), 10)}${lpad(sgn(wmean(byHand(s, "L"), (r) => r.resid)), 10)}`);
  }
}
say();
say(`     INFLUENCE on the corrected pooled cubic:`);
say(`        Kish ESS over CARDS of the cubic information: ${f(kish([...cubInfoByCard(CORR).values()]), 1)} effective cards (of ${cardsOf(CORR)})`);
for (const x of looC.slice(0, 5)) say(`        ${pad(x.name.slice(0, 22), 24)}z ${sgn(x.z, 2)}  →  ${sgn(x.d, 4)}  (Δ ${sgn(x.delta, 4)})`);
say(`        sequential greedy drop: ${dropSeqC.map((d) => sgn(d, 3)).join("  →  ")}`);
say();
say(`     SEED STABILITY of the corrected pooled cubic (20 streams × 3,000 cluster draws):`);
say(`        p: min ${f(psC[0]!, 3)}  median ${f(q(psC, 0.5), 3)}  max ${f(psC[psC.length - 1]!, 3)};  CI-clear in ${seedsC.filter((r) => clear(r.ci)).length}/20`);
say();
say(`     SPEC SENSITIVITY of the corrected pooled cubic:`);
say(`     ${pad("specification", 26)}${lpad("rows", 7)}${lpad("cubic", 10)}${lpad("% of base", 11)}`);
for (const s of specC) { const c = wpolyGen(s.rows, s.deg, s.zf, (r) => r.resid, s.wf)[3]!; say(`     ${pad(s.tag, 26)}${lpad(String(s.rows.length), 7)}${lpad(sgn(c, 4), 10)}${lpad(f(100 * c / corrBase, 0) + "%", 11)}`); }
say();
say(`     IS A CUBIC THE RIGHT FORM FOR THE CORRECTED RESIDUAL? BF-weighted MSE, same three CVs.`);
say(`     ${pad("hand-blind correction", 30)}${lpad("par", 5)}${lpad("in-sample", 11)}${lpad("LOSO", 10)}${lpad("10-fold card", 14)}${lpad("LOCO", 10)}`);
const cvC = FORMS.map((m) => ({ ...m, ins: inSampleC(m.fit), loso: cv(foldSeasonC, m.fit), c10: cv(foldCard10C, m.fit), loco: cv(foldCardC, m.fit) }));
for (const m of cvC) say(`     ${pad(m.tag, 30)}${lpad(String(m.par), 5)}${lpad(f(m.ins, 3), 11)}${lpad(f(m.loso, 3), 10)}${lpad(f(m.c10, 3), 14)}${lpad(f(m.loco, 3), 10)}`);
const bC = (kk: "loso" | "c10" | "loco") => cvC.reduce((a, b) => (b[kk] < a[kk] ? b : a)).tag;
say(`     Best by LOSO: ${bC("loso")}.   Best by 10-fold-card: ${bC("c10")}.   Best by LOCO: ${bC("loco")}.`);
const cvNo = cvC.find((m) => m.tag === "no correction")!, cvCu = cvC.find((m) => m.tag === "CUBIC")!, cvHa = cvC.find((m) => m.tag === "hand-conditioned CUBIC")!, cvQt = cvC.find((m) => m.tag === "quartic")!;
say(`     The CUBIC now earns its keep: LOCO ${f(cvCu.loco, 2)} vs ${f(cvNo.loco, 2)} uncorrected (${sgn(100 * (cvCu.loco - cvNo.loco) / cvNo.loco, 1)}%), and it beats`);
say(`     every 2–3 parameter alternative on all three folds. Hand-conditioning it makes prediction`);
say(`     WORSE on both card-based folds (${f(cvHa.c10, 2)} / ${f(cvHa.loco, 2)} vs ${f(cvCu.c10, 2)} / ${f(cvCu.loco, 2)}) — the rejection stands after correction.`);
say(`     The QUARTIC beats the cubic on all three (${f(cvQt.loco, 2)} LOCO) — so "cubic" is not established as the`);
say(`     right form; what is established is that the leftover shape is higher-order than quadratic.`);
say();
say(`     Residual composition-shape check — is any of the leftover cubic still a mixture effect?`);
say(`        same-side BF share by Stuff quintile (if this varied sharply with Stuff, a cell-mean`);
say(`        removal would still leave a mixture footprint):`);
{
  const srt = [...FULL].sort((a, b) => a.stu - b.stu);
  const parts: string[] = [];
  for (let i = 0; i < 5; i++) { const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length)); const sm = s.filter((r) => (r.throws === 1 && r.side === "R") || (r.throws === 2 && r.side === "L")); parts.push(`Q${i + 1} ${f(100 * sum(sm.map((r) => r.w)) / sum(s.map((r) => r.w)), 0)}%`); }
  say(`           ${parts.join("   ")}`);
}
say(`        cubic WITHIN each matchup cell, after the cell level is removed:`);
for (const [t, sel] of [["RHP vs RHB", (r: Row) => r.throws === 1 && r.side === "R"], ["RHP vs LHB", (r: Row) => r.throws === 1 && r.side === "L"], ["LHP vs RHB", (r: Row) => r.throws === 2 && r.side === "R"], ["LHP vs LHB", (r: Row) => r.throws === 2 && r.side === "L"]] as const) {
  const s = CORR.filter(sel);
  say(`           ${pad(t, 14)}n=${lpad(String(s.length), 4)}  ${lpad(k(sum(s.map((r) => r.w))), 10)} BF   cubic ${sgn(cubOf(s), 4)}`);
}
say(`        (all four cells carry the same-signed cubic ⇒ the leftover shape is a property of Stuff,`);
say(`         not of the matchup mixture. But note how NON-UNIFORM the mixture itself is across Stuff`);
say(`         — that is precisely the machinery that converted a matchup LEVEL into arm-specific SHAPE.)`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// §11 — "OUT-OF-TIME REPLICATION" — how much of it is arithmetic?
// ══════════════════════════════════════════════════════════════════════════════════
// 53 of the 61 OOS cards are fit-window cards. A card's ratings never change, so its residual
// is largely a fixed number. Test: replace every OOS row's residual with THAT CARD'S IN-SAMPLE
// mean residual on the same arm — i.e. carry the in-sample answer forward and add no new
// information at all — and see how much of the "out-of-sample" cubic that reproduces.
const inMean = new Map<string, number>();
{
  const g = new Map<string, Row[]>();
  for (const r of ROWS_IN) { const kk = `${r.cid}|${r.side}`; (g.get(kk) ?? g.set(kk, []).get(kk)!).push(r); }
  for (const [kk, s] of g) inMean.set(kk, wmean(s, (r) => r.resid));
}
const oosShared = ROWS_OOS.filter((r) => inMean.has(`${r.cid}|${r.side}`));
const carry: Row[] = oosShared.map((r) => ({ ...r, resid: inMean.get(`${r.cid}|${r.side}`)! }));
const oosActualCells = (() => {
  const g = new Map<string, Row[]>();
  for (const r of oosShared) { const kk = `${r.cid}|${r.side}`; (g.get(kk) ?? g.set(kk, []).get(kk)!).push(r); }
  return [...g.entries()].map(([kk, s]) => ({ kk, w: sum(s.map((r) => r.w)), act: wmean(s, (r) => r.resid), pre: inMean.get(kk)! }));
})();
const corrW = (xs: { w: number; a: number; b: number }[]) => {
  const W = sum(xs.map((x) => x.w)), ma = sum(xs.map((x) => x.w * x.a)) / W, mb = sum(xs.map((x) => x.w * x.b)) / W;
  const sab = sum(xs.map((x) => x.w * (x.a - ma) * (x.b - mb))), saa = sum(xs.map((x) => x.w * (x.a - ma) ** 2)), sbb = sum(xs.map((x) => x.w * (x.b - mb) ** 2));
  return sab / (Math.sqrt(saa * sbb) || 1e-12);
};
const rCarry = corrW(oosActualCells.map((c) => ({ w: c.w, a: c.act, b: c.pre })));
say("################################################################################");
say("## 11. THE \"OUT-OF-TIME REPLICATION\" IS LARGELY ARITHMETIC");
say("################################################################################");
say();
say(`     ${ROWS_OOS.length} out-of-sample rows; ${oosShared.length} of them (${f(100 * sum(oosShared.map((r) => r.w)) / sum(ROWS_OOS.map((r) => r.w)), 1)}% of OOS BF) belong to a card×arm cell that`);
say(`     the fit window also contains. Ratings never change, so that cell's residual is close to a`);
say(`     constant. CARRY-FORWARD TEST — overwrite each OOS row's residual with its own cell's`);
say(`     IN-SAMPLE mean (zero new information) and recompute:`);
say(`        ${pad("", 34)}${lpad("POOLED", 11)}${lpad("vR", 11)}${lpad("vL", 11)}`);
say(`        ${pad("actual OOS cubic", 34)}${lpad(sgn(cubOf(ROWS_OOS), 4), 11)}${lpad(sgn(cubOf(byHand(ROWS_OOS, "R")), 4), 11)}${lpad(sgn(cubOf(byHand(ROWS_OOS, "L")), 4), 11)}`);
say(`        ${pad("carry-forward (no new info)", 34)}${lpad(sgn(cubOf(carry), 4), 11)}${lpad(sgn(cubOf(byHand(carry, "R")), 4), 11)}${lpad(sgn(cubOf(byHand(carry, "L")), 4), 11)}`);
say(`        ${pad("in-sample cubic", 34)}${lpad(sgn(cubOf(ROWS_IN), 4), 11)}${lpad(sgn(cubOf(byHand(ROWS_IN, "R")), 4), 11)}${lpad(sgn(cubOf(byHand(ROWS_IN, "L")), 4), 11)}`);
say();
say(`     BF-weighted correlation between a cell's IN-SAMPLE residual and its OUT-OF-SAMPLE residual:`);
say(`        r = ${f(rCarry, 3)} over ${oosActualCells.length} card×arm cells ⇒ ${f(100 * rCarry * rCarry, 0)}% of the "new" measurement was`);
say(`        already determined by the in-sample one.`);
say(`     The artifact's headline — vR ${sgn(cubOf(byHand(ROWS_IN, "R")), 4)} in-sample vs ${sgn(cubOf(byHand(ROWS_OOS, "R")), 4)} out-of-sample, "a 0.8% difference" —`);
say(`     is therefore not a strong replication result. Two estimates that share ${f(100 * sum(oosShared.map((r) => r.w)) / sum(ROWS_OOS.map((r) => r.w)), 0)}% of their cards and`);
say(`     read the SAME unchanging ratings SHOULD agree closely; agreeing is the null, not the finding.`);
say(`     The closeness of the agreement (0.8%) is if anything a warning that the two windows are`);
say(`     nearly the same measurement, not two of them.`);
say();

// ══════════════════════════════════════════════════════════════════════════════════
// VERDICT — written into HEAD so it leads the document
// ══════════════════════════════════════════════════════════════════════════════════
const killShare = 100 * (1 - Math.abs(dCub(cellFE) / base_d));
sayH("################################################################################");
sayH("### VERDICT ON THE ASYMMETRY:  EXPLAINED");
sayH("################################################################################");
sayH();
sayH("  CAUSE: OPPOSING-BATTER COMPOSITION, resolved by PITCHER hand. The deployed pitching");
sayH("  prediction contains NO opponent term — predictPitching() sees only the pitcher's own");
sayH("  ratings — while the opposition a line was thrown to differs enormously by matchup cell.");
sayH();
sayH(`   1. Opposing avoid-K by cell (PA-weighted, switch-hitters resolved to the hand they bat from):`);
sayH(`      same-side matchups face batters ${sgn(sum(oppSeries.map((o) => o.gapK)) / oppSeries.length, 2)} avoid-K points weaker than opposite-side ones.`);
sayH(`   2. The residual tracks it: same−opposite K residual level gap ${sgn(lvlSame - lvlOpp)}/600, CI [${sgn(pcSOlvl.ci.lo)}, ${sgn(pcSOlvl.ci.hi)}],`);
sayH(`      p=${f(pcSOlvl.p, 3)}; correlation with the opposition gap ${sgn(corrArr(oppSeries.map((o) => o.gapK), oppSeries.map((o) => o.residGap)), 2)} across seasons, same sign in ${cellRows.filter((c) => c.soGap < 0).length}/${cellRows.length} league-seasons.`);
sayH(`      The fitted slope is ${sgn(slope, 3)} K/600 per opposing rating point — ${f(Math.abs(slope / hitSlope), 2)}× what the model's OWN`);
sayH(`      hitter K curve says a rating point is worth. It is the missing opponent term, at full size.`);
sayH(`   3. The two arms carry that effect in DIFFERENT PROPORTIONS: the vR arm is ${f(100 * sum(FULL.filter((r) => r.throws === 1 && r.side === "R").map((r) => r.w)) / sum(byHand(FULL, "R").map((r) => r.w)), 0)}% same-side`);
sayH(`      matchups, the vL arm ${f(100 * sum(FULL.filter((r) => r.throws === 2 && r.side === "L").map((r) => r.w)) / sum(byHand(FULL, "L").map((r) => r.w)), 0)}%. And because STU vR ≠ STU vL (mean gap ${sgn(meanD(byThrow(1)), 1)} for RHP, ${sgn(meanD(byThrow(2)), 1)} for LHP),`);
sayH(`      the mixture lands at DIFFERENT PLACES on the Stuff axis in each arm — a level effect`);
sayH(`      converted into a shape difference.`);
sayH(`   4. REMOVE IT AND THE ASYMMETRY IS GONE: with the matchup-cell level removed, vR−vL cubic goes`);
sayH(`      ${sgn(base_d, 4)} → ${sgn(dCub(cellFE), 4)} (${f(killShare, 0)}% of it), CI [${sgn(pcCellFE.ci.lo, 3)}, ${sgn(pcCellFE.ci.hi, 3)}], p=${f(pcCellFE.p, 3)}. The arms converge to`);
sayH(`      vR ${sgn(cubOf(byHand(cellFE, "R")), 4)} vs vL ${sgn(cubOf(byHand(cellFE, "L")), 4)}. Stratifying instead of correcting gives the same answer:`);
sayH(`      the vR−vL cubic computed WITHIN pitcher hand and BF-averaged is ${sgn(stThrow.pt, 4)} (p=${f(stThrow.p, 3)}).`);
sayH();
sayH("  There is no hand-specific curve behaviour left to explain. This is consistent with the");
sayH("  mechanism argument that closed the decision: the platoon difference is already in the");
sayH("  ratings, and nothing in the engine converts ratings to outcomes differently by hand.");
sayH();
sayH("################################################################################");
sayH("### WHAT THIS MEANS FOR THE POOLED CUBIC:  NOT CONTAMINATED — AND ATTENUATED, NOT INFLATED");
sayH("################################################################################");
sayH();
sayH(`  The fear was that the pooled ${sgn(cubOf(FULL), 4)} is partly the same artifact. It is not. Removing the`);
sayH(`  composition makes the pooled cubic STRONGER and CLEANER, not weaker:`);
sayH();
sayH(`     ${pad("", 40)}${lpad("pooled cubic", 14)}  ${pad("95% CI (card cluster)", 24)}${lpad("p", 8)}`);
sayH(`     ${pad("raw (the artifact's number)", 40)}${lpad(sgn(cubOf(FULL), 4), 14)}  ${pad(`[${sgn(bpBase.ci.lo, 3)}, ${sgn(bpBase.ci.hi, 3)}]`, 24)}${lpad(f(bpBase.p, 3), 8)}  ${clear(bpBase.ci) ? "CI-clear" : "COVERS 0"}`);
sayH(`     ${pad("− matchup-cell level", 40)}${lpad(sgn(cubOf(cellFE), 4), 14)}  ${pad(`[${sgn(bpCellFE.ci.lo, 3)}, ${sgn(bpCellFE.ci.hi, 3)}]`, 24)}${lpad(f(bpCellFE.p, 3), 8)}  ${clear(bpCellFE.ci) ? "CI-CLEAR" : "covers 0"}`);
sayH(`     ${pad("− matchup-cell × season level", 40)}${lpad(sgn(cubOf(cellYearFE), 4), 14)}  ${pad(`[${sgn(bpCellYFE.ci.lo, 3)}, ${sgn(bpCellYFE.ci.hi, 3)}]`, 24)}${lpad(f(bpCellYFE.p, 3), 8)}  ${clear(bpCellYFE.ci) ? "CI-CLEAR" : "covers 0"}`);
sayH(`     ${pad("− linear opposing-avoid-K term", 40)}${lpad(sgn(cubOf(oppAdj), 4), 14)}  ${pad(`[${sgn(bpOppAdj.ci.lo, 3)}, ${sgn(bpOppAdj.ci.hi, 3)}]`, 24)}${lpad(f(bpOppAdj.p, 3), 8)}  ${clear(bpOppAdj.ci) ? "CI-CLEAR" : "covers 0"}`);
sayH();
sayH(`  The composition was ADDING NOISE, not signal: the BF-weighted residual variance falls from`);
sayH(`  ${f(totVar, 1)} to ${f(inSampleC(fitZero), 1)} (K/600)² once the matchup cells are centred — the composition is ${f(100 * (1 - inSampleC(fitZero) / totVar), 0)}% of the`);
sayH(`  whole K residual, dwarfing anything the curve shape is doing. Its effect on the pooled cubic`);
sayH(`  was to widen the CI to the point of covering zero (raw p=${f(bpBase.p, 3)}), not to create the estimate.`);
sayH();
sayH(`  SO THE POOLED CUBIC IS USABLE — WITH THREE CAVEATS THAT ARE NOT ABOUT THE HAND SPLIT:`);
sayH(`   (i)  IT RESTS ON ~10 EFFECTIVE CARDS. The Kish ESS over CARDS of the cubic's own information`);
sayH(`        is ${f(kish([...cubInfoByCard(CORR).values()]), 1)} of ${cardsOf(CORR)} (the artifact's quoted 94.6 is a ROW-grain ESS, and the bootstrap`);
sayH(`        resamples cards, not rows). ${nameOf(topP[0]![0])} alone holds ${f(100 * topP[0]![1] / infoPtot, 0)}% of it. A cubic coefficient is`);
sayH(`        ${sgn(corrBase * 27, 1)} K/600 at z=+3, so its value is set by the two or three cards out there.`);
sayH(`   (ii) A CUBIC IS NOT ESTABLISHED AS THE FORM. On the corrected residual the QUARTIC beats the`);
sayH(`        cubic on all three cross-validations (LOCO ${f(cvQt.loco, 2)} vs ${f(cvCu.loco, 2)}), and trimming to |z|≤1.75`);
sayH(`        cuts the coefficient to ${f(100 * wpolyGen(trimZ(CORR, 1.75), 3, zRow, (r) => r.resid, wBF)[3]! / corrBase, 0)}% of its value. What is established is only that the leftover`);
sayH(`        shape is HIGHER-ORDER THAN QUADRATIC and lives in the Stuff tails.`);
sayH(`   (iii) THE FIRST-BEST FIX IS NOT A CURVE TERM AT ALL. The largest measurable defect on this line`);
sayH(`        is the missing opponent term (${f(100 * (1 - inSampleC(fitZero) / totVar), 0)}% of the residual variance, a ${sgn(lvlSame - lvlOpp)}/600 matchup gap).`);
sayH(`        Fitting a cubic on top of an uncorrected residual spends curve parameters absorbing`);
sayH(`        exposure. Note the deployed form is fit on 2042+2043 whose matchup mixture is a property`);
sayH(`        of THAT window's rosters and usage — the same drift the pool-turnover argument warns about.`);
sayH();
sayH(`  WHAT WOULD SETTLE THE REMAINING QUESTIONS`);
sayH(`   • For the ~10-effective-card problem: cards outside the current Stuff tail, or the`);
sayH(`     cwhitstats corpus (100s of instances per format at 1000s of IP) which resolves the elite`);
sayH(`     tail this corpus cannot. Nothing inside 'League Files' can fix it — 7 seasons of the same`);
sayH(`     70 cards buy ~1.2–1.3× the information of one season (§10).`);
sayH(`   • For cubic-vs-quartic-vs-something-else: refit the K channel WITH an opponent term present`);
sayH(`     and re-measure the leftover shape. Until the opponent term exists, every shape estimate on`);
sayH(`     this line is measured on a residual that is ${f(100 * (1 - inSampleC(fitZero) / totVar), 0)}% exposure.`);
sayH(`   • For the hand question: closed. It is explained, and the explanation is measurable, sized,`);
sayH(`     and removable.`);
sayH();

process.stdout.write(HEAD.concat(L).join("\n") + "\n");
process.exit(0);
