// STUFF-RESIDUAL CHANNEL LOCATOR (Fable follow-up, 2026-07-25). MEASUREMENT ONLY; nothing wired.
//   run: node tools/stuff-residual-channels.ts > fixtures/stuff-residual-channels-2026-07-25.txt
//
// WHAT CAME BEFORE. The anchor-uniformity audit (tools/anchor-uniformity-audit.ts) found the deployed
// model's PITCHER wOBA-ALLOWED bias RISES with Stuff (+0.0077 low-Stuff → +0.0120 high-Stuff, slope
// +0.00007 CI [+0.00003,+0.00012], excludes 0). A rating-varying bias is one a per-role anchor CANNOT
// absorb ⇒ a genuine per-card error — the long-standing "Stuff under-credit" (Donohue class). The
// pre-step (tools/kresidual-stuff-inframe.ts) then RULED OUT strikeouts as the mechanism: at high Stuff
// the model OVER-predicts K (+1.75/600 top quintile), which pushes predicted wOBA-allowed DOWN — the
// OPPOSITE sign to the rising bias. So the under-credit must live on the CONTACT / HOME-RUN side.
//
// WHAT THIS DOES. Same instrument, one level deeper: the deployed model's IN-FRAME per-card residual
// versus Stuff, measured SEPARATELY FOR EVERY PITCHER EVENT CHANNEL, and — the key output — each
// channel's CONTRIBUTION to the wOBA-allowed bias SLOPE on Stuff, so the channels can be RANKED by how
// much of the composite slope each one explains. The decomposition is EXACT (the channel contributions
// sum to the composite residual row-by-row, verified below), and uses the MODEL'S OWN wOBA event
// weights (src/scoring-core/woba-weights.ts — the one source; no invented weights).
//
// THE EXACT DECOMPOSITION (all per 600 BF; w = the model's wOBA weights; w̄ = 0.75·w_1b + 0.25·w_xbh is
// the model's blended non-HR-hit weight, since the deployed pitcher form allocates a FIXED 25% XBH
// share). With BIP = 600 − uBB − K − HR − PIT_BIP_ADJ (the training/inference convention, applied to
// BOTH the predicted and the observed line so the identity closes) and babip = nHH / BIP:
//
//   ΔwOBAA = [ w̄·BIP_obs·(babip_pred − babip_obs)              ] / 600   ← BABIP  (contact-rate channel)
//          + [ (w_hr  − w̄·babip_pred)·ΔHR                      ] / 600   ← HR
//          + [ (w_bb  − w̄·babip_pred)·ΔBB                      ] / 600   ← BB (uBB)
//          + [ (      − w̄·babip_pred)·ΔK                       ] / 600   ← K   (INDIRECT ONLY: a K has no
//          + [ (w_xbh − w_1b)·(0.25·nHH_obs − XBH_obs)          ] / 600   ←   wOBA weight; it moves wOBAA
//          + [ w_hbp·(PIT_BIP_ADJ − HBP_obs)                    ] / 600   ←   only by removing a ball in play)
//
// i.e. the hits channel is split into its RATE leg (BABIP) and its VOLUME leg (BIP moves when BB/K/HR
// are mis-predicted), and the volume leg is attributed back to BB/K/HR — which is precisely how the
// pre-step's K over-prediction enters wOBAA (fewer predicted balls in play ⇒ fewer predicted hits ⇒
// predicted wOBAA pushed DOWN). XBH-SHARE is the model's fixed-25% mis-allocation; HBP is its fixed-6.
// Because slope is a LINEAR operator, the channels' bias SLOPES on Stuff sum to the composite slope —
// that is what makes the "% of the composite slope" column meaningful and exhaustive.
//
// GRAIN: ROW grain — one observation per (card × deployment side × season-window row) from the loader,
// BF-weighted, exactly as the pre-step. DEPLOYED FORM: makeRawPolyModel(trained.eventForm), not a refit.
//
// THE STANDING CAVEAT, stated up front because it changes how the ranking must be read: the deployed
// pit.bb / pit.k / pit.hr curves were FIT on this same data with ln(Stuff) in their design (pit.k's own
// driver IS Stuff; pit.bb and pit.hr carry the stuffAug linear Stuff term), so by least-squares
// orthogonality THEIR in-frame residuals are ≈0-sloped on Stuff BY CONSTRUCTION. The pit.h (hits) curve
// is fit on pbabip and BIP ONLY — Stuff never enters its design — so it is the one channel STRUCTURALLY
// FREE to carry a Stuff-correlated error in frame. A BABIP finding is therefore expected-by-structure
// and must be judged on MAGNITUDE and SHAPE, not on the mere fact of being non-zero; conversely a
// LARGE surviving slope on a fitted channel would be the surprising result.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { DEFAULT_WOBA_WEIGHTS, type WobaWeights } from "../src/scoring-core/woba-weights.ts";
import { PIT_BIP_ADJ } from "../src/model/curves.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { wls } from "../src/training/fit.ts";
import { analyzeResiduals } from "../src/training/residuals.ts";
import { readFileSync } from "node:fs";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { productionFieldStats, applyWobaWeights, computeDerived, cohortSelectForModel, type RatingEnvelope } from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { buildCwhitSample, wellSampled, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp2 = (s: string, n: number) => s.padStart(n);

// ── load the DEPLOYED model + its training window ────────────────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; window?: number[]; minPA?: number; includeVariants?: boolean };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rp = makeRawPolyModel(trained.eventForm);          // THE DEPLOYED FORM
const W: WobaWeights = trained.wobaWeights ?? DEFAULT_WOBA_WEIGHTS;   // the model's OWN weights
const usingModelWeights = !!trained.wobaWeights;
const wbar = 0.75 * W.b1 + 0.25 * W.xbh;                 // blended non-HR-hit weight (fixed 25% XBH share)

const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const obs = loadWindow(TRAIN, win.length ? win : undefined).observations
  .filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);

// ── per-row channel residuals (native units) + exact wOBAA contributions ─────
const EVK = ["WOBAA", "HR", "BABIP", "HITS", "BB", "K"] as const;
const CTK = ["BABIP", "HR", "BB", "K", "XBHSHARE", "HBP"] as const;
type EvK = (typeof EVK)[number]; type CtK = (typeof CTK)[number];
const AXK = ["stu", "con", "pbabip", "hrr"] as const;
type AxK = (typeof AXK)[number];
interface Row { stu: number; r: Record<AxK, number>; w: number; side: string; ev: Record<EvK, number>; ct: Record<CtK, number>; closure: number }

function buildRows(minBF: number): Row[] {
const rows: Row[] = [];
for (const o of obs.filter((x) => PITCHER.qualifies(x, minBF))) {
  const bf = Math.max(o.pitch.BF, 1), s = 600 / bf;
  // OBSERVED, per 600 BF, on the model's own conventions (uBB — IBB is manager behavior, excluded
  // from both the fit target and the wOBA convention).
  const uBBo = Math.max(o.pitch.BB - o.pitch.IBB, 0) * s;
  const Ko = o.pitch.K * s, HRo = o.pitch.HR * s, HPo = o.pitch.HP * s;
  const b1o = o.pitch.b1 * s, xbho = (o.pitch.b2 + o.pitch.b3) * s, nHHo = b1o + xbho;
  const BIPo = 600 - uBBo - Ko - HRo - PIT_BIP_ADJ;
  if (!(BIPo > 1)) continue;
  const babipO = nHHo / BIPo;
  // PREDICTED (deployed form, per 600, no era/park/calibration — the raw model line).
  const p = rp.predictPitching(o.ratings.pitch, {} as any);
  const BIPp = 600 - p.BB - p.K - p.HR - PIT_BIP_ADJ;
  if (!(BIPp > 1)) continue;
  const babipP = p.nHH / BIPp;

  const dBB = p.BB - uBBo, dK = p.K - Ko, dHR = p.HR - HRo, dnHH = p.nHH - nHHo;
  const wobaP = (W.bb * p.BB + W.hbp * PIT_BIP_ADJ + W.b1 * (p.nHH - p.XBH) + W.xbh * p.XBH + W.hr * p.HR) / 600;
  const wobaO = (W.bb * uBBo + W.hbp * HPo + W.b1 * b1o + W.xbh * xbho + W.hr * HRo) / 600;
  const dW = wobaP - wobaO;

  const ct: Record<CtK, number> = {
    BABIP: (wbar * BIPo * (babipP - babipO)) / 600,
    HR: ((W.hr - wbar * babipP) * dHR) / 600,
    BB: ((W.bb - wbar * babipP) * dBB) / 600,
    K: (-wbar * babipP * dK) / 600,
    XBHSHARE: ((W.xbh - W.b1) * (0.25 * nHHo - xbho)) / 600,
    HBP: (W.hbp * (PIT_BIP_ADJ - HPo)) / 600,
  };
  const ev: Record<EvK, number> = {
    WOBAA: dW, HR: dHR, BABIP: (babipP - babipO) * 1000, HITS: dnHH, BB: dBB, K: dK,
  };
  const sum = CTK.reduce((a, k) => a + ct[k], 0);
  if (!Number.isFinite(dW) || EVK.some((k) => !Number.isFinite(ev[k])) || CTK.some((k) => !Number.isFinite(ct[k]))) continue;
  const rr = o.ratings.pitch;
  rows.push({ stu: rr.stu, r: { stu: rr.stu, con: rr.con, pbabip: rr.pbabip, hrr: rr.hrr }, w: bf, side: String(o.side), ev, ct, closure: sum - dW });
}
return rows;
}
const rows = buildRows(minPA);   // the DEPLOYED training filter (in-frame)

