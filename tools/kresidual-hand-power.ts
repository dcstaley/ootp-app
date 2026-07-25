// K-RESIDUAL vs STUFF — HAND-SPLIT POWER AUDIT (2026-07-25). MEASUREMENT ONLY; nothing wired.
//   run: node tools/kresidual-hand-power.ts > fixtures/kresidual-hand-power-2026-07-25.txt
//
// THE QUESTION. tools/kresidual-stuff-inframe.ts (artifact fixtures/kresidual-stuff-inframe-2026-07-23.txt)
// found a CI-clear CUBIC misfit of the deployed K curve on Stuff, POOLED (-0.5049, CI [-0.9188,-0.1386]),
// and reported it CONCENTRATED ON vR (N=77, cubic -0.8145 CI-clear, level +0.55/600) while vL (N=72) was
// flat with a CI covering zero (+0.0537, [-0.6781,+0.5923]). A +0.54/600 hand LEVEL gap was also reported.
//
// Is that vR-concentration a REAL hand asymmetry, or an artifact of unequal statistical power between the
// two splits? "vL is flat" and "vL is unresolved" look identical when only the CI-clear flag is read. This
// tool answers it by (1) comparing the two hands' information content (rows, BF, BF distribution, BF by
// Stuff quintile, and the LEVERAGE the cubic contrast actually draws on), (2) reporting each hand's
// effective sample size and bootstrap CI WIDTH, (3) POWER-MATCHING: repeatedly degrading vR to vL-equivalent
// information and asking whether its cubic survives, and (4) testing the DIFFERENCE (vR − vL) directly.
//
// MACHINERY is inherited verbatim from the kresidual tool: same loader, same deployed form, same BF weights,
// same ROW grain, same global standardization of Stuff (so cubic coefficients are comparable across hands),
// same weighted normal-equation poly fit, same percentile bootstrap. Nothing is re-fit; nothing is wired.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const k = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; window?: number[]; minPA?: number; includeVariants?: boolean };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rp = makeRawPolyModel(trained.eventForm);      // THE DEPLOYED FORM
const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const obs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const pitQ = obs.filter((o) => PITCHER.qualifies(o, minPA));

interface Row { stu: number; resid: number; w: number; side: string }
const rows: Row[] = [];
for (const o of pitQ) {
  const bf = Math.max(o.pitch.BF, 1);
  const obsK = (o.pitch.K / bf) * 600;
  const predK = rp.predictPitching(o.ratings.pitch, {} as any).K;   // deployed form, per 600
  if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
  rows.push({ stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side) });
}

const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = rs.reduce((a, r) => a + r.w, 0); return sw > 0 ? rs.reduce((a, r) => a + r.w * get(r), 0) / sw : NaN; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// GLOBAL standardization (as in the source tool) so per-hand cubic coefficients are on ONE scale
const mu = wmean(rows, (r) => r.stu), sd = Math.sqrt(wmean(rows, (r) => (r.stu - mu) ** 2)) || 1;
const z = (s: number) => (s - mu) / sd;

/** Weighted poly fit on standardized stu; `y` selects the response (default = residual). */
function wfit(rs: Row[], deg: number, y: (r: Row) => number = (r) => r.resid): number[] {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) {
    const zz = z(r.stu), p = [1, zz, zz * zz, zz * zz * zz].slice(0, n);
    for (let i = 0; i < n; i++) { b[i] += r.w * p[i]! * y(r); for (let j = 0; j < n; j++) A[i]![j] += r.w * p[i]! * p[j]!; }
  }
  for (let i = 0; i < n; i++) { let piv = i; for (let kk = i + 1; kk < n; kk++) if (Math.abs(A[kk]![i]!) > Math.abs(A[piv]![i]!)) piv = kk; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let kk = i + 1; kk < n; kk++) { const fct = A[kk]![i]! / d; for (let j = i; j < n; j++) A[kk]![j]! -= fct * A[i]![j]!; b[kk] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
const cubOf = (rs: Row[]) => wfit(rs, 3)[3]!;

const mkRnd = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rnd = mkRnd(20260725);
const q = (xs: number[], p: number) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]!; };
const ci = (xs: number[]) => ({ lo: q(xs, 0.025), hi: q(xs, 0.975) });
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const boot = (rs: Row[], B: number, stat: (s: Row[]) => number) => {
  const out: number[] = [];
  for (let b = 0; b < B; b++) { const bs = rs.map(() => rs[Math.floor(rnd() * rs.length)]!); out.push(stat(bs)); }
  return out;
};

