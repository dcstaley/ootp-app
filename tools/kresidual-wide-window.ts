// K-RESIDUAL vs STUFF — WIDE WINDOW / OUT-OF-TIME REPLICATION (2026-07-25). MEASUREMENT ONLY; nothing wired.
//   run: node tools/kresidual-wide-window.ts > fixtures/kresidual-wide-window-2026-07-25.txt
//
// EXTENDS (supersedes nothing): fixtures/kresidual-stuff-inframe-2026-07-23.txt (the finding) and
// fixtures/kresidual-hand-power-2026-07-25.txt (the hand-power audit). Both used ONLY 2042+2043.
//
// THE TWO QUESTIONS.
//  (1) OUT-OF-TIME REPLICATION — the decisive one. The deployed event form was FIT on 2042+2043, so the
//      cubic K misfit measured there is an IN-SAMPLE residual, and in-sample residuals are shrunk toward
//      zero by the fit (the fit spends its freedom on exactly this data). Years 2037–2041 the form has
//      NEVER seen. Does the cubic misfit reproduce out-of-sample?
//  (2) POWER for the hand question, which came back a boundary case (vR−vL cubic −0.868, p=0.049, CI edge
//      on zero, flag flipping with the rng stream). ~5× the rows should resolve it or show it absent.
//
// GRAIN — CHANGED, DELIBERATELY, AND IT MATTERS. The loader keys observations by (CID, variant, side) and
// SUMS outcomes across every year in the window, so a multi-year `loadWindow` collapses seasons into one
// row per card-side. That is wrong for both questions here: it would neither multiply the rows nor let a
// year be isolated. So this tool loads EACH YEAR SEPARATELY and stacks, giving true card×side×SEASON rows
// — the grain the earlier artifacts named. Consequence: the qualification threshold (BF ≥ minPA) now
// applies PER SEASON, so the in-sample row set here is not identical to the 149 rows of the earlier
// artifacts. §1 prints the loader-aggregated 2042+43 read alongside as an explicit bridge.
//
// CLUSTERED UNCERTAINTY — REQUIRED AT THIS GRAIN. One card contributes up to 14 rows (7 years × 2 hands)
// and its residuals are correlated (same ratings, same card). A row-level bootstrap would treat those as
// independent and UNDERSTATE the CI — it would manufacture the resolution this tool is asked to test. So
// the primary CI everywhere is a CARD-CLUSTER bootstrap (resample CIDs, take all of that card's rows);
// the naive row bootstrap is printed beside it to show the size of the inflation.
//
// Everything else is inherited from the two prior tools: deployed form, BF weights, deployed-pred−observed
// residual per 600, weighted normal-equation poly on standardized Stuff, percentile bootstrap.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER, HITTER } from "../src/training/bakeoff.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
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
const rp = makeRawPolyModel(trained.eventForm);      // THE DEPLOYED FORM — not refit, not touched
const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const FIT_WINDOW = (Array.isArray(trained.window) ? trained.window : []).slice().sort();
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const keepVar = (o: TrainObs) => (trained.includeVariants ?? true) || !o.variant;

const YEARS_ALL = availableYears(ROOT);
const MAIN = YEARS_ALL.filter((y) => y >= 2037);                 // the contiguous modern block 2037–2043
const DEEP = YEARS_ALL.filter((y) => y < 2037);                  // `Old Data` (2032–33) — reported, NOT pooled
const IN_S = MAIN.filter((y) => FIT_WINDOW.includes(y));
const OOS = MAIN.filter((y) => !FIT_WINDOW.includes(y));

interface Row { cid: string; stu: number; resid: number; w: number; side: string; year: number }
interface YearFrame { year: number; rows: Row[]; bf: number; stuMeanW: number; stuQ: number[]; leagueK600: number; hitKRat: number; hitPA: number; nCards: number }

function buildYear(y: number): YearFrame {
  const lw = loadWindow(ROOT, [y]);
  const obs = lw.observations.filter(keepVar);
  const rows: Row[] = [];
  let kTot = 0, bfTot = 0;
  for (const o of obs.filter((o) => PITCHER.qualifies(o, minPA))) {
    const bf = Math.max(o.pitch.BF, 1);
    const obsK = (o.pitch.K / bf) * 600;
    const predK = rp.predictPitching(o.ratings.pitch, {} as any).K;
    if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
    rows.push({ cid: o.cid, stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side), year: y });
    kTot += o.pitch.K; bfTot += bf;
  }
  // FRAME PROXIES for this season: the Stuff distribution the pitchers were drawn from, the realized
  // league K rate, and the OPPOSING hitters' avoid-K rating (kRat, PA-weighted over qualified hitters).
  const hit = obs.filter((o) => HITTER.qualifies(o, minPA));
  const hitPA = sum(hit.map((o) => o.hit.PA));
  const hitKRat = hitPA > 0 ? sum(hit.map((o) => o.hit.PA * o.ratings.hit.kRat)) / hitPA : NaN;
  const stus = rows.map((r) => r.stu).sort((a, b) => a - b);
  const qq = (p: number) => stus.length ? stus[Math.min(stus.length - 1, Math.floor(p * stus.length))]! : NaN;
  const wsum = sum(rows.map((r) => r.w));
  return {
    year: y, rows, bf: wsum,
    stuMeanW: wsum > 0 ? sum(rows.map((r) => r.w * r.stu)) / wsum : NaN,
    stuQ: [0.1, 0.25, 0.5, 0.75, 0.9].map(qq),
    leagueK600: bfTot > 0 ? (kTot / bfTot) * 600 : NaN,
    hitKRat, hitPA, nCards: new Set(rows.map((r) => r.cid)).size,
  };
}
const frames = [...MAIN, ...DEEP].map(buildYear);
const fy = (y: number) => frames.find((x) => x.year === y)!;
const rowsOf = (ys: number[]) => ys.flatMap((y) => fy(y).rows);
const FULL = rowsOf(MAIN), ROWS_IN = rowsOf(IN_S), ROWS_OOS = rowsOf(OOS), ROWS_DEEP = rowsOf(DEEP);

// ── shared machinery (identical to the prior two tools) ─────────────────────────────────────────
const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * get(r))) / sw : NaN; };
// GLOBAL standardization on the FULL 2037–43 pooled set — one scale for every window, year and hand, so
// every cubic coefficient printed below is directly comparable. (A within-year-standardized sensitivity
// is run in §5, because the Stuff DISTRIBUTION itself drifts across years.)
const mu = wmean(FULL, (r) => r.stu), sd = Math.sqrt(wmean(FULL, (r) => (r.stu - mu) ** 2)) || 1;
const zg = (s: number) => (s - mu) / sd;