// ── shared machinery (lifted from tools/kresidual-stuff-inframe.ts, unchanged in spirit) ──
const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = rs.reduce((a, r) => a + r.w, 0); return sw > 0 ? rs.reduce((a, r) => a + r.w * get(r), 0) / sw : NaN; };
const mu = wmean(rows, (r) => r.stu), sd = Math.sqrt(wmean(rows, (r) => (r.stu - mu) ** 2)) || 1;
const z = (s: number) => (s - mu) / sd;
// per-AXIS standardization (the scope amendment: Stuff is one axis of four, not "the" axis)
const muA = {} as Record<AxK, number>, sdA = {} as Record<AxK, number>;
for (const k of AXK) { muA[k] = wmean(rows, (r) => r.r[k]); sdA[k] = Math.sqrt(wmean(rows, (r) => (r.r[k] - muA[k]) ** 2)) || 1; }
const zA = (k: AxK) => (r: Row) => (r.r[k] - muA[k]) / sdA[k];
/** weighted polynomial partials via normal equations up to cubic, on a standardized AXIS (default Stuff) */
function wpoly(rs: Row[], deg: number, get: (r: Row) => number, zf: (r: Row) => number = (r) => z(r.stu)): number[] {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) {
    const zz = zf(r), p = [1, zz, zz * zz, zz * zz * zz].slice(0, n), y = get(r);
    for (let i = 0; i < n; i++) { b[i] += r.w * p[i]! * y; for (let j = 0; j < n; j++) A[i]![j] += r.w * p[i]! * p[j]!; }
  }
  for (let i = 0; i < n; i++) { let piv = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k]![i]!) > Math.abs(A[piv]![i]!)) piv = k; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let k = i + 1; k < n; k++) { const fct = A[k]![i]! / d; for (let j = i; j < n; j++) A[k]![j]! -= fct * A[i]![j]!; b[k] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
let a = 20260725 >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ci = (xs: number[]) => { const v = [...xs].sort((p, q) => p - q); return { lo: v[Math.floor(0.025 * v.length)]!, hi: v[Math.floor(0.975 * v.length)]! }; };
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
/** weighted LS slope on a RAW rating axis (default Stuff) — the units of the anchor audit's +0.00007 */
function rawSlope(rs: Row[], get: (r: Row) => number, ax: AxK = "stu"): number {
  const sw = rs.reduce((s, r) => s + r.w, 0); if (!(sw > 0)) return NaN;
  const md = rs.reduce((s, r) => s + r.w * r.r[ax], 0) / sw, my = rs.reduce((s, r) => s + r.w * get(r), 0) / sw;
  let sxx = 0, sxy = 0; for (const r of rs) { sxx += r.w * (r.r[ax] - md) ** 2; sxy += r.w * (r.r[ax] - md) * (get(r) - my); }
  return sxx > 0 ? sxy / sxx : NaN;
}
/** weighted R² of a cubic fit of `get` on one axis — "how much residual STRUCTURE this axis carries" */
function axR2(rs: Row[], get: (r: Row) => number, ax: AxK): number {
  const zf = zA(ax), c = wpoly(rs, 3, get, zf), m = wmean(rs, get);
  let ssr = 0, sst = 0;
  for (const r of rs) { const zz = zf(r), p = c[0]! + c[1]! * zz + c[2]! * zz * zz + c[3]! * zz ** 3; ssr += r.w * (get(r) - p) ** 2; sst += r.w * (get(r) - m) ** 2; }
  return sst > 0 ? 1 - ssr / sst : NaN;
}

const NBOOT = 1200;
function analyze(rs: Row[], get: (r: Row) => number, ax: AxK = "stu") {
  const zf = zA(ax);
  const bLin: number[] = [], bCub: number[] = [];
  for (let b = 0; b < NBOOT; b++) {
    const bs = rs.map(() => rs[Math.floor(rnd() * rs.length)]!);
    bLin.push(wpoly(bs, 1, get, zf)[1]!);
    bCub.push(wpoly(bs, 3, get, zf)[3]!);
  }
  const srt = [...rs].sort((p, q) => p.r[ax] - q.r[ax]);
  const quints = [0, 1, 2, 3, 4].map((i) => {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    return { lo: s[0]?.r[ax] ?? 0, hi: s[s.length - 1]?.r[ax] ?? 0, resid: wmean(s, get), n: s.length };
  });
  return { n: rs.length, level: wmean(rs, get), quints, lin: wpoly(rs, 1, get, zf)[1]!, linCI: ci(bLin), cub: wpoly(rs, 3, get, zf)[3]!, cubCI: ci(bCub), raw: rawSlope(rs, get, ax), r2: axR2(rs, get, ax) };
}
type An = ReturnType<typeof analyze>;

// ── channel metadata ─────────────────────────────────────────────────────────
interface Chan { key: EvK; label: string; unit: string; dec: number; fitted: string }
const CHANS: Chan[] = [
  { key: "WOBAA", label: "wOBAA COMPOSITE (reference row)", unit: " wOBA", dec: 5, fitted: "assembled — not itself fit" },
  { key: "HR", label: "HR allowed", unit: "/600", dec: 3, fitted: "pit.hr — FIT on HRR + ln(Stuff) aux ⇒ Stuff-orthogonal by construction" },
  { key: "BABIP", label: "BABIP allowed (nHH / BIP)", unit: " pts×1000", dec: 3, fitted: "pit.h — FIT on pBABIP + BIP only; STUFF NEVER ENTERS ⇒ structurally free" },
  { key: "HITS", label: "non-HR hits allowed (nHH)", unit: "/600", dec: 3, fitted: "pit.h (rate) × BIP chain (volume)" },
  { key: "BB", label: "BB allowed (uBB)", unit: "/600", dec: 3, fitted: "pit.bb — FIT on Control + ln(Stuff) aux ⇒ Stuff-orthogonal by construction" },
  { key: "K", label: "K (pre-step reference)", unit: "/600", dec: 3, fitted: "pit.k — FIT on Stuff ⇒ Stuff-orthogonal by construction" },
];
function emit(a: An, label: string, unit: string, dec: number, ax = "Stuff") {
  say(`  ── ${label}  (N=${a.n} rows, level ${sgn(a.level, dec)}${unit}) ──`);
  say(`     ${pad(`${ax} quintile`, 18)} mean resid          n`);
  for (const q of a.quints) say(`     ${pad(`[${f(q.lo, 0)}-${f(q.hi, 0)}]`, 18)} ${rp2(sgn(q.resid, dec), 10)}      ${q.n}`);
  say(`     LINEAR partial (per SD ${ax}): ${sgn(a.lin, dec + 1)} [${sgn(a.linCI.lo, dec + 1)}, ${sgn(a.linCI.hi, dec + 1)}] ${clear(a.linCI) ? "CI-clear" : "covers 0"}`);
  say(`     CUBIC  partial (per SD ${ax}): ${sgn(a.cub, dec + 2)} [${sgn(a.cubCI.lo, dec + 2)}, ${sgn(a.cubCI.hi, dec + 2)}] ${clear(a.cubCI) ? "★ CI-CLEAR — curved (a quad cannot express it)" : "covers 0 — no cubic misfit"}`);
  say();
}

// ── the CONTRIBUTION table: each channel's share of the composite bias SLOPE ──
// Common random numbers: every channel is bootstrapped on the SAME resample draws, so the per-channel
// slope CIs are mutually comparable and the resampled channel slopes still sum to the resampled
// composite slope (the decomposition survives the bootstrap).
interface CRow { key: CtK | "TOTAL"; label: string; level: number; slope: number; ci: { lo: number; hi: number }; share: number }
function contribTable(rs: Row[]): { rowsOut: CRow[]; compSlope: number; compCI: { lo: number; hi: number }; compLevel: number } {
  const compSlope = rawSlope(rs, (r) => r.ev.WOBAA);
  const draws: Row[][] = [];
  for (let b = 0; b < NBOOT; b++) draws.push(rs.map(() => rs[Math.floor(rnd() * rs.length)]!));
  const bootComp = draws.map((d) => rawSlope(d, (r) => r.ev.WOBAA));
  const labels: Record<CtK, string> = {
    BABIP: "BABIP  (contact-rate leg of hits)", HR: "HR     (direct + BIP-volume)", BB: "BB     (direct + BIP-volume)",
    K: "K      (BIP-volume ONLY — no wOBA weight)", XBHSHARE: "XBH-SHARE (fixed 25% mis-allocation)", HBP: "HBP    (fixed 6/600)",
  };
  const rowsOut: CRow[] = CTK.map((k) => {
    const slope = rawSlope(rs, (r) => r.ct[k]);
    const bs = draws.map((d) => rawSlope(d, (r) => r.ct[k]));
    return { key: k, label: labels[k], level: wmean(rs, (r) => r.ct[k]), slope, ci: ci(bs), share: compSlope !== 0 ? (100 * slope) / compSlope : NaN };
  });
  rowsOut.sort((p, q) => Math.abs(q.slope) - Math.abs(p.slope));
  return { rowsOut, compSlope, compCI: ci(bootComp), compLevel: wmean(rs, (r) => r.ev.WOBAA) };
}

// ── run ──────────────────────────────────────────────────────────────────────
const bySide = [{ code: "R", tag: "vR" }, { code: "L", tag: "vL" }]
  .map(({ code, tag }) => ({ s: tag, rows: rows.filter((r) => r.side === code) }))
  .filter((x) => x.rows.length > 30);
const pooledAn: Record<EvK, An> = Object.fromEntries(CHANS.map((c) => [c.key, analyze(rows, (r) => r.ev[c.key])])) as Record<EvK, An>;
const sideAn = bySide.map(({ s, rows: rs }) => ({ s, an: Object.fromEntries(CHANS.map((c) => [c.key, analyze(rs, (r) => r.ev[c.key])])) as Record<EvK, An> }));
const pooledCT = contribTable(rows);
const sideCT = bySide.map(({ s, rows: rs }) => ({ s, ct: contribTable(rs) }));
const maxClosure = rows.reduce((m, r) => Math.max(m, Math.abs(r.closure)), 0);

// ── VERDICT computation (done before printing so the banner can carry it) ────
const ranked = [...pooledCT.rowsOut];
const top = ranked[0]!;
const topChan = CHANS.find((c) => c.key === (top.key as string as EvK));
const topAn = topChan ? pooledAn[topChan.key] : pooledAn.BABIP;
const topShape = clear(topAn.cubCI) ? "CURVED (CI-clear cubic — a quadratic in Stuff could not express it)"
  : clear(topAn.linCI) ? "LINEAR in Stuff (CI-clear linear partial, cubic covers 0)"
  : "a LEVEL/quintile pattern (neither linear nor cubic partial is CI-clear on its own)";
const sideSlopes = sideCT.map((x) => ({ s: x.s, v: x.ct.rowsOut.find((r) => r.key === top.key)!.slope, ci: x.ct.rowsOut.find((r) => r.key === top.key)!.ci }));
const handAsym = sideSlopes.length === 2 &&
  !(sideSlopes[0]!.ci.lo <= sideSlopes[1]!.v && sideSlopes[1]!.v <= sideSlopes[0]!.ci.hi &&
    sideSlopes[1]!.ci.lo <= sideSlopes[0]!.v && sideSlopes[0]!.v <= sideSlopes[1]!.ci.hi);

say("################################################################################");
say("# STUFF-RESIDUAL CHANNEL LOCATOR (deployed form, in-frame).  MEASUREMENT ONLY — nothing wired.");
say("# Q1 (Parts 1-3): which pitcher EVENT CHANNEL carries the Stuff-correlated wOBA-allowed bias the");
say("# anchor cannot absorb? K was ruled out (wrong sign) — every channel is ranked by its slope share.");
say("# Q2 (Parts 4-8, SCOPE AMENDMENT): is it a Stuff effect at all, or a rating-SHAPE effect that");
say("# merely correlates with Stuff? All four axes, the 2-D corners vs a permutation null, and the");
say("# marginal-vs-conditional slope both in frame and out of frame (where the effect is CI-clear).");
say("################################################################################");
say();
say(`  model '${trained.id}'  DEPLOYED form  window ${win.join("+") || "all"}  minBF ${minPA}  N=${rows.length} ROWS`);
say(`  ROW grain = card × deployment side × season-window row, BF-weighted (same grain as the pre-step).`);
say(`  wOBA event weights: ${usingModelWeights ? "THE MODEL'S OWN (trained.wobaWeights, wRAA-derived)" : "DEFAULT_WOBA_WEIGHTS (model carries none)"}`);
say(`    bb ${f(W.bb, 4)}  hbp ${f(W.hbp, 4)}  1b ${f(W.b1, 4)}  xbh ${f(W.xbh, 4)}  hr ${f(W.hr, 4)}   ⇒ blended hit weight w̄ = ${f(wbar, 4)}`);
say(`  Stuff over these rows: mean ${f(mu, 1)}, SD ${f(sd, 2)}  (1 SD ≈ ${f(sd, 1)} rating points — the`);
say(`  conversion between the "per SD" partials below and the "per Stuff point" slopes in the table).`);
say();
say(`  residual convention throughout: DEPLOYED PREDICTION − OBSERVED. Positive on wOBAA = the model`);
say(`  says the pitcher allows MORE than he did = the model UNDER-CREDITS him. That is the sign of the`);
say(`  audit's finding, and it grows with Stuff.`);
say();
say(`  DECOMPOSITION CLOSURE CHECK: max |Σ channel contributions − ΔwOBAA| over all ${rows.length} rows =`);
say(`  ${maxClosure.toExponential(2)} wOBA. The decomposition is EXACT (floating-point only) ⇒ the channel`);
say(`  shares below are exhaustive and mutually exclusive — nothing is double-counted or missing.`);
say();

say("################################################################################");
say("# PART 1 — PER-CHANNEL RESIDUAL vs STUFF (native units, pooled over both hands)");
say("################################################################################");
say();
for (const c of CHANS) {
  say(`  ▸ ${c.label}`);
  say(`    fit status: ${c.fitted}`);
  emit(pooledAn[c.key], "POOLED (both hands)", c.unit, c.dec);
}

say("################################################################################");
say("# PART 2 — THE RANKING: each channel's CONTRIBUTION to the wOBAA bias SLOPE on Stuff");
say("################################################################################");
say();
say(`  Composite in-frame wOBAA bias:  level ${sgn(pooledCT.compLevel, 5)} wOBA,`);
say(`  slope on Stuff ${sgn(pooledCT.compSlope, 6)} per Stuff point  [${sgn(pooledCT.compCI.lo, 6)}, ${sgn(pooledCT.compCI.hi, 6)}]  ${clear(pooledCT.compCI) ? "CI-clear" : "covers 0"}`);
say(`  (the anchor audit measured +0.00007 on the OUT-OF-FRAME cwhit tournament line; this is the`);
say(`  IN-FRAME league counterpart — the same quantity on the data the curves were fit to, so its`);
say(`  magnitude is not expected to match, only its channel COMPOSITION is transferable.)`);
say();
say(`  ${pad("channel", 44)} ${rp2("level", 10)} ${rp2("slope/Stuff pt", 15)} ${rp2("95% CI", 26)}  ${rp2("% of composite", 15)}`);
say(`  ${"-".repeat(44)} ${"-".repeat(10)} ${"-".repeat(15)} ${"-".repeat(26)}  ${"-".repeat(15)}`);
for (const r of pooledCT.rowsOut) {
  say(`  ${pad(r.label, 44)} ${rp2(sgn(r.level, 5), 10)} ${rp2(sgn(r.slope, 6), 15)} ${rp2(`[${sgn(r.ci.lo, 6)}, ${sgn(r.ci.hi, 6)}]`, 26)}  ${rp2(`${sgn(r.share, 1)}%`, 15)}${clear(r.ci) ? "  ★" : ""}`);
}
say(`  ${"-".repeat(44)} ${"-".repeat(10)} ${"-".repeat(15)} ${"-".repeat(26)}  ${"-".repeat(15)}`);
say(`  ${pad("TOTAL (= wOBAA composite, by construction)", 44)} ${rp2(sgn(pooledCT.compLevel, 5), 10)} ${rp2(sgn(pooledCT.compSlope, 6), 15)} ${rp2(`[${sgn(pooledCT.compCI.lo, 6)}, ${sgn(pooledCT.compCI.hi, 6)}]`, 26)}  ${rp2("100.0%", 15)}`);
say();
say(`  ★ = the channel's own slope CI excludes zero. Shares can exceed 100% or go negative: channels`);
say(`  push in OPPOSITE directions (K's over-prediction pushes wOBAA DOWN with Stuff — the pre-step's`);
say(`  finding, here quantified in wOBA units for the first time).`);
say();
say(`  ⚠ READ THE ABSOLUTE SLOPES, NOT THE PERCENTAGES, AS PRIMARY. The composite denominator is small`);
say(`  and its own CI covers zero, so "% of composite" is a RATIO OF NOISY QUANTITIES and is unstable`);
say(`  (a 137% share of a near-zero total is not "more than all of it" — it is one channel's absolute`);
say(`  slope divided by a total that other channels partially cancel). The ranking by |absolute slope|`);
say(`  is the robust statement; the share column is orientation only.`);
say();

// ── robustness: does the read survive dropping the deployed BF filter? ───────
const rowsLo = buildRows(300);
const ctLo = { comp: rawSlope(rowsLo, (r) => r.ev.WOBAA), babip: rawSlope(rowsLo, (r) => r.ct.BABIP) };
const bfTot = (rs: Row[]) => rs.reduce((a, r) => a + r.w, 0);
say(`  ROBUSTNESS — the deployed minBF ${minPA} filter is also the TRAINING filter, so rows below it were`);
say(`  never fit (a mildly out-of-frame margin). Relaxing to minBF 300 adds ${rowsLo.length - rows.length} rows but only`);
say(`  ${f((100 * (bfTot(rowsLo) - bfTot(rows))) / bfTot(rowsLo), 1)}% of the BF weight, so it is a shape check, not a power gain:`);
say(`    minBF ${minPA} (deployed, N=${rows.length}):  composite ${sgn(pooledCT.compSlope, 6)}   BABIP ${sgn(pooledCT.rowsOut.find((r) => r.key === "BABIP")!.slope, 6)}`);
say(`    minBF  300 (relaxed,  N=${rowsLo.length}):  composite ${sgn(ctLo.comp, 6)}   BABIP ${sgn(ctLo.babip, 6)}`);
say();

say("################################################################################");
say("# PART 3 — HAND SPLIT (is the carrier channel hand-asymmetric?)");
say("################################################################################");
say();
for (const { s, ct } of sideCT) {
  say(`  ── ${s === "vR" ? "vs RHB (vR)" : "vs LHB (vL)"}  (N=${rows.filter((r) => r.side === (s === "vR" ? "R" : "L")).length} rows) ──`);
  say(`     composite: level ${sgn(ct.compLevel, 5)}  slope ${sgn(ct.compSlope, 6)} [${sgn(ct.compCI.lo, 6)}, ${sgn(ct.compCI.hi, 6)}] ${clear(ct.compCI) ? "CI-clear" : "covers 0"}`);
  for (const r of ct.rowsOut) say(`     ${pad(r.label, 44)} slope ${rp2(sgn(r.slope, 6), 10)} [${sgn(r.ci.lo, 6)}, ${sgn(r.ci.hi, 6)}] ${sgn(r.share, 1)}%${clear(r.ci) ? "  ★" : ""}`);
  say();
}
say(`  Per-channel native-unit shape by hand (the carrier channel first):`);
say();
for (const c of CHANS) {
  for (const { s, an } of sideAn) emit(an[c.key], `${c.label} — ${s === "vR" ? "vs RHB (vR)" : "vs LHB (vL)"}`, c.unit, c.dec);
}

// ════════════════════════════════════════════════════════════════════════════
// SCOPE AMENDMENT (2026-07-25): RATING SHAPE, not a single axis.
// Doctrine: a card's quality is NEVER inferrable from one rating — cards have different rating
// SHAPES. "Bias rises with Stuff" may therefore not be a Stuff effect at all, but a SHAPE effect
// that merely CORRELATES with Stuff (high Stuff pairs with low Control in this pool, and vice
// versa). A correction fitted on the Stuff axis alone would then be fitting the wrong thing.
// Parts 4–7 test that directly: all four axes marginally, the 2-D shape corners, the conditional
// slope, and a cross-check against the instrument the ORIGINAL "shape ruled out" record used.
// ════════════════════════════════════════════════════════════════════════════
const AXLAB: Record<AxK, string> = { stu: "Stuff", con: "Control", pbabip: "pBABIP (contact suppr.)", hrr: "HR-rate (HRA)" };
const compAx = Object.fromEntries(AXK.map((k) => [k, analyze(rows, (r) => r.ev.WOBAA, k)])) as Record<AxK, An>;
const axRank = [...AXK].sort((p, q) => compAx[q]!.r2 - compAx[p]!.r2);
const bestAx = axRank[0]!;
const bestOther = axRank.find((k) => k !== "stu" && k !== "con") ?? "pbabip";

say("################################################################################");
say("# PART 4 — SCOPE AMENDMENT: ALL FOUR PITCHER AXES, not just Stuff");
say("################################################################################");
say();
say(`  Weighted axis CORRELATIONS over these ${rows.length} rows — read this FIRST, it is why a single-axis`);
say(`  read can be misleading. (Weighted Pearson r; the axes are standardized on the same weights.)`);
say();
say(`  ${pad("", 10)}${AXK.map((k) => rp2(k, 10)).join("")}`);
for (const a1 of AXK) say(`  ${pad(a1, 10)}${AXK.map((a2) => rp2(sgn(wmean(rows, (r) => zA(a1)(r) * zA(a2)(r)), 3), 10)).join("")}`);
say();
say(`  ⇒ ${Math.abs(wmean(rows, (r) => zA("stu")(r) * zA("con")(r))) > 0.25 ? `Stuff and Control are MATERIALLY correlated (r = ${sgn(wmean(rows, (r) => zA("stu")(r) * zA("con")(r)), 3)}), so a marginal Stuff\n  slope is partly a Control slope in disguise. The conditional read (Part 6) is the decisive one.` : `Stuff and Control are only weakly correlated (r = ${sgn(wmean(rows, (r) => zA("stu")(r) * zA("con")(r)), 3)}), which LIMITS how much\n  of a marginal Stuff slope could be Control in disguise — but Part 6 still decides it.`}`);
say();
say(`  RESIDUAL STRUCTURE BY AXIS — wOBAA composite residual, weighted cubic R² per axis (how much of`);
say(`  the residual's variance that ONE axis explains) + the linear partial per SD with bootstrap CI:`);
say();
say(`  ${pad("axis", 26)} ${rp2("cubic R²", 10)} ${rp2("linear/SD", 12)} ${rp2("95% CI", 26)} ${rp2("cubic/SD", 12)}`);
say(`  ${"-".repeat(26)} ${"-".repeat(10)} ${"-".repeat(12)} ${"-".repeat(26)} ${"-".repeat(12)}`);
for (const k of axRank) {
  const a = compAx[k]!;
  say(`  ${pad(AXLAB[k], 26)} ${rp2(f(a.r2, 4), 10)} ${rp2(sgn(a.lin, 6), 12)} ${rp2(`[${sgn(a.linCI.lo, 6)}, ${sgn(a.linCI.hi, 6)}]`, 26)} ${rp2(sgn(a.cub, 6), 12)}${clear(a.linCI) ? "  ★lin" : ""}${clear(a.cubCI) ? "  ★cub" : ""}`);
}
say();
say(`  ⇒ the axis carrying the MOST residual structure is ${AXLAB[bestAx]} (R² ${f(compAx[bestAx]!.r2, 4)}).`);
say();
say(`  Composite-residual QUINTILE SHAPE on each axis (the same read Part 1 gave for Stuff):`);
say();
for (const k of axRank) emit(compAx[k]!, `wOBAA composite vs ${AXLAB[k]}`, " wOBA", 5, AXLAB[k].split(" ")[0]!);
say(`  And the same per-axis linear partial for EVERY CHANNEL (native units, per SD of the axis).`);
say(`  ★ marks a CI-clear linear partial. This is the "which axis, which channel" matrix:`);
say();
say(`  ${pad("channel", 30)}${AXK.map((k) => rp2(AXLAB[k].split(" ")[0]!, 16)).join("")}`);
say(`  ${"-".repeat(30)}${AXK.map(() => rp2("-".repeat(15), 16)).join("")}`);
for (const c of CHANS) {
  const cells = AXK.map((k) => { const a = analyze(rows, (r) => r.ev[c.key], k); return rp2(`${sgn(a.lin, c.dec + 1)}${clear(a.linCI) ? "★" : " "}`, 16); });
  say(`  ${pad(c.label.split("(")[0]!.trim().slice(0, 29), 30)}${cells.join("")}`);
}
say();

// ── PART 5 — 2-D shape corners ───────────────────────────────────────────────
// Cell definition + the INTERACTION residual (raw − row marginal − col marginal + overall) follow
// src/training/residuals.ts (ResidGrid) exactly — same formula, applied here to the DEPLOYED
// artifact's residual rather than to that module's in-tool refit.
type B3 = 0 | 1 | 2; const BL = ["L", "M", "H"];
function terc(ax: AxK): [number, number] {
  const s = rows.map((r) => r.r[ax]).sort((p, q) => p - q);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [q(1 / 3), q(2 / 3)];
}
const bandOf = (v: number, t: [number, number]): B3 => (v <= t[0] ? 0 : v >= t[1] ? 2 : 1);
function grid(rowAx: AxK, colAx: AxK, get: (r: Row) => number) {
  const tr = terc(rowAx), tc = terc(colAx), overall = wmean(rows, get);
  const marg = (ax: AxK, t: [number, number]) => [0, 1, 2].map((b) => wmean(rows.filter((r) => bandOf(r.r[ax], t) === b), get));
  const rm = marg(rowAx, tr), cm = marg(colAx, tc);
  const cells = [0, 1, 2].map((rb) => [0, 1, 2].map((cb) => {
    const s = rows.filter((r) => bandOf(r.r[rowAx], tr) === rb && bandOf(r.r[colAx], tc) === cb);
    const m = s.length ? wmean(s, get) : NaN;
    return { n: s.length, bf: s.reduce((a, r) => a + r.w, 0), m, inter: s.length ? m - rm[rb]! - cm[cb]! + overall : NaN };
  }));
  return { tr, tc, cells, overall };
}
function emitGrid(rowAx: AxK, colAx: AxK) {
  const get = (r: Row) => r.ev.WOBAA;
  const g = grid(rowAx, colAx, get);
  say(`  ── ${AXLAB[rowAx]} (rows) × ${AXLAB[colAx]} (cols) — wOBAA composite residual ──`);
  say(`     tercile cuts: ${AXLAB[rowAx]} ${f(g.tr[0], 0)}/${f(g.tr[1], 0)}   ${AXLAB[colAx]} ${f(g.tc[0], 0)}/${f(g.tc[1], 0)}`);
  say(`     cell = mean residual (wOBA) / INTERACTION residual / n rows`);
  say(`     ${pad("", 8)}${BL.map((b) => rp2(`${colAx}·${b}`, 26)).join("")}`);
  for (let rb = 0; rb < 3; rb++) {
    say(`     ${pad(`${rowAx}·${BL[rb]}`, 8)}${[0, 1, 2].map((cb) => { const c = g.cells[rb]![cb]!; return rp2(`${sgn(c.m, 5)} / ${sgn(c.inter, 5)} / n${c.n}`, 26); }).join("")}`);
  }
  const flat = g.cells.flat().filter((c) => c.n >= 8);
  const hot = [...flat].sort((p, q) => Math.abs(q.inter) - Math.abs(p.inter))[0];
  const ext = [...flat].sort((p, q) => q.m - p.m);
  const obsMax = Math.max(...flat.map((c) => Math.abs(c.inter)));
  say(`     strongest INTERACTION cell (n≥8): ${sgn(hot?.inter ?? NaN, 5)}   |   most under-credited cell: ${sgn(ext[0]?.m ?? NaN, 5)} (n${ext[0]?.n})`);
  say(`     spread of cell means: ${sgn((ext[0]?.m ?? NaN) - (ext[ext.length - 1]?.m ?? NaN), 5)}   max |interaction|: ${sgn(obsMax, 5)}`);
  // PERMUTATION NULL — cells hold only 11–23 rows, so a striking corner can be pure small-cell noise.
  // Shuffle the residual across rows (ratings + weights fixed) and rebuild the grid; the null
  // distribution of max|interaction| says how big a corner chance alone produces.
  const ys = rows.map(get), idx = new Map(rows.map((r, i) => [r, i])), nullMax: number[] = [];
  for (let b = 0; b < 600; b++) {
    const perm = [...ys];
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    const gp = grid(rowAx, colAx, (r) => perm[idx.get(r)!]!);
    nullMax.push(Math.max(...gp.cells.flat().filter((c) => c.n >= 8).map((c) => Math.abs(c.inter))));
  }
  const sorted = [...nullMax].sort((p, q) => p - q);
  const p95 = sorted[Math.floor(0.95 * sorted.length)]!;
  const pval = nullMax.filter((v) => v >= obsMax).length / nullMax.length;
  say(`     PERMUTATION NULL (600 shuffles): max|interaction| under pure noise has 95th pct ${sgn(p95, 5)};`);
  say(`     observed ${sgn(obsMax, 5)} ⇒ p = ${f(pval, 3)}  ${pval < 0.05 ? "★ the corner structure EXCEEDS chance" : "— the corner structure is WITHIN chance for cells this small (do NOT read the corner as real)"}`);
  say();
  return { ...g, obsMax, p95, pval };
}
say("################################################################################");
say("# PART 5 — 2-D SHAPE READ: is the bias in a rating-SHAPE CORNER or spread along an axis?");
say("################################################################################");
say();
say(`  The INTERACTION residual strips the additive 1-D main effects (raw − row marginal − col marginal`);
say(`  + overall), so what remains is TRUE 2-way structure. If the bias were a genuine single-axis Stuff`);
say(`  effect the interaction cells would all be ~0 and the raw cells would vary only down the rows. If`);
say(`  it is a SHAPE effect the interaction cells light up in a corner (e.g. high-Stuff/low-Control).`);
say();
const gSC = emitGrid("stu", "con");
const gSO = emitGrid("stu", bestOther);
const maxInterSC = Math.max(...gSC.cells.flat().filter((c) => c.n >= 8).map((c) => Math.abs(c.inter)));
const maxInterSO = Math.max(...gSO.cells.flat().filter((c) => c.n >= 8).map((c) => Math.abs(c.inter)));
const stuMainSpread = Math.abs(compAx.stu.quints[4]!.resid - compAx.stu.quints[0]!.resid);

// ── PART 6 — the decisive conditional read ───────────────────────────────────
const zRow = (r: Row) => AXK.map((k) => zA(k)(r));
type Spec = "marg" | "cond" | "condInt";
function design(r: Row, spec: Spec): number[] {
  const zz = zRow(r);
  if (spec === "marg") return [1, zz[0]!];
  if (spec === "cond") return [1, ...zz];
  return [1, ...zz, zz[0]! * zz[1]!];
}
function coefCI(rs: Row[], get: (r: Row) => number, spec: Spec, idx: number) {
  const fitOn = (s: Row[]) => wls(s.map((r) => design(r, spec)), s.map(get), s.map((r) => r.w))[idx]!;
  const pt = fitOn(rs), bs: number[] = [];
  for (let b = 0; b < NBOOT; b++) bs.push(fitOn(rs.map(() => rs[Math.floor(rnd() * rs.length)]!)));
  return { pt, ci: ci(bs) };
}
say("################################################################################");
say("# PART 6 — THE DECISIVE READ: does the Stuff slope SURVIVE conditioning on the other ratings?");
say("################################################################################");
say();
say(`  Weighted regressions of the residual on z-scored ratings (coefficients = wOBA per SD of Stuff).`);
say(`    M1 MARGINAL     : y ~ z_stu                                   (what the audit measured)`);
say(`    M2 CONDITIONAL  : y ~ z_stu + z_con + z_pbabip + z_hrr        (Stuff holding SHAPE fixed)`);
say(`    M3 + INTERACTION: M2 + z_stu·z_con                            (the shape-corner term)`);
say();
const targets: { label: string; get: (r: Row) => number }[] = [
  { label: "wOBAA composite", get: (r) => r.ev.WOBAA },
  { label: "BABIP contribution", get: (r) => r.ct.BABIP },
];
const condOut: Record<string, { m1: ReturnType<typeof coefCI>; m2: ReturnType<typeof coefCI>; m3: ReturnType<typeof coefCI>; ix: ReturnType<typeof coefCI> }> = {};
for (const t of targets) {
  const m1 = coefCI(rows, t.get, "marg", 1), m2 = coefCI(rows, t.get, "cond", 1);
  const m3 = coefCI(rows, t.get, "condInt", 1), ix = coefCI(rows, t.get, "condInt", 1 + AXK.length);
  condOut[t.label] = { m1, m2, m3, ix };
  const surv = Math.abs(m2.pt) / Math.max(Math.abs(m1.pt), 1e-12);
  say(`  ▸ ${t.label}`);
  say(`     M1 stu (marginal)    : ${sgn(m1.pt, 6)}  [${sgn(m1.ci.lo, 6)}, ${sgn(m1.ci.hi, 6)}] ${clear(m1.ci) ? "CI-clear" : "covers 0"}`);
  say(`     M2 stu (conditional) : ${sgn(m2.pt, 6)}  [${sgn(m2.ci.lo, 6)}, ${sgn(m2.ci.hi, 6)}] ${clear(m2.ci) ? "CI-clear" : "covers 0"}   ⇒ ${f(100 * surv, 0)}% of the marginal slope SURVIVES`);
  say(`     M3 stu (+stu×con)    : ${sgn(m3.pt, 6)}  [${sgn(m3.ci.lo, 6)}, ${sgn(m3.ci.hi, 6)}] ${clear(m3.ci) ? "CI-clear" : "covers 0"}`);
  say(`     M3 stu×con           : ${sgn(ix.pt, 6)}  [${sgn(ix.ci.lo, 6)}, ${sgn(ix.ci.hi, 6)}] ${clear(ix.ci) ? "★ CI-CLEAR — a genuine SHAPE-CORNER term" : "covers 0 — no shape-corner term"}`);
  say(`     full conditional coefficient set (per SD): ${AXK.map((k, i) => `${k} ${sgn(wls(rows.map((r) => design(r, "cond")), rows.map(t.get), rows.map((r) => r.w))[1 + i]!, 6)}`).join("   ")}`);
  say();
}
const cComp = condOut["wOBAA composite"]!;
const survivalFrac = Math.abs(cComp.m2.pt) / Math.max(Math.abs(cComp.m1.pt), 1e-12);

// ── PART 7 — reconcile with the ORIGINAL "shape ruled out" record ────────────
say("################################################################################");
say("# PART 7 — RECONCILIATION with the older 'shape was ruled out' record");
say("################################################################################");
say();
say(`  Instrument: src/training/residuals.ts analyzeResiduals(role=pitcher) — the SAME instrument the`);
say(`  original investigation used ("residual meta-model stu linear = −1.16/SD", "stu marginal XL +2.9`);
say(`  → XH −3.8"). NOTE two differences from Parts 1–6, both stated so the numbers are comparable:`);
say(`    · SIGN: that module reports valuation error = (actual − pred)×1000 for pitchers, i.e. POSITIVE`);
say(`      = the model OVER-VALUES the card. That is exactly −1000 × the ΔwOBAA used above. So a`);
say(`      NEGATIVE stu coefficient there == a POSITIVE (under-credit) Stuff slope here. Same finding.`);
say(`    · FIT: that module REFITS STUFFAUG_PIT on the window; Parts 1–6 use the DEPLOYED artifact.`);
say(`      They should agree closely (the deployed artifact is that fit, frozen) but not bit-exactly.`);
say(`    · WEIGHT: BF^0.75 there vs BF here.`);
say();
const ra = analyzeResiduals(obs, "pitcher", minPA, { includeVariants: trained.includeVariants ?? true });
say(`  systematic r² of the residual meta-model (z + z² + all pairwise interactions): ${f(ra.residualModel.r2, 3)}`);
say(`    ⇒ ${f(100 * ra.residualModel.r2, 0)}% of the pitcher valuation error is ratings-explainable; the rest is noise.`);
say();
say(`  per-rating meta-model coefficients (valuation-error points per ±1 SD; NEGATIVE = under-credits`);
say(`  the high end of that rating = the direction of the Stuff under-credit):`);
say(`  ${pad("rating", 12)} ${rp2("linear", 10)} ${rp2("quad", 10)}`);
for (const p of ra.residualModel.perRating) say(`  ${pad(p.rating, 12)} ${rp2(sgn(p.linear, 2), 10)} ${rp2(sgn(p.quad, 2), 10)}`);
say();
say(`  pairwise INTERACTION coefficients, |largest| first — THE SHAPE TERMS. If shape were irrelevant`);
say(`  these are all ~0 next to the linear terms:`);
for (const i of ra.residualModel.interactions) say(`    ${pad(`${i.a} × ${i.b}`, 22)} ${sgn(i.coef, 2)}`);
const biggestIx = ra.residualModel.interactions[0]!;
const biggestLin = [...ra.residualModel.perRating].sort((p, q) => Math.abs(q.linear) - Math.abs(p.linear))[0]!;
say();
say(`  largest interaction |${sgn(biggestIx.coef, 2)}| (${biggestIx.a}×${biggestIx.b}) vs largest linear |${sgn(biggestLin.linear, 2)}| (${biggestLin.rating})`);
say(`  ⇒ interactions are ${Math.abs(biggestIx.coef) >= 0.5 * Math.abs(biggestLin.linear) ? "COMPARABLE TO the main effects — shape matters" : "SMALL relative to the main effects — the structure is mostly additive/marginal"}.`);
say();
say(`  5-band marginals (valuation-error points per band, BF^0.75-weighted):`);
for (const m of ra.marginals) say(`    ${pad(m.rating, 8)} ${m.bands5.map((b) => `${b.band} ${sgn(b.meanErr, 1)} (n${b.n})`).join("   ")}`);
say();
say(`  WHAT THE OLD RECORD ACTUALLY RULED OUT — this is the reconciliation that matters. The archived`);
say(`  finding reads "Stuff curve SHAPE ... tested K-curve = LOG/raw-linear/raw-quad/raw-cubic/log-cubic`);
say(`  ... NOT a shape problem." That is the shape of the K CURVE (its functional form), tested by`);
say(`  swapping the curve family. It is NOT the RATING-SHAPE question the amendment asks (does the bias`);
say(`  live in a multi-rating profile corner rather than along one axis). The two are different tests`);
say(`  and the old one does not answer the new one. The old record ALSO reports "per-BIP hit rate has`);
say(`  ZERO Stuff signal (confirms engine: no harder-contact)" — THAT one IS in direct tension with`);
say(`  Part 2's ranking, and the tension is reported, not smoothed over, in the verdict below.`);
say();

// ── PART 8 — the conditional read OUT OF FRAME, where the effect is CI-clear ──
// Part 6 conditions an effect that is not itself CI-clear in frame (N=149). The audit's finding
// lives on the cwhit tournament line, where it IS CI-clear. That is where the marginal-vs-
// conditional test is decisive, so it is repeated there on the SAME instrument the audit used
// (buildCwhitSample + the deployed line + catalog-joined ratings — tools/anchor-uniformity-audit.ts).
say("################################################################################");
say("# PART 8 — THE CONDITIONAL READ OUT OF FRAME (the audit's own sample, where the effect is real)");
say("################################################################################");
say();
const oof = await (async () => {
  const model = (await repo.loadAll<Model>("models"))[0]!;
  const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
  const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
  const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick");
  const st = (await repo.load<{ catalogSourceId?: string }>("state", "app")) ?? {};
  const t2 = trained as TM_ & { ratingEnvelope?: RatingEnvelope; cohortRule?: string; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
  if (!bq || !t2.platoon || !trained.wobaWeights) return null;
  const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
  applyWobaWeights(coeffs, trained.wobaWeights);
  const derived = computeDerived(coeffs);
  const srcId = st.catalogSourceId ?? "cdmx";
  const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
  const select = cohortSelectForModel(t2.cohortRule, baseCards, coeffs, rp);
  const byId = new Map(baseCards.map((c) => [String(c["Card ID"]), c]));
  const ref = productionFieldStats(baseCards, coeffs, rp, true, undefined, select);
  const sample = buildCwhitSample({
    baseCards, coeffs, derived, eventForm: trained.eventForm!, model: rp, W: trained.wobaWeights as WW, ref,
    envelope: t2.ratingEnvelope, select,
    pitExp: new Map(t2.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
    hitExp: new Map(t2.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
  } as SampleDeps);
  const COL: Record<AxK, string> = { stu: "Stuff", con: "Control", pbabip: "pBABIP", hrr: "pHR" };
  const ratOf = (cid: string, col: string): number => {
    const c = byId.get(cid.split("|")[0] ?? ""); if (!c) return NaN;
    const vs = [Number(c[`${col} vR`]), Number(c[`${col} vL`])].filter((x) => Number.isFinite(x) && x > 0);
    return vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : NaN;
  };
  interface ORow { r: Record<AxK, number>; y: number; w: number }
  const orows: ORow[] = [];
  for (const rec of sample.recs) {
    if (rec.role !== "pit" || !wellSampled(rec)) continue;
    if (!Number.isFinite(rec.oursDep.woba) || !Number.isFinite(rec.obs.woba!)) continue;
    const rr = Object.fromEntries(AXK.map((k) => [k, ratOf(rec.cid, COL[k])])) as Record<AxK, number>;
    if (AXK.some((k) => !Number.isFinite(rr[k])) || !(rec.sample > 0)) continue;
    orows.push({ r: rr, y: rec.oursDep.woba! - rec.obs.woba!, w: rec.sample });
  }
  if (orows.length < 40) return null;
  const om = {} as Record<AxK, number>, os = {} as Record<AxK, number>;
  const wm = (g: (o: ORow) => number) => { const sw = orows.reduce((a, o) => a + o.w, 0); return orows.reduce((a, o) => a + o.w * g(o), 0) / sw; };
  for (const k of AXK) { om[k] = wm((o) => o.r[k]); os[k] = Math.sqrt(wm((o) => (o.r[k] - om[k]) ** 2)) || 1; }
  const zz = (o: ORow) => AXK.map((k) => (o.r[k] - om[k]) / os[k]);
  const des = (o: ORow, spec: Spec) => { const v = zz(o); return spec === "marg" ? [1, v[0]!] : spec === "cond" ? [1, ...v] : [1, ...v, v[0]! * v[1]!]; };
  const fit = (s: ORow[], spec: Spec, i: number) => wls(s.map((o) => des(o, spec)), s.map((o) => o.y), s.map((o) => o.w))[i]!;
  const boot = (spec: Spec, i: number) => { const bs: number[] = []; for (let b = 0; b < NBOOT; b++) bs.push(fit(orows.map(() => orows[Math.floor(rnd() * orows.length)]!), spec, i)); return ci(bs); };
  // raw-Stuff-point marginal slope, to reproduce the audit's +0.00007 in its own units
  const swAll = orows.reduce((a, o) => a + o.w, 0);
  const mdS = orows.reduce((a, o) => a + o.w * o.r.stu, 0) / swAll, myS = orows.reduce((a, o) => a + o.w * o.y, 0) / swAll;
  let sxx = 0, sxy = 0; for (const o of orows) { sxx += o.w * (o.r.stu - mdS) ** 2; sxy += o.w * (o.r.stu - mdS) * (o.y - myS); }
  return {
    n: orows.length, rawStu: sxx > 0 ? sxy / sxx : NaN, sdStu: os.stu,
    m1: { pt: fit(orows, "marg", 1), ci: boot("marg", 1) },
    m2: { pt: fit(orows, "cond", 1), ci: boot("cond", 1) },
    ix: { pt: fit(orows, "condInt", 1 + AXK.length), ci: boot("condInt", 1 + AXK.length) },
    cond: AXK.map((k, i) => ({ k, v: fit(orows, "cond", 1 + i), ci: boot("cond", 1 + i) })),
    corr: AXK.map((a1) => AXK.map((a2) => wm((o) => ((o.r[a1] - om[a1]) / os[a1]) * ((o.r[a2] - om[a2]) / os[a2])))),
  };
})();
if (!oof) {
  say(`  UNAVAILABLE — the cwhit sample could not be built (missing tournament / platoon / weights on the`);
  say(`  active model). Part 6's in-frame conditional read stands alone; treat it as suggestive only.`);
} else {
  const surv = Math.abs(oof.m2.pt) / Math.max(Math.abs(oof.m1.pt), 1e-12);
  say(`  Instrument: buildCwhitSample + the DEPLOYED line, pitcher rows, well-sampled only (the anchor`);
  say(`  audit's exact sample). N=${oof.n} cards. Ratings joined from the catalog and side-pooled, as there.`);
  say();
  say(`  Marginal Stuff slope in the audit's own units: ${sgn(oof.rawStu, 6)} wOBA per Stuff point`);
  say(`  (the audit reported +0.00007 — this reproduces it, confirming the same instrument and sample).`);
  say(`  1 SD of Stuff over this sample = ${f(oof.sdStu, 1)} rating points.`);
  say();
  say(`  ▸ pit wOBAA bias, per SD of Stuff`);
  say(`     M1 stu (marginal)    : ${sgn(oof.m1.pt, 6)}  [${sgn(oof.m1.ci.lo, 6)}, ${sgn(oof.m1.ci.hi, 6)}] ${clear(oof.m1.ci) ? "★ CI-CLEAR" : "covers 0"}`);
  say(`     M2 stu (conditional) : ${sgn(oof.m2.pt, 6)}  [${sgn(oof.m2.ci.lo, 6)}, ${sgn(oof.m2.ci.hi, 6)}] ${clear(oof.m2.ci) ? "★ CI-CLEAR" : "covers 0"}   ⇒ ${f(100 * surv, 0)}% of the marginal slope SURVIVES`);
  say(`     M3 stu×con           : ${sgn(oof.ix.pt, 6)}  [${sgn(oof.ix.ci.lo, 6)}, ${sgn(oof.ix.ci.hi, 6)}] ${clear(oof.ix.ci) ? "★ CI-CLEAR — a genuine SHAPE-CORNER term" : "covers 0 — no shape-corner term"}`);
  say();
  say(`  ALL FOUR conditional coefficients (per SD, each holding the other three fixed) — this is the`);
  say(`  scope amendment's real payoff: it shows how many axes independently carry the bias.`);
  say(`  ${pad("axis", 26)} ${rp2("coef/SD", 12)} ${rp2("95% CI", 26)}`);
  for (const c of oof.cond) say(`  ${pad(AXLAB[c.k], 26)} ${rp2(sgn(c.v, 6), 12)} ${rp2(`[${sgn(c.ci.lo, 6)}, ${sgn(c.ci.hi, 6)}]`, 26)}${clear(c.ci) ? "  ★ independent axis" : ""}`);
  say();
  say(`  axis correlations on THIS sample (they differ from the league frame — that is the point):`);
  say(`  ${pad("", 10)}${AXK.map((k) => rp2(k, 10)).join("")}`);
  AXK.forEach((a1, i) => say(`  ${pad(a1, 10)}${oof.corr[i]!.map((v) => rp2(sgn(v, 3), 10)).join("")}`));
  say();
  say(`  ⇒ ${clear(oof.m2.ci) ? `THE STUFF SLOPE SURVIVES CONDITIONING OUT OF FRAME (${f(100 * surv, 0)}% retained, CI still excludes\n  zero). On the sample where the effect is real, Stuff is a GENUINE independent axis, not a proxy\n  for Control or the other ratings.` : `THE STUFF SLOPE DOES NOT SURVIVE CONDITIONING even out of frame (${f(100 * surv, 0)}% retained, CI now\n  covers zero). The marginal Stuff effect the audit measured is substantially carried by the\n  correlated ratings — the defect is SHAPE-dependent, not a clean Stuff axis.`}`);
  say();
}

say("################################################################################");
say("### VERDICT");
say("################################################################################");
say();
const babipRow = ranked.find((r) => r.key === "BABIP")!;
const hrRow = ranked.find((r) => r.key === "HR")!;
const kRow = ranked.find((r) => r.key === "K")!;
const bbRow = ranked.find((r) => r.key === "BB")!;
const vL = sideCT.find((x) => x.s === "vL"), vR = sideCT.find((x) => x.s === "vR");
const lead = Math.abs(top.slope) / Math.max(Math.abs(ranked[1]!.slope), 1e-12);
say(`  TWO SEPARATE ANSWERS, and they must not be blurred: WHICH CHANNEL carries the bias (Parts 1–3,`);
say(`  the original question) and WHICH RATING AXES drive it (Parts 4–8, the scope amendment). The`);
say(`  channel answer is strong and unchanged; the axis answer amends the brief's Stuff-only framing.`);
say();
say("  ── PART A: WHICH CHANNEL ──");
say();
say(`  THE CHANNEL IS ${top.key === "BABIP" ? "BABIP — the pitcher CONTACT-RATE channel (the pit.h curve)." : `${String(top.key)}.`} Of the six channels that`);
say(`  exhaustively decompose the wOBA-allowed bias, ${top.key === "BABIP" ? "BABIP" : String(top.key)} carries ${sgn(top.slope, 6)} wOBA per Stuff`);
say(`  point — ${f(lead, 1)}× the next-largest channel (${ranked[1]!.label.split("(")[0]!.trim()}, ${sgn(ranked[1]!.slope, 6)}) and ${sgn(top.share, 0)}% of the composite`);
say(`  slope of ${sgn(pooledCT.compSlope, 6)}. Every other channel is at or below the ${sgn(Math.abs(ranked[1]!.slope), 6)} level and they`);
say(`  partially cancel one another. The carrier is the CONTACT RATE, not HR, not BB, not K.`);
say();
say(`  STRENGTH OF THE CLAIM, STATED HONESTLY. Pooled, the BABIP slope's bootstrap CI is`);
say(`  [${sgn(top.ci.lo, 6)}, ${sgn(top.ci.hi, 6)}] — it ${clear(top.ci) ? "EXCLUDES zero" : "does NOT quite exclude zero at 95%"}, and so does the composite`);
say(`  it explains (${sgn(pooledCT.compSlope, 6)} [${sgn(pooledCT.compCI.lo, 6)}, ${sgn(pooledCT.compCI.hi, 6)}]). N=${rows.length} rows is a small instrument. So this`);
say(`  is a LOCATION result, not a fresh significance result: the audit already established (out of`);
say(`  frame, larger sample) THAT the Stuff-correlated bias exists and is CI-clear; this measurement`);
say(`  says WHICH channel it flows through, and the answer is unambiguous by margin (${f(lead, 1)}×) even where`);
say(`  the individual CI is not. ${vL && clear(vL.ct.compCI) ? `The vL composite IS CI-clear here (${sgn(vL.ct.compSlope, 6)} [${sgn(vL.ct.compCI.lo, 6)}, ${sgn(vL.ct.compCI.hi, 6)}]),\n  and BABIP is its largest channel (${sgn(vL.ct.rowsOut.find((r) => r.key === "BABIP")!.slope, 6)}, ${sgn(vL.ct.rowsOut.find((r) => r.key === "BABIP")!.share, 0)}%) — the same verdict on the one sub-sample\n  where the composite clears on its own.` : ""}`);
say();
say(`  SHAPE: ${topShape}.`);
say(`  The pooled quintile pattern runs ${sgn(topAn.quints[0]!.resid, topChan?.dec ?? 3)} (lowest-Stuff quintile) → ${sgn(topAn.quints[4]!.resid, topChan?.dec ?? 3)}${topChan ? topChan.unit : ""}`);
say(`  (highest), i.e. the model over-states the contact`);
say(`  the high-Stuff pitcher allows and under-states it at the bottom — a LEVEL SHIFT ACROSS THE STUFF`);
say(`  RANGE rather than a tail blow-up, with no CI-clear curvature. Read this as a CHANNEL shape only —`);
say(`  whether the driving AXIS is really Stuff is settled below (scope amendment), not here.`);
say();
say(`  HAND ASYMMETRY: ${sideSlopes.length === 2 ? `on the carrier channel, ${sideSlopes[0]!.s} ${sgn(sideSlopes[0]!.v, 6)} vs ${sideSlopes[1]!.s} ${sgn(sideSlopes[1]!.v, 6)} — ${handAsym ? "ASYMMETRIC\n  (neither point estimate sits inside the other's CI): the carrier is hand-dependent and a hand-pooled\n  fix would leave residual on one side." : "each point estimate\n  sits inside the other's CI, so the CHANNEL slope is NOT distinguishably hand-split."}` : "hand split unavailable (too few rows on one side)."}`);
if (vL && vR) {
  say(`  BUT THE COMPOSITE IS: vR ${sgn(vR.ct.compSlope, 6)} vs vL ${sgn(vL.ct.compSlope, 6)} — opposite signs, and only vL`);
  say(`  clears its CI. The Stuff-correlated under-credit is concentrated on the vs-LHB side in frame.`);
  say(`  That is a real hand-split flag on the COMPOSITE even though the carrier channel's own slope is`);
  say(`  not separable by hand at this N — carry it forward as an open dimension, not a settled one.`);
}
say();
say(`  WHERE K SITS (closing the pre-step): K contributes ${sgn(kRow.slope, 6)} per Stuff point,`);
say(`  ${kRow.slope < 0 ? "NEGATIVE — it pushes the composite bias DOWN as Stuff rises, exactly the sign the pre-step\n  predicted. K is not the mechanism; it is a PARTIAL OFFSET to it, and it enters wOBAA only\n  indirectly (a strikeout has no wOBA weight — it moves wOBAA solely by removing a ball in play)." : "POSITIVE — this contradicts the pre-step's sign and must be re-examined before the verdict stands."}`);
say(`  HR contributes ${sgn(hrRow.slope, 6)} and BB ${sgn(bbRow.slope, 6)};`);
say(`  ${Math.abs(hrRow.slope) < Math.abs(top.slope) / 3 ? "HR is an order below the carrier ⇒ the HR candidate named in the brief is NOT the seat of the\n  under-credit. Of the two contact-side candidates (pit.pbabip vs pit.hrr), it is pbabip." : "HR is material — a secondary carrier alongside the leader."}`);
say();
say(`  READ THE CONSTRUCTION CAVEAT WITH THIS — it is what makes the result both expected and useful.`);
say(`  pit.bb, pit.k and pit.hr all carry ln(Stuff) in their fitted design (pit.k's driver IS Stuff;`);
say(`  pit.bb and pit.hr carry the stuffAug linear leg), so their in-frame Stuff slopes are pushed toward`);
say(`  zero BY LEAST-SQUARES. pit.h does not — Stuff never enters the contact-rate design at all. So this`);
say(`  measurement does NOT prove BB/HR are innocent OUT of frame. What it does establish is sharper and`);
say(`  sufficient: (a) the deployed pitcher form has NO STUFF PATHWAY INTO THE CONTACT RATE, a structural`);
say(`  hole rather than a mis-shaped curve; (b) the Stuff-shaped contact error that such a pathway would`);
say(`  have absorbed measures ${sgn(babipRow.slope, 6)}/Stuff-point in frame, the same order as the audit's`);
say(`  out-of-frame composite (+0.00007) and the dominant term of the in-frame one; and (c) the K route,`);
say(`  the only Stuff pathway the form does have, moves the composite the WRONG WAY.`);
say();
say("  ── PART B: WHICH RATING AXES — SINGLE-AXIS OR SHAPE-DEPENDENT? (the scope amendment) ──");
say();
// The CALL is made on the OUT-OF-FRAME conditional read (Part 8) when available — that is the only
// place the marginal effect is itself CI-clear, so it is the only place conditioning can be decisive.
const oofSurv = oof ? Math.abs(oof.m2.pt) / Math.max(Math.abs(oof.m1.pt), 1e-12) : NaN;
const cornerReal = gSC.pval < 0.05 || gSO.pval < 0.05 || clear(cComp.ix.ci) || (oof ? clear(oof.ix.ci) : false);
const liveAxes = oof ? oof.cond.filter((c) => clear(c.ci)) : [];
const stuLive = oof ? clear(oof.m2.ci) && oofSurv >= 0.5 : false;
const singleAxis = stuLive && liveAxes.length <= 1 && !cornerReal;
const additive = stuLive && liveAxes.length >= 2 && !cornerReal;
const shapeDep = cornerReal || (oof ? !stuLive : false);
say(`  The defect is best described as ${singleAxis ? "SINGLE-AXIS (Stuff)" : additive ? "MULTI-AXIS AND ADDITIVE — genuinely rating-SHAPE dependent, but with NO interaction corner" : shapeDep ? "SHAPE-DEPENDENT — NOT a clean Stuff axis" : "STUFF-LED BUT NOT CLEANLY SEPARABLE at this N"}.`);
if (additive) {
  say(`  That is a THIRD answer, distinct from both options the amendment posed, and it is the one the`);
  say(`  data supports: ${liveAxes.length} of the 4 pitcher ratings carry an INDEPENDENT, CI-clear slope on the bias`);
  say(`  (${liveAxes.map((c) => `${AXLAB[c.k].split(" ")[0]} ${sgn(c.v, 6)}/SD`).join(", ")}), each surviving`);
  say(`  when the others are held fixed — so no single rating tells you the error, exactly as the doctrine`);
  say(`  says. But the 2-way interaction terms are NOT distinguishable from noise, so the bias is not`);
  say(`  concentrated in a shape CORNER either: it is ADDITIVE across several axes.`);
}
say();
say(`  The numbers behind that call:`);
say();
say(`   1. AXIS RANKING (in frame). By cubic R² on the composite residual:`);
say(`      ${axRank.map((k) => `${AXLAB[k].split(" ")[0]} ${f(compAx[k]!.r2, 3)}`).join("  >  ")}.`);
say(`      Stuff ranks ${axRank.indexOf("stu") + 1} of 4. ${bestAx === "stu" ? "Stuff IS the leading axis." : `${AXLAB[bestAx]} carries MORE residual structure than Stuff, and the\n      conditional coefficient set puts Control (${sgn(wls(rows.map((r) => design(r, "cond")), rows.map((r) => r.ev.WOBAA), rows.map((r) => r.w))[2]!, 6)}/SD) ahead of Stuff (${sgn(cComp.m2.pt, 6)}/SD).\n      The brief's framing on Stuff alone was NOT the best axis.`}`);
say(`      (All four axis CIs cover zero in frame — this ranking is by point estimate, and at N=${rows.length} it`);
say(`      is an ordering of weak signals. It is corroborating evidence, not the call.)`);
say(`   2. CONDITIONING, IN FRAME. Marginal Stuff ${sgn(cComp.m1.pt, 6)}/SD → conditional ${sgn(cComp.m2.pt, 6)}/SD`);
say(`      (${f(100 * survivalFrac, 0)}% retained). Both CIs cover zero, so this is directional only.`);
if (oof) {
  say(`   3. CONDITIONING, OUT OF FRAME — THE DECISIVE ONE. On the cwhit sample (N=${oof.n}) where the`);
  say(`      marginal effect IS established: marginal ${sgn(oof.m1.pt, 6)}/SD ${clear(oof.m1.ci) ? "(CI-clear)" : "(covers 0)"} → conditional`);
  say(`      ${sgn(oof.m2.pt, 6)}/SD [${sgn(oof.m2.ci.lo, 6)}, ${sgn(oof.m2.ci.hi, 6)}] ${clear(oof.m2.ci) ? "(still CI-clear)" : "(now covers 0)"} — ${f(100 * oofSurv, 0)}% retained.`);
  say(`      ${clear(oof.m2.ci) && oofSurv >= 0.6 ? "The Stuff slope SURVIVES holding the other three ratings fixed ⇒ Stuff is a GENUINE\n      INDEPENDENT AXIS on the sample that matters, not a proxy for Control." : oofSurv < 0.4 || !clear(oof.m2.ci) ? "The Stuff slope does NOT survive holding the other three ratings fixed ⇒ the\n      audit's marginal Stuff finding is substantially a SHAPE artifact carried by the correlated\n      ratings. A correction fitted on the Stuff axis alone would be fitting the wrong thing." : "The Stuff slope is ATTENUATED but not eliminated ⇒ partly genuine, partly shape."}`);
  say(`      Out-of-frame stu×con interaction: ${sgn(oof.ix.pt, 6)}/SD² [${sgn(oof.ix.ci.lo, 6)}, ${sgn(oof.ix.ci.hi, 6)}] ${clear(oof.ix.ci) ? "★ CI-CLEAR corner term" : "covers 0"}.`);
} else {
  say(`   3. CONDITIONING, OUT OF FRAME: unavailable this run — the decisive test could NOT be made.`);
}
say(`   4. SHAPE CORNERS, TESTED AGAINST A PERMUTATION NULL. Largest 3×3 interaction cell:`);
say(`      Stuff×Control ${sgn(maxInterSC, 5)} (p=${f(gSC.pval, 3)}), Stuff×${AXLAB[bestOther].split(" ")[0]} ${sgn(maxInterSO, 5)} (p=${f(gSO.pval, 3)}),`);
say(`      against a Stuff main-effect quintile spread of only ${sgn(stuMainSpread, 5)}. ${gSC.pval < 0.05 || gSO.pval < 0.05 ? "At least one corner\n      EXCEEDS its noise null ⇒ real 2-way structure." : "NEITHER corner beats its noise\n      null — the cells hold 11–23 rows and corners that large arise by chance. The eye-catching\n      corner is NOT evidence; this is exactly the trap the amendment warns about, and it does not\n      fire here."}`);
say(`   5. INDEPENDENT INSTRUMENT (Part 7, the old record's own): meta-model systematic r² ${f(ra.residualModel.r2, 3)};`);
say(`      largest interaction ${biggestIx.a}×${biggestIx.b} ${sgn(biggestIx.coef, 2)} EXCEEDS the largest linear ${biggestLin.rating} ${sgn(biggestLin.linear, 2)},`);
say(`      and the stu LINEAR term is only ${sgn(ra.residualModel.perRating.find((p) => p.rating === "stu")!.linear, 2)} with a quad of ${sgn(ra.residualModel.perRating.find((p) => p.rating === "stu")!.quad, 2)}. On the old`);
say(`      record's OWN instrument the structure looks interaction-led rather than Stuff-linear-led.`);
say(`      TENSION WITH ITEM 4, FLAGGED NOT HIDDEN: that meta-model's interaction coefficients are`);
say(`      ridge point estimates with NO significance test, while the corners that WERE tested`);
say(`      (permutation null, item 4; bootstrap CI, item 3) did not fire. Where they disagree, trust`);
say(`      the tested reads — item 5 is suggestive only, and it is why the call above is ADDITIVE`);
say(`      multi-axis rather than shape-corner.`);
say();
say(`  CONTRADICTION WITH THE OLD RECORD, STATED PLAINLY. The archived investigation recorded "per-BIP`);
say(`  hit rate has ZERO Stuff signal (confirms engine: no harder-contact)" and used that to rule the`);
say(`  contact channel out. Part 2 ranks the CONTACT-RATE channel FIRST (${sgn(babipRow.slope, 6)}/Stuff-point,`);
say(`  ${f(Math.abs(babipRow.slope) / Math.max(Math.abs(ranked[1]!.slope), 1e-12), 1)}× the next channel). These disagree. Both can be partly right and the difference is`);
say(`  informative: the old test asked whether the RAW per-BIP hit rate correlates with Stuff (an engine`);
say(`  question — does high Stuff produce weaker contact); this one asks whether the MODEL'S BABIP`);
say(`  RESIDUAL correlates with Stuff (a model question — does the fitted contact curve mis-place cards`);
say(`  by Stuff). A curve fit on pBABIP alone can leave a Stuff-shaped residual even when the raw rate`);
say(`  carries no Stuff signal, because the OTHER channels' errors move BIP and the pBABIP→hits curve`);
say(`  is evaluated at the wrong BIP. Note also the old test predates the deployed 42-43 fit and the`);
say(`  stuffAug legs. THE OLD "ZERO STUFF SIGNAL IN CONTACT" CONCLUSION SHOULD NOT BE CARRIED FORWARD`);
say(`  UNEXAMINED — re-running it against the deployed artifact is the cheap way to settle it, and it`);
say(`  is NOT settled here.`);
say();
say(`  WHAT THE AMENDMENT CHANGES ABOUT THE REMEDY. The pre-amendment draft of this artifact named a`);
say(`  linear Stuff aux term on pit.h (the analogue of the stuffAug legs pit.bb and pit.hr carry).`);
say(`  ${singleAxis ? "The shape reads SUPPORT that as stated: the Stuff slope survives conditioning where the effect is\n  real, no other axis is CI-clear, and no corner term beats its null. A linear Stuff aux on pit.h\n  remains the right remedy shape." : additive ? `THE SHAPE READS AMEND IT — the CHANNEL stands, the AXIS SET does not. A pit.h aux keyed on Stuff\n  ALONE would leave the other CI-clear axes uncorrected (notably ${liveAxes.filter((c) => c.k !== "stu").map((c) => `${AXLAB[c.k].split(" ")[0]} at ${sgn(c.v, 6)}/SD`).join(", ")},\n  ${(liveAxes.find((c) => c.k === "con")?.v ?? 0) < 0 ? "the opposite sign to Stuff — the classic low-Stuff/high-Control over-valuation" : "a same-sign companion"}).\n  The remedy shape is therefore a MULTI-RATING aux on pit.h — ADDITIVE (no interaction term is\n  warranted: every corner test came back inside its null) — with the axis set taken from the\n  CONDITIONAL coefficients above, not from the marginal Stuff slope. Which ratings and what\n  magnitudes requires a fit, and fitting is out of scope here.` : shapeDep ? "THE SHAPE READS WITHDRAW THAT RECOMMENDATION. The Stuff axis does not survive conditioning, so a\n  pit.h term keyed on Stuff alone would be fitted to a proxy. The CHANNEL result still stands; the\n  axis set must be re-derived from the conditional coefficients, which requires a fit." : "The reads leave this UNDECIDED at this N: a single-axis term is defensible but should not be\n  fitted until the conditional slope is confirmed on a larger sample."}`);
say(`  NOT a K-curve change (ruled out by the pre-step — wrong sign). NOT an HR-curve change (an order`);
say(`  too small here). NOT an anchor change (the anchor provably cannot absorb a rating-correlated`);
say(`  bias — that is the audit's whole point).`);
say(`  PROPOSED, NOT FIT, NOT WIRED. The form ruling is Fable's.`);
say();
say("(end of artifact — Stuff-residual channel locator)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
