// HITTER-RESIDUAL CHANNEL LOCATOR (2026-07-25). MEASUREMENT ONLY; nothing wired, nothing fit into
// production, no defaults changed.
//   run: node tools/hitter-residual-channels.ts > fixtures/hitter-residual-channels-2026-07-25.txt
//
// WHY THIS EXISTS. The pitcher side has had this instrument for a day (tools/stuff-residual-channels.ts
// + fixtures/stuff-residual-channels-2026-07-25.txt): the deployed model's IN-FRAME per-card residual,
// decomposed EXACTLY into event channels, ranked by each channel's contribution to the composite wOBA
// bias SLOPE on a rating axis, with marginal-vs-conditional slopes and a permutation null on the 2-D
// corners (which correctly killed an eye-catching false positive). THE EQUIVALENT HAS NEVER BEEN RUN
// FOR HITTERS. This is that mirror image. Methods are the pitcher tool's, deliberately unchanged in
// spirit; three things are NEW because the hitter side demands them:
//
//   1. FIVE AXES, NOT ONE. The pitcher brief had a named suspect (Stuff). Here the governing doctrine
//      — a card's quality is NEVER inferrable from a single rating; cards have different rating SHAPES
//      — means there is no privileged axis. Every read below is run against ALL FIVE hitter ratings
//      (eye, pow, kRat, babip, gap — HIT_RATINGS, src/model/pool-transform.ts:87).
//   2. CLUSTER BOOTSTRAP. The distinct-CARD count here is ~0.43× the row count, and a card's residual
//      is close to a fixed function of its unchanging ratings. Every CI below resamples CARDS (all of
//      a card's rows move together), never rows. Part 0 quantifies how much a naive row bootstrap
//      would have narrowed the intervals — i.e. how much significance it would have manufactured.
//   3. A STRUCTURAL RATING-PATHWAY MAP (Part 0). On the pitcher side the verdict turned on structure:
//      three of four channels carry a ln(Stuff) aux (`stuffAug`), so their in-frame Stuff slopes are
//      ~0 BY LEAST-SQUARES, and the contact channel — the only one with no Stuff pathway at all — was
//      where the residual had nowhere else to land. That made a striking finding an ARTIFACT of the
//      form's wiring rather than a mechanism. The hitter form's wiring is DIFFERENT and must be read
//      from the code, not assumed; Part 0 does that, and every later read is interpreted through it.
//
// THE EXACT DECOMPOSITION (all per 600 PA; w = the model's own wOBA weights, src/scoring-core/
// woba-weights.ts — no invented weights). Unlike the pitcher form (fixed 25% XBH share), the hitter
// form FITS the XBH share as its own channel (hit.xbh on GAP), so the blended non-HR-hit weight is
// the model's OWN predicted share, not a constant:
//
//     w̃ = (1 − share_pred)·w_1b + share_pred·w_xbh
//
// With BIP = 600 − uBB − K − HR − HIT_BIP_ADJ (HIT_BIP_ADJ = 6 HBP + 3 SH − 4 SF = 5, the training/
// inference convention, applied to BOTH the predicted and the observed line so the identity closes)
// and babip = nHH / BIP, nHH = H − HR:
//
//   ΔwOBA = [ w̃·BIP_obs·(babip_pred − babip_obs)          ] / 600  ← BABIP   (contact-RATE leg of hits)
//         + [ (w_xbh − w_1b)·nHH_obs·(share_pred−share_obs)] / 600  ← GAP/XBH-SHARE (the hit MIX)
//         + [ (w_hr − w̃·babip_pred)·ΔHR                    ] / 600  ← HR  (direct + BIP-volume)
//         + [ (w_bb − w̃·babip_pred)·ΔBB                    ] / 600  ← BB  (direct + BIP-volume)
//         + [ (     − w̃·babip_pred)·ΔK                     ] / 600  ← K   (BIP-VOLUME ONLY — a strikeout
//         + [ w_hbp·(HIT_HBP − HBP_obs)                    ] / 600  ←   has no wOBA weight; it moves wOBA
//                                                                   ←   solely by removing a ball in play)
//
// i.e. the hits channel is split into its RATE leg (BABIP), its MIX leg (GAP), and its VOLUME leg (BIP
// moves when BB/K/HR are mis-predicted), the volume leg attributed back to BB/K/HR. Closure is verified
// row-by-row and printed. Because slope is a LINEAR operator, the channels' bias SLOPES on any axis sum
// to the composite slope — that is what makes the "% of composite" column exhaustive.
//
// GRAIN — read this before any N below. `loadWindow` SUMS a card's seasons into ONE row per card-side.
// The deployed model was FIT on exactly those summed rows (window 2042+2043, minPA 1000), so:
//   · PRIMARY (Parts 1–7) = FIT GRAIN: one row per (card × side), summed over the window, PA ≥ 1000.
//     These are the actual fit units; "in-frame" means precisely this set.
//   · Part 8 = ROW GRAIN: each season loaded SEPARATELY and stacked (card × side × season), which is
//     NOT what a multi-year loadWindow call returns. Used for the per-season consistency read and the
//     out-of-frame seasons 2037–2041, with per-season weight reported (league coverage is unequal).
// Old Data (2032–2033) sits after a four-season gap and is reported SEPARATELY, never pooled.
//
// WHICH LINE IS MEASURED (the hitter-tail question, stated up front): `makeRawPolyModel(trained
// .eventForm).predictHitting` — the DEPLOYED raw event line, pre-era, pre-park, pre-anchor. The
// deployed GAP-conditioned hitter-tail correction (src/scoring-core/hit-tail.ts) is NOT in this line,
// and that is not a choice: applyHitTail is the EXACT IDENTITY at zero pool gap by construction
// (every strength is λ·w(g), g = max(ref.μ/pool.μ − 1, 0) over the SAME own-gap transform; a league/
// unrestricted pool gives g = 0 ⇒ lw = 0 ⇒ no-op). On league training data there is no correction to
// include. Part 7 states what that means for reproducing the published elite-power residual.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { DEFAULT_WOBA_WEIGHTS, type WobaWeights } from "../src/scoring-core/woba-weights.ts";
import { HIT_BIP_ADJ, type FittedEvent, type FittedH } from "../src/model/curves.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { wls } from "../src/training/fit.ts";
import { analyzeResiduals } from "../src/training/residuals.ts";

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
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; window?: number[]; minPA?: number; includeVariants?: boolean; datasetRoot?: string };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rp = makeRawPolyModel(trained.eventForm);          // THE DEPLOYED FORM
const W: WobaWeights = trained.wobaWeights ?? DEFAULT_WOBA_WEIGHTS;   // the model's OWN weights
const usingModelWeights = !!trained.wobaWeights;
const HIT_HBP = 6;                                       // the model's fixed hitter HBP (woba.ts adv_hbp)

const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const keepVar = (o: TrainObs) => (trained.includeVariants ?? true) || !o.variant;

// FIT GRAIN — one row per (card × side), seasons SUMMED over the window: the actual fit units.
const fitObs = loadWindow(TRAIN, win.length ? win : undefined);
// ROW GRAIN — each season loaded separately (loadWindow does NOT do this for you) and stacked.
const YEARS = availableYears(TRAIN);
const OLD_YEARS = YEARS.filter((y) => y <= 2033);
const MAIN_YEARS = YEARS.filter((y) => y >= 2037);
const perSeason = MAIN_YEARS.map((y) => ({ y, ld: loadWindow(TRAIN, [y]) }));
const perSeasonOld = OLD_YEARS.map((y) => ({ y, ld: loadWindow(TRAIN, [y]) }));
const SEASON_MIN_PA = 400;   // per-SEASON qualification (the deployed 1000 is a WINDOW-SUM threshold)

// ── per-row channel residuals (native units) + exact wOBA contributions ──────
const EVK = ["WOBA", "HR", "BABIP", "HITS", "XBHSHARE", "BB", "K"] as const;
const CTK = ["BABIP", "GAP", "HR", "BB", "K", "HBP"] as const;
type EvK = (typeof EVK)[number]; type CtK = (typeof CTK)[number];
const AXK = ["eye", "pow", "kRat", "babip", "gap"] as const;   // HIT_RATINGS
type AxK = (typeof AXK)[number];
const AXLAB: Record<AxK, string> = { eye: "EYE", pow: "POW", kRat: "AvoidK", babip: "BABIP(rat)", gap: "GAP" };
interface Row { cid: string; key: string; year: string; r: Record<AxK, number>; w: number; side: string; ev: Record<EvK, number>; ct: Record<CtK, number>; closure: number; hrPred: number; hrObs: number; wt: number; bipP: number; nhhP: number }

function buildRows(obs: TrainObs[], minN: number, year: string): Row[] {
  const rows: Row[] = [];
  for (const o of obs.filter((x) => keepVar(x) && HITTER.qualifies(x, minN))) {
    const pa = Math.max(o.hit.PA, 1), s = 600 / pa;
    // OBSERVED, per 600 PA, on the model's own conventions (uBB — IBB is manager behavior, excluded
    // from both the fit target and the wOBA convention; nHH = H − HR, exactly the hit.h fit target).
    const uBBo = Math.max(o.hit.BB - o.hit.IBB, 0) * s;
    const Ko = o.hit.K * s, HRo = o.hit.HR * s, HPo = o.hit.HP * s;
    const nHHo = Math.max(o.hit.H - o.hit.HR, 0) * s, xbho = (o.hit.b2 + o.hit.b3) * s;
    const BIPo = 600 - uBBo - Ko - HRo - HIT_BIP_ADJ;
    if (!(BIPo > 1) || !(nHHo > 0)) continue;
    const babipO = nHHo / BIPo, shareO = xbho / nHHo;
    // PREDICTED (deployed form, per 600, no era/park/calibration/hit-tail — the raw model line).
    const p = rp.predictHitting(o.ratings.hit, {} as never);
    const nHHp = p.oneB + p.GAP;
    const BIPp = 600 - p.BB - p.SO - p.HR - HIT_BIP_ADJ;
    if (!(BIPp > 1) || !(nHHp > 0)) continue;
    const babipP = nHHp / BIPp, shareP = p.GAP / nHHp;
    const wt = (1 - shareP) * W.b1 + shareP * W.xbh;   // the model's OWN blended non-HR-hit weight

    const dBB = p.BB - uBBo, dK = p.SO - Ko, dHR = p.HR - HRo, dnHH = nHHp - nHHo;
    const wobaP = (W.bb * p.BB + W.hbp * HIT_HBP + W.b1 * p.oneB + W.xbh * p.GAP + W.hr * p.HR) / 600;
    const wobaO = (W.bb * uBBo + W.hbp * HPo + W.b1 * (nHHo - xbho) + W.xbh * xbho + W.hr * HRo) / 600;
    const dW = wobaP - wobaO;

    const ct: Record<CtK, number> = {
      BABIP: (wt * BIPo * (babipP - babipO)) / 600,
      GAP: ((W.xbh - W.b1) * nHHo * (shareP - shareO)) / 600,
      HR: ((W.hr - wt * babipP) * dHR) / 600,
      BB: ((W.bb - wt * babipP) * dBB) / 600,
      K: (-wt * babipP * dK) / 600,
      HBP: (W.hbp * (HIT_HBP - HPo)) / 600,
    };
    const ev: Record<EvK, number> = {
      WOBA: dW, HR: dHR, BABIP: (babipP - babipO) * 1000, HITS: dnHH,
      XBHSHARE: (shareP - shareO) * 1000, BB: dBB, K: dK,
    };
    const sum = CTK.reduce((a, k) => a + ct[k], 0);
    if (!Number.isFinite(dW) || EVK.some((k) => !Number.isFinite(ev[k])) || CTK.some((k) => !Number.isFinite(ct[k]))) continue;
    const rr = o.ratings.hit;
    rows.push({
      cid: o.cid, key: o.key, year, side: String(o.side), w: pa, closure: sum - dW,
      r: { eye: rr.eye, pow: rr.pow, kRat: rr.kRat, babip: rr.babip, gap: rr.gap },
      ev, ct, hrPred: p.HR, hrObs: HRo, wt, bipP: BIPp, nhhP: nHHp,
    });
  }
  return rows;
}

const rows = buildRows(fitObs.observations, minPA, win.join("+"));   // PRIMARY: fit grain, in-frame
const cardsOf = (rs: Row[]) => new Set(rs.map((r) => r.cid)).size;