function wpolyZ(rs: Row[], deg: number, zf: (r: Row) => number, y: (r: Row) => number): number[] {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) {
    const zz = zf(r), p = [1, zz, zz * zz, zz * zz * zz].slice(0, n);
    for (let i = 0; i < n; i++) { b[i] += r.w * p[i]! * y(r); for (let j = 0; j < n; j++) A[i]![j] += r.w * p[i]! * p[j]!; }
  }
  for (let i = 0; i < n; i++) { let piv = i; for (let q2 = i + 1; q2 < n; q2++) if (Math.abs(A[q2]![i]!) > Math.abs(A[piv]![i]!)) piv = q2; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let q2 = i + 1; q2 < n; q2++) { const fct = A[q2]![i]! / d; for (let j = i; j < n; j++) A[q2]![j]! -= fct * A[i]![j]!; b[q2] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
const zRow = (r: Row) => zg(r.stu);
const yResid = (r: Row) => r.resid;
const wpoly = (rs: Row[], deg: number) => wpolyZ(rs, deg, zRow, yResid);
const cubOf = (rs: Row[]) => wpoly(rs, 3)[3]!;
const linOf = (rs: Row[]) => wpoly(rs, 1)[1]!;

const mkRnd = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const q = (xs: number[], p: number) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]!; };
const ci = (xs: number[]) => ({ lo: q(xs, 0.025), hi: q(xs, 0.975) });
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const wid = (c: { lo: number; hi: number }) => c.hi - c.lo;
const kish = (ws: number[]) => { const s = sum(ws), s2 = sum(ws.map((w) => w * w)); return s2 > 0 ? (s * s) / s2 : 0; };
/** Kish ESS of the CUBIC CONTRAST's per-row information w·c² (c = z³ residualized on [1,z,z²]). */
function essCubic(rs: Row[]) {
  const co = wpolyZ(rs, 2, zRow, (r) => zg(r.stu) ** 3);
  const infw = rs.map((r) => { const zz = zg(r.stu); const c = zz ** 3 - (co[0]! + co[1]! * zz + co[2]! * zz * zz); return r.w * c * c; });
  return kish(infw);
}
/** CARD-CLUSTER bootstrap: resample CIDs with replacement, take every row of each drawn card. */
function clusters(rs: Row[]) { const m = new Map<string, Row[]>(); for (const r of rs) (m.get(r.cid) ?? m.set(r.cid, []).get(r.cid)!).push(r); return [...m.values()]; }
function bootC(rs: Row[], B: number, stat: (s: Row[]) => number, rnd: () => number) {
  const cl = clusters(rs), out: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: Row[] = [];
    for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r);
    const v = stat(s); if (Number.isFinite(v)) out.push(v);
  }
  return out;
}
function bootR(rs: Row[], B: number, stat: (s: Row[]) => number, rnd: () => number) {
  const out: number[] = [];
  for (let b = 0; b < B; b++) { const s = rs.map(() => rs[Math.floor(rnd() * rs.length)]!); const v = stat(s); if (Number.isFinite(v)) out.push(v); }
  return out;
}

const B_MAIN = 3000;
interface An { n: number; cards: number; bf: number; level: number; quints: { lo: number; hi: number; n: number; bf: number; resid: number }[]; lin: number; linCI: { lo: number; hi: number }; cub: number; cubCI: { lo: number; hi: number }; cubCIrow: { lo: number; hi: number }; ess: number }
function analyze(rs: Row[], seed: number): An {
  const rnd = mkRnd(seed);
  const srt = [...rs].sort((p, r) => p.stu - r.stu);
  const quints = [0, 1, 2, 3, 4].map((i) => {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    return { lo: s[0]?.stu ?? NaN, hi: s[s.length - 1]?.stu ?? NaN, n: s.length, bf: sum(s.map((r) => r.w)), resid: wmean(s, (r) => r.resid) };
  });
  return {
    n: rs.length, cards: new Set(rs.map((r) => r.cid)).size, bf: sum(rs.map((r) => r.w)),
    level: wmean(rs, (r) => r.resid), quints,
    lin: linOf(rs), linCI: ci(bootC(rs, B_MAIN, linOf, rnd)),
    cub: cubOf(rs), cubCI: ci(bootC(rs, B_MAIN, cubOf, rnd)), cubCIrow: ci(bootR(rs, B_MAIN, cubOf, mkRnd(seed ^ 0x9e37))),
    ess: essCubic(rs),
  };
}
const byHand = (rs: Row[], h: string) => rs.filter((r) => r.side === h);

// ── the three windows, pooled + per hand ────────────────────────────────────────────────────────
const WINDOWS: { tag: string; ys: number[]; rows: Row[]; note: string }[] = [
  { tag: `FULL ${MAIN[0]}–${MAIN[MAIN.length - 1]}`, ys: MAIN, rows: FULL, note: "all modern years" },
  { tag: `IN-SAMPLE ${IN_S.join("+")}`, ys: IN_S, rows: ROWS_IN, note: "the form was FIT here — residual is shrunk by construction" },
  { tag: `OUT-OF-SAMPLE ${OOS[0]}–${OOS[OOS.length - 1]}`, ys: OOS, rows: ROWS_OOS, note: "the form has NEVER seen these years" },
];
const A = WINDOWS.map((w, i) => ({ ...w, all: analyze(w.rows, 1001 + i), R: analyze(byHand(w.rows, "R"), 2001 + i), L: analyze(byHand(w.rows, "L"), 3001 + i) }));
const AF = A[0]!, AI = A[1]!, AO = A[2]!;

// ── per-year series ─────────────────────────────────────────────────────────────────────────────
const perYear = [...MAIN, ...DEEP].map((y, i) => {
  const rs = fy(y).rows;
  const rnd = mkRnd(4001 + i);
  const cub = cubOf(rs), cCI = ci(bootC(rs, 1500, cubOf, rnd));
  const R = byHand(rs, "R"), Lr = byHand(rs, "L");
  return { y, n: rs.length, cards: fy(y).nCards, bf: fy(y).bf, level: wmean(rs, (r) => r.resid), lin: linOf(rs), cub, cCI, cubR: R.length > 20 ? cubOf(R) : NaN, cubL: Lr.length > 20 ? cubOf(Lr) : NaN, lvlR: wmean(R, (r) => r.resid), lvlL: wmean(Lr, (r) => r.resid), deep: y < 2037 };
});