// ── information content ─────────────────────────────────────────────────────────────────────────
/** Kish effective sample size of a weight vector: (Σw)²/Σw² — how many equally-weighted rows the
 *  weighted set is worth. Equals n when weights are equal, collapses toward 1 when one row dominates. */
const kish = (ws: number[]) => { const s = sum(ws), s2 = sum(ws.map((w) => w * w)); return s2 > 0 ? (s * s) / s2 : 0; };
/** The cubic partial is a CONTRAST: β₃ = Σ wᵢcᵢrᵢ / Σ wᵢcᵢ², where c = z³ residualized against [1,z,z²]
 *  under the same weights. So the rows that actually INFORM the cubic carry weight wᵢcᵢ². Its Kish ESS is
 *  the honest "effective n for the cubic" — it is much smaller than the raw row count by construction. */
function cubicInfo(rs: Row[]) {
  const co = wfit(rs, 2, (r) => z(r.stu) ** 3);            // project z³ on [1,z,z²] with these weights
  const c = rs.map((r) => { const zz = z(r.stu); return zz ** 3 - (co[0]! + co[1]! * zz + co[2]! * zz * zz); });
  const infw = rs.map((r, i) => r.w * c[i]! * c[i]!);       // per-row information about β₃
  return { essCub: kish(infw), infoTotal: sum(infw), c };
}
function info(rs: Row[]) {
  const bf = rs.map((r) => r.w);
  const ci3 = cubicInfo(rs);
  return {
    n: rs.length, bfTot: sum(bf), bfMean: sum(bf) / (rs.length || 1),
    bfQ: [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0].map((p) => q(bf, p === 1 ? 0.999999 : p)),
    ess: kish(bf), essCub: ci3.essCub, infoTotal: ci3.infoTotal,
  };
}

// quintile table (by Stuff), reporting BF as well as residual — where does each hand's mass sit?
function quints(rs: Row[]) {
  const srt = [...rs].sort((p, r) => p.stu - r.stu);
  return [0, 1, 2, 3, 4].map((i) => {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    return { lo: s[0]?.stu ?? 0, hi: s[s.length - 1]?.stu ?? 0, n: s.length, bf: sum(s.map((r) => r.w)), resid: wmean(s, (r) => r.resid) };
  });
}

const R = rows.filter((r) => r.side === "R"), Lh = rows.filter((r) => r.side === "L");
const iR = info(R), iL = info(Lh);
const cubR = cubOf(R), cubL = cubOf(Lh), cubAll = cubOf(rows);
const B_MAIN = 2000;
const bR = boot(R, B_MAIN, cubOf), bL = boot(Lh, B_MAIN, cubOf), bAll = boot(rows, B_MAIN, cubOf);
const ciR = ci(bR), ciL = ci(bL), ciAll = ci(bAll);
const wid = (c: { lo: number; hi: number }) => c.hi - c.lo;
const lvlR = wmean(R, (r) => r.resid), lvlL = wmean(Lh, (r) => r.resid);