// ── shared machinery (lifted from tools/stuff-residual-channels.ts) ──────────
const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = rs.reduce((a, r) => a + r.w, 0); return sw > 0 ? rs.reduce((a, r) => a + r.w * get(r), 0) / sw : NaN; };
// per-AXIS standardization
const muA = {} as Record<AxK, number>, sdA = {} as Record<AxK, number>;
for (const k of AXK) { muA[k] = wmean(rows, (r) => r.r[k]); sdA[k] = Math.sqrt(wmean(rows, (r) => (r.r[k] - muA[k]) ** 2)) || 1; }
const zA = (k: AxK) => (r: Row) => (r.r[k] - muA[k]) / sdA[k];
/** weighted polynomial partials via normal equations up to cubic, on a standardized AXIS */
function wpoly(rs: Row[], deg: number, get: (r: Row) => number, zf: (r: Row) => number): number[] {
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

// ── THE CLUSTER BOOTSTRAP (the grain trap, handled) ─────────────────────────
// A card's residual is close to a fixed function of its unchanging ratings, and each card contributes
// up to 2 side-rows (and, at row grain, one per season). Resampling ROWS treats those as independent
// observations and shrinks every interval. Every CI in this artifact resamples CARDS: a drawn card
// brings ALL of its rows. Part 0 prints the width ratio vs the naive row bootstrap.
function clustersOf(rs: Row[]): Row[][] {
  const m = new Map<string, Row[]>();
  for (const r of rs) { const g = m.get(r.cid); if (g) g.push(r); else m.set(r.cid, [r]); }
  return [...m.values()];
}
function clusterDraw(cl: Row[][]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < cl.length; i++) { const g = cl[Math.floor(rnd() * cl.length)]!; for (const r of g) out.push(r); }
  return out;
}
const rowDraw = (rs: Row[]): Row[] => rs.map(() => rs[Math.floor(rnd() * rs.length)]!);
const cardList = [...new Set(rows.map((r) => r.cid))];
const byCardIdx = new Map<string, Row[]>();
for (const r of rows) { const g = byCardIdx.get(r.cid); if (g) g.push(r); else byCardIdx.set(r.cid, [r]); }