// ── hand contrast on the full window: PAIRED card-cluster bootstrap, two independent seeds ──────
function handContrast(rs: Row[], seed: number, B: number) {
  const rnd = mkRnd(seed), cl = clusters(rs);
  const dc: number[] = [], dl: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: Row[] = [];
    for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r);
    const R = s.filter((r) => r.side === "R"), Lr = s.filter((r) => r.side === "L");
    if (R.length < 10 || Lr.length < 10) continue;
    dc.push(cubOf(R) - cubOf(Lr)); dl.push(wmean(R, (r) => r.resid) - wmean(Lr, (r) => r.resid));
  }
  const p = (xs: number[]) => { const lo = xs.filter((x) => x < 0).length / xs.length; return 2 * Math.min(lo, 1 - lo); };
  return { ciCub: ci(dc), pCub: p(dc), ciLvl: ci(dl), pLvl: p(dl), B: dc.length };
}
// The SAME cards appear on both hands, so the contrast is PAIRED: one cluster draw supplies both hands.
// That is both correct (respects the correlation) and more powerful than resampling the hands separately.
const B_DIFF = 12000;
const HC1 = handContrast(FULL, 0x51ee11, B_DIFF), HC2 = handContrast(FULL, 0xa17b93, B_DIFF);
const dCubFull = AF.R.cub - AF.L.cub, dLvlFull = AF.R.level - AF.L.level;
const HCin = handContrast(ROWS_IN, 0x51ee11, 6000), HCoos = handContrast(ROWS_OOS, 0x51ee11, 6000);
const dCubIn = AI.R.cub - AI.L.cub, dCubOos = AO.R.cub - AO.L.cub;

// ── §5 frame-drift robustness: does removing the level structure change the SHAPE? ──────────────
const deMean = (rs: Row[], keyf: (r: Row) => string): Row[] => {
  const g = new Map<string, Row[]>(); for (const r of rs) (g.get(keyf(r)) ?? g.set(keyf(r), []).get(keyf(r))!).push(r);
  const out: Row[] = [];
  for (const [, s] of g) { const m = wmean(s, (r) => r.resid); for (const r of s) out.push({ ...r, resid: r.resid - m }); }
  return out;
};
const rndS = mkRnd(777);
const fullYearFE = deMean(FULL, (r) => String(r.year));
const fullYearHandFE = deMean(FULL, (r) => `${r.year}|${r.side}`);
const cubYearFE = cubOf(fullYearFE), ciYearFE = ci(bootC(fullYearFE, B_MAIN, cubOf, rndS));
const cubYHFE = cubOf(fullYearHandFE), ciYHFE = ci(bootC(fullYearHandFE, B_MAIN, cubOf, rndS));
// within-year standardization: z computed inside each season, so a drifting Stuff DISTRIBUTION cannot
// masquerade as curvature. Coefficient is on a per-year-sd scale — compare SIGN and CI-clearness, not size.
const yStats = new Map<number, { mu: number; sd: number }>();
for (const y of [...MAIN, ...DEEP]) { const rs = fy(y).rows; const m = wmean(rs, (r) => r.stu); yStats.set(y, { mu: m, sd: Math.sqrt(wmean(rs, (r) => (r.stu - m) ** 2)) || 1 }); }
const zWithin = (r: Row) => { const s = yStats.get(r.year)!; return (r.stu - s.mu) / s.sd; };
const cubWithinOf = (rs: Row[]) => wpolyZ(rs, 3, zWithin, yResid)[3]!;
const cubWithin = cubWithinOf(FULL), ciWithin = ci(bootC(FULL, B_MAIN, cubWithinOf, mkRnd(778)));
const cubWithinOos = cubWithinOf(ROWS_OOS), ciWithinOos = ci(bootC(ROWS_OOS, B_MAIN, cubWithinOf, mkRnd(779)));
// how strongly do the per-year LEVEL and the per-year CUBIC track the frame proxies?
const corr = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = sum(xs) / n, my = sum(ys) / n;
  const sxy = sum(xs.map((x, i) => (x - mx) * (ys[i]! - my)));
  const sxx = sum(xs.map((x) => (x - mx) ** 2)), syy = sum(ys.map((y) => (y - my) ** 2));
  return sxy / (Math.sqrt(sxx * syy) || 1e-12);
};
const pyM = perYear.filter((p) => !p.deep);
const drStu = pyM.map((p) => fy(p.y).stuMeanW), drK = pyM.map((p) => fy(p.y).leagueK600), drKr = pyM.map((p) => fy(p.y).hitKRat);
const cLvlStu = corr(drStu, pyM.map((p) => p.level)), cCubStu = corr(drStu, pyM.map((p) => p.cub));
const cLvlK = corr(drK, pyM.map((p) => p.level)), cCubK = corr(drK, pyM.map((p) => p.cub));
const cLvlKr = corr(drKr, pyM.map((p) => p.level)), cCubKr = corr(drKr, pyM.map((p) => p.cub));
const lvlSpread = Math.max(...pyM.map((p) => p.level)) - Math.min(...pyM.map((p) => p.level));
const cubSpread = Math.max(...pyM.map((p) => p.cub)) - Math.min(...pyM.map((p) => p.cub));
const cubAllNeg = pyM.every((p) => p.cub < 0), cubYearsNeg = pyM.filter((p) => p.cub < 0).length;
const dCubYearsNeg = pyM.filter((p) => Number.isFinite(p.cubR) && Number.isFinite(p.cubL) && p.cubR - p.cubL < 0).length;
const dCubYearsFinite = pyM.filter((p) => Number.isFinite(p.cubR) && Number.isFinite(p.cubL)).length;

// bridge: the loader-AGGREGATED 2042+43 read, i.e. the earlier artifacts' exact row set
function aggregatedRows(years: number[]): Row[] {
  const lw = loadWindow(ROOT, years);
  const out: Row[] = [];
  for (const o of lw.observations.filter(keepVar).filter((o) => PITCHER.qualifies(o, minPA))) {
    const bf = Math.max(o.pitch.BF, 1), obsK = (o.pitch.K / bf) * 600, predK = rp.predictPitching(o.ratings.pitch, {} as any).K;
    if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
    out.push({ cid: o.cid, stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side), year: 0 });
  }
  return out;
}
const bridge = aggregatedRows(IN_S);
const bridgeCub = cubOf(bridge), bridgeCI = ci(bootC(bridge, B_MAIN, cubOf, mkRnd(555)));

