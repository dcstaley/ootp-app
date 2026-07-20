// cwhit BENCHMARK SCORECARD core (work-order P1d) — the pure machinery behind `tools/cwhit-scorecard.ts`.
// Supersedes the ad-hoc statistics inside `tools/cwhit-triangulate.ts` (v1), whose headline
// `mean|pred−obs|` CONFLATED level and shape and is banned as a headline (two-axis doctrine).
//
// What lives here:
//   1. PROJECTED-table parsers (cwhit's own tournament-native model output) + provenance parsing.
//   2. WINDOW OVERLAP — his model's training window vs the observed judging window. His projections
//      are SEMI-IN-SAMPLE against the data we judge on; ours are honest OOS. Never compare silently.
//   3. cwhit's rate CONVENTIONS (his hitter SO% is K/AB, ours is K/PA — verified empirically across
//      all four tiers by reconstructing BABIP both ways: K/AB residual 0.003 vs K/PA residual 0.012).
//   4. The LEVEL / SHAPE / SPREAD decomposition with CIs, observed-noise deconvolution, and a paired
//      bootstrap DUEL for "is cwhit's edge real?".
//
// GROUND-TRUTH DISCIPLINE (memory cwhitstats-external-data + handoff §7): cwhit's RAW OBSERVED
// events are ground truth. His PROJECTIONS are a COMPETITOR BENCHMARK — weight ZERO as truth, never
// a fitting target. His pwOBA column is never used as truth; wOBA is recomputed from raw events with
// OUR weights. Nothing in this file feeds the scoring path.

import { IP_TO_BF } from "./parse.ts";
// audit.ts imports NOTHING, so this cannot cycle. (sample.ts imports THIS file, so this file must
// never import sample.ts — hence the composite-noise helpers below take plain rates, not a `Rec`.)
import { hitWobaFromRates, pitWobaFromChannels, type WobaWeights } from "./audit.ts";

// ── provenance ───────────────────────────────────────────────────────────────

export interface CwhitProjMeta {
  format: string;          // e.g. "Bronze Quick"
  role: "pit" | "hit";
  projectedOn?: string;    // ISO date the projections were pulled
  trainFrom?: string;      // ISO — cwhit's model training window
  trainTo?: string;
  topN?: number;
  headerLine: string;
}

/** Every ISO date in a string, tolerating a SHORT second date ("2026-07-04..07-12" — the real
 *  fixture's form): a bare MM-DD inherits the preceding date's year. */