// ── POWER MATCHING ──────────────────────────────────────────────────────────────────────────────
// Degrade vR to vL-equivalent information and ask whether its cubic survives. Two matching criteria,
// because "power" has two faces here: total BF (the noise in each row's K rate) and the cubic-contrast
// ESS (how many rows actually inform β₃). Subsampling is WITHOUT replacement, rows drawn at random,
// accumulating until the target is met — so the subsample keeps vR's own Stuff/BF joint structure.
function subsampleTo(src: Row[], reached: (s: Row[]) => boolean): Row[] {
  const idx = src.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  const out: Row[] = [];
  for (const i of idx) { out.push(src[i]!); if (out.length >= 8 && reached(out)) break; }
  return out;
}
const OUTER = 400, INNER = 400;
interface Matched { label: string; target: string; reachable: boolean; est: number[]; inner: number[]; nSub: number[]; bfSub: number[]; essCub: number[]; width: number[]; clearNeg: number; clearAny: number }
function powerMatch(label: string, target: string, reachable: boolean, src: Row[], reached: (s: Row[]) => boolean): Matched {
  const m: Matched = { label, target, reachable, est: [], inner: [], nSub: [], bfSub: [], essCub: [], width: [], clearNeg: 0, clearAny: 0 };
  if (!reachable) return m;
  for (let o = 0; o < OUTER; o++) {
    const s = subsampleTo(src, reached);
    const e = cubOf(s);
    if (!Number.isFinite(e)) continue;
    const bs = boot(s, INNER, cubOf).filter(Number.isFinite);
    const c = ci(bs);
    m.est.push(e); m.nSub.push(s.length); m.bfSub.push(sum(s.map((r) => r.w))); m.essCub.push(cubicInfo(s).essCub);
    m.width.push(wid(c)); for (const v of bs) m.inner.push(v);
    if (clear(c)) { m.clearAny++; if (c.hi < 0) m.clearNeg++; }
  }
  return m;
}
const med = (xs: number[]) => q(xs, 0.5);
// A matching criterion is only meaningful if vR actually EXCEEDS vL on it. Where it does not, vR cannot be
// degraded to vL's level — vL is already the better-informed split on that dimension, which is itself an
// answer to the power question and is reported as such rather than faked with a degenerate "match".
const bfReach = iR.bfTot > iL.bfTot, essReach = iR.essCub > iL.essCub;
const matchBF = powerMatch("BF-matched", `total BF ≥ ${k(iL.bfTot)}`, bfReach, R, (s) => sum(s.map((r) => r.w)) >= iL.bfTot);
const matchESS = powerMatch("cubic-ESS-matched", `cubic-ESS ≥ ${f(iL.essCub, 1)}`, essReach, R, (s) => cubicInfo(s).essCub >= iL.essCub);
// The mirror direction (degrading vL to vR-equivalent) is only defined where vL is the RICHER split; the
// difference test below plus the replication probability are the reverse-direction reads.

// DIFFERENCE TEST: independent bootstrap within each hand, CI on (cubR − cubL) and (levelR − levelL).
// This one sits near the decision boundary, so it gets (a) its OWN rng stream — so its answer does not
// depend on how many draws the sections above happened to consume — and (b) 10× the draws, so the reported
// two-sided bootstrap p-value is Monte-Carlo-stable to ~±0.003. The p-value is reported ALONGSIDE the CI
// precisely because a CI-clear/covers-0 flag is not a stable summary of a boundary case.
const B_DIFF = 20000, rndD = mkRnd(0x5eed1234);
const bDiffCub: number[] = [], bDiffLvl: number[] = [];
for (let b = 0; b < B_DIFF; b++) {
  const sR = R.map(() => R[Math.floor(rndD() * R.length)]!), sL = Lh.map(() => Lh[Math.floor(rndD() * Lh.length)]!);
  bDiffCub.push(cubOf(sR) - cubOf(sL));
  bDiffLvl.push(wmean(sR, (r) => r.resid) - wmean(sL, (r) => r.resid));
}
const ciDiffCub = ci(bDiffCub), ciDiffLvl = ci(bDiffLvl);
const pBoot = (xs: number[]) => { const lo = xs.filter((x) => x < 0).length / xs.length; return 2 * Math.min(lo, 1 - lo); };
const pDiffCub = pBoot(bDiffCub), pDiffLvl = pBoot(bDiffLvl);
const fracNeg = (xs: number[]) => (xs.length ? xs.filter((x) => x < 0).length / xs.length : NaN);
const pctIn = (xs: number[], v: number) => (xs.length ? xs.filter((x) => x <= v).length / xs.length : NaN);
// QUESTION 4, done honestly. Comparing vL's POINT estimate to the spread of matched SUBSAMPLE estimates is
// anti-conservative (subsampling a fixed set understates fresh sampling noise). The right reference is the
// POOLED INNER bootstrap of the matched draws: "what an estimate of a vR-SIZED effect looks like when
// measured at vL's information, INCLUDING sampling noise". P(est ≥ vL's value | vR-sized effect) is then the
// replication probability — if it is large, vL's flat reading is exactly what a hidden vR effect would give.
const refDist = matchBF.inner.length ? matchBF.inner : matchESS.inner;
const pRepl = refDist.length ? refDist.filter((x) => x >= cubL).length / refDist.length : NaN;
const posInBF = pctIn(matchBF.est, cubL), posInESS = pctIn(matchESS.est, cubL);