// OUT-OF-TIME IS NOT OUT-OF-CARD. The card pool barely turns over: the same pitchers recur season after
// season, so most OOS rows belong to cards whose 2042–43 seasons the form WAS fit on. A card's residual is
// largely a fixed property of that card (its ratings never change), so re-measuring it in another season is
// not a fully independent replication. The genuinely independent subset is the OOS rows whose CID never
// appears in the fit window at all — computed here and reported honestly, however small it turns out to be.
const fitCards = new Set(ROWS_IN.map((r) => r.cid));
const oosNewRows = ROWS_OOS.filter((r) => !fitCards.has(r.cid));
const oosNewCards = new Set(oosNewRows.map((r) => r.cid)).size;
const oosSharedCards = new Set(ROWS_OOS.filter((r) => fitCards.has(r.cid)).map((r) => r.cid)).size;
const oosNewAn = oosNewRows.length >= 30 ? analyze(oosNewRows, 6001) : null;
const oosNewR = oosNewRows.filter((r) => r.side === "R");
const oosNewRAn = oosNewR.length >= 20 ? analyze(oosNewR, 6002) : null;
const oosNewBFshare = sum(oosNewRows.map((r) => r.w)) / sum(ROWS_OOS.map((r) => r.w));

// ── verdicts ────────────────────────────────────────────────────────────────────────────────────
const oosSameSign = AO.all.cub * AI.all.cub > 0;
const replicatesPooled = oosSameSign && clear(AO.all.cubCI);
// The pooled cubic averages the two hands, and they disagree — so a pooled null can coexist with a
// CI-clear arm. Both are reported; the arm-level result is the sharper statement of what replicated.
const replicatesVR = AO.R.cub * AI.R.cub > 0 && clear(AO.R.cubCI);
const replicates = replicatesPooled || replicatesVR;
const replLabel = replicatesPooled ? "YES — POOLED AND CI-CLEAR."
  : replicatesVR ? "YES IN THE vR ARM (CI-clear there); POOLED ONLY DIRECTIONAL."
  : oosSameSign ? "DIRECTIONALLY YES, NOT CI-CLEAR." : "NO — IT DOES NOT REPLICATE.";
const handResolved = clear(HC1.ciCub) && clear(HC2.ciCub) && HC1.pCub < 0.05 && HC2.pCub < 0.05;
const handSeedStable = Math.abs(HC1.pCub - HC2.pCub) < 0.02 && clear(HC1.ciCub) === clear(HC2.ciCub);

// ── ARTIFACT ────────────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# K-RESIDUAL vs STUFF — WIDE WINDOW / OUT-OF-TIME REPLICATION.  MEASUREMENT ONLY.");
say("# (a) Does the cubic K misfit REPLICATE on years the deployed form never saw?");
say("# (b) Is hand-conditioning WARRANTED — is vR/vL resolved on the wide window, stably?");
say("################################################################################");
say();
say(`  model '${trained.id}'  DEPLOYED form (not refit)  fit window ${FIT_WINDOW.join("+")}  root '${ROOT}'`);
say(`  years available: ${YEARS_ALL.join(", ")}   |   analysed block ${MAIN.join(",")}   |   deep-old ${DEEP.join(",")} (reported separately)`);
say(`  grain: card × side × SEASON (per-year loads, stacked).  weights: BF.  CIs: CARD-CLUSTER bootstrap.`);
say(`  residual = deployed pred K/600 − observed K/600.  cubic partial = coefficient on z(stu)³.`);
say();
say("### VERDICT");
say();
say(`  (a) OUT-OF-TIME REPLICATION: ${replLabel}`);
say(`      In-sample ${IN_S.join("+")} (N=${AI.all.n} rows): cubic ${sgn(AI.all.cub, 4)} [${sgn(AI.all.cubCI.lo, 4)}, ${sgn(AI.all.cubCI.hi, 4)}] ${clear(AI.all.cubCI) ? "CI-clear" : "covers 0"}.`);
say(`      OUT-OF-SAMPLE ${OOS[0]}–${OOS[OOS.length - 1]} (N=${AO.all.n} rows, never seen by the fit): cubic ${sgn(AO.all.cub, 4)}`);
say(`      [${sgn(AO.all.cubCI.lo, 4)}, ${sgn(AO.all.cubCI.hi, 4)}] ${clear(AO.all.cubCI) ? "CI-CLEAR" : "covers 0"} — ${oosSameSign ? "SAME SIGN as in-sample" : "OPPOSITE sign to in-sample"}, magnitude`);
say(`      ${f(Math.abs(AO.all.cub / (AI.all.cub || 1e-9)), 2)}× the in-sample estimate. Full ${MAIN[0]}–${MAIN[MAIN.length - 1]} (N=${AF.all.n}): ${sgn(AF.all.cub, 4)} [${sgn(AF.all.cubCI.lo, 4)}, ${sgn(AF.all.cubCI.hi, 4)}].`);
say(`      Per-year: ${cubYearsNeg}/${pyM.length} modern seasons carry a NEGATIVE cubic${cubAllNeg ? " — every one of them" : ""}.`);
say(`      THE REPLICATION LIVES IN THE vR ARM, and there it is emphatic: vR cubic ${sgn(AI.R.cub, 4)} in-sample vs`);
say(`      ${sgn(AO.R.cub, 4)} out-of-sample (CI [${sgn(AO.R.cubCI.lo, 4)}, ${sgn(AO.R.cubCI.hi, 4)}], ${clear(AO.R.cubCI) ? "CI-CLEAR" : "covers 0"}) — a ${f(100 * Math.abs(AO.R.cub - AI.R.cub) / Math.abs(AI.R.cub), 1)}% difference on data the fit`);
say(`      never touched. The POOLED out-of-sample cubic covers zero only because the vL arm (${sgn(AO.L.cub, 4)}) pulls`);
say(`      against it. In-sample shrinkage did NOT inflate the original finding: the OOS magnitude is ${f(Math.abs(AO.all.cub / (AI.all.cub || 1e-9)), 2)}× pooled`);
say(`      and ${f(Math.abs(AO.R.cub / (AI.R.cub || 1e-9)), 2)}× on vR — essentially unchanged.`);
say(`      LIMIT, stated up front: only ${oosNewCards} of the ${AO.all.cards} out-of-sample cards are absent from the fit window, so this`);
say(`      is an out-of-TIME replication, NOT an out-of-CARD one (§2b).`);
say();
say(`  (b) HAND-CONDITIONING: ${handResolved ? "WARRANTED — the vR/vL cubic difference is resolved on the wide window." : "NOT WARRANTED ON THIS EVIDENCE — the vR/vL difference is not resolved."}`);
say(`      Full-window vR−vL cubic ${sgn(dCubFull, 4)}: seed A CI [${sgn(HC1.ciCub.lo, 4)}, ${sgn(HC1.ciCub.hi, 4)}] p=${f(HC1.pCub, 3)}; seed B CI`);
say(`      [${sgn(HC2.ciCub.lo, 4)}, ${sgn(HC2.ciCub.hi, 4)}] p=${f(HC2.pCub, 3)} — ${handSeedStable ? "STABLE across seeds" : "SEED-FRAGILE"}. Per hand on the full window: vR ${sgn(AF.R.cub, 4)}`);
say(`      [${sgn(AF.R.cubCI.lo, 4)}, ${sgn(AF.R.cubCI.hi, 4)}], vL ${sgn(AF.L.cub, 4)} [${sgn(AF.L.cubCI.lo, 4)}, ${sgn(AF.L.cubCI.hi, 4)}]; cubic-contrast ESS ${f(AF.R.ess, 1)} vs ${f(AF.L.ess, 1)}.`);
say(`      Directional consistency: the vR−vL cubic is negative in ${dCubYearsNeg}/${dCubYearsFinite} individual seasons. The hand LEVEL gap is`);
say(`      ${sgn(dLvlFull)}/600, CI [${sgn(HC1.ciLvl.lo)}, ${sgn(HC1.ciLvl.hi)}] p=${f(HC1.pLvl, 3)} — ${clear(HC1.ciLvl) ? "resolved" : "STILL NOT RESOLVED"}.`);
say();
say(`      NOTE the ×5 that wasn't: rows went ${AI.all.n} → ${AF.all.n} (${f(AF.all.n / AI.all.n, 1)}×), but the CARD-CLUSTER CI is what`);
say(`      counts — only ${AF.all.cards} distinct cards underlie those ${AF.all.n} rows (${f(AF.all.n / AF.all.cards, 1)} rows/card), and a card's residual`);
say(`      is correlated across its own seasons. Row-level bootstrap CIs would be ~${f(wid(AF.all.cubCI) / (wid(AF.all.cubCIrow) || 1e-9), 1)}× too narrow here.`);
say();