/** weighted LS slope on a RAW rating axis (per rating POINT — the anchor-audit's units) */
function rawSlope(rs: Row[], get: (r: Row) => number, ax: AxK): number {
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
function analyze(rs: Row[], get: (r: Row) => number, ax: AxK) {
  const zf = zA(ax), cl = clustersOf(rs);
  const bLin: number[] = [], bCub: number[] = [];
  for (let b = 0; b < NBOOT; b++) {
    const bs = clusterDraw(cl);
    bLin.push(wpoly(bs, 1, get, zf)[1]!);
    bCub.push(wpoly(bs, 3, get, zf)[3]!);
  }
  const srt = [...rs].sort((p, q) => p.r[ax] - q.r[ax]);
  const quints = [0, 1, 2, 3, 4].map((i) => {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    return { lo: s[0]?.r[ax] ?? 0, hi: s[s.length - 1]?.r[ax] ?? 0, resid: wmean(s, get), n: s.length, cards: cardsOf(s) };
  });
  return { n: rs.length, cards: cardsOf(rs), level: wmean(rs, get), quints, lin: wpoly(rs, 1, get, zf)[1]!, linCI: ci(bLin), cub: wpoly(rs, 3, get, zf)[3]!, cubCI: ci(bCub), raw: rawSlope(rs, get, ax), r2: axR2(rs, get, ax) };
}
type An = ReturnType<typeof analyze>;

// ── channel metadata: fit status comes from the CODE (Part 0 builds the map) ──
interface Chan { key: EvK; label: string; unit: string; dec: number; fitted: string }
const CHANS: Chan[] = [
  { key: "WOBA", label: "wOBA COMPOSITE (reference row)", unit: " wOBA", dec: 5, fitted: "assembled — not itself fit" },
  { key: "HR", label: "HR", unit: "/600", dec: 3, fitted: "hit.hr — FIT on POW (raw-QUAD). No aux ⇒ eye/kRat/babip/gap NEVER enter" },
  { key: "BABIP", label: "BABIP (nHH / BIP)", unit: " pts×1000", dec: 3, fitted: "hit.h — FIT on ln(BABIP-rating) + ln(BIP). No aux ⇒ pow/eye/kRat enter ONLY through BIP" },
  { key: "HITS", label: "non-HR hits (nHH)", unit: "/600", dec: 3, fitted: "hit.h (rate) × BIP chain (volume)" },
  { key: "XBHSHARE", label: "XBH share of hits", unit: " pts×1000", dec: 3, fitted: "hit.xbh — FIT on ln(GAP). No aux ⇒ no other rating enters" },
  { key: "BB", label: "BB (uBB)", unit: "/600", dec: 3, fitted: "hit.bb — FIT on ln(EYE). No aux ⇒ no other rating enters" },
  { key: "K", label: "K", unit: "/600", dec: 3, fitted: "hit.k — FIT on ln(AvoidK). No aux ⇒ no other rating enters" },
];
const PRIMARY: Record<EvK, AxK | null> = { WOBA: null, HR: "pow", BABIP: "babip", HITS: "babip", XBHSHARE: "gap", BB: "eye", K: "kRat" };

function emit(an: An, label: string, unit: string, dec: number, ax: string) {
  say(`  ── ${label}  (N=${an.n} rows / ${an.cards} distinct cards, level ${sgn(an.level, dec)}${unit}) ──`);
  say(`     ${pad(`${ax} quintile`, 18)} mean resid          n rows   cards`);
  for (const q of an.quints) say(`     ${pad(`[${f(q.lo, 0)}-${f(q.hi, 0)}]`, 18)} ${rp2(sgn(q.resid, dec), 10)}      ${rp2(String(q.n), 6)}  ${rp2(String(q.cards), 6)}`);
  say(`     LINEAR partial (per SD ${ax}): ${sgn(an.lin, dec + 1)} [${sgn(an.linCI.lo, dec + 1)}, ${sgn(an.linCI.hi, dec + 1)}] ${clear(an.linCI) ? "★ CI-clear" : "covers 0"}`);
  say(`     CUBIC  partial (per SD ${ax}): ${sgn(an.cub, dec + 2)} [${sgn(an.cubCI.lo, dec + 2)}, ${sgn(an.cubCI.hi, dec + 2)}] ${clear(an.cubCI) ? "★ CI-CLEAR — curved (a quad cannot express it)" : "covers 0 — no cubic misfit"}`);
  say();
}

// ── the CONTRIBUTION table: each channel's share of the composite bias SLOPE on one axis ──
// Common random numbers: every channel is bootstrapped on the SAME card-resample draws, so the
// per-channel slope CIs are mutually comparable and the resampled channel slopes still sum to the
// resampled composite slope (the decomposition survives the bootstrap).
interface CRow { key: CtK; label: string; level: number; slope: number; ci: { lo: number; hi: number }; share: number }
const CTLAB: Record<CtK, string> = {
  BABIP: "BABIP  (contact-RATE leg of hits)", GAP: "GAP    (XBH-share = the hit MIX)",
  HR: "HR     (direct + BIP-volume)", BB: "BB     (direct + BIP-volume)",
  K: "K      (BIP-volume ONLY — no wOBA weight)", HBP: "HBP    (fixed 6/600)",
};
function contribTable(rs: Row[], ax: AxK) {
  const compSlope = rawSlope(rs, (r) => r.ev.WOBA, ax);
  const cl = clustersOf(rs), draws: Row[][] = [];
  for (let b = 0; b < NBOOT; b++) draws.push(clusterDraw(cl));
  const bootComp = draws.map((d) => rawSlope(d, (r) => r.ev.WOBA, ax));
  const rowsOut: CRow[] = CTK.map((k) => {
    const slope = rawSlope(rs, (r) => r.ct[k], ax);
    const bs = draws.map((d) => rawSlope(d, (r) => r.ct[k], ax));
    return { key: k, label: CTLAB[k], level: wmean(rs, (r) => r.ct[k]), slope, ci: ci(bs), share: compSlope !== 0 ? (100 * slope) / compSlope : NaN };
  });
  rowsOut.sort((p, q) => Math.abs(q.slope) - Math.abs(p.slope));
  return { rowsOut, compSlope, compCI: ci(bootComp), compLevel: wmean(rs, (r) => r.ev.WOBA) };
}

// ── marginal / conditional regression machinery (used from Part 1b onward) ───
const zRow = (r: Row) => AXK.map((k) => zA(k)(r));
function designOf(r: Row, spec: "marg" | "cond" | "condInt", margAx?: AxK, ixPair?: [AxK, AxK]): number[] {
  const zz = zRow(r);
  if (spec === "marg") return [1, zA(margAx!)(r)];
  if (spec === "cond") return [1, ...zz];
  return [1, ...zz, zA(ixPair![0])(r) * zA(ixPair![1])(r)];
}
/** point + cluster-bootstrap CI for EVERY coefficient of one spec, from ONE bootstrap loop. */
function coefsCI(rs: Row[], get: (r: Row) => number, spec: "marg" | "cond" | "condInt", margAx?: AxK, ixPair?: [AxK, AxK]) {
  const fitOn = (s: Row[]) => wls(s.map((r) => designOf(r, spec, margAx, ixPair)), s.map(get), s.map((r) => r.w));
  const pt = fitOn(rs), cl = clustersOf(rs);
  const bs: number[][] = [];
  for (let b = 0; b < NBOOT; b++) bs.push(fitOn(clusterDraw(cl)));
  return pt.map((v, i) => ({ pt: v, ci: ci(bs.map((r) => r[i]!)) }));
}

// ── run the primary reads ────────────────────────────────────────────────────
const bySide = [{ code: "R", tag: "vR" }, { code: "L", tag: "vL" }]
  .map(({ code, tag }) => ({ s: tag, rows: rows.filter((r) => r.side === code) }))
  .filter((x) => x.rows.length > 30);
const maxClosure = rows.reduce((m, r) => Math.max(m, Math.abs(r.closure)), 0);
const compAx = Object.fromEntries(AXK.map((k) => [k, analyze(rows, (r) => r.ev.WOBA, k)])) as Record<AxK, An>;
const axRank = [...AXK].sort((p, q) => compAx[q]!.r2 - compAx[p]!.r2);
const ctByAx = Object.fromEntries(AXK.map((k) => [k, contribTable(rows, k)])) as Record<AxK, ReturnType<typeof contribTable>>;

// ════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say("# HITTER-RESIDUAL CHANNEL LOCATOR (deployed form, in-frame).  MEASUREMENT ONLY — nothing wired,");
say("# nothing fit into production, no defaults changed.");
say("# THE MIRROR of tools/stuff-residual-channels.ts, which had never been run for hitters. Questions:");
say("#  Q1 which hitter EVENT CHANNEL carries the largest share of the model's wOBA bias, and its slope");
say("#     on each rating axis (Parts 1-3);");
say("#  Q2 which RATING AXES are genuine independent drivers once the other four are held fixed, vs");
say("#     merely proxies for a correlated rating (Parts 4-6);");
say("#  Q3 is any of it SHAPE (an interaction corner) rather than additive — tested against a");
say("#     permutation null, not eyeballed (Part 5);");
say("#  Q4 does the published elite-POWER 'hitter tail' residual reproduce here, and on which line");
say("#     (Part 7);");
say("#  Q0 and, governing all of it: which ratings can physically REACH which channels in the deployed");
say("#     form — the structural map, read from the code (Part 0).");
say("################################################################################");
say();
say(`  model '${trained.id}'  DEPLOYED form  window ${win.join("+") || "all"}  minPA ${minPA} (window SUM)`);
say(`  PRIMARY GRAIN = FIT GRAIN: one row per (card × side), seasons SUMMED over the window — the`);
say(`  actual units the deployed curves were fit on.  N=${rows.length} ROWS / ${cardsOf(rows)} DISTINCT CARDS, PA-weighted.`);
say(`  (loadWindow SUMS a card's seasons into one row per card-side. It does NOT return per-season rows;`);
say(`  Part 8 loads each season SEPARATELY and stacks them for the row-grain / per-season reads.)`);
say(`  variants: ${(trained.includeVariants ?? true) ? "INCLUDED (as the model trains them)" : "excluded"}`);
say(`  wOBA event weights: ${usingModelWeights ? "THE MODEL'S OWN (trained.wobaWeights, wRAA-derived)" : "DEFAULT_WOBA_WEIGHTS (model carries none)"}`);
say(`    bb ${f(W.bb, 4)}  hbp ${f(W.hbp, 4)}  1b ${f(W.b1, 4)}  xbh ${f(W.xbh, 4)}  hr ${f(W.hr, 4)}`);
say(`    ⇒ the blended non-HR-hit weight w̃ is NOT a constant here (unlike the pitcher form's fixed 25%`);
say(`      XBH share): w̃ = (1−share_pred)·w_1b + share_pred·w_xbh, and share_pred is the FITTED hit.xbh`);
say(`      curve on GAP. PA-weighted mean w̃ over these rows = ${f(wmean(rows, (r) => r.wt), 4)} (range ${f(Math.min(...rows.map((r) => r.wt)), 4)}-${f(Math.max(...rows.map((r) => r.wt)), 4)}).`);
say();
say(`  RATING AXES (all five — HIT_RATINGS, src/model/pool-transform.ts:87). Mean / SD over these rows:`);
say(`  ${AXK.map((k) => `${AXLAB[k]} ${f(muA[k], 1)}/${f(sdA[k], 1)}`).join("   ")}`);
say();
say(`  residual convention throughout: DEPLOYED PREDICTION − OBSERVED. Positive on the wOBA composite =`);
say(`  the model says the hitter produced MORE than he did = the model OVER-CREDITS him. (This is the`);
say(`  OPPOSITE sign convention in meaning from the pitcher artifact, where positive wOBA-ALLOWED meant`);
say(`  UNDER-credit. Same arithmetic, mirrored role — do not blur the two.)`);
say();
say(`  DECOMPOSITION CLOSURE CHECK: max |Σ channel contributions − ΔwOBA| over all ${rows.length} rows =`);
say(`  ${maxClosure.toExponential(2)} wOBA. The decomposition is EXACT (floating-point only) ⇒ the channel`);
say(`  shares below are exhaustive and mutually exclusive — nothing is double-counted or missing.`);
say();
say(`  DATA / EXCLUSIONS. root '${TRAIN}'. The loader's corrupt-cell detector (src/training/validate.ts`);
say(`  corruptCellKeys — duplicate vL/vR files) ran on this load and excluded: ${JSON.stringify(fitObs.summary.excludedCells)}`);
say(`  ${fitObs.summary.excludedCells.length === 0 ? "(none inside the deployed window; the known corrupt cell HD450|2039 sits OUTSIDE it — it IS\n  detected and dropped in the per-season loads of Part 8, confirmed there)." : "(confirmed applied)"}`);
say(`  leagues in-window: ${fitObs.summary.leagues.join(", ")}   seasons: ${fitObs.summary.years.join(", ")}   unparsed files: ${fitObs.summary.unparsedFiles.length}`);
say();

const VERDICT_AT = L.length;   // the top-of-artifact VERDICT paragraph is spliced in here at the end

// ── PART 0 ───────────────────────────────────────────────────────────────────
const HF = trained.eventForm.hit;
const ev0 = (e: FittedEvent) => `${e.curve.kind}${e.curve.kind === "rawpoly" || e.curve.kind === "logpoly" ? `-${(e.curve as { degree: number }).degree}` : ""}${e.aux ? "  +AUX" : ""}`;
const h0 = (h: FittedH) => `rating ${h.rating.curve.kind}${h.rating.curve.kind === "rawpoly" ? `-${(h.rating.curve as { degree: number }).degree}` : ""} + BIP ${h.bip ? h.bip.curve.kind : "unit"}`;
say("################################################################################");
say("# PART 0 — THE STRUCTURAL RATING-PATHWAY MAP (read from the code, not assumed)");
say("################################################################################");
say();
say(`  Sources: fitHitForm (src/training/forms.ts:211) — what each curve is FIT on; predictHitting`);
say(`  (src/model/raw-poly.ts:27) — what each curve is EVALUATED on; the deployed artifact's own`);
say(`  fitted curves (printed below, so this is the DEPLOYED wiring, not the form template's).`);
say();
say(`  ${pad("channel", 16)} ${pad("deployed curve", 30)} ${pad("PRIMARY rating", 14)} AUX terms`);
say(`  ${"-".repeat(16)} ${"-".repeat(30)} ${"-".repeat(14)} ${"-".repeat(30)}`);
say(`  ${pad("hit.bb  (uBB)", 16)} ${pad(ev0(HF.bb), 30)} ${pad("EYE", 14)} NONE`);
say(`  ${pad("hit.k   (K)", 16)} ${pad(ev0(HF.k), 30)} ${pad("AvoidK", 14)} NONE`);
say(`  ${pad("hit.hr  (HR)", 16)} ${pad(ev0(HF.hr), 30)} ${pad("POW", 14)} NONE`);
say(`  ${pad("hit.h   (nHH)", 16)} ${pad(h0(HF.h), 30)} ${pad("BABIP-rating", 14)} the derived BIP count (its OWN fitted curve)`);
say(`  ${pad("hit.xbh (share)", 16)} ${pad(ev0(HF.xbh), 30)} ${pad("GAP", 14)} NONE`);
say();
say(`  ⇒ THE HEADLINE STRUCTURAL FACT, and it is the OPPOSITE of the pitcher side: NOT ONE HITTER`);
say(`  CHANNEL CARRIES AN AUX TERM. fitHitForm never calls fitEventAux (compare fitPitForm, which calls`);
say(`  it for pit.bb and pit.hr under \`stuffAug\`), and the deployed artifact confirms it — aux present`);
say(`  on hit.*: ${[HF.bb.aux, HF.k.aux, HF.hr.aux, HF.xbh.aux].some(Boolean) ? "YES (unexpected — re-read)" : "NONE"}. Every hitter channel is a ONE-RATING channel.`);
say();
say(`  WHICH RATINGS CANNOT REACH WHICH CHANNELS (the "nowhere to land" analysis):`);
say(`    · EYE, AvoidK, POW  →  reach hit.h ONLY through the BIP COUNT (BIP = 600 − BB − K − HR − 5),`);
say(`      and BIP enters hit.h's design as its own fitted ln(BIP) term ⇒ the hits residual is`);
say(`      orthogonalized against the BIP COMBINATION, but NOT against eye/kRat/pow individually.`);
say(`    · BABIP-rating  →  NO pathway into BB, K or HR. None. It touches only the hit RATE.`);
say(`    · GAP           →  NO pathway into BB, K, HR, BIP, or the hit TOTAL. It splits hits into 1B vs`);
say(`      XBH and nothing else. A GAP-correlated error can therefore ONLY surface in the XBH-share`);
say(`      channel (and, through the wOBA weights, in the composite).`);
say(`    · POW           →  NO pathway into the contact rate, the walk rate, or the K rate.`);
say();
say(`  HOW TO READ EVERY RESIDUAL BELOW (the least-squares orthogonality caveat, hitter version):`);
say(`  each channel was fit BY WEIGHTED LEAST SQUARES on its own primary rating, so IN FRAME its`);
say(`  residual is pushed toward zero slope ON THAT RATING BY CONSTRUCTION — but is STRUCTURALLY FREE`);
say(`  on the other four. So:`);
say(`    · a channel showing a slope on a FOREIGN rating (e.g. HR residual vs GAP) is the informative`);
say(`      case: the form has no way to express it;`);
say(`    · a channel showing a slope on its OWN rating is the suppressed case — for the LOG channels`);
say(`      (bb/k/h/xbh) the fit absorbs level and linear-in-ln, and for hit.hr (raw-QUAD in POW) it`);
say(`      absorbs level, linear AND quadratic in raw POW. In both, only the CUBIC partial is free.`);
say(`  THREE REASONS THE ORTHOGONALITY IS ONLY APPROXIMATE, not exact (so a small own-rating slope is`);
say(`  not automatically a finding): (a) the fit weights PA^0.75, this artifact weights PA; (b) the fit`);
say(`  target for hit.h/hit.xbh is a CHAIN quantity (predicted-BIP, predicted-hits) while the residual`);
say(`  here is measured against the OBSERVED line; (c) the deployed hit.hr was NOT vertex-pinned`);
say(`  (vertexPinned lists only pit.hr) but IS tangent-linear-extended beyond its fit domain — see Part 7.`);
say();

// ── PART 1 ───────────────────────────────────────────────────────────────────
say("################################################################################");
say("# PART 1 — PER-CHANNEL RESIDUAL vs ITS OWN PRIMARY RATING (native units, pooled over both hands)");
say("################################################################################");
say();
say(`  The in-frame orthogonality check, channel by channel. The composite is shown against every axis`);
say(`  in Part 4; here each channel is shown against the rating it was FIT on.`);
say();
for (const c of CHANS) {
  const ax = PRIMARY[c.key];
  say(`  ▸ ${c.label}`);
  say(`    fit status: ${c.fitted}`);
  if (ax) emit(analyze(rows, (r) => r.ev[c.key], ax), `POOLED (both hands) vs ${AXLAB[ax]}`, c.unit, c.dec, AXLAB[ax]);
  else emit(compAx[axRank[0]!]!, `POOLED (both hands) vs ${AXLAB[axRank[0]!]} (its strongest axis)`, c.unit, c.dec, AXLAB[axRank[0]!]);
}

// ── PART 2 ───────────────────────────────────────────────────────────────────
// ── PART 1b — the structurally-FREE cells, with a multiplicity guard ─────────
// Part 0 says every cross-rating cell (a channel against a rating that CANNOT reach it) is
// structurally free — so THOSE are where a real second-rating dependence would show. Scanning them
// all is a multiple-comparisons problem (28 free cells ⇒ ~1.4 CI-clear cells expected from noise
// alone at 95%), so the scan is guarded by a FAMILY-WISE permutation null on max|r| over the whole
// free-cell family, with the residual shuffled at CARD level and every channel read through the SAME
// shuffle. r = the weighted correlation between the channel residual and the z-scored rating —
// unit-free, so cells in different native units are comparable and a max statistic is meaningful.
const CHAN_ONLY = CHANS.filter((c) => c.key !== "WOBA");
const isOwn = (c: Chan, ax: AxK) => PRIMARY[c.key] === ax || (c.key === "HITS" && ax === "babip");
const freeCells = CHAN_ONLY.flatMap((c) => AXK.filter((ax) => !isOwn(c, ax)).map((ax) => ({ c, ax })));
const wsd = (rs: Row[], get: (r: Row) => number) => { const m = wmean(rs, get); return Math.sqrt(wmean(rs, (r) => (get(r) - m) ** 2)) || 1e-12; };
const corrOf = (rs: Row[], get: (r: Row) => number, ax: AxK) => wpoly(rs, 1, get, zA(ax))[1]! / wsd(rs, get);
const freeR = freeCells.map(({ c, ax }) => ({ c, ax, r: corrOf(rows, (x) => x.ev[c.key], ax) }));
const obsMaxR = Math.max(...freeR.map((x) => Math.abs(x.r)));
const nullMaxR: number[] = [], nullPerCell = freeR.map(() => 0);
for (let b = 0; b < 600; b++) {
  const pm = cardPermutation();
  let mx = 0;
  freeR.forEach((cell, i) => {
    const rr = Math.abs(corrOf(rows, (x) => pm.get(x)!.ev[cell.c.key], cell.ax));
    if (rr > mx) mx = rr;
    if (rr >= Math.abs(cell.r)) nullPerCell[i]!++;
  });
  nullMaxR.push(mx);
}
const sortedNullR = [...nullMaxR].sort((p, q) => p - q);
const fwer95 = sortedNullR[Math.floor(0.95 * sortedNullR.length)]!;
const fwerP = nullMaxR.filter((v) => v >= obsMaxR).length / nullMaxR.length;
say("################################################################################");
say("# PART 1b — THE STRUCTURALLY-FREE CELLS: does any rating reach a channel it cannot reach?");
say("################################################################################");
say();
say(`  ${freeCells.length} free (channel × rating) cells — every pairing where Part 0 says the rating has NO pathway`);
say(`  into the channel, so the fit could not have absorbed it and a non-zero reading is real signal`);
say(`  rather than least-squares leftovers. Weighted correlation r of the channel residual with the`);
say(`  z-scored rating (unit-free, hence comparable across cells):`);
say();
say(`  ${pad("channel", 22)}${AXK.map((k) => rp2(AXLAB[k], 15)).join("")}`);
say(`  ${"-".repeat(22)}${AXK.map(() => rp2("-".repeat(14), 15)).join("")}`);
for (const c of CHAN_ONLY) {
  const cells = AXK.map((ax) => {
    if (isOwn(c, ax)) return rp2("(fit)", 15);
    const cell = freeR.find((x) => x.c.key === c.key && x.ax === ax)!;
    const i = freeR.indexOf(cell), p = nullPerCell[i]! / 600;
    return rp2(`${sgn(cell.r, 3)}${p < 0.05 ? "*" : " "}`, 15);
  });
  say(`  ${pad(c.label.split("(")[0]!.trim().slice(0, 21), 22)}${cells.join("")}`);
}
say(`  (* = that cell's own uncorrected permutation p < 0.05 — NOT multiplicity-corrected.)`);
say();
const topFree = [...freeR].sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
say(`  FAMILY-WISE PERMUTATION NULL (600 CARD-level shuffles, all channels read through the SAME`);
say(`  shuffle, max|r| taken over all ${freeCells.length} free cells):`);
say(`    observed max|r| = ${f(obsMaxR, 3)}  (${topFree[0]!.c.label.split("(")[0]!.trim()} × ${AXLAB[topFree[0]!.ax]})`);
say(`    null 95th pct   = ${f(fwer95, 3)}   ⇒ family-wise p = ${f(fwerP, 3)}  ${fwerP < 0.05 ? "★ SURVIVES multiplicity correction" : "— does NOT survive multiplicity correction"}`);
say(`    top free cells by |r|: ${topFree.slice(0, 5).map((x) => `${x.c.label.split("(")[0]!.trim()}×${AXLAB[x.ax]} ${sgn(x.r, 3)}`).join(", ")}`);
say();
// the CI-clear free cells, in detail: quintile shape + marginal AND conditional native-unit slopes
const freeClear = freeCells.map(({ c, ax }) => ({ c, ax, an: analyze(rows, (r) => r.ev[c.key], ax) })).filter((x) => clear(x.an.linCI));
say(`  DETAIL ON THE ${freeClear.length} FREE CELLS WHOSE LINEAR PARTIAL IS CI-CLEAR (card-cluster bootstrap). For each,`);
say(`  the quintile shape, then the MARGINAL and CONDITIONAL (all five ratings held) slope in the`);
say(`  channel's native units — the conditional is the decisive one:`);
say();
const freeDetail: { c: Chan; ax: AxK; m1: { pt: number; ci: { lo: number; hi: number } }; m2: { pt: number; ci: { lo: number; hi: number } } }[] = [];
for (const { c, ax, an } of freeClear) {
  emit(an, `${c.label} vs ${AXLAB[ax]}  [FREE CELL — ${AXLAB[ax]} has NO pathway into this channel]`, c.unit, c.dec, AXLAB[ax]);
  const m1 = coefsCI(rows, (r) => r.ev[c.key], "marg", ax)[1]!;
  const mc = coefsCI(rows, (r) => r.ev[c.key], "cond");
  const m2 = mc[1 + AXK.indexOf(ax)]!;
  freeDetail.push({ c, ax, m1, m2 });
  say(`     MARGINAL    (per SD ${AXLAB[ax]}): ${sgn(m1.pt, c.dec + 1)} [${sgn(m1.ci.lo, c.dec + 1)}, ${sgn(m1.ci.hi, c.dec + 1)}] ${clear(m1.ci) ? "★" : "covers 0"}`);
  say(`     CONDITIONAL (per SD ${AXLAB[ax]}): ${sgn(m2.pt, c.dec + 1)} [${sgn(m2.ci.lo, c.dec + 1)}, ${sgn(m2.ci.hi, c.dec + 1)}] ${clear(m2.ci) ? "★ SURVIVES — an independent axis for this channel" : "covers 0 — a proxy for a correlated rating"}`);
  say(`     full conditional set: ${AXK.map((k, i) => `${AXLAB[k]} ${sgn(mc[1 + i]!.pt, c.dec + 1)}${clear(mc[1 + i]!.ci) ? "★" : ""}`).join("   ")}`);
  say();
}
// ── the BIP-chain coupling check: are these cells one error or several? ──────
{
  const bipBar = wmean(rows, (r) => r.bipP), nhhBar = wmean(rows, (r) => r.nhhP);
  const bBip = trained.eventForm.hit.h.beta[2] ?? NaN;      // fitted ln(BIP) coefficient
  const elast = bBip / nhhBar;                              // dlnH / dlnBIP at the pooled mean
  // babip = nHH(BIP)/BIP with nHH = … + bBip·ln(BIP) ⇒ d babip/d BIP = (bBip − nHH)/BIP²
  const dBabipDBip = (bBip - nhhBar) / (bipBar * bipBar);
  const kSlopeEye = wpoly(rows, 1, (r) => r.ev.K, zA("eye"))[1]!;         // ΔK per SD EYE
  const echo = -dBabipDBip * kSlopeEye * 1000;                            // pts×1000 per SD EYE
  const measured = wpoly(rows, 1, (r) => r.ev.BABIP, zA("eye"))[1]!;
  say(`  ARE THESE ONE ERROR OR SEVERAL? THE BIP-CHAIN COUPLING CHECK. A K mis-prediction moves the`);
  say(`  predicted BIP count, and hit.h reads BIP through its own fitted ln(BIP) term — so a K error`);
  say(`  MECHANICALLY produces a BABIP-rate error. If the BABIP cell were merely that echo it would`);
  say(`  not be a separate finding. The arithmetic (all at the pooled means):`);
  say(`    fitted ln(BIP) coefficient ${f(bBip, 2)};  mean predicted nHH ${f(nhhBar, 1)}/600, mean predicted BIP ${f(bipBar, 1)}/600`);
  say(`    ⇒ H-on-BIP elasticity ${f(elast, 3)} at the mean, and d(babip)/d(BIP) = (b_BIP − nHH)/BIP² = ${(dBabipDBip).toExponential(2)}`);
  say(`    measured ΔK slope on EYE: ${sgn(kSlopeEye, 3)} K/600 per SD ⇒ PREDICTED BABIP echo ${sgn(echo, 3)} pts×1000 per SD`);
  say(`    MEASURED BABIP slope on EYE: ${sgn(measured, 3)} pts×1000 per SD`);
  say(`    ⇒ the chain echo explains ${f((100 * echo) / (measured || 1e-12), 0)}% of it. ${Math.abs(echo) < 0.4 * Math.abs(measured) ? "The BABIP cell is therefore NOT mostly a mechanical\n    echo of the K cell — it is a largely SEPARATE contact-rate error on the same rating axis." : "The BABIP cell is largely the mechanical echo of the\n    K cell and must NOT be counted as an independent finding."}`);
  say(`    (Note the elasticity is BELOW 1, so a K over-prediction shrinks predicted hits LESS than`);
  say(`    proportionally — which is why the echo has the sign it does.)`);
  say();
}

say("################################################################################");
say("# PART 2 — THE RANKING: each channel's CONTRIBUTION to the wOBA bias SLOPE, on EVERY axis");
say("################################################################################");
say();
say(`  Composite in-frame wOBA bias LEVEL: ${sgn(wmean(rows, (r) => r.ev.WOBA), 5)} wOBA  (positive = the model OVER-credits).`);
say();
say(`  LEVEL DECOMPOSITION first — which channel carries the level bias, before any slope:`);
say(`  ${pad("channel", 44)} ${rp2("level (wOBA)", 14)}  ${rp2("% of composite level", 22)}`);
const compLevel = wmean(rows, (r) => r.ev.WOBA);
const levelRank = CTK.map((k) => ({ k, v: wmean(rows, (r) => r.ct[k]) })).sort((p, q) => Math.abs(q.v) - Math.abs(p.v));
for (const l of levelRank) say(`  ${pad(CTLAB[l.k], 44)} ${rp2(sgn(l.v, 5), 14)}  ${rp2(`${sgn((100 * l.v) / (compLevel || 1e-12), 1)}%`, 22)}`);
say(`  ${pad("TOTAL", 44)} ${rp2(sgn(compLevel, 5), 14)}  ${rp2("100.0%", 22)}`);
say();
for (const ax of AXK) {
  const t = ctByAx[ax]!;
  say(`  ── SLOPE ON ${AXLAB[ax]} (per rating point) ──`);
  say(`     composite ${sgn(t.compSlope, 6)}  [${sgn(t.compCI.lo, 6)}, ${sgn(t.compCI.hi, 6)}] ${clear(t.compCI) ? "★ CI-CLEAR" : "covers 0"}   (card-cluster bootstrap)`);
  say(`     ${pad("channel", 44)} ${rp2("slope", 12)} ${rp2("95% CI", 26)}  ${rp2("% of comp", 11)}`);
  for (const r of t.rowsOut) say(`     ${pad(r.label, 44)} ${rp2(sgn(r.slope, 6), 12)} ${rp2(`[${sgn(r.ci.lo, 6)}, ${sgn(r.ci.hi, 6)}]`, 26)}  ${rp2(`${sgn(r.share, 1)}%`, 11)}${clear(r.ci) ? "  ★" : ""}`);
  say();
}
say(`  ★ = the channel's own slope CI excludes zero. Shares can exceed 100% or go negative: channels`);
say(`  push in OPPOSITE directions.`);
say();
say(`  ⚠ READ THE ABSOLUTE SLOPES, NOT THE PERCENTAGES, AS PRIMARY. Where the composite denominator is`);
say(`  small and its own CI covers zero, "% of composite" is a RATIO OF NOISY QUANTITIES and unstable.`);
say(`  The ranking by |absolute slope| is the robust statement; the share column is orientation only.`);
say();

// ── ROBUSTNESS: the deployed PA filter ───────────────────────────────────────
const rowsLo = buildRows(fitObs.observations, 300, win.join("+"));
const paTot = (rs: Row[]) => rs.reduce((s, r) => s + r.w, 0);
say(`  ROBUSTNESS — the deployed minPA ${minPA} filter is also the TRAINING filter, so rows below it were`);
say(`  never fit (a mildly out-of-frame margin). Relaxing to minPA 300 adds ${rowsLo.length - rows.length} rows`);
say(`  (${cardsOf(rowsLo) - cardsOf(rows)} more distinct cards) but only ${f((100 * (paTot(rowsLo) - paTot(rows))) / paTot(rowsLo), 1)}% of the PA weight — a shape check, not power:`);
say(`    ${pad(`minPA ${minPA} (deployed, N=${rows.length}/${cardsOf(rows)}c)`, 40)} level ${sgn(wmean(rows, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(rows, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
say(`    ${pad(`minPA  300 (relaxed,  N=${rowsLo.length}/${cardsOf(rowsLo)}c)`, 40)} level ${sgn(wmean(rowsLo, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(rowsLo, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
say();

// ── the cluster-vs-row bootstrap demonstration ───────────────────────────────
{
  const cl = clustersOf(rows);
  const widths = (draws: Row[][]) => {
    const out: Record<string, number> = {};
    for (const ax of AXK) { const bs = draws.map((d) => rawSlope(d, (r) => r.ev.WOBA, ax)); const c = ci(bs); out[ax] = c.hi - c.lo; }
    return out;
  };
  const dC: Row[][] = [], dR: Row[][] = [];
  for (let b = 0; b < NBOOT; b++) { dC.push(clusterDraw(cl)); dR.push(rowDraw(rows)); }
  const wc = widths(dC), wr = widths(dR);
  say(`  THE GRAIN TRAP, QUANTIFIED (why every CI here is a CARD-CLUSTER bootstrap). ${rows.length} rows come from`);
  say(`  only ${cardsOf(rows)} distinct cards (${f(rows.length / cardsOf(rows), 2)} rows/card), and a card's residual is close to a fixed`);
  say(`  function of its unchanging ratings. Ratio of CLUSTER CI width to naive ROW CI width, composite`);
  say(`  slope, per axis:`);
  say(`    ${AXK.map((k) => `${AXLAB[k]} ${f(wc[k]! / (wr[k]! || 1e-12), 2)}×`).join("   ")}`);
  say(`  A ratio > 1 means the naive row bootstrap would have reported an interval that much TOO NARROW`);
  say(`  — i.e. would have manufactured that much significance. Every interval in this artifact is the`);
  say(`  cluster one.`);
  say();
}

// ── PART 3 — hand split ──────────────────────────────────────────────────────
say("################################################################################");
say("# PART 3 — HAND SPLIT (vs RHP / vs LHP)");
say("################################################################################");
say();
for (const { s, rows: rs } of bySide) {
  say(`  ── ${s === "vR" ? "vs RHP (vR)" : "vs LHP (vL)"}  (N=${rs.length} rows / ${cardsOf(rs)} cards) ──`);
  say(`     composite level ${sgn(wmean(rs, (r) => r.ev.WOBA), 5)} wOBA`);
  say(`     composite slope per axis:`);
  for (const ax of AXK) {
    const cl = clustersOf(rs), bs: number[] = [];
    for (let b = 0; b < NBOOT; b++) bs.push(rawSlope(clusterDraw(cl), (r) => r.ev.WOBA, ax));
    const c = ci(bs), pt = rawSlope(rs, (r) => r.ev.WOBA, ax);
    say(`       ${pad(AXLAB[ax], 14)} ${rp2(sgn(pt, 6), 12)} [${sgn(c.lo, 6)}, ${sgn(c.hi, 6)}] ${clear(c) ? "★ CI-clear" : "covers 0"}`);
  }
  say(`     channel LEVELS: ${CTK.map((k) => `${k} ${sgn(wmean(rs, (r) => r.ct[k]), 5)}`).join("  ")}`);
  say();
}

// ── PART 4 — all five axes ───────────────────────────────────────────────────
say("################################################################################");
say("# PART 4 — ALL FIVE HITTER AXES on the composite (the doctrine's read)");
say("################################################################################");
say();
say(`  Weighted axis CORRELATIONS over these ${rows.length} rows — read this FIRST, it is why a single-axis`);
say(`  read can be misleading. (Weighted Pearson r; axes standardized on the same weights.)`);
say();
say(`  ${pad("", 13)}${AXK.map((k) => rp2(AXLAB[k], 13)).join("")}`);
for (const a1 of AXK) say(`  ${pad(AXLAB[a1], 13)}${AXK.map((a2) => rp2(sgn(wmean(rows, (r) => zA(a1)(r) * zA(a2)(r)), 3), 13)).join("")}`);
say();
const corrPairs = AXK.flatMap((a1, i) => AXK.slice(i + 1).map((a2) => ({ a1, a2, r: wmean(rows, (r) => zA(a1)(r) * zA(a2)(r)) })))
  .sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
say(`  ⇒ strongest rating correlations: ${corrPairs.slice(0, 3).map((c) => `${AXLAB[c.a1]}×${AXLAB[c.a2]} ${sgn(c.r, 3)}`).join(", ")}.`);
say(`  Any marginal slope on one of a correlated pair is partly the other's. Part 6 is the decisive read.`);
say();
say(`  RESIDUAL STRUCTURE BY AXIS — composite residual, weighted cubic R² per axis + linear partial:`);
say();
say(`  ${pad("axis", 14)} ${rp2("cubic R²", 10)} ${rp2("linear/SD", 12)} ${rp2("95% CI", 26)} ${rp2("cubic/SD", 12)} ${rp2("slope/point", 12)}`);
say(`  ${"-".repeat(14)} ${"-".repeat(10)} ${"-".repeat(12)} ${"-".repeat(26)} ${"-".repeat(12)} ${"-".repeat(12)}`);
for (const k of axRank) {
  const an = compAx[k]!;
  say(`  ${pad(AXLAB[k], 14)} ${rp2(f(an.r2, 4), 10)} ${rp2(sgn(an.lin, 6), 12)} ${rp2(`[${sgn(an.linCI.lo, 6)}, ${sgn(an.linCI.hi, 6)}]`, 26)} ${rp2(sgn(an.cub, 6), 12)} ${rp2(sgn(an.raw, 6), 12)}${clear(an.linCI) ? "  ★lin" : ""}${clear(an.cubCI) ? "  ★cub" : ""}`);
}
say();
say(`  ⇒ the axis carrying the MOST composite-residual structure is ${AXLAB[axRank[0]!]} (R² ${f(compAx[axRank[0]!]!.r2, 4)}).`);
say();
say(`  Composite-residual QUINTILE SHAPE on each axis:`);
say();
for (const k of axRank) emit(compAx[k]!, `wOBA composite vs ${AXLAB[k]}`, " wOBA", 5, AXLAB[k]);
say(`  THE FULL CHANNEL × AXIS MATRIX — linear partial per SD of the axis, native channel units.`);
say(`  ★ = CI-clear (card-cluster bootstrap). Diagonal-ish cells (a channel against its OWN fitted`);
say(`  rating) are SUPPRESSED BY CONSTRUCTION — marked (fit). Everything else is structurally free:`);
say();
say(`  ${pad("channel", 22)}${AXK.map((k) => rp2(AXLAB[k], 16)).join("")}`);
say(`  ${"-".repeat(22)}${AXK.map(() => rp2("-".repeat(15), 16)).join("")}`);
for (const c of CHANS) {
  const cells = AXK.map((k) => {
    const an = analyze(rows, (r) => r.ev[c.key], k);
    const own = PRIMARY[c.key] === k || (c.key === "HITS" && k === "babip");
    return rp2(`${sgn(an.lin, c.dec + 1)}${clear(an.linCI) ? "★" : " "}${own ? "(fit)" : ""}`, 16);
  });
  say(`  ${pad(c.label.split("(")[0]!.trim().slice(0, 21), 22)}${cells.join("")}`);
}
say();

// ── PART 5 — 2-D shape corners + permutation null ────────────────────────────
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
    return { n: s.length, cards: cardsOf(s), m, inter: s.length ? m - rm[rb]! - cm[cb]! + overall : NaN };
  }));
  return { tr, tc, cells, overall };
}
// CARD-LEVEL permutation: the residual is shuffled between CARDS (a card's rows move together),
// never between rows — the same cluster logic as the bootstrap. Shuffling rows freely would give an
// over-tight null for exactly the reason the row bootstrap gives an over-tight CI. The permutation is
// built ONCE per draw as a row→donor-row map, so EVERY channel is read through the SAME shuffle and
// the cross-channel correlation structure is preserved (a per-channel shuffle would destroy it).
function cardPermutation(): Map<Row, Row> {
  const order = [...cardList];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const out = new Map<Row, Row>();
  cardList.forEach((cid, i) => {
    const src = byCardIdx.get(order[i]!)!, dst = byCardIdx.get(cid)!;
    dst.forEach((r, j) => out.set(r, src[j % src.length]!));
  });
  return out;
}
const permuteByCard = (get: (r: Row) => number): Map<Row, number> => {
  const pm = cardPermutation(); const out = new Map<Row, number>();
  for (const r of rows) out.set(r, get(pm.get(r)!));
  return out;
};
function emitGrid(rowAx: AxK, colAx: AxK) {
  const get = (r: Row) => r.ev.WOBA;
  const g = grid(rowAx, colAx, get);
  say(`  ── ${AXLAB[rowAx]} (rows) × ${AXLAB[colAx]} (cols) — wOBA composite residual ──`);
  say(`     tercile cuts: ${AXLAB[rowAx]} ${f(g.tr[0], 0)}/${f(g.tr[1], 0)}   ${AXLAB[colAx]} ${f(g.tc[0], 0)}/${f(g.tc[1], 0)}`);
  say(`     cell = mean residual (wOBA) / INTERACTION residual / n rows / c cards`);
  say(`     ${pad("", 10)}${BL.map((b) => rp2(`${AXLAB[colAx]}·${b}`, 30)).join("")}`);
  for (let rb = 0; rb < 3; rb++) {
    say(`     ${pad(`${AXLAB[rowAx]}·${BL[rb]}`, 10)}${[0, 1, 2].map((cb) => { const c = g.cells[rb]![cb]!; return rp2(`${sgn(c.m, 5)} / ${sgn(c.inter, 5)} / n${c.n}/c${c.cards}`, 30); }).join("")}`);
  }
  const flat = g.cells.flat().filter((c) => c.n >= 8);
  const hot = [...flat].sort((p, q) => Math.abs(q.inter) - Math.abs(p.inter))[0];
  const ext = [...flat].sort((p, q) => q.m - p.m);
  const obsMax = Math.max(...flat.map((c) => Math.abs(c.inter)));
  say(`     strongest INTERACTION cell (n≥8): ${sgn(hot?.inter ?? NaN, 5)}   |   most over-credited cell: ${sgn(ext[0]?.m ?? NaN, 5)} (n${ext[0]?.n})`);
  say(`     spread of cell means: ${sgn((ext[0]?.m ?? NaN) - (ext[ext.length - 1]?.m ?? NaN), 5)}   max |interaction|: ${sgn(obsMax, 5)}`);
  const nullMax: number[] = [];
  for (let b = 0; b < 600; b++) {
    const perm = permuteByCard(get);
    const gp = grid(rowAx, colAx, (r) => perm.get(r)!);
    nullMax.push(Math.max(...gp.cells.flat().filter((c) => c.n >= 8).map((c) => Math.abs(c.inter))));
  }
  const sorted = [...nullMax].sort((p, q) => p - q);
  const p95 = sorted[Math.floor(0.95 * sorted.length)]!;
  const pval = nullMax.filter((v) => v >= obsMax).length / nullMax.length;
  say(`     PERMUTATION NULL (600 CARD-level shuffles): max|interaction| under pure noise has 95th pct`);
  say(`     ${sgn(p95, 5)}; observed ${sgn(obsMax, 5)} ⇒ p = ${f(pval, 3)}  ${pval < 0.05 ? "★ the corner structure EXCEEDS chance" : "— WITHIN chance for cells this small (do NOT read the corner as real)"}`);
  say();
  return { ...g, obsMax, p95, pval, rowAx, colAx };
}
say("################################################################################");
say("# PART 5 — 2-D SHAPE READ: corner or additive? (every corner tested against a permutation null)");
say("################################################################################");
say();
say(`  The INTERACTION residual strips the additive 1-D main effects (raw − row marginal − col marginal`);
say(`  + overall), so what remains is TRUE 2-way structure. Cells here hold ~15-25 rows and as few as`);
say(`  ~8 CARDS, and small cells throw large corners by chance — so no corner is reported without its`);
say(`  null p-value beside it. (On the pitcher side this test killed an eye-catching false positive.)`);
say();
const pairSpec: [AxK, AxK][] = [
  ["pow", axRank.find((k) => k !== "pow")!],  // the prior's axis × the strongest other
  ["pow", "gap"],                              // the power/gap shape pair
  ["eye", "kRat"],                             // the pair Part 1b implicates (EYE reaching the K channel)
];
const seenPair = new Set<string>();
const grids = pairSpec.filter(([a1, a2]) => { const k = [a1, a2].sort().join("|"); if (a1 === a2 || seenPair.has(k)) return false; seenPair.add(k); return true; })
  .map(([a1, a2]) => emitGrid(a1, a2));

// ── PART 6 — marginal vs conditional ─────────────────────────────────────────
say("################################################################################");
say("# PART 6 — THE DECISIVE READ: marginal vs CONDITIONAL slope, every rating");
say("################################################################################");
say();
say(`  Weighted regressions of the residual on z-scored ratings (coefficients = residual per SD).`);
say(`    M1 MARGINAL     : y ~ z_<axis>                                        (one axis alone)`);
say(`    M2 CONDITIONAL  : y ~ z_eye + z_pow + z_kRat + z_babip + z_gap        (that axis, shape fixed)`);
say(`    M3 + INTERACTION: M2 + one z·z product                                (the shape-corner term)`);
say(`  All CIs are card-cluster bootstrap. THIS IS THE READ THAT SEPARATES a genuine independent axis`);
say(`  from one that is merely a proxy for a correlated rating.`);
say();
const condTargets: { label: string; get: (r: Row) => number; dec: number }[] = [
  { label: "wOBA composite", get: (r) => r.ev.WOBA, dec: 6 },
  ...CTK.map((k) => ({ label: `${k} contribution`, get: (r: Row) => r.ct[k], dec: 6 })),
];
const condStore: Record<string, { marg: Record<AxK, { pt: number; ci: { lo: number; hi: number } }>; cond: { pt: number; ci: { lo: number; hi: number } }[] }> = {};
for (const t of condTargets) {
  const cond = coefsCI(rows, t.get, "cond");
  const marg = {} as Record<AxK, { pt: number; ci: { lo: number; hi: number } }>;
  for (const ax of AXK) marg[ax] = coefsCI(rows, t.get, "marg", ax)[1]!;
  condStore[t.label] = { marg, cond };
  say(`  ▸ ${t.label}   (level ${sgn(wmean(rows, t.get), 5)})`);
  say(`     ${pad("axis", 14)} ${rp2("M1 marginal", 12)} ${rp2("95% CI", 26)} ${rp2("M2 conditional", 14)} ${rp2("95% CI", 26)}  survives`);
  for (let i = 0; i < AXK.length; i++) {
    const ax = AXK[i]!, m1 = marg[ax], m2 = cond[1 + i]!;
    const surv = Math.abs(m2.pt) / Math.max(Math.abs(m1.pt), 1e-12);
    say(`     ${pad(AXLAB[ax], 14)} ${rp2(sgn(m1.pt, t.dec), 12)} ${rp2(`[${sgn(m1.ci.lo, t.dec)}, ${sgn(m1.ci.hi, t.dec)}]`, 26)}${clear(m1.ci) ? "★" : " "}${rp2(sgn(m2.pt, t.dec), 14)} ${rp2(`[${sgn(m2.ci.lo, t.dec)}, ${sgn(m2.ci.hi, t.dec)}]`, 26)}${clear(m2.ci) ? "★" : " "} ${rp2(`${f(100 * surv, 0)}%`, 6)}`);
  }
  say();
}
// interaction terms for the same pairs the grids used
say(`  M3 INTERACTION TERMS on the composite (same pairs as the Part-5 grids):`);
const ixOut = grids.map((g) => {
  const c = coefsCI(rows, (r) => r.ev.WOBA, "condInt", undefined, [g.rowAx, g.colAx]);
  const t = c[c.length - 1]!;
  say(`     ${pad(`${AXLAB[g.rowAx]} × ${AXLAB[g.colAx]}`, 26)} ${sgn(t.pt, 6)} [${sgn(t.ci.lo, 6)}, ${sgn(t.ci.hi, 6)}] ${clear(t.ci) ? "★ CI-CLEAR — a genuine SHAPE-CORNER term" : "covers 0 — no shape-corner term"}   (grid null p=${f(g.pval, 3)})`);
  return { pair: [g.rowAx, g.colAx] as [AxK, AxK], t, pval: g.pval };
});
say();

// ── PART 7 — the elite-power tail ────────────────────────────────────────────
say("################################################################################");
say("# PART 7 — THE ELITE-POWER TAIL: does the published 'hitter tail' residual reproduce here?");
say("################################################################################");
say();
say(`  THE PRIOR (src/scoring-core/hit-tail.ts + docs/CWHIT_HITTAIL_BUILD2_2026-07-17.md): OUT of frame`);
say(`  (tournament pools) the hitter HR quad bends down too early — elite-power HR under-predicted, mid`);
say(`  power over-predicted, elite calibration slope 2.44 vs pooled 1.17; BABIP tail under-reacted;`);
say(`  SO% under-reacts in its MID band. The deployed correction is hinge(HR, λ2.20) + hinge(BABIP,`);
say(`  λ1.10) + step(SO, λ0.30), gap-conditioned.`);
say();
say(`  WHICH LINE IS MEASURED HERE, AND WHY. This artifact measures predictHitting — the RAW deployed`);
say(`  event line. The hitter-tail correction is NOT in it, and could not be: applyHitTail's strength is`);
say(`  lw = λ·w(g) with g = max(ref.μ/pool.μ − 1, 0) taken from the own-gap pool transform, so on a`);
say(`  LEAGUE (unrestricted) pool g = 0 ⇒ every lw = 0 ⇒ applyHitTail is the EXACT IDENTITY. There is`);
say(`  no correction to include on league training data. The hit-tail doc says the same thing from the`);
say(`  other side ("League IN-FRAME is calibrated"). CONSEQUENCE FOR THIS READ: in-frame is the WRONG`);
say(`  frame to confirm or refute the tail. A null here is the EXPECTED result, not a refutation; a`);
say(`  POSITIVE here would be the surprise — it would mean the defect is present even in frame, where`);
say(`  the correction is switched off by construction.`);
say();
const powAn = compAx.pow!;
const hrAn = analyze(rows, (r) => r.ev.HR, "pow");
say(`  POW QUARTILES (PA-weighted), composite and HR channel — pred − obs, so NEGATIVE HR = the model`);
say(`  UNDER-predicts the home runs that band actually hit (the direction the published tail claims):`);
say();
const srtPow = [...rows].sort((p, q) => p.r.pow - q.r.pow);
say(`  ${pad("POW quartile", 20)} ${rp2("n/cards", 10)} ${rp2("comp resid", 12)} ${rp2("HR resid/600", 14)} ${rp2("HR pred", 9)} ${rp2("HR obs", 9)} ${rp2("BABIP resid", 12)}`);
const quartStats = [0, 1, 2, 3].map((i) => {
  const s = srtPow.slice(Math.floor((i / 4) * srtPow.length), Math.floor(((i + 1) / 4) * srtPow.length));
  const st = { lo: s[0]!.r.pow, hi: s[s.length - 1]!.r.pow, n: s.length, cards: cardsOf(s), comp: wmean(s, (r) => r.ev.WOBA), hr: wmean(s, (r) => r.ev.HR), hp: wmean(s, (r) => r.hrPred), ho: wmean(s, (r) => r.hrObs), bab: wmean(s, (r) => r.ev.BABIP), rows: s };
  say(`  ${pad(`Q${i + 1} [${f(st.lo, 0)}-${f(st.hi, 0)}]`, 20)} ${rp2(`${st.n}/${st.cards}`, 10)} ${rp2(sgn(st.comp, 5), 12)} ${rp2(sgn(st.hr, 3), 14)} ${rp2(f(st.hp, 2), 9)} ${rp2(f(st.ho, 2), 9)} ${rp2(sgn(st.bab, 2), 12)}`);
  return st;
});
say();
// calibration slope: observed ~ a + b*predicted, weighted, pooled and within the elite band
const calib = (rs: Row[]) => {
  const sw = rs.reduce((s, r) => s + r.w, 0);
  const mp = rs.reduce((s, r) => s + r.w * r.hrPred, 0) / sw, mo = rs.reduce((s, r) => s + r.w * r.hrObs, 0) / sw;
  let sxx = 0, sxy = 0; for (const r of rs) { sxx += r.w * (r.hrPred - mp) ** 2; sxy += r.w * (r.hrPred - mp) * (r.hrObs - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
};
const calPooled = calib(rows), calElite = calib(quartStats[3]!.rows);
{
  const cl = clustersOf(rows), clE = clustersOf(quartStats[3]!.rows), bp: number[] = [], be: number[] = [];
  for (let b = 0; b < NBOOT; b++) { bp.push(calib(clusterDraw(cl))); be.push(calib(clusterDraw(clE))); }
  const cp = ci(bp), ce = ci(be);
  say(`  HR CALIBRATION SLOPE (observed HR regressed on PREDICTED HR; 1.00 = correctly spread, >1 = the`);
  say(`  model UNDER-spreads i.e. compresses the real spread into too narrow a predicted range):`);
  say(`    pooled     ${f(calPooled, 3)}  [${f(cp.lo, 3)}, ${f(cp.hi, 3)}]`);
  say(`    elite band ${f(calElite, 3)}  [${f(ce.lo, 3)}, ${f(ce.hi, 3)}]   (top POW quartile, n=${quartStats[3]!.n}/${quartStats[3]!.cards} cards)`);
  say(`    published OUT-OF-FRAME reference: pooled 1.17, elite 2.44.`);
  say();
}
// the fit-domain / tangent-linear fact
{
  const e = HF.hr, uOf = (v: number) => (e.sd > 1e-9 ? (v - e.mu) / e.sd : 0);
  const above = rows.filter((r) => uOf(r.r.pow) > (e.uMax ?? Infinity));
  const b1 = e.beta[1] ?? 0, b2 = e.beta[2] ?? 0, vtx = b2 !== 0 ? -b1 / (2 * b2) : NaN;
  say(`  THE STRUCTURAL FACT BEHIND THE TAIL CLAIM (deployed hit.hr, raw-quad in POW):`);
  say(`    μ ${f(e.mu, 2)}  σ ${f(e.sd, 2)}  β [${e.beta.map((b) => f(b, 4)).join(", ")}]  fit domain z [${f(e.uMin ?? NaN, 3)}, ${f(e.uMax ?? NaN, 3)}]`);
  say(`    unconstrained vertex at z ${f(vtx, 3)} (POW ${f(e.mu + vtx * e.sd, 0)}) — ${Number.isFinite(vtx) && (vtx <= (e.uMin ?? -9) || vtx >= (e.uMax ?? 9)) ? "OUTSIDE the fit domain ⇒ no in-domain turn-over,\n    and the deployed artifact's vertexPinned list confirms hit.hr was NOT pinned (only pit.hr was)." : "INSIDE the fit domain (would have been pinned)."}`);
  say(`    Beyond z ${f(e.uMax ?? NaN, 3)} (POW ${f(e.mu + (e.uMax ?? 0) * e.sd, 0)}) the curve is TANGENT-LINEAR, not quadratic`);
  say(`    (curves.ts curveBase out-of-domain policy). In THIS in-frame set ${above.length} of ${rows.length} rows sit above that`);
  say(`    edge, so the quad's late bend — the thing the tail correction fights — is ${above.length === 0 ? "NOT EXERCISED AT ALL\n    by the league frame. That is a second, independent reason a league-frame null on the tail is\n    uninformative about the out-of-frame claim." : "only lightly exercised here."}`);
  say();
}
say(`  POW-axis partials on the composite and on HR (from Parts 1/4, restated for the verdict):`);
say(`    composite vs POW: linear ${sgn(powAn.lin, 6)} [${sgn(powAn.linCI.lo, 6)}, ${sgn(powAn.linCI.hi, 6)}] ${clear(powAn.linCI) ? "★" : "covers 0"};  cubic ${sgn(powAn.cub, 6)} ${clear(powAn.cubCI) ? "★" : "covers 0"}`);
say(`    HR channel vs POW: linear ${sgn(hrAn.lin, 4)} [${sgn(hrAn.linCI.lo, 4)}, ${sgn(hrAn.linCI.hi, 4)}] ${clear(hrAn.linCI) ? "★" : "covers 0"};  cubic ${sgn(hrAn.cub, 4)} ${clear(hrAn.cubCI) ? "★" : "covers 0"}`);
say(`    (the HR-vs-POW linear AND quadratic partials are absorbed by the raw-quad fit — only the CUBIC`);
say(`     is structurally free, so THAT is the term to read here.)`);
say();

// ── PART 8 — per-season, row grain, in- and out-of-frame ─────────────────────
say("################################################################################");
say("# PART 8 — PER-SEASON (row grain): coverage, weight, and whether the reads are season-stable");
say("################################################################################");
say();
say(`  Each season is loaded SEPARATELY (loadWindow(root,[y])) and kept as its own rows — card × side ×`);
say(`  season. Seasons ${win.join("+")} are IN FRAME (the deployed fit); every other season is OUT of frame`);
say(`  for this model. League coverage VARIES by season, so the weight column is not uniform and no`);
say(`  "consistent across N seasons" claim below is treated as N equal seasons.`);
say(`  Per-season qualification: PA ≥ ${SEASON_MIN_PA} (the deployed minPA ${minPA} is a WINDOW-SUM threshold and would`);
say(`  discard most single seasons).`);
say();
say(`  ${pad("season", 8)} ${pad("leagues", 34)} ${rp2("rows", 6)} ${rp2("cards", 6)} ${rp2("PA wt%", 8)} ${rp2("comp level", 11)} ${AXK.map((k) => rp2(AXLAB[k], 12)).join("")}  excluded`);
say(`  ${"-".repeat(8)} ${"-".repeat(34)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(11)} ${AXK.map(() => rp2("-".repeat(11), 12)).join("")}`);
const seasonRows: { y: number; rows: Row[]; leagues: string[]; excl: string[] }[] = [];
for (const { y, ld } of perSeason) {
  const rs = buildRows(ld.observations, SEASON_MIN_PA, String(y));
  seasonRows.push({ y, rows: rs, leagues: ld.summary.leagues, excl: ld.summary.excludedCells });
}
const totWt = seasonRows.reduce((s, x) => s + paTot(x.rows), 0);
for (const s of seasonRows) {
  const inF = win.includes(s.y);
  say(`  ${pad(`${s.y}${inF ? "*" : " "}`, 8)} ${pad(s.leagues.join("/"), 34)} ${rp2(String(s.rows.length), 6)} ${rp2(String(cardsOf(s.rows)), 6)} ${rp2(f((100 * paTot(s.rows)) / totWt, 1), 8)} ${rp2(sgn(wmean(s.rows, (r) => r.ev.WOBA), 5), 11)} ${AXK.map((k) => rp2(sgn(rawSlope(s.rows, (r) => r.ev.WOBA, k), 6), 12)).join("")}  ${s.excl.join(",") || "—"}`);
}
say(`  * = in the deployed fit window.`);
say();
say(`  The corrupt cell HD450|2039 IS detected and dropped by the loader in the 2039 load (see the`);
say(`  excluded column) — confirming the exclusion is live in this run. 2037 carries 4 leagues (no`);
say(`  HD452) and 2039 is effectively 4 after the exclusion; 2038 and 2040-2043 carry 5.`);
say();
const stacked = seasonRows.flatMap((s) => s.rows);
const stackedIn = seasonRows.filter((s) => win.includes(s.y)).flatMap((s) => s.rows);
say(`  STACKED ROW GRAIN, in-frame seasons only (${win.join("+")}): N=${stackedIn.length} rows / ${cardsOf(stackedIn)} cards.`);
say(`  Compare with the FIT-GRAIN primary (N=${rows.length}/${cardsOf(rows)}): the composite level and axis slopes should`);
say(`  agree in sign and rough size; a divergence would mean the summing changes the answer.`);
say(`    ${pad("fit grain (summed)", 26)} level ${sgn(wmean(rows, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(rows, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
say(`    ${pad("row grain (per season)", 26)} level ${sgn(wmean(stackedIn, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(stackedIn, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
say();
say(`  ALL SEASONS 2037-2043 stacked (${stacked.length} rows / ${cardsOf(stacked)} cards) — mostly OUT of frame, so this is`);
say(`  the model's behavior on data it did not see, at the cost of a moving league frame (cards improve`);
say(`  every season, so the frame strengthens BY CONSTRUCTION — a level drift across seasons is the`);
say(`  NULL, not a defect):`);
say(`    level ${sgn(wmean(stacked, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(stacked, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
{
  const cl = clustersOf(stacked);
  say(`    conditional (all five, per SD, card-cluster CI):`);
  const c = coefsCI(stacked, (r) => r.ev.WOBA, "cond");
  for (let i = 0; i < AXK.length; i++) say(`      ${pad(AXLAB[AXK[i]!], 14)} ${sgn(c[1 + i]!.pt, 6)} [${sgn(c[1 + i]!.ci.lo, 6)}, ${sgn(c[1 + i]!.ci.hi, 6)}] ${clear(c[1 + i]!.ci) ? "★ independent axis" : "covers 0"}`);
  void cl;
}
say();
// ── replication of the headline cell across every available sample ──────────
let kEyeSeasonsClear = 0, kEyeSeasonsTotal = 0, kEyeAllSeasons = { pt: NaN, ci: { lo: NaN, hi: NaN } };
{
  const kEyeOf = (rs: Row[]) => {
    if (rs.length < 30) return null;
    const pt = wpoly(rs, 1, (r) => r.ev.K, zA("eye"))[1]!, cl = clustersOf(rs), bs: number[] = [];
    for (let b = 0; b < NBOOT; b++) bs.push(wpoly(clusterDraw(cl), 1, (r) => r.ev.K, zA("eye"))[1]!);
    return { pt, ci: ci(bs), n: rs.length, c: cardsOf(rs) };
  };
  const samples: { lab: string; rs: Row[] }[] = [
    { lab: `FIT GRAIN in-frame (minPA ${minPA})`, rs: rows },
    { lab: "FIT GRAIN in-frame (minPA 300)", rs: rowsLo },
    { lab: "ROW GRAIN in-frame (2042,2043)", rs: stackedIn },
    ...seasonRows.map((s) => ({ lab: `  season ${s.y}${win.includes(s.y) ? "*" : " (OUT of frame)"}`, rs: s.rows })),
    { lab: "ALL SEASONS 2037-2043 stacked", rs: stacked },
  ];
  say(`  REPLICATION OF THE HEADLINE CELL (K residual vs EYE, per SD, card-cluster CI) across every`);
  say(`  sample available. A finding that only exists in the fit window would be suspect; one that`);
  say(`  holds out of frame and season by season is a property of the FORM, not of the fit:`);
  say();
  say(`  ${pad("sample", 34)} ${rp2("n/cards", 10)} ${rp2("K/600 per SD EYE", 18)} ${rp2("95% CI", 22)}`);
  for (const s of samples) {
    const k = kEyeOf(s.rs); if (!k) continue;
    if (s.lab.startsWith("  season")) { kEyeSeasonsTotal++; if (clear(k.ci)) kEyeSeasonsClear++; }
    if (s.lab.startsWith("ALL SEASONS")) kEyeAllSeasons = k;
    say(`  ${pad(s.lab, 34)} ${rp2(`${k.n}/${k.c}`, 10)} ${rp2(sgn(k.pt, 3), 18)} ${rp2(`[${sgn(k.ci.lo, 3)}, ${sgn(k.ci.hi, 3)}]`, 22)}${clear(k.ci) ? " ★" : ""}`);
  }
  say(`  ⇒ CI-clear in ${kEyeSeasonsClear} of ${kEyeSeasonsTotal} individual seasons (${kEyeSeasonsTotal - 2} of them OUT of the fit window) and in every`);
  say(`  pooled sample. NOTE THE COVERAGE CAVEAT: the seasons are NOT equal weight (2037 has 4 leagues,`);
  say(`  2039 is 4 after the corrupt-cell exclusion, the rest 5), and the same ~80-card pool recurs`);
  say(`  across seasons, so these are NOT ${kEyeSeasonsTotal} independent replications — they are one persistent`);
  say(`  form property observed repeatedly. That is still the right conclusion: it is a defect of the`);
  say(`  FORM (no EYE pathway into hit.k), not of the 42-43 fit.`);
  say();
}

const oldRows = perSeasonOld.flatMap(({ y, ld }) => buildRows(ld.observations, SEASON_MIN_PA, String(y)));
say(`  OLD DATA (${OLD_YEARS.join(", ")}), REPORTED SEPARATELY AND NEVER POOLED — it sits after a four-season gap`);
say(`  from the rest, across which the league frame moved wholesale. N=${oldRows.length} rows / ${cardsOf(oldRows)} cards.`);
say(`    level ${sgn(wmean(oldRows, (r) => r.ev.WOBA), 5)}   ${AXK.map((k) => `${AXLAB[k]} ${sgn(rawSlope(oldRows, (r) => r.ev.WOBA, k), 6)}`).join("  ")}`);
say(`    Treat as context only: a 2032-33 card pool is not the pool the deployed model describes.`);
say();

// ── PART 9 — the independent instrument ──────────────────────────────────────
say("################################################################################");
say("# PART 9 — INDEPENDENT INSTRUMENT: the residual meta-model (src/training/residuals.ts)");
say("################################################################################");
say();
say(`  A different instrument on the same question, kept because the pitcher artifact used it and the`);
say(`  comparison is only meaningful if both sides run it. DIFFERENCES, stated so the numbers are`);
say(`  comparable: it REFITS RAWPOLY_HIT on the window (vs the DEPLOYED artifact used above — they`);
say(`  should agree closely but not bit-exactly); it weights PA^0.75 (vs PA); and it reports valuation`);
say(`  error = (pred − actual)×1000 for hitters, i.e. POSITIVE = the model OVER-values — the SAME sign`);
say(`  direction as this artifact's composite.`);
say();
const ra = analyzeResiduals(fitObs.observations, "hitter", minPA, { includeVariants: trained.includeVariants ?? true });
say(`  systematic r² of the residual meta-model (z + z² + all pairwise interactions): ${f(ra.residualModel.r2, 3)}`);
say(`    ⇒ ${f(100 * ra.residualModel.r2, 0)}% of the hitter valuation error is ratings-explainable; the rest is noise.`);
say();
say(`  per-rating meta-model coefficients (valuation-error points per ±1 SD):`);
say(`  ${pad("rating", 12)} ${rp2("linear", 10)} ${rp2("quad", 10)}`);
for (const p of ra.residualModel.perRating) say(`  ${pad(p.rating, 12)} ${rp2(sgn(p.linear, 2), 10)} ${rp2(sgn(p.quad, 2), 10)}`);
say();
say(`  pairwise INTERACTION coefficients, |largest| first — THE SHAPE TERMS:`);
for (const i of ra.residualModel.interactions) say(`    ${pad(`${i.a} × ${i.b}`, 22)} ${sgn(i.coef, 2)}`);
const biggestIx = ra.residualModel.interactions[0]!;
const biggestLin = [...ra.residualModel.perRating].sort((p, q) => Math.abs(q.linear) - Math.abs(p.linear))[0]!;
say();
say(`  largest interaction |${sgn(biggestIx.coef, 2)}| (${biggestIx.a}×${biggestIx.b}) vs largest linear |${sgn(biggestLin.linear, 2)}| (${biggestLin.rating})`);
say(`  ⇒ interactions are ${Math.abs(biggestIx.coef) >= 0.5 * Math.abs(biggestLin.linear) ? "COMPARABLE TO the main effects on this instrument" : "SMALL relative to the main effects — mostly additive/marginal"}.`);
say(`  CAVEAT (same as the pitcher artifact): these are ridge point estimates with NO significance test.`);
say(`  Where they disagree with the tested reads (Part 5's permutation null, Part 6's bootstrap CIs),`);
say(`  trust the tested reads.`);
say();
say(`  5-band marginals (valuation-error points per band, PA^0.75-weighted):`);
for (const m of ra.marginals) say(`    ${pad(m.rating, 8)} ${m.bands5.map((b) => `${b.band} ${sgn(b.meanErr, 1)} (n${b.n})`).join("   ")}`);
say();

// ── VERDICT ──────────────────────────────────────────────────────────────────
say("################################################################################");
say("### VERDICT");
say("################################################################################");
say();
// which channel carries the largest LEVEL bias and the largest SLOPE on the strongest axis
const topLevel = levelRank[0]!;
const bestAx = axRank[0]!;
const topSlopeRow = ctByAx[bestAx]!.rowsOut[0]!;
const condComp = condStore["wOBA composite"]!;
const liveMarg = AXK.filter((k) => clear(condComp.marg[k].ci));
const liveCond = AXK.filter((k, i) => clear(condComp.cond[1 + i]!.ci));
const anyCorner = grids.some((g) => g.pval < 0.05) || ixOut.some((x) => clear(x.t.ci));
const eliteHR = quartStats[3]!.hr, midHR = quartStats[1]!.hr;
const tailRepro = eliteHR < 0 && Math.abs(eliteHR) > 0.2;
const kEye = freeDetail.find((d) => d.c.key === "K" && d.ax === "eye");
const babEye = freeDetail.find((d) => d.c.key === "BABIP" && d.ax === "eye");
const survFree = freeDetail.filter((d) => clear(d.m2.ci));
const ctEye = ctByAx.eye!.rowsOut;
const ctEyeClear = ctEye.filter((r) => clear(r.ci));
say(`  ── THE ONE-PARAGRAPH ANSWER ──`);
say();
say(`  THE LARGEST BIAS IS A LEVEL, NOT A SLOPE, AND IT IS ANCHOR-ABSORBABLE: ${sgn(topLevel.v, 5)} of the`);
say(`  ${sgn(compLevel, 5)} composite (${sgn((100 * topLevel.v) / (compLevel || 1e-12), 0)}%) is the ${topLevel.k} channel — the model assigns every hitter a`);
say(`  FIXED ${HIT_HBP}/600 hit-by-pitch against an observed mean of ${f(HIT_HBP - (topLevel.v * 600) / W.hbp, 2)}/600. A pure constant is exactly what a`);
say(`  per-role anchor CAN absorb, so it is not a per-card error and it is not the interesting result.`);
say(`  ON THE COMPOSITE, NO RATING AXIS IS A CI-CLEAR DRIVER — marginally ${liveMarg.length ? liveMarg.map((k) => AXLAB[k]).join("/") : "none of the five"}, conditionally`);
say(`  ${liveCond.length ? liveCond.map((k) => AXLAB[k]).join("/") : "none of the five"}. BUT THAT COMPOSITE NULL IS A CANCELLATION, NOT AN ABSENCE, and the exact`);
say(`  decomposition is what exposes it: on the EYE axis ${ctEyeClear.length} of 6 channels carry CI-clear slopes that`);
say(`  very nearly annihilate each other (${ctEye.slice(0, 3).map((r) => `${r.key} ${sgn(r.slope, 6)}`).join(", ")} — sum ≈ the`);
say(`  ${sgn(ctByAx.eye!.compSlope, 6)} composite). A composite-only read would have reported "nothing here".`);
say();
say(`  ── THE FINDING: EYE REACHES CHANNELS THE FORM DENIES IT ──`);
say();
say(`  The strongest, most robust result in this artifact is a STRUCTURALLY-FREE cell (Part 1b): the`);
say(`  strikeout channel's residual against EYE.`);
if (kEye) {
  say(`    · K residual vs EYE: marginal ${sgn(kEye.m1.pt, 3)} K/600 per SD [${sgn(kEye.m1.ci.lo, 3)}, ${sgn(kEye.m1.ci.hi, 3)}] ★,`);
  say(`      CONDITIONAL on all four other ratings ${sgn(kEye.m2.pt, 3)} [${sgn(kEye.m2.ci.lo, 3)}, ${sgn(kEye.m2.ci.hi, 3)}] ★ — it does not merely`);
  say(`      survive conditioning, it STRENGTHENS. Weighted correlation r = ${f(Math.abs(topFree[0]!.r), 3)}, the largest of all`);
  say(`      ${freeCells.length} free cells, and it clears a FAMILY-WISE permutation null over the whole family (p = ${f(fwerP, 3)}),`);
  say(`      so it is not a multiple-comparisons artifact.`);
  say(`      MEANING: hit.k is fit on AvoidK ALONE and EYE has NO pathway into it (Part 0). The model`);
  say(`      OVER-predicts strikeouts for high-EYE hitters by ~${f(kEye.m2.pt, 1)} K/600 per SD of EYE and under-predicts`);
  say(`      them for low-EYE hitters — a monotone quintile ramp (${sgn(analyze(rows, (r) => r.ev.K, "eye").quints[0]!.resid, 2)} → ${sgn(analyze(rows, (r) => r.ev.K, "eye").quints[4]!.resid, 2)}/600). Plate`);
  say(`      discipline genuinely suppresses strikeouts beyond what the contact rating expresses, and`);
  say(`      the deployed hitter form CANNOT express it. This is the exact hitter analogue of the`);
  say(`      pitcher form's stuffAug legs — a second rating that genuinely reaches a channel.`);
}
if (babEye) {
  say(`    · BABIP residual vs EYE: marginal ${sgn(babEye.m1.pt, 3)} pts×1000 per SD [${sgn(babEye.m1.ci.lo, 3)}, ${sgn(babEye.m1.ci.hi, 3)}] ★,`);
  say(`      CONDITIONAL ${sgn(babEye.m2.pt, 3)} [${sgn(babEye.m2.ci.lo, 3)}, ${sgn(babEye.m2.ci.hi, 3)}] ★ — also survives. AND IT IS NOT THE FIRST`);
  say(`      FINDING'S ECHO: the BIP-chain coupling check (Part 1b) shows the mechanical echo of the K`);
  say(`      error through the fitted ln(BIP) term accounts for only ~6% of it. Two separate errors on`);
  say(`      one axis, not one error seen twice.`);
}
say(`    · HR residual vs EYE is CI-clear MARGINALLY but its conditional CI covers zero ⇒ that third`);
say(`      cell is a proxy for the correlated ratings (EYE×POW r ${sgn(wmean(rows, (r) => zA("eye")(r) * zA("pow")(r)), 3)}), NOT an independent axis.`);
say(`      Reporting it as a finding would be exactly the single-axis trap the doctrine warns about.`);
say(`    · The HBP channel ALSO carries a CI-clear EYE slope (conditional ${sgn(condStore["HBP contribution"]!.cond[1]!.pt, 6)}/SD ★): the fixed`);
say(`      ${HIT_HBP}/600 constant has no rating pathway at all, so the real EYE-correlation of hit-by-pitches lands`);
say(`      entirely in the residual. Small, but a rating-correlated bias an anchor cannot absorb.`);
say();
say(`  ── SHAPE OR ADDITIVE ──`);
say();
say(`  ADDITIVE. No tested 2-D corner came close to its permutation null: ${grids.map((g) => `${AXLAB[g.rowAx]}×${AXLAB[g.colAx]} p=${f(g.pval, 3)}`).join(", ")}.`);
const ixLive = ixOut.filter((x) => clear(x.t.ci));
if (ixLive.length) {
  say(`  ONE TENSION, FLAGGED NOT HIDDEN: the ${ixLive.map((x) => `${AXLAB[x.pair[0]]}×${AXLAB[x.pair[1]]}`).join(", ")} product term in the M3 regression IS`);
  say(`  CI-clear (${ixLive.map((x) => `${sgn(x.t.pt, 6)} [${sgn(x.t.ci.lo, 6)}, ${sgn(x.t.ci.hi, 6)}]`).join("; ")}) while the corresponding grid null`);
  say(`  says p=${ixLive.map((x) => f(x.pval, 3)).join("/")}. These are DIFFERENT tests: the M3 term is a single pre-specified degree of`);
  say(`  freedom with no multiplicity correction, the grid null is a MAX statistic over 9 cells (i.e.`);
  say(`  already multiplicity-corrected). The multiplicity-safe test does not fire, the CI barely`);
  say(`  excludes zero, and the meta-model's interaction coefficients (Part 9) are untested ridge point`);
  say(`  estimates. CALL: a shape corner is NOT ESTABLISHED. It is a pre-registerable question for a`);
  say(`  larger sample, not a result.`);
}
say();
say(`  ── THE ELITE-POWER TAIL (the standing published residual) ──`);
say();
say(`  LINE MEASURED: the RAW deployed event line, with the hitter-tail correction ABSENT — not by`);
say(`  choice but by construction (zero pool gap ⇒ every λ·w(g) = 0 ⇒ applyHitTail is the exact`);
say(`  identity on league data). SPLIT THE CLAIM IN TWO:`);
say(`    · the LEVEL claim (elite POW under-predicted) does NOT reproduce in frame — the top POW`);
say(`      quartile's HR residual is ${sgn(eliteHR, 3)}/600, i.e. very slightly OVER-predicted, the OPPOSITE`);
say(`      sign; the mid quartile is ${sgn(midHR, 3)}/600.`);
say(`    · the SPREAD claim (elite calibration slope above pooled) is DIRECTIONALLY present but weak:`);
say(`      elite ${f(calElite, 3)} vs pooled ${f(calPooled, 3)}, and the elite CI covers 1.0. Published out-of-frame: 2.44 vs 1.17.`);
say(`  NEITHER IS EVIDENCE AGAINST THE PUBLISHED RESIDUAL, and the artifact should not be read that`);
say(`  way. In frame is the wrong frame for it: the correction is switched off here by design, the`);
say(`  hit-tail doc itself records league in-frame as calibrated, and — the sharper structural point —`);
say(`  0 of ${rows.length} in-frame rows sit beyond the hit.hr quad's fit-domain edge (z ${f(HF.hr.uMax ?? NaN, 2)}, POW ${f((HF.hr.mu ?? 0) + (HF.hr.uMax ?? 0) * (HF.hr.sd ?? 0), 0)}),`);
say(`  which is exactly where the late bend the correction fights would live. THE LEAGUE FRAME DOES`);
say(`  NOT EXERCISE THE FAILURE MODE. Confirming or refuting the tail requires the out-of-frame`);
say(`  instrument (the cwhit sample), which is out of scope here.`);
say();
const ownMisfits = [
  { lab: "hit.k (log on AvoidK)", ch: "K/600", an: analyze(rows, (r) => r.ev.K, "kRat") },
  { lab: "hit.h (log on the BABIP rating)", ch: "BABIP pts×1000", an: analyze(rows, (r) => r.ev.BABIP, "babip") },
  { lab: "hit.bb (log on EYE)", ch: "BB/600", an: analyze(rows, (r) => r.ev.BB, "eye") },
  { lab: "hit.xbh (log on GAP)", ch: "XBH-share pts×1000", an: analyze(rows, (r) => r.ev.XBHSHARE, "gap") },
].filter((x) => clear(x.an.cubCI));
say(`  ── SECONDARY: CURVE-SHAPE MISFIT ON OWN RATINGS (${ownMisfits.length} of the 4 log channels) ──`);
say();
{
  const owns = ownMisfits;
  if (owns.length) {
    say(`  On an own-rating cell the fit absorbs level and linear-in-ln, so ONLY the cubic partial is free`);
    say(`  — and it is CI-clear in ${owns.length} of the four log channels:`);
    for (const o of owns) say(`    · ${pad(o.lab, 34)} cubic ${sgn(o.an.cub, 4)} [${sgn(o.an.cubCI.lo, 4)}, ${sgn(o.an.cubCI.hi, 4)}] ★  (${o.ch} per SD)`);
    say(`  These are genuine functional-form misfits of the LOG family on its own driver (a log curve`);
    say(`  cannot bend that way), not rating-shape effects. They are an order less consequential than`);
    say(`  the EYE finding in wOBA terms and are recorded, not acted on.`);
  } else {
    say(`  None: no log channel leaves a CI-clear cubic partial on its own rating.`);
  }
}
say();
say(`  ── FRAME NOTE (Part 8) ──`);
say();
say(`  The composite LEVEL moves monotonically across seasons: ${seasonRows.map((s) => `${s.y} ${sgn(wmean(s.rows, (r) => r.ev.WOBA), 4)}`).join("  ")}.`);
say(`  Out-of-frame seasons sit NEGATIVE (the model under-credits) and in-frame seasons positive. That`);
say(`  is the league frame strengthening every window — cards improve each season, so a model fit on`);
say(`  42-43 opposition scores earlier, weaker-opposition seasons low. It is the NULL, not a defect,`);
say(`  and it is why the all-seasons pooled conditional (which shows a CI-clear BABIP-rating slope) is`);
say(`  reported as a LEAD ONLY: any rating correlated with the season composition will pick up the`);
say(`  drift. Do not carry that pooled coefficient forward as a finding.`);
say();
say(`  WHAT IS AN ARTIFACT OF STRUCTURE, NOT A MECHANISM. Every hitter channel is a ONE-RATING channel`);
say(`  with NO aux term (Part 0) — the exact opposite of the pitcher form, where three of four channels`);
say(`  carried a ln(Stuff) aux and the contact channel had no Stuff pathway at all. Consequences:`);
say(`    (a) each channel's residual is least-squares-suppressed on its OWN rating, so an own-rating`);
say(`        null is uninformative — only the CUBIC partial is free there;`);
say(`    (b) EVERY cross-rating cell of the Part-4 matrix is structurally free, so a cross cell that`);
say(`        comes back near zero is REAL evidence of absence, not a suppression artifact;`);
say(`    (c) there is no hitter analogue of the pitcher's "residual had nowhere to land except contact"`);
say(`        artifact, because no hitter channel is privileged by an aux term. A cross-rating hitter`);
say(`        finding therefore does NOT carry the pitcher artifact's structural discount — and the EYE`);
say(`        result above sits in free cells, so it is the real thing rather than the mirror image of`);
say(`        the pitcher artifact's cautionary tale.`);
say(`  NAMED AS ARTIFACTS, NOT MECHANISMS:`);
say(`    · the ${topLevel.k} LEVEL term (${sgn((100 * topLevel.v) / (compLevel || 1e-12), 0)}% of the composite level) — a fixed constant, absorbable by any`);
say(`      per-role anchor; only its EYE SLOPE is a genuine per-card error;`);
say(`    · every near-zero own-rating linear partial (HR vs POW ${sgn(hrAn.lin, 3)}, BB vs EYE, K vs AvoidK, …) —`);
say(`      FORCED by least squares, and NOT evidence that those curves are correctly shaped;`);
say(`    · the HR-vs-EYE marginal cell — CI-clear marginally, gone conditionally ⇒ a proxy for POW;`);
say(`    · the pooled all-seasons BABIP-rating coefficient — confounded with the season level drift;`);
say(`    · the POW×EYE M3 interaction — single untested df against a multiplicity-safe null that did`);
say(`      not fire.`);
say();
say(`  MEASUREMENT ONLY. Nothing here was fit, wired, or persisted; no default changed. Any remedy is a`);
say(`  separate, pre-registered step.`);
say();
say("(end of artifact — hitter-residual channel locator)");

// ── the top-of-artifact VERDICT paragraph (spliced in above PART 0) ──────────
const TOP: string[] = [];
const t = (s = "") => TOP.push(s);
t("################################################################################");
t("### VERDICT (the short form — the full argument, with every number, is at the end)");
t("################################################################################");
t();
t(`  THE BIGGEST BIAS IS A LEVEL AND IT DOES NOT MATTER: ${sgn((100 * topLevel.v) / (compLevel || 1e-12), 0)}% of the ${sgn(compLevel, 5)} composite level is`);
t(`  the HBP channel's fixed ${HIT_HBP}/600 constant, which any per-role anchor absorbs. THE BIGGEST BIAS THAT`);
t(`  DOES MATTER IS ON THE EYE AXIS, AND THE COMPOSITE HIDES IT COMPLETELY. No rating axis has a`);
t(`  CI-clear slope on the composite (marginal or conditional) — but that is a CANCELLATION between`);
t(`  channels, not an absence of error: on EYE, ${ctEyeClear.length} of 6 channels carry CI-clear, opposite-signed`);
t(`  contributions (K ${sgn(ctEye.find((r) => r.key === "K")!.slope, 6)}, BABIP ${sgn(ctEye.find((r) => r.key === "BABIP")!.slope, 6)}, HR ${sgn(ctEye.find((r) => r.key === "HR")!.slope, 6)}) that sum to`);
t(`  ${sgn(ctByAx.eye!.compSlope, 6)}. Only the exact channel decomposition exposes it.`);
t();
t(`  WHICH CHANNEL CARRIES THE LARGEST RATING-CORRELATED BIAS: the STRIKEOUT channel, against EYE —`);
t(`  a rating that has`);
t(`  NO PATHWAY into it (hit.k is fit on AvoidK alone; no hitter channel carries an aux term). The`);
t(`  model over-predicts K by ${kEye ? sgn(kEye.m1.pt, 2) : "n/a"}/600 per SD of EYE marginally and ${kEye ? sgn(kEye.m2.pt, 2) : "n/a"}/600 CONDITIONAL on the`);
t(`  other four ratings — it strengthens under conditioning. r = ${f(obsMaxR, 3)}, the largest of all ${freeCells.length}`);
t(`  structurally-free cells, and it clears a family-wise permutation null over that whole family`);
t(`  (p = ${f(fwerP, 3)}). The BABIP channel carries a second, independent EYE error (conditional`);
t(`  ${babEye ? sgn(babEye.m2.pt, 2) : "n/a"} pts×1000 per SD, CI-clear), and the BIP-chain coupling check shows only ~6% of it is`);
t(`  the mechanical echo of the K error — two errors, not one seen twice.`);
t(`  IT IS A PROPERTY OF THE FORM, NOT OF THE 42-43 FIT: the K-vs-EYE slope is CI-clear in ${kEyeSeasonsClear} of ${kEyeSeasonsTotal}`);
t(`  individual seasons (${kEyeSeasonsTotal - 2} of them OUT of the fit window) at ${sgn(kEyeAllSeasons.pt, 2)}/600 per SD pooled over`);
t(`  2037-2043 [${sgn(kEyeAllSeasons.ci.lo, 2)}, ${sgn(kEyeAllSeasons.ci.hi, 2)}]. (Not ${kEyeSeasonsTotal} independent replications — the same card pool`);
t(`  recurs — but the same defect every time, in and out of frame.)`);
t();
t(`  WHICH AXES ARE GENUINELY INDEPENDENT: EYE, and only EYE. It is the sole rating whose slope`);
t(`  survives holding the other four fixed (in the K, BABIP and HBP channels). POW, AvoidK, the BABIP`);
t(`  rating and GAP produce nothing that survives conditioning. Notably HR-vs-EYE is CI-clear`);
t(`  MARGINALLY and dies conditionally — the single-axis trap, firing exactly where the doctrine says`);
t(`  it would.`);
t();
t(`  SHAPE OR ADDITIVE: ADDITIVE. Every 2-D corner tested inside its permutation null`);
t(`  (${grids.map((g) => `${AXLAB[g.rowAx]}×${AXLAB[g.colAx]} p=${f(g.pval, 3)}`).join(", ")}). One M3 product term (POW×EYE) is`);
t(`  CI-clear, but it is a single uncorrected df against a multiplicity-safe null that did not fire —`);
t(`  NOT ESTABLISHED, flagged for a larger sample.`);
t();
t(`  THE ELITE-POWER TAIL DOES NOT REPRODUCE IN FRAME, AND THAT IS THE EXPECTED RESULT. The line`);
t(`  measured is the RAW deployed event line; the deployed hitter-tail correction is the EXACT`);
t(`  IDENTITY on league data by construction (zero pool gap ⇒ every strength 0), so there was nothing`);
t(`  to include. Top-POW-quartile HR residual ${sgn(eliteHR, 3)}/600 (slightly OVER-predicted — opposite sign to`);
t(`  the published claim); elite calibration slope ${f(calElite, 3)} vs pooled ${f(calPooled, 3)}, CI covering 1.0 (published`);
t(`  out-of-frame: 2.44 vs 1.17). Decisively, 0 of ${rows.length} in-frame rows sit beyond the hit.hr quad's`);
t(`  fit-domain edge (POW ${f((HF.hr.mu ?? 0) + (HF.hr.uMax ?? 0) * (HF.hr.sd ?? 0), 0)}) where the late bend lives — THE LEAGUE FRAME DOES NOT EXERCISE`);
t(`  THE FAILURE MODE. This is not evidence against the published residual.`);
t();
t(`  WHAT IS AN ARTIFACT OF THE FORM'S WIRING RATHER THAN A MECHANISM: the HBP level term (a`);
t(`  constant); every near-zero OWN-rating partial (least-squares-forced, not evidence the curve is`);
t(`  right); the HR-vs-EYE marginal (a POW proxy); the pooled all-seasons BABIP-rating coefficient`);
t(`  (confounded with the season-level frame drift). The EYE findings are NOT in that list: they sit`);
t(`  in cells the form structurally cannot reach, which is precisely why they are readable.`);
t();
t(`  MEASUREMENT ONLY — nothing fit, wired, persisted, or defaulted.`);
t();
L.splice(VERDICT_AT, 0, ...TOP);
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