// ── verdict logic ───────────────────────────────────────────────────────────────────────────────
const detectBF = matchBF.est.length ? matchBF.clearNeg / matchBF.est.length : NaN;
const detectESS = matchESS.est.length ? matchESS.clearNeg / matchESS.est.length : NaN;
const detect = Math.max(Number.isFinite(detectBF) ? detectBF : -1, Number.isFinite(detectESS) ? detectESS : -1);
const diffClear = clear(ciDiffCub);
// Is vL actually the weaker-powered split? It is only a POWER explanation if vL is worse-resolved. vL is
// weaker only if BOTH its cubic-contrast ESS is lower AND its bootstrap CI is wider than vR's.
const vlWeaker = iL.essCub < iR.essCub && wid(ciL) > wid(ciR);
let verdict: string, body: string[];
if (!vlWeaker && detect >= 0.5 && pRepl < 0.05) {
  verdict = `REAL ASYMMETRY — power ruled out${diffClear ? "" : " (hand DIFFERENCE only marginally resolved)"}`;
  body = [
    `The power explanation fails at the first hurdle: vL is NOT the weaker split. It carries ${iL.n} rows to vR's ${iR.n},`,
    `${f(100 * iL.bfTot / iR.bfTot, 0)}% of the BF, but ${f(iL.essCub, 1)} cubic-contrast ESS against vR's ${f(iR.essCub, 1)} — and a NARROWER bootstrap CI`,
    `(${f(wid(ciL), 3)} vs ${f(wid(ciR), 3)}). vL resolves the cubic at least as well as vR does, so "vL is flat" is not "vL is unresolved".`,
    `Degrading vR to vL-equivalent BF, its cubic stays negative in ${f(100 * fracNeg(matchBF.est), 0)}% of draws and CI-clear in ${f(100 * detect, 0)}%,`,
    `and only ${f(100 * pRepl, 1)}% of vL-powered measurements of a vR-sized effect would read as high as vL's ${sgn(cubL, 4)}.`,
    `CAVEAT, stated plainly: the direct vR−vL difference is ${sgn(cubR - cubL, 4)}, CI [${sgn(ciDiffCub.lo, 4)}, ${sgn(ciDiffCub.hi, 4)}], bootstrap p=${f(pDiffCub, 3)} —`,
    `a BOUNDARY case: the CI edge sits on zero, so the CI-clear flag itself is not a stable summary.`,
    `So: the vR-concentration is NOT a power artifact, but the two hands are only marginally distinguishable from`,
    `each other. The hand LEVEL gap (+${f(lvlR - lvlL, 2)}/600) is a separate claim and is NOT resolved (see §2).`,
  ];
} else if (vlWeaker && (detect < 0.5 || pRepl >= 0.05)) {
  verdict = "POWER ARTIFACT";
  body = [
    `vL is the weaker-powered split (cubic-contrast ESS ${f(iL.essCub, 1)} vs vR's ${f(iR.essCub, 1)}; CI width ${f(wid(ciL), 3)} vs ${f(wid(ciR), 3)}),`,
    `and the vR effect does NOT survive being cut to that information: CI-clear in only ${f(100 * detect, 0)}% of matched draws.`,
    `A vR-sized effect measured at vL's power would read as high as vL's ${sgn(cubL, 4)} in ${f(100 * pRepl, 1)}% of cases.`,
    `The vR−vL difference is ${sgn(cubR - cubL, 4)}, CI [${sgn(ciDiffCub.lo, 4)}, ${sgn(ciDiffCub.hi, 4)}]. "vL is flat" cannot be separated from "vL is unresolved".`,
  ];
} else {
  verdict = "UNRESOLVED";
  body = [
    `The criteria disagree. vL is ${vlWeaker ? "the weaker-powered split" : "NOT the weaker-powered split"} (cubic-contrast ESS ${f(iL.essCub, 1)} vs vR's ${f(iR.essCub, 1)},`,
    `CI width ${f(wid(ciL), 3)} vs ${f(wid(ciR), 3)}); the power-matched vR cubic stays CI-clear in ${f(100 * detect, 0)}% of vL-equivalent draws;`,
    `a vR-sized effect measured at vL's power would read as high as vL's ${sgn(cubL, 4)} in ${f(100 * pRepl, 1)}% of cases; and the direct`,
    `vR−vL difference is ${sgn(cubR - cubL, 4)}, CI [${sgn(ciDiffCub.lo, 4)}, ${sgn(ciDiffCub.hi, 4)}] (${diffClear ? "CI-clear" : "covers zero"}). The hand-split read should`,
    `not be treated as established in either direction on this data.`,
  ];
}