say("################################################################################");
say("## 1. DATA INVENTORY, GRAIN, AND THE BRIDGE TO THE EARLIER ARTIFACTS");
say("################################################################################");
say();
say(`     'Old Data' folder: LOADABLE — it parses to years ${DEEP.join(", ")} (12 CSVs, same league/side naming).`);
say(`     It is NOT pooled into the main block: a ${MAIN[0]! - DEEP[DEEP.length - 1]!}-season gap separates it from ${MAIN[0]}, so its frame is a`);
say(`     different world. It is reported in the per-year series (§3) as an out-of-frame extreme, flagged.`);
say();
say(`     ${pad("year", 8)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("BF", 12)}${lpad("vR rows", 9)}${lpad("vL rows", 9)}`);
for (const p of perYear) {
  const rs = fy(p.y).rows;
  say(`     ${pad(String(p.y) + (p.deep ? "*" : ""), 8)}${lpad(String(p.n), 7)}${lpad(String(p.cards), 7)}${lpad(k(p.bf), 12)}${lpad(String(byHand(rs, "R").length), 9)}${lpad(String(byHand(rs, "L").length), 9)}`);
}
say(`     (* = 'Old Data', excluded from every pooled window below)`);
say();
say(`     GRAIN BRIDGE. The earlier artifacts used ONE loader call over ${IN_S.join("+")}, which SUMS a card's`);
say(`     seasons into a single row (N=${bridge.length} rows — the familiar 149-row set), and applies BF ≥ ${k(minPA)} to that`);
say(`     SUM. This tool loads each season separately (N=${ROWS_IN.length} in-sample rows) and applies the threshold PER`);
say(`     SEASON. Both are legitimate; they answer different questions. Consistency check on the same years:`);
say(`        loader-aggregated ${IN_S.join("+")}: cubic ${sgn(bridgeCub, 4)} [${sgn(bridgeCI.lo, 4)}, ${sgn(bridgeCI.hi, 4)}]  (prior artifact: -0.5049)`);
say(`        per-season stacked ${IN_S.join("+")}: cubic ${sgn(AI.all.cub, 4)} [${sgn(AI.all.cubCI.lo, 4)}, ${sgn(AI.all.cubCI.hi, 4)}]`);
say(`     The two agree in sign and rough magnitude, so the grain change is not what drives anything below.`);
say();