function isoDates(s: string): string[] {
  const out: string[] = [];
  let year = "";
  for (const m of s.matchAll(/(\d{4})-(\d{2})-(\d{2})|(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g)) {
    if (m[1]) { year = m[1]; out.push(`${m[1]}-${m[2]}-${m[3]}`); }
    else if (year) out.push(`${year}-${m[4]}-${m[5]}`);
  }
  return out;
}

/** Parse the `#` provenance line of a PROJECTED table. Tolerant: pulls the format, the projection
 *  date, the model TRAINING window, and the top-N cap from a free-form header. */
export function parseCwhitProjMeta(headerLine: string, role: "pit" | "hit"): CwhitProjMeta {
  const meta: CwhitProjMeta = { format: "", role, headerLine };
  const body = headerLine.replace(/^#\s*/, "");
  const parts = body.split("|").map((s) => s.trim());
  if (parts[0]) meta.format = parts[0].replace(/\bPROJECTED\b/i, "").replace(/\s*\(.*$/, "").replace(/\s+(pitchers|hitters)\s*$/i, "").trim();
  for (const p of parts) {
    let m: RegExpMatchArray | null;
    if ((m = p.match(/train(?:ed|ing)[^0-9]*(.+)$/i))) { const d = isoDates(m[1]!); if (d[0]) meta.trainFrom = d[0]; if (d[1]) meta.trainTo = d[1]; }
    if ((m = p.match(/projections?[^0-9]*(\d{4}-\d{2}-\d{2})/i))) meta.projectedOn = m[1];
    if ((m = p.match(/top\s+(\d+)/i))) meta.topN = Number(m[1]);
  }
  return meta;
}

export interface WindowOverlap {
  obsFrom?: string; obsTo?: string; trainFrom?: string; trainTo?: string;
  obsDays: number; trainDays: number; overlapDays: number;
  overlapPctOfObs: number;     // share of the JUDGING window his model already saw
  verdict: string;
}

const DAY = 86_400_000;
const days = (a?: string, b?: string): number => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1 : NaN);

/** Overlap of cwhit's TRAINING window with the OBSERVED (judging) window. The headline confound:
 *  he is fit on data that is inside what we score him against; we are not. */
export function windowOverlap(obsFrom?: string, obsTo?: string, trainFrom?: string, trainTo?: string): WindowOverlap {
  const obsDays = days(obsFrom, obsTo), trainDays = days(trainFrom, trainTo);
  let overlapDays = NaN, overlapPctOfObs = NaN, verdict = "UNKNOWN — a window is missing from a fixture header; cannot state in/out-of-sample status";
  if (Number.isFinite(obsDays) && Number.isFinite(trainDays)) {
    const lo = Math.max(Date.parse(obsFrom!), Date.parse(trainFrom!)), hi = Math.min(Date.parse(obsTo!), Date.parse(trainTo!));
    overlapDays = hi >= lo ? Math.round((hi - lo) / DAY) + 1 : 0;
    overlapPctOfObs = (overlapDays / obsDays) * 100;
    verdict = overlapDays <= 0
      ? "DISJOINT — cwhit is out-of-sample too; the comparison is like-for-like"
      : overlapPctOfObs >= 99
        ? "FULLY IN-SAMPLE for cwhit — he was fit on the whole judging window; ours is honest OOS. His edge is UPPER-BOUNDED, not measured."
        : `SEMI-IN-SAMPLE for cwhit — he was fit on ${overlapPctOfObs.toFixed(0)}% of the judging window; ours is honest OOS. His edge is BIASED UPWARD by an unknown amount.`;
  }
  return { obsFrom, obsTo, trainFrom, trainTo, obsDays, trainDays, overlapDays, overlapPctOfObs, verdict };
}

// ── projected-table parsing (defensive: unknown header ⇒ fail loudly) ────────

export interface CwhitProjPitRow {
  title: string; role?: string; val: number; vlvl: number; hand: string;
  pwoba: number;                                   // his model's wOBA — reference ONLY, never truth
  kPerPa: number; bbPerPa: number; hrPerPa: number; babip: number;
}
export interface CwhitProjHitRow {
  title: string; pos?: string; val: number; vlvl: number; hand: string;
  pwoba: number;                                   // reference ONLY
  bbPerPa: number; kPerPa: number; hrPer600: number; babip: number;
  xbhPct: number;                                  // cwhit's own column, verbatim ((2B+3B+HR)/H)
  abPerPa: number;                                 // the AB/PA used for the K/AB→K/PA conversion
  soConvention: string; hrConvention: string; xbhConvention: string;
}

/** Split a projected TSV. `#` lines are COMMENTS and there may be ANY number of them (the pitcher
 *  tables carry 1 = provenance; the hitter tables carry 2 = provenance + a conventions NOTE). Consume
 *  every leading `#` line rather than a fixed count — assuming one silently ate the hitter tables'
 *  column row and made the parser report "cwhit changed his table". First `#` line = provenance. */
function splitTsv(tsv: string): { headerLine: string; notes: string[]; cols: string[]; rows: string[][] } {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const comments: string[] = [];
  while (lines[0]?.startsWith("#")) comments.push(lines.shift()!);
  const cols = (lines.shift() ?? "").split("\t").map((c) => c.trim());
  return { headerLine: comments[0] ?? "", notes: comments.slice(1), cols, rows: lines.map((l) => l.split("\t")) };
}
const num = (v: string | undefined): number => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };

/** Resolve a logical field to a column index from an alias list. Returns the MATCHED alias too, so
 *  callers can branch on a detected convention (e.g. HR600 vs HRpct). */
function resolve(cols: string[], aliases: string[]): { i: number; via: string } {
  const lower = cols.map((c) => c.toLowerCase());
  for (const a of aliases) { const i = lower.indexOf(a.toLowerCase()); if (i >= 0) return { i, via: cols[i]! }; }
  return { i: -1, via: "" };
}
function require_(cols: string[], headerLine: string, file: string, aliases: string[]): { i: number; via: string } {
  const r = resolve(cols, aliases);
  if (r.i < 0) {
    throw new Error(
      `[cwhit-scorecard] ${file}: cannot find a column for [${aliases.join(" | ")}].\n` +
      `  provenance: ${headerLine || "(none)"}\n  ACTUAL columns: ${cols.join(" | ")}\n` +
      `  → cwhit changed his table. Add the real column name to the alias list in src/eval/cwhit/scorecard.ts.`,
    );
  }
  return r;
}

const A_TITLE = ["Name", "Card Title", "//Card Title", "Card"];
const A_VAL = ["VAL", "Value", "Card Value"];
const A_VLVL = ["VLvl", "VL", "Variant", "Variant Level"];
const A_HAND = ["Hand", "Bats", "Throws"];
const A_PWOBA = ["pwOBA", "wOBA", "pWOBA", "proj wOBA"];
const A_BABIP = ["BABIP", "pBABIP"];

export function parseCwhitProjPit(tsv: string, file = "proj-pit"): { meta: CwhitProjMeta; rows: CwhitProjPitRow[] } {
  const { headerLine, cols, rows } = splitTsv(tsv);
  const meta = parseCwhitProjMeta(headerLine, "pit");
  const R = (a: string[]) => require_(cols, headerLine, file, a).i;
  const iTitle = R(A_TITLE), iVal = R(A_VAL), iVlvl = R(A_VLVL), iHand = R(A_HAND), iPw = R(A_PWOBA);
  const iK = R(["Kpct", "K%", "SOpct", "SO%"]), iBb = R(["BBpct", "BB%"]), iHr = R(["HRpct", "HR%"]), iBa = R(A_BABIP);
  const iRole = resolve(cols, ["Role", "POS", "Position"]).i;
  const out = rows.filter((r) => (r[iTitle] ?? "").trim()).map((r): CwhitProjPitRow => ({
    title: r[iTitle]!.trim(), role: iRole >= 0 ? (r[iRole] ?? "").trim() : undefined,
    val: num(r[iVal]), vlvl: num(r[iVlvl]), hand: (r[iHand] ?? "").trim(), pwoba: num(r[iPw]),
    // His pitcher %-columns are per-BATTER-FACED (per-PA). Verified by reconstructing his own pwOBA
    // from these four channels: the per-PA reading lands on his published pwOBA (0.2877 vs 0.287 for
    // the lead row); the per-AB reading misses by ~0.004. Unlike his HITTER SO%, no AB conversion.
    kPerPa: num(r[iK]) / 100, bbPerPa: num(r[iBb]) / 100, hrPerPa: num(r[iHr]) / 100, babip: num(r[iBa]),
  }));
  return { meta, rows: out };
}

export function parseCwhitProjHit(tsv: string, file = "proj-hit"): { meta: CwhitProjMeta; rows: CwhitProjHitRow[] } {
  const { headerLine, cols, rows } = splitTsv(tsv);
  const meta = parseCwhitProjMeta(headerLine, "hit");
  const R = (a: string[]) => require_(cols, headerLine, file, a);
  const iTitle = R(A_TITLE).i, iVal = R(A_VAL).i, iVlvl = R(A_VLVL).i, iHand = R(A_HAND).i, iPw = R(A_PWOBA).i, iBa = R(A_BABIP).i;
  const iBb = R(["BBpct", "BB%"]).i;
  const so = R(["SOpct", "SO%", "Kpct", "K%"]);
  const hr = R(["HR600", "HRpct", "HR%", "HR/600"]);
  const iPos = resolve(cols, ["POS", "Pos", "Position"]).i;
  // AVG/OBP give AB/PA EXACTLY per row. The projected table has neither, so fall back to the
  // BB-derived estimate (still row-specific, and 4.5× tighter than a flat constant — see abPerPaFromBb).
  const iAvg = resolve(cols, ["AVG", "BA"]).i, iObp = resolve(cols, ["OBP"]).i;
  const iXbh = resolve(cols, ["XBHpct", "XBH%"]).i;
  const hrIsPct = /pct|%/i.test(hr.via);
  // cwhit's OBSERVED hitter SO% is K/AB (verified). His PROJECTED table is assumed to follow the same
  // convention when the column is named SOpct/SO%; a Kpct/K% column is read as per-PA (his pitcher form).
  const soIsPerAb = /^so/i.test(so.via);
  const exactAb = iAvg >= 0 && iObp >= 0;

  const out = rows.filter((r) => (r[iTitle] ?? "").trim()).map((r): CwhitProjHitRow => {
    const bbPerPa = num(r[iBb]) / 100, soRaw = num(r[so.i]) / 100;
    const abPa = exactAb ? abPerPa(num(r[iAvg]), num(r[iObp]), bbPerPa) : abPerPaFromBb(bbPerPa);
    return {
      title: r[iTitle]!.trim(), pos: iPos >= 0 ? (r[iPos] ?? "").trim() : undefined,
      val: num(r[iVal]), vlvl: num(r[iVlvl]), hand: (r[iHand] ?? "").trim(), pwoba: num(r[iPw]),
      bbPerPa, kPerPa: soIsPerAb ? soRaw * abPa : soRaw,
      hrPer600: hrIsPct ? num(r[hr.i]) / 100 * 600 : num(r[hr.i]),
      babip: num(r[iBa]), xbhPct: iXbh >= 0 ? num(r[iXbh]) : NaN, abPerPa: abPa,
      soConvention: `${so.via} → ${soIsPerAb ? `K/AB, converted to K/PA via AB/PA=${abPa.toFixed(3)} (${exactAb ? "exact, from this row's AVG/OBP" : "from this row's BB; no AVG/OBP in the projected table"})` : "K/PA (as-is)"}`,
      hrConvention: `${hr.via} → ${hrIsPct ? "per-PA rate ×600 ⇒ HR600 (observed table's unit)" : "per 600 PA"}`,
      xbhConvention: iXbh >= 0 ? `${cols[iXbh]} → (2B+3B+HR)/H [measured]; HR subtracted to get the non-HR XBH our wOBA weight applies to` : "no XBH column — falling back to a FIXED 0.30 non-HR XBH share",
    };
  });
  return { meta, rows: out };
}

// ── cwhit rate conventions ───────────────────────────────────────────────────

export const HBP_PER_PA = 0.008;
export const AB_PER_PA_FALLBACK = 0.925;   // last resort only: neither AVG/OBP nor BB available

/** Sacrifice (SF+SH) per PA. MEASURED, not assumed: AB = PA − BB − HBP − SF − SH, so the exact
 *  AVG/OBP identity minus (1 − BB/PA − HBP/PA) isolates the sac term. Over all 5 observed hitter
 *  tables (N=500) that signed residual is a TIGHT, CONSISTENT −0.0124 (sd 0.0082) — a bias, not
 *  noise, so folding it in is a correction rather than a fudge. */
export const SAC_PER_PA = 0.0124;

/** AB/PA implied by a row's own AVG + OBP: H/PA = OBP − BB/PA − HBP/PA and AB = H/AVG.
 *  EXACT from cwhit's published columns (no assumption beyond the small fixed HBP rate). */
export function abPerPa(avg: number, obp: number, bbPerPa: number, hbpPerPa = HBP_PER_PA): number {
  if (!(avg > 0)) return AB_PER_PA_FALLBACK;
  const r = (obp - bbPerPa - hbpPerPa) / avg;
  return Number.isFinite(r) && r > 0.5 && r < 1 ? r : AB_PER_PA_FALLBACK;
}

/** AB/PA from BB alone — for cwhit's PROJECTED hitter table, which publishes NO AVG/OBP so the exact
 *  identity above is unavailable. Row-specific (a high-BB card really does have fewer AB/PA), which a
 *  constant cannot be. VALIDATED against the exact identity on the observed tables (N=500): mean|err|
 *  0.0057 vs 0.0262 for the flat 0.925 — ~4.5× tighter, i.e. ≤0.12pp of K/PA on a 20% K/AB hitter. */
export function abPerPaFromBb(bbPerPa: number, hbpPerPa = HBP_PER_PA, sacPerPa = SAC_PER_PA): number {
  const r = 1 - bbPerPa - hbpPerPa - sacPerPa;
  return Number.isFinite(r) && r > 0.5 && r < 1 ? r : AB_PER_PA_FALLBACK;
}

/** cwhit's XBHpct counts HOME RUNS and is a share of ALL hits: XBHpct = (2B+3B+HR)/H. MEASURED, not
 *  assumed — regressing an independent XBH recon (from SLG/AVG/3B-XBH) on each candidate reading over
 *  the observed tables (N=500) gives slope 1.03 / corr 0.996 for (2B+3B+HR)/H, versus slope 0.99 but
 *  corr only 0.87 for (2B+3B)/non-HR-H, and slope ~0.1–0.26 for the per-AB and per-PA readings.
 *  Returns the NON-HR extra-base-hit rate per PA, which is what our wOBA's `xbh` weight applies to. */
export function xbhNonHrPerPa(xbhPct: number, hitsPerPa: number, hrPerPa: number): number {
  return Math.max(hitsPerPa * (xbhPct / 100) - hrPerPa, 0);
}

/** cwhit's OBSERVED hitter SO% is K per **AB**; our model's soPct is K per **PA**. Convert his to
 *  ours. VERIFIED empirically: reconstructing his published BABIP from his own columns under each
 *  reading gives mean |err| 0.003 (K/AB) vs 0.012 (K/PA) across iron/bronze/gold/diamond, N=100 each.
 *  (Note: `audit.ts#hitWobaFromRates` reads soPct as per-PA — a separate, pre-existing issue.) */
export function soPctPerAbToPerPa(soPct: number, avg: number, obp: number, bbPct: number): number {
  return soPct * abPerPa(avg, obp, bbPct / 100);
}

// ── observed sampling noise (for spread deconvolution) ───────────────────────
// Observed SD is INFLATED by binomial sampling noise, so a raw SD(pred)/SD(obs) reads LOW-biased
// against a noiseless predictor. Both models are compared to the SAME observed series, so the raw
// ratio is still fair BETWEEN them — but it is NOT fair as an absolute "are we too flat?" read.

export const BF_PER_9 = IP_TO_BF * 9;   // 38.7

/** Var of an observed per-9 rate: count ~ Binomial(BF, p) with BF = IP × IP_TO_BF, rate9 = p × BF_PER_9. */
export function per9NoiseVar(rate9: number, ip: number): number {
  const bf = ip * IP_TO_BF; if (!(bf > 0)) return 0;
  const p = Math.min(Math.max(rate9 / BF_PER_9, 0), 1);
  return (BF_PER_9 ** 2) * p * (1 - p) / bf;
}
/** Var of an observed BABIP over `bip` balls in play. */
export function babipNoiseVar(babip: number, bip: number): number {
  if (!(bip > 0)) return 0;
  const p = Math.min(Math.max(babip, 0), 1);
  return p * (1 - p) / bip;
}
/** Var of an observed per-PA percentage (0–100 scale) over `pa` plate appearances. */
export function pctNoiseVar(pct: number, pa: number): number {
  if (!(pa > 0)) return 0;
  const p = Math.min(Math.max(pct / 100, 0), 1);
  return 1e4 * p * (1 - p) / pa;
}
/** Var of an observed per-600-PA count over `pa` plate appearances. */
export function per600NoiseVar(r600: number, pa: number): number {
  if (!(pa > 0)) return 0;
  const p = Math.min(Math.max(r600 / 600, 0), 1);
  return (600 ** 2) * p * (1 - p) / pa;
}

// ── COMPOSITE (wOBA / wOBAA) sampling noise ──────────────────────────────────
//
// THIS EXISTS BECAUSE ITS ABSENCE CAUSED TWO WRONG FINDINGS (2026-07-20). The scorecard's
// `noiseOf` used to return NaN for the composite with the comment "a composite; no clean
// binomial form", so `agreement()` never deconvolved it and only the RAW ratio ever printed.
// A raw composite ratio then got compared against noise-DECONVOLVED per-channel ratios —
// unlike quantities — which manufactured both a phantom "hitters are severely under-spread"
// finding and a phantom cross-channel-covariance mechanism to explain it. The comment was
// wrong: there IS a clean closed form, below.
//
// ONE COPY. `tools/obs-pred-slopes.ts` and `tools/channel-covariance.ts` import these rather
// than re-deriving them — one-copy applies to eval instruments, not just the scoring core.
//
// NOTE ON TYPES: this module must NOT import `sample.ts` (sample.ts imports THIS file), so
// these take plain rates rather than a `Rec`. Callers destructure.

export interface WobaNoiseCell { p: number; w: number }

export type WobaNoiseInput =
  | { role: "pit"; k9: number; bb9: number; hr9: number; babip: number }
  | { role: "hit"; bbPct: number; soPct: number; hr600: number; babip: number; avg: number; slg: number; tripleXbh: number };

/** The RANDOM event cells of a card's observed composite, as (proportion, wOBA weight) pairs.
 *  The wOBA reconstructions are LINEAR in the weight bag, so evaluating one at a unit basis
 *  vector returns that event's per-PA (hitters) / per-BF (pitchers) proportion verbatim — no
 *  algebra is re-derived here, which is what keeps this honest w.r.t. one-copy.
 *
 *  HBP is DELIBERATELY EXCLUDED: both reconstructions insert it as a FIXED constant rate, so its
 *  count is deterministic in this frame — a constant offset with ZERO sampling variance.
 *  Everything unlisted (outs, strikeouts) falls into an implicit weight-0 cell. In particular
 *  SO/K is NOT a wOBA channel: it carries zero weight and enters only via the BIP denominator.
 *
 *  `collapseHits` MUST be true for pitchers: cwhit publishes only BABIP for them and the
 *  reconstruction splits it with a FIXED 0.25 XBH share, so 1B and XBH are not independently
 *  observed. The quantity that actually fluctuates is the non-HR HIT count, carrying the blended
 *  weight; splitting it would invent variance the published columns cannot contain. */
export function wobaNoiseCells(inp: WobaNoiseInput, w: WobaWeights, collapseHits: boolean): WobaNoiseCell[] {
  const ZERO: WobaWeights = { bb: 0, hbp: 0, b1: 0, xbh: 0, hr: 0 };
  const basis = (j: keyof WobaWeights): WobaWeights => ({ ...ZERO, [j]: 1 });
  const ev = (j: keyof WobaWeights): number => inp.role === "pit"
    ? pitWobaFromChannels(inp.k9, inp.bb9, inp.hr9, inp.babip, basis(j))
    : hitWobaFromRates({ bbPct: inp.bbPct, soPct: inp.soPct, hr600: inp.hr600, babip: inp.babip, avg: inp.avg, slg: inp.slg, tripleXbh: inp.tripleXbh }, basis(j));
  const pBb = ev("bb"), p1 = ev("b1"), pX = ev("xbh"), pHr = ev("hr");
  if (!collapseHits) return [{ p: pBb, w: w.bb }, { p: p1, w: w.b1 }, { p: pX, w: w.xbh }, { p: pHr, w: w.hr }];
  const pH = p1 + pX;
  return [{ p: pBb, w: w.bb }, { p: pH, w: pH > 0 ? (w.b1 * p1 + w.xbh * pX) / pH : w.b1 }, { p: pHr, w: w.hr }];
}

/** Var of the observed composite over `n` trials (PA for hitters, BF for pitchers).
 *  Multinomial ⇒ Var(Σ wⱼXⱼ / n) = (Σ wⱼ²pⱼ − (Σ wⱼpⱼ)²)/n. The SUBTRACTED SQUARE **is** the
 *  negative-covariance term — this is exact, not an independence approximation. */
export function wobaNoiseVar(cells: WobaNoiseCell[], n: number): number {
  if (!(n > 0)) return NaN;
  let s1 = 0, s2 = 0;
  for (const { p, w } of cells) { const q = Math.min(Math.max(p, 0), 1); s1 += w * q; s2 += w * w * q; }
  return Math.max(s2 - s1 * s1, 0) / n;
}

/** The INDEPENDENCE-ASSUMING version — Σ wⱼ²pⱼ(1−pⱼ)/n. Kept ONLY so the size of the covariance
 *  term can be printed as a contrast rather than asserted (it overstates noise SD by ~1.08–1.12×).
 *  NEVER use it for a reported number. */
export function wobaNoiseVarIndep(cells: WobaNoiseCell[], n: number): number {
  if (!(n > 0)) return NaN;
  let s = 0;
  for (const { p, w } of cells) { const q = Math.min(Math.max(p, 0), 1); s += w * w * q * (1 - q); }
  return s / n;
}

// ── the LEVEL / SHAPE / SPREAD decomposition ─────────────────────────────────

export interface LevelStat { bias: number; ciLo: number; ciHi: number; sig: boolean }
export interface ShapeStat {
  corr: number; corrLo: number; corrHi: number;   // Pearson + Fisher-z 95% CI
  spearman: number;                                // rank concordance (regret proxy)
  mae: number; rmse: number;                       // error AFTER DE-MEANING (see note below)
  slope: number;                                   // OLS slope of pred on obs — 1 = right responsiveness
}
export interface SpreadStat {
  sdPred: number; sdObs: number; ratio: number;
  sdObsDeconv: number; ratioDeconv: number; noiseShare: number;  // noiseShare = mean noise var ÷ obs var
}
export interface Agreement { n: number; level: LevelStat; shape: ShapeStat; spread: SpreadStat }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sdPop = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
export function pearson(xs: number[], ys: number[]): number {
  const nn = xs.length; if (nn < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < nn; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  return vx > 0 && vy > 0 ? cv / Math.sqrt(vx * vy) : NaN;
}
function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}
export const spearman = (xs: number[], ys: number[]): number => pearson(ranks(xs), ranks(ys));

/**
 * Split predicted-vs-observed agreement into the three INDEPENDENT axes the two-axis doctrine
 * requires. `noiseVar` (optional, per card) = the observed value's binomial sampling variance.
 *
 * ALIGNMENT CHOICE (stated explicitly, per the work order): the SHAPE error de-means only —
 * `(pred − mean(pred)) − (obs − mean(obs))` — it does NOT regress pred on obs. A full affine
 * alignment would rescale the prediction and thereby ABSORB the spread defect into the fit,
 * double-counting what `spread` reports separately. De-meaning removes exactly the level, leaving
 * shape+spread in the residual, with the spread component then read off `spread.ratio` and `slope`.
 */
export function agreement(pred: number[], obs: number[], noiseVar?: number[]): Agreement {
  const keep = pred.map((_, i) => Number.isFinite(pred[i]!) && Number.isFinite(obs[i]!)).map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
  const p = keep.map((i) => pred[i]!), o = keep.map((i) => obs[i]!);
  const n = p.length;

  // LEVEL — card-level mean(pred − obs) with a normal 95% CI (cards are the unit).
  const ds = p.map((x, i) => x - o[i]!);
  const bias = mean(ds);
  const sdD = n > 1 ? Math.sqrt(ds.reduce((a, d) => a + (d - bias) ** 2, 0) / (n - 1)) : 0;
  const se = n ? sdD / Math.sqrt(n) : NaN;
  const level: LevelStat = { bias, ciLo: bias - 1.96 * se, ciHi: bias + 1.96 * se, sig: (bias - 1.96 * se) * (bias + 1.96 * se) > 0 };

  // SHAPE — after de-meaning both series.
  const mp = mean(p), mo = mean(o);
  const dp = p.map((x) => x - mp), dobs = o.map((x) => x - mo);
  const r = pearson(p, o);
  const z = Math.atanh(Math.min(Math.max(r, -0.999999), 0.999999)), zse = n > 3 ? 1 / Math.sqrt(n - 3) : NaN;
  const errs = dp.map((x, i) => x - dobs[i]!);
  const vo = dobs.reduce((a, x) => a + x * x, 0);
  const shape: ShapeStat = {
    corr: r, corrLo: Math.tanh(z - 1.96 * zse), corrHi: Math.tanh(z + 1.96 * zse),
    spearman: spearman(p, o),
    mae: mean(errs.map(Math.abs)), rmse: Math.sqrt(mean(errs.map((x) => x * x))),
    slope: vo > 0 ? dp.reduce((a, x, i) => a + x * dobs[i]!, 0) / vo : NaN,
  };

  // SPREAD — raw + noise-deconvolved (Var_true = Var_obs − mean sampling Var).
  const sdP = sdPop(p), sdO = sdPop(o);
  // No noiseVar supplied ⇒ deconvolution is NOT attempted and the fields read NaN, rather than
  // silently reporting the raw ratio as deconvolved. Refusing to guess is right; what was WRONG was
  // the old claim that composites have "no clean binomial form" and must therefore go without.
  // They do have one — `wobaNoiseCells` + `wobaNoiseVar` above — so composites now supply noiseVar
  // like any other channel. A caller reaching this NaN branch is asserting it genuinely cannot
  // characterise the sampling noise; it must NOT then compare its raw ratio against a deconvolved
  // one elsewhere. That exact comparison produced two retracted findings on 2026-07-20.
  const nv = noiseVar ? mean(keep.map((i) => noiseVar[i] ?? 0)) : NaN;
  const sdOd = Number.isFinite(nv) ? Math.sqrt(Math.max(sdO ** 2 - nv, 0)) : NaN;
  const spread: SpreadStat = {
    sdPred: sdP, sdObs: sdO, ratio: sdO > 0 ? sdP / sdO : NaN,
    sdObsDeconv: sdOd, ratioDeconv: sdOd > 0 ? sdP / sdOd : NaN,
    noiseShare: Number.isFinite(nv) && sdO > 0 ? nv / sdO ** 2 : NaN,
  };
  return { n, level, shape, spread };
}

// ── the DUEL: is one predictor's edge over the other real? ────────────────────

/** Deterministic RNG (mulberry32) so the bootstrap is reproducible across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 97.5th-percentile bootstrap upper bound on a cell's NOISE SHARE (mean sampling var ÷ observed
 *  var). A share ≥ 1 is PHYSICALLY IMPOSSIBLE — it says sampling noise exceeds the total observed
 *  variance — so the deconvolved SD collapses to ~0 and the dcv ratio explodes to garbage.
 *
 *  Why the CI UPPER and not the point estimate: the motivating case (gold pitchers, N=15) had a
 *  POINT share of 75% with a CI reaching 199%. A point-estimate test passes that cell and prints a
 *  dcv of 2.17 as if it were a measurement. Callers should mark such cells UNRELIABLE.
 *
 *  Deterministic (mulberry32, same convention as `duel`) so committed fixtures are reproducible. */
export function noiseShareCiUpper(obs: number[], noiseVar: number[], B = 2000, seed = 20260720): number {
  const n = obs.length;
  if (n < 3 || noiseVar.length !== n || !noiseVar.every((x) => Number.isFinite(x))) return NaN;
  const rnd = rng(seed);
  const shares: number[] = [];
  for (let b = 0; b < B; b++) {
    const io: number[] = [], iv: number[] = [];
    for (let i = 0; i < n; i++) { const k = Math.floor(rnd() * n); io.push(obs[k]!); iv.push(noiseVar[k]!); }
    const vo = sdPop(io) ** 2;
    if (vo > 0) shares.push(mean(iv) / vo);
  }
  if (!shares.length) return NaN;
  shares.sort((a, b) => a - b);
  return shares[Math.min(shares.length - 1, Math.floor(0.975 * shares.length))]!;
}

export interface Delta { est: number; lo: number; hi: number; sig: boolean }
export interface Duel {
  n: number;
  corr: Delta;       // ours − cwhit Pearson; POSITIVE ⇒ OURS orders cards better. THE shape axis:
                     //   scale-free, so a spread defect cannot masquerade as a discrimination defect.
  shapeMae: Delta;   // ours − cwhit de-meaned MAE; NEGATIVE ⇒ OURS closer. NOTE: de-meaning removes
                     //   level but NOT scale, so this is a shape+SPREAD composite — read it with
                     //   `spreadLog`, never as a pure discrimination verdict.
  spreadLog: Delta;  // |ln(SD ours/SD obs)| − |ln(SD cwhit/SD obs)|; NEGATIVE ⇒ OURS closer to 1.0×
  absLevel: Delta;   // |ours bias| − |cwhit bias|; NEGATIVE ⇒ OURS closer on level
}

/** PAIRED bootstrap (resample CARDS, both predictors together) on the ours-minus-cwhit gaps. Paired
 *  is essential: the two predictors are scored on the SAME cards, so the shared card-difficulty
 *  variance cancels and the CI is on the DIFFERENCE, not on two independent errors. */
export function duel(ours: number[], cwhit: number[], obs: number[], B = 2000, seed = 20260716): Duel {
  const idx = obs.map((_, i) => i).filter((i) => Number.isFinite(ours[i]!) && Number.isFinite(cwhit[i]!) && Number.isFinite(obs[i]!));
  const n = idx.length;
  const stat = (ix: number[]) => {
    const a = agreement(ix.map((i) => ours[i]!), ix.map((i) => obs[i]!));
    const b = agreement(ix.map((i) => cwhit[i]!), ix.map((i) => obs[i]!));
    return {
      mae: a.shape.mae - b.shape.mae, corr: a.shape.corr - b.shape.corr,
      spr: Math.abs(Math.log(a.spread.ratio)) - Math.abs(Math.log(b.spread.ratio)),
      lvl: Math.abs(a.level.bias) - Math.abs(b.level.bias),
    };
  };
  const pt = stat(idx);
  const rnd = rng(seed);
  const s: { mae: number[]; corr: number[]; spr: number[]; lvl: number[] } = { mae: [], corr: [], spr: [], lvl: [] };
  for (let b = 0; b < B; b++) {
    const rs = idx.map(() => idx[Math.floor(rnd() * n)]!);
    const t = stat(rs);
    if (Number.isFinite(t.mae)) s.mae.push(t.mae);
    if (Number.isFinite(t.corr)) s.corr.push(t.corr);
    if (Number.isFinite(t.spr)) s.spr.push(t.spr);
    if (Number.isFinite(t.lvl)) s.lvl.push(t.lvl);
  }
  const ci = (est: number, xs: number[]): Delta => {
    if (xs.length < 20) return { est, lo: NaN, hi: NaN, sig: false };
    const v = [...xs].sort((x, y) => x - y);
    const lo = v[Math.floor(0.025 * v.length)]!, hi = v[Math.min(Math.floor(0.975 * v.length), v.length - 1)]!;
    return { est, lo, hi, sig: lo * hi > 0 };
  };
  return { n, corr: ci(pt.corr, s.corr), shapeMae: ci(pt.mae, s.mae), spreadLog: ci(pt.spr, s.spr), absLevel: ci(pt.lvl, s.lvl) };
}