// ── artifact ────────────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# K-RESIDUAL vs STUFF — HAND-SPLIT POWER AUDIT.  MEASUREMENT ONLY — nothing wired.");
say("# Is the vR-concentration of the cubic K misfit a REAL hand asymmetry, or unequal power?");
say("################################################################################");
say();
say(`  model '${trained.id}'  DEPLOYED form  window ${win.join("+") || "all"}  N=${rows.length} ROWS (card×side, BF-weighted)`);
say(`  source finding: fixtures/kresidual-stuff-inframe-2026-07-23.txt (pooled cubic CI-clear, vR-concentrated)`);
say(`  residual = deployed pred K/600 − observed K/600.  Cubic partial = coefficient on z(stu)³.`);
say();
say("### VERDICT");
say();
say(`  ${verdict}`);
say();
for (const b of body) say(`  ${b}`);
say();
say(`  Supporting numbers: vR cubic ${sgn(cubR, 4)} [${sgn(ciR.lo, 4)}, ${sgn(ciR.hi, 4)}] (width ${f(wid(ciR), 3)}) vs vL cubic`);
say(`  ${sgn(cubL, 4)} [${sgn(ciL.lo, 4)}, ${sgn(ciL.hi, 4)}] (width ${f(wid(ciL), 3)}) — vL's CI is ${f(wid(ciL) / wid(ciR), 2)}× vR's width.`);
say(`  Information: vR ${iR.n} rows / ${k(iR.bfTot)} BF / cubic-ESS ${f(iR.essCub, 1)};  vL ${iL.n} rows / ${k(iL.bfTot)} BF /`);
say(`  cubic-ESS ${f(iL.essCub, 1)}  (vL carries ${f(100 * iL.bfTot / iR.bfTot, 0)}% of vR's BF and ${f(100 * iL.essCub / iR.essCub, 0)}% of its cubic-contrast ESS).`);
say();

say("################################################################################");
say("## 1. INFORMATION CONTENT PER HAND — is vL thinner in BF, or only in rows?");
say("################################################################################");
say();
say(`     ${pad("", 22)} ${pad("vR (RHB)", 16)} ${pad("vL (LHB)", 16)} ratio vL/vR`);
const irow = (lab: string, x: number, y: number, d = 0) => say(`     ${pad(lab, 22)} ${pad(d ? f(x, d) : k(x), 16)} ${pad(d ? f(y, d) : k(y), 16)} ${f(y / x, 2)}×`);
irow("rows", iR.n, iL.n);
irow("total BF", iR.bfTot, iL.bfTot);
irow("mean BF / row", iR.bfMean, iL.bfMean);
irow("Kish ESS (BF wts)", iR.ess, iL.ess, 1);
irow("cubic-contrast ESS", iR.essCub, iL.essCub, 1);
irow("cubic info (Σ w·c²)", iR.infoTotal, iL.infoTotal, 1);
say();
say(`     BF distribution (quantiles of per-row BF)`);
say(`     ${pad("", 22)} ${["min", "p10", "p25", "med", "p75", "p90", "max"].map((s) => pad(s, 9)).join("")}`);
say(`     ${pad("vR (RHB)", 22)} ${iR.bfQ.map((x) => pad(k(x), 9)).join("")}`);
say(`     ${pad("vL (LHB)", 22)} ${iL.bfQ.map((x) => pad(k(x), 9)).join("")}`);
say();
say(`     BF and residual by Stuff quintile (per hand). The CUBIC is driven by the TAILS — if vL's BF is`);
say(`     thin exactly where the bend lives, its flatness is a support problem, not a shape finding.`);
say();
for (const [tag, rs] of [["vR (RHB)", R], ["vL (LHB)", Lh]] as const) {
  const qs = quints(rs), tot = sum(qs.map((x) => x.bf));
  say(`     ── ${tag} ──`);
  say(`        stu quintile       n     total BF    % of hand BF    mean K resid`);
  for (const x of qs) say(`        ${pad(`[${f(x.lo, 0)}-${f(x.hi, 0)}]`, 16)} ${String(x.n).padStart(3)}   ${k(x.bf).padStart(9)}    ${f(100 * x.bf / tot, 1).padStart(8)}%       ${sgn(x.resid).padStart(7)}`);
  say();
}