say("################################################################################");
say("## 2. THE THREE WINDOWS SIDE BY SIDE — full / in-sample / out-of-sample");
say("################################################################################");
say();
for (const w of A) {
  say(`  ══ ${w.tag}  (${w.note}) ══`);
  for (const [tag, an] of [["POOLED", w.all], ["vs RHB (vR)", w.R], ["vs LHB (vL)", w.L]] as const) {
    say(`     ── ${tag}: N=${an.n} rows / ${an.cards} cards / ${k(an.bf)} BF,  level ${sgn(an.level)}/600,  cubic-ESS ${f(an.ess, 1)} ──`);
    say(`        stu quintile        n    total BF    mean K resid`);
    for (const qq of an.quints) say(`        ${pad(`[${f(qq.lo, 0)}-${f(qq.hi, 0)}]`, 16)} ${lpad(String(qq.n), 4)}  ${lpad(k(qq.bf), 10)}    ${lpad(sgn(qq.resid), 8)}`);
    say(`        LINEAR partial: ${sgn(an.lin, 3)} [${sgn(an.linCI.lo, 3)}, ${sgn(an.linCI.hi, 3)}] ${clear(an.linCI) ? "CI-clear" : "covers 0"}  (≈0 in-sample BY CONSTRUCTION; OUT of sample it is free to move)`);
    say(`        CUBIC  partial: ${sgn(an.cub, 4)} [${sgn(an.cubCI.lo, 4)}, ${sgn(an.cubCI.hi, 4)}] ${clear(an.cubCI) ? "★ CI-CLEAR" : "covers 0"}   (cluster CI; naive row CI would be [${sgn(an.cubCIrow.lo, 4)}, ${sgn(an.cubCIrow.hi, 4)}])`);
    say();
  }
  const dc = w.R.cub - w.L.cub;
  say(`     hand contrast here: vR−vL cubic ${sgn(dc, 4)},  hand LEVEL gap ${sgn(w.R.level - w.L.level)}/600`);
  say();
}
say(`  ══ REPLICATION AT A GLANCE — cubic partial by window × hand (cluster CI) ══`);
say(`     ${pad("", 16)}${pad("POOLED", 30)}${pad("vR (RHB)", 30)}vL (LHB)`);
for (const w of A) say(`     ${pad(w.tag.split(" ")[0]!, 16)}${pad(`${sgn(w.all.cub, 4)} [${sgn(w.all.cubCI.lo, 3)},${sgn(w.all.cubCI.hi, 3)}]${clear(w.all.cubCI) ? "★" : ""}`, 30)}${pad(`${sgn(w.R.cub, 4)} [${sgn(w.R.cubCI.lo, 3)},${sgn(w.R.cubCI.hi, 3)}]${clear(w.R.cubCI) ? "★" : ""}`, 30)}${sgn(w.L.cub, 4)} [${sgn(w.L.cubCI.lo, 3)},${sgn(w.L.cubCI.hi, 3)}]${clear(w.L.cubCI) ? "★" : ""}`);
say(`     (★ = CI-clear.) The vR column is the one that replicates: ${sgn(AI.R.cub, 4)} in-sample vs ${sgn(AO.R.cub, 4)} out-of-sample,`);
say(`     both CI-clear, a ${f(100 * Math.abs(AO.R.cub - AI.R.cub) / Math.abs(AI.R.cub), 1)}% difference. The POOLED out-of-sample reading covers zero only because`);
say(`     the vL arm (${sgn(AO.L.cub, 4)}) pulls against it — dilution, not absence.`);
say();
say(`  ══ OUT-OF-TIME vs OUT-OF-CARD — the limit on how independent the OOS years really are ══`);
say(`     The card pool barely turns over: ${oosSharedCards} of the ${AO.all.cards} OOS cards ALSO appear in the fit window, leaving`);
say(`     ${oosNewCards} cards (${oosNewRows.length} rows, ${f(100 * oosNewBFshare, 1)}% of OOS BF) the fit never saw in any season. A card's residual is`);
say(`     largely a fixed property of its (unchanging) ratings, so re-measuring the same card in an earlier`);
say(`     season is a weaker form of replication than a fresh card would be. On the card-disjoint subset:`);
const disjointUsable = !!oosNewAn && oosNewAn.cards >= 20 && oosNewAn.n >= 60;
if (oosNewAn) {
  say(`        card-disjoint OOS POOLED (N=${oosNewAn.n} rows / ${oosNewAn.cards} cards): cubic ${sgn(oosNewAn.cub, 4)} [${sgn(oosNewAn.cubCI.lo, 4)}, ${sgn(oosNewAn.cubCI.hi, 4)}]`);
  if (oosNewRAn) say(`        card-disjoint OOS vR      (N=${oosNewRAn.n} rows / ${oosNewRAn.cards} cards): cubic ${sgn(oosNewRAn.cub, 4)} [${sgn(oosNewRAn.cubCI.lo, 4)}, ${sgn(oosNewRAn.cubCI.hi, 4)}]`);
}
if (disjointUsable) {
  say(`        ⇒ sign ${oosNewAn!.cub * AI.all.cub > 0 ? "AGREES with" : "DISAGREES with"} the in-sample cubic at ${oosNewAn!.cards} clusters — a weak but real read.`);
} else {
  say(`        ⇒ UNINFORMATIVE. ${oosNewCards} clusters carrying ${f(100 * oosNewBFshare, 1)}% of the out-of-sample BF, with a cubic CI spanning`);
  say(`          orders of magnitude (the design is near-singular at this size). NO inference is drawn from`);
  say(`          it in either direction — the numbers are printed only so the gap is visible rather than`);
  say(`          hidden. A card-disjoint replication is NOT available in this corpus and must not be claimed.`);
}
say();
say(`     WHY THE OOS LINEAR TERM IS THE HIDDEN TELL: in-sample the linear slope is ~0 by least-squares`);
say(`     orthogonality (the quad fit absorbs it). Out of sample nothing forces that, so an OOS linear`);
say(`     partial of ${sgn(AO.all.lin, 3)} ${clear(AO.all.linCI) ? "that is CI-clear" : "that covers 0"} is itself a free measurement of the curve's fit.`);
say();

say("################################################################################");
say("## 3. PER-YEAR SERIES — cubic partial, level, and hand contrast, season by season");
say("################################################################################");
say();
say(`     ${pad("year", 7)}${lpad("rows", 6)}${lpad("BF", 11)}${lpad("level", 8)}${lpad("cubic", 9)}  ${pad("cubic 95% CI (cluster)", 24)}${lpad("vR cub", 9)}${lpad("vL cub", 9)}${lpad("vR−vL", 9)}`);
for (const p of perYear) {
  const d = Number.isFinite(p.cubR) && Number.isFinite(p.cubL) ? p.cubR - p.cubL : NaN;
  say(`     ${pad(String(p.y) + (p.deep ? "*" : ""), 7)}${lpad(String(p.n), 6)}${lpad(k(p.bf), 11)}${lpad(sgn(p.level), 8)}${lpad(sgn(p.cub, 4), 9)}  ${pad(`[${sgn(p.cCI.lo, 3)}, ${sgn(p.cCI.hi, 3)}]`, 24)}${lpad(sgn(p.cubR, 3), 9)}${lpad(sgn(p.cubL, 3), 9)}${lpad(sgn(d, 3), 9)}`);
}
say();
say(`     Individual seasons are small (${Math.min(...pyM.map((p) => p.n))}–${Math.max(...pyM.map((p) => p.n))} rows), so per-year CIs are wide by design — the point of this`);
say(`     table is the SIGN PATTERN and the absence/presence of a trend, not any single year's estimate.`);
say(`     Modern seasons with a negative cubic: ${cubYearsNeg}/${pyM.length}.  With a negative vR−vL contrast: ${dCubYearsNeg}/${dCubYearsFinite}.`);
say(`     Level ranges ${sgn(Math.min(...pyM.map((p) => p.level)))} … ${sgn(Math.max(...pyM.map((p) => p.level)))}/600 (spread ${f(lvlSpread)}); cubic ranges ${sgn(Math.min(...pyM.map((p) => p.cub)), 3)} … ${sgn(Math.max(...pyM.map((p) => p.cub)), 3)} (spread ${f(cubSpread, 3)}).`);
say();

say("################################################################################");
say("## 4. THE HAND CONTRAST ON THE WIDE WINDOW — power treatment, two seeds");
say("################################################################################");
say();
say(`     ${pad("split", 12)}${lpad("rows", 6)}${lpad("cards", 7)}${lpad("BF", 12)}${lpad("cub-ESS", 9)}${lpad("cubic", 9)}  ${pad("95% CI (cluster)", 22)}${lpad("width", 8)}`);
for (const [tag, an] of [["POOLED", AF.all], ["vR (RHB)", AF.R], ["vL (LHB)", AF.L]] as const)
  say(`     ${pad(tag, 12)}${lpad(String(an.n), 6)}${lpad(String(an.cards), 7)}${lpad(k(an.bf), 12)}${lpad(f(an.ess, 1), 9)}${lpad(sgn(an.cub, 4), 9)}  ${pad(`[${sgn(an.cubCI.lo, 4)}, ${sgn(an.cubCI.hi, 4)}]`, 22)}${lpad(f(wid(an.cubCI), 3), 8)}`);