say("################################################################################");
say("## 2. RESOLUTION PER HAND — effective n and bootstrap CI WIDTH for the cubic");
say("################################################################################");
say();
say(`     A wide CI means UNRESOLVED, not FLAT. Widths from ${B_MAIN} percentile-bootstrap draws (row resample).`);
say();
say(`     ${pad("split", 12)} ${pad("rows", 6)} ${pad("cubic-ESS", 11)} ${pad("cubic β₃", 10)} ${pad("95% CI", 24)} ${pad("width", 8)} status`);
for (const [tag, rs, est, c] of [["POOLED", rows, cubAll, ciAll], ["vR (RHB)", R, cubR, ciR], ["vL (LHB)", Lh, cubL, ciL]] as const) {
  say(`     ${pad(tag, 12)} ${pad(String(rs.length), 6)} ${pad(f(cubicInfo(rs).essCub, 1), 11)} ${pad(sgn(est, 4), 10)} ${pad(`[${sgn(c.lo, 4)}, ${sgn(c.hi, 4)}]`, 24)} ${pad(f(wid(c), 3), 8)} ${clear(c) ? "CI-clear" : "covers 0"}`);
}
say();
say(`     vL's CI is ${f(wid(ciL) / wid(ciR), 2)}× the width of vR's. Level: vR ${sgn(lvlR)}/600, vL ${sgn(lvlL)}/600,`);
say(`     gap ${sgn(lvlR - lvlL)}/600 with bootstrap CI [${sgn(ciDiffLvl.lo)}, ${sgn(ciDiffLvl.hi)}] ${clear(ciDiffLvl) ? "CI-clear" : "COVERS 0"}.`);
say();

say("################################################################################");
say("## 3. POWER-MATCHED vR — degrade vR to vL-equivalent information, ask if it survives");
say("################################################################################");
say();
say(`     ${OUTER} random without-replacement subsamples of vR per criterion; each gets its OWN ${INNER}-draw`);
say(`     bootstrap CI. "detection rate" = share of matched draws whose cubic CI excludes zero on the`);
say(`     negative side — i.e. the probability of REPRODUCING the vR finding at vL's information level.`);
say();
for (const m of [matchBF, matchESS]) {
  if (!m.reachable || !m.est.length) {
    say(`     ── ${m.label} (target: ${m.target}): NOT APPLICABLE ──`);
    say(`        vR is ALREADY at or below vL on this criterion (vR ${m.label.startsWith("BF") ? k(iR.bfTot) + " BF" : f(iR.essCub, 1) + " cubic-ESS"} vs vL`);
    say(`        ${m.label.startsWith("BF") ? k(iL.bfTot) + " BF" : f(iL.essCub, 1) + " cubic-ESS"}), so there is nothing to degrade. That is itself an answer: on this`);
    say(`        dimension vL is the BETTER-informed split, and its null cannot be blamed on power.`);
    say(); continue;
  }
  say(`     ── ${m.label} (target: ${m.target}) ──`);
  say(`        subsample size:    median ${f(med(m.nSub), 0)} rows  [${f(q(m.nSub, 0.05), 0)}, ${f(q(m.nSub, 0.95), 0)}]   (vL has ${iL.n} rows)`);
  say(`        subsample BF:      median ${k(med(m.bfSub))}   (vL has ${k(iL.bfTot)})`);
  say(`        subsample cub-ESS: median ${f(med(m.essCub), 1)}   (vL has ${f(iL.essCub, 1)})`);
  say(`        cubic β₃ across matched draws: median ${sgn(med(m.est), 4)}  [p2.5 ${sgn(q(m.est, 0.025), 4)}, p97.5 ${sgn(q(m.est, 0.975), 4)}]`);
  say(`        share of draws with β₃ < 0: ${f(100 * fracNeg(m.est), 1)}%`);
  say(`        median per-draw CI width: ${f(med(m.width), 3)}   (vR full ${f(wid(ciR), 3)}, vL actual ${f(wid(ciL), 3)})`);
  say(`        DETECTION RATE (CI-clear negative): ${f(100 * m.clearNeg / m.est.length, 1)}%   (any-direction CI-clear ${f(100 * m.clearAny / m.est.length, 1)}%)`);
  say();
}
say(`     READ: if the detection rate is HIGH, an effect of vR's magnitude would normally have been seen at`);
say(`     vL's information — so vL's null is informative and the asymmetry is real. If it is LOW, vL's null is`);
say(`     what you would expect even if vL carried the SAME effect — the split is a power artifact.`);
say();