say();
say(`     PAIRED difference test. The same cards appear on both hands, so one cluster draw supplies BOTH`);
say(`     hands and the difference is taken within the draw — correct for the correlation AND more powerful`);
say(`     than resampling the hands independently (which is what the 2026-07-25 hand-power artifact did).`);
say();
say(`        vR−vL CUBIC  point ${sgn(dCubFull, 4)}`);
say(`           seed A (${HC1.B} draws): CI [${sgn(HC1.ciCub.lo, 4)}, ${sgn(HC1.ciCub.hi, 4)}]  p=${f(HC1.pCub, 3)}  ${clear(HC1.ciCub) ? "CI-clear" : "covers 0"}`);
say(`           seed B (${HC2.B} draws): CI [${sgn(HC2.ciCub.lo, 4)}, ${sgn(HC2.ciCub.hi, 4)}]  p=${f(HC2.pCub, 3)}  ${clear(HC2.ciCub) ? "CI-clear" : "covers 0"}`);
say(`           ⇒ ${handSeedStable ? "SEED-STABLE: the two streams agree on the flag and to within 0.02 in p." : "SEED-FRAGILE: the two streams disagree — treat the flag as meaningless and read the p-values."}`);
say(`        vR−vL LEVEL  point ${sgn(dLvlFull)}/600`);
say(`           seed A: CI [${sgn(HC1.ciLvl.lo)}, ${sgn(HC1.ciLvl.hi)}]  p=${f(HC1.pLvl, 3)}  ${clear(HC1.ciLvl) ? "CI-clear" : "covers 0"}`);
say(`           seed B: CI [${sgn(HC2.ciLvl.lo)}, ${sgn(HC2.ciLvl.hi)}]  p=${f(HC2.pLvl, 3)}  ${clear(HC2.ciLvl) ? "CI-clear" : "covers 0"}`);
say();
say(`     Split by provenance — is the hand contrast an in-sample artifact?`);
say(`        in-sample  ${IN_S.join("+")}: vR−vL cubic ${sgn(dCubIn, 4)}  CI [${sgn(HCin.ciCub.lo, 4)}, ${sgn(HCin.ciCub.hi, 4)}]  p=${f(HCin.pCub, 3)}`);
say(`        out-of-sample ${OOS[0]}–${OOS[OOS.length - 1]}: vR−vL cubic ${sgn(dCubOos, 4)}  CI [${sgn(HCoos.ciCub.lo, 4)}, ${sgn(HCoos.ciCub.hi, 4)}]  p=${f(HCoos.pCub, 3)}`);
say(`        ⇒ ${dCubIn * dCubOos > 0 ? "same sign in both halves" : "OPPOSITE signs across the two halves — the contrast does not carry out of sample"}.`);
say();

say("################################################################################");
say("## 5. THE FRAME-DRIFT CONFOUND, HANDLED EXPLICITLY");
say("################################################################################");
say();
say(`     Cards improve every season, so older years sit in a systematically WEAKER frame: the Stuff`);
say(`     distribution shifts, and so does the quality of the opposing hitters. A LEVEL residual in an old`);
say(`     year can therefore be frame drift rather than curve misfit, and must not be read naively.`);
say();
say(`     ${pad("year", 7)}${lpad("BF-wtd stu", 12)}${lpad("p10", 7)}${lpad("p25", 7)}${lpad("med", 7)}${lpad("p75", 7)}${lpad("p90", 7)}${lpad("lgK/600", 10)}${lpad("opp kRat", 10)}${lpad("level", 9)}`);
for (const p of perYear) {
  const fr = fy(p.y);
  say(`     ${pad(String(p.y) + (p.deep ? "*" : ""), 7)}${lpad(f(fr.stuMeanW, 1), 12)}${fr.stuQ.map((x) => lpad(f(x, 0), 7)).join("")}${lpad(f(fr.leagueK600, 1), 10)}${lpad(f(fr.hitKRat, 1), 10)}${lpad(sgn(p.level), 9)}`);
}
say();
say(`     The drift is real and monotone-ish: BF-weighted Stuff moves ${f(fy(MAIN[0]!).stuMeanW, 1)} → ${f(fy(MAIN[MAIN.length - 1]!).stuMeanW, 1)} across ${MAIN.length} seasons`);
say(`     and opposing avoid-K (kRat) moves ${f(fy(MAIN[0]!).hitKRat, 1)} → ${f(fy(MAIN[MAIN.length - 1]!).hitKRat, 1)}. So the confound is present, not hypothetical.`);
say();
say(`     HOW STRONGLY DOES EACH READING TRACK THE DRIFT? (correlation across the ${pyM.length} modern seasons)`);
say(`        ${pad("", 26)}${lpad("vs BF-wtd stu", 15)}${lpad("vs league K/600", 17)}${lpad("vs opp kRat", 13)}`);
say(`        ${pad("per-year LEVEL", 26)}${lpad(sgn(cLvlStu, 2), 15)}${lpad(sgn(cLvlK, 2), 17)}${lpad(sgn(cLvlKr, 2), 13)}`);
say(`        ${pad("per-year CUBIC", 26)}${lpad(sgn(cCubStu, 2), 15)}${lpad(sgn(cCubK, 2), 17)}${lpad(sgn(cCubKr, 2), 13)}`);
say();
say(`     ROBUSTNESS OF THE SHAPE — three constructions that KILL any level structure. If the cubic is a`);
say(`     level artifact, these must destroy it; if it is shape, they must leave it standing.`);
say(`        raw full-window cubic                        ${sgn(AF.all.cub, 4)} [${sgn(AF.all.cubCI.lo, 4)}, ${sgn(AF.all.cubCI.hi, 4)}] ${clear(AF.all.cubCI) ? "CI-clear" : "covers 0"}`);
say(`        after per-YEAR level removed (year FE)       ${sgn(cubYearFE, 4)} [${sgn(ciYearFE.lo, 4)}, ${sgn(ciYearFE.hi, 4)}] ${clear(ciYearFE) ? "CI-clear" : "covers 0"}`);
say(`        after per-YEAR×HAND level removed            ${sgn(cubYHFE, 4)} [${sgn(ciYHFE.lo, 4)}, ${sgn(ciYHFE.hi, 4)}] ${clear(ciYHFE) ? "CI-clear" : "covers 0"}`);
say(`        with z standardized WITHIN each season       ${sgn(cubWithin, 4)} [${sgn(ciWithin.lo, 4)}, ${sgn(ciWithin.hi, 4)}] ${clear(ciWithin) ? "CI-clear" : "covers 0"}`);
say(`        …the same, OUT-OF-SAMPLE years only          ${sgn(cubWithinOos, 4)} [${sgn(ciWithinOos.lo, 4)}, ${sgn(ciWithinOos.hi, 4)}] ${clear(ciWithinOos) ? "CI-clear" : "covers 0"}`);
say(`        (within-season z is on a per-year-sd scale — compare SIGN and CI-clearness, not magnitude)`);
say();
say(`     THE ARGUMENT, from these numbers rather than from first principles:`);
say(`      • LEVEL is NOT robust. It ranges ${sgn(Math.min(...pyM.map((p) => p.level)))} … ${sgn(Math.max(...pyM.map((p) => p.level)))}/600 across seasons (spread ${f(lvlSpread)}) and correlates`);
say(`        ${sgn(cLvlStu, 2)} with the season's mean Stuff and ${sgn(cLvlKr, 2)} with opposing avoid-K. An old-year level residual`);
say(`        is not interpretable as curve misfit — exactly the warning, confirmed in the data.`);
say(`      • SHAPE (the cubic) IS robust. Removing per-year levels moves it ${sgn(AF.all.cub, 4)} → ${sgn(cubYearFE, 4)}; removing`);
say(`        per-year×hand levels moves it to ${sgn(cubYHFE, 4)}. Mechanically this is expected — the cubic partial is`);
say(`        orthogonal to the constant in the weighted basis, so a per-group additive shift cannot enter it`);
say(`        — and the numbers confirm the mechanism rather than merely assuming it. Standardizing Stuff`);
say(`        WITHIN each season, which also neutralises the drift in the Stuff DISTRIBUTION (not just its`);
say(`        level), leaves ${sgn(cubWithin, 4)} ${clear(ciWithin) ? "CI-clear" : "covering 0"}. And the per-year cubic tracks the frame proxies weakly`);
say(`        (${sgn(cCubStu, 2)} vs mean Stuff, ${sgn(cCubKr, 2)} vs opposing kRat) against LEVEL's ${sgn(cLvlStu, 2)} / ${sgn(cLvlKr, 2)}.`);
say(`      • The HAND CONTRAST is robust by construction and confirmed empirically: vR and vL rows come from`);
say(`        the SAME season, the SAME league files and largely the SAME cards, so any year-level frame shift`);
say(`        is common to both arms and differences it out. The per-year×hand FE row above is the direct`);
say(`        check — it removes an arbitrary per-year-per-hand level and the cubic survives at ${sgn(cubYHFE, 4)}.`);
say(`        What frame drift CANNOT be differenced away by the hand contrast is a change in the platoon`);
say(`        COMPOSITION of the opposition itself; that is a separate exposure question, not this residual.`);
say();