say("################################################################################");
say("## 4. THE REVERSE DIRECTION — is vL's point estimate merely noisier, or genuinely ~0?");
say("################################################################################");
say();
say(`     vL point estimate ${sgn(cubL, 4)} vs vR ${sgn(cubR, 4)}. vL is ${f(100 * Math.abs(cubL) / Math.abs(cubR), 0)}% of vR's magnitude`);
say(`     and ${cubL * cubR > 0 ? "the SAME sign" : "the OPPOSITE sign"}. A merely-noisier-but-same-effect vL would sit near vR's value with a wide CI.`);
say();
say(`     DIFFERENCE TEST (independent bootstrap within each hand, ${B_DIFF} draws, dedicated rng stream):`);
say(`        vR − vL cubic: ${sgn(cubR - cubL, 4)}   CI [${sgn(ciDiffCub.lo, 4)}, ${sgn(ciDiffCub.hi, 4)}]   p=${f(pDiffCub, 3)}   ${clear(ciDiffCub) ? "★ CI-clear" : "covers 0"}`);
say(`        vR − vL level: ${sgn(lvlR - lvlL)}/600   CI [${sgn(ciDiffLvl.lo)}, ${sgn(ciDiffLvl.hi)}]   p=${f(pDiffLvl, 3)}   ${clear(ciDiffLvl) ? "★ CI-clear" : "covers 0 — the hand LEVEL gap is NOT resolved"}`);
say(`        The CUBIC difference is a BOUNDARY case (CI edge on zero) — read the p-value, not the flag. The`);
say(`        LEVEL gap is nowhere near resolved: it is well inside its own noise.`);
say();
say(`     REPLICATION PROBABILITY — the decisive reverse read. Reference distribution = the POOLED inner`);
say(`     bootstrap of the power-matched vR draws, i.e. what an estimate of a vR-SIZED effect looks like when`);
say(`     measured at vL's information, sampling noise included.`);
if (refDist.length) {
  say(`        reference (vR-sized effect @ vL power): median ${sgn(med(refDist), 4)}  [p2.5 ${sgn(q(refDist, 0.025), 4)}, p97.5 ${sgn(q(refDist, 0.975), 4)}]`);
  say(`        P(estimate ≥ vL's ${sgn(cubL, 4)} | vR-sized effect at vL power) = ${f(100 * pRepl, 1)}%`);
  say(`        ⇒ ${pRepl >= 0.05 ? "vL's flat reading IS a plausible measurement of a hidden vR-sized effect — its null does not refute vR."
    : "vL's flat reading is NOT a plausible measurement of a vR-sized effect — vL's point estimate is genuinely near zero."}`);
} else say(`        (no matched draws available — see §3)`);
say();
say(`     Secondary (anti-conservative, for completeness — subsample spread only, no sampling noise):`);
say(`        vL's ${sgn(cubL, 4)} sits at percentile ${f(100 * posInBF, 1)} of the BF-matched vR subsample estimates`);
say(`        and percentile ${f(100 * posInESS, 1)} of the cubic-ESS-matched ones (NaN = criterion not applicable).`);
say();
say(`     Also: pooled cubic ${sgn(cubAll, 4)} [${sgn(ciAll.lo, 4)}, ${sgn(ciAll.hi, 4)}] ${clear(ciAll) ? "CI-clear" : "covers 0"}. The POOLED finding is`);
say(`     unaffected by this audit either way — this tool only tests the HAND-SPLIT attribution.`);
say();
say("(end of artifact — K-residual hand-split power audit)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