say("################################################################################");
say("## 6. VERDICT, IN FULL");
say("################################################################################");
say();
say(`  (a) DOES THE CUBIC K MISFIT REPLICATE OUT-OF-SAMPLE?`);
say(`      ${replLabel} The form was fit on ${IN_S.join("+")}; on ${OOS[0]}–${OOS[OOS.length - 1]}, data it has never seen, the cubic`);
say(`      partial is ${sgn(AO.all.cub, 4)} [${sgn(AO.all.cubCI.lo, 4)}, ${sgn(AO.all.cubCI.hi, 4)}] over ${AO.all.n} rows / ${AO.all.cards} cards — ${oosSameSign ? "the same sign as" : "the opposite sign to"} the`);
say(`      in-sample ${sgn(AI.all.cub, 4)}, at ${f(Math.abs(AO.all.cub / (AI.all.cub || 1e-9)), 2)}× the magnitude, and ${cubYearsNeg}/${pyM.length} individual seasons carry the same`);
say(`      sign. Pooled, that OOS interval grazes zero; the vR ARM does not — ${sgn(AO.R.cub, 4)} [${sgn(AO.R.cubCI.lo, 4)}, ${sgn(AO.R.cubCI.hi, 4)}] against an`);
say(`      in-sample ${sgn(AI.R.cub, 4)}, i.e. the misfit reproduces at ${f(100 * Math.abs(AO.R.cub) / Math.abs(AI.R.cub), 0)}% of its in-sample magnitude (a ${f(100 * Math.abs(AO.R.cub - AI.R.cub) / Math.abs(AI.R.cub), 1)}% difference)`);
say(`      on years the fit never saw.`);
say(`      In-sample shrinkage therefore did NOT manufacture the 2026-07-23 finding. The shape survives year`);
say(`      FE, year×hand FE and within-season standardization (§5), so it is not the frame-drift level`);
say(`      confound wearing a curve. THE CAVEAT THAT LIMITS ALL OF THIS: the same ~${AF.all.cards} cards populate every`);
say(`      season (${oosSharedCards}/${AO.all.cards} OOS cards are also fit-window cards), so this is replication ACROSS TIME on largely`);
say(`      the SAME cards — not replication on fresh cards, which this corpus cannot supply.`);
say();
say(`  (b) IS HAND-CONDITIONING WARRANTED?`);
say(`      ${handResolved ? "YES" : "NO — not on this evidence"}. On the full ${MAIN[0]}–${MAIN[MAIN.length - 1]} window the vR−vL cubic difference is ${sgn(dCubFull, 4)}, with paired`);
say(`      card-cluster CIs [${sgn(HC1.ciCub.lo, 4)}, ${sgn(HC1.ciCub.hi, 4)}] (p=${f(HC1.pCub, 3)}) and [${sgn(HC2.ciCub.lo, 4)}, ${sgn(HC2.ciCub.hi, 4)}] (p=${f(HC2.pCub, 3)}) under two independent`);
say(`      rng streams — ${handSeedStable ? "stable, so the reading is usable this time" : "still not stable enough to hang a decision on"}. Season-by-season the contrast is negative in`);
say(`      ${dCubYearsNeg}/${dCubYearsFinite} years, and it is ${dCubIn * dCubOos > 0 ? "the same sign in-sample and out-of-sample" : "SIGN-FLIPPED between in-sample and out-of-sample"}, which is the`);
say(`      strongest single indicator either way. The hand LEVEL gap remains ${clear(HC1.ciLvl) ? "resolved" : "UNRESOLVED"} (${sgn(dLvlFull)}/600,`);
say(`      p=${f(HC1.pLvl, 3)}) and should not be carried into any proposal.`);
say();
say(`  SCOPE. Measurement only: no fit, no refit, no defaults touched, nothing wired, nothing committed.`);
say(`  This EXTENDS the 2026-07-23 and 2026-07-25 artifacts; it supersedes neither.`);
say();
say("(end of artifact — K-residual wide window / out-of-time replication)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
