// M6 / SP-9 — training-data loader. Reads the real per-(league, side, year) season
// outcome CSVs in `Model 2037 and 2038/` and normalizes them into observations the
// trainer fits against. The model is NOT trained here — this is ingestion only.
//
// Grouping (decided 2026-06-24, parity-first; revisit when dissecting the model):
//   • An observation is keyed by (CID, variant-flag, side). Base and variant of the
//     same player are SEPARATE groups; ALL variant levels pool together (VLvl
//     ignored — just base vs. variant via the `VAR` column). vL and vR stay
//     separate observations (side-specific ratings → side-specific outcomes).
//   • Outcomes (counting stats) are SUMMED across every league/year a card-side
//     appears in. Ratings are constant per card, so only outcomes accumulate; we
//     keep the highest-PA source's ratings as representative (variant pooling can
//     mix levels — a parity-revisit). The data was collected in a NEUTRAL league
//     environment (no park, neutral era), so every file shares one run environment
//     and outcomes sum directly — no per-source neutralization. Era/park are
//     applied on top of the model's neutral prediction at inference, not removed
//     from the training data. Each source league/year is retained only for
//     provenance / per-league diagnostics.
//
// Filename detection is robust to token order: `HD 450 vL 2037.csv` and
// `HD 452 2038 vR.csv` (year before side) both parse.

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { HittingRatings, PitchingRatings } from "../model/types.ts";
import { DEFAULT_WOBA_WEIGHTS, type WobaWeights } from "../scoring-core/woba-weights.ts";
import { corruptCellKeys } from "./validate.ts";

// Normal-equations solve (X'X b = X'y) via Gauss-Jordan — used to reverse-engineer
// the game's wOBA event weights from wRAA (see deriveWobaWeights below).
function solveNormal(X: number[][], y: number[]): number[] {
  const p = X[0]!.length, A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < X.length; i++) { for (let j = 0; j < p; j++) { for (let k = 0; k < p; k++) A[j]![k] += X[i]![j]! * X[i]![k]!; A[j]![p] += X[i]![j]! * y[i]!; } }
  for (let c = 0; c < p; c++) {
    let m = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[m]![c]!)) m = r;
    [A[c], A[m]] = [A[m]!, A[c]!];
    const pv = A[c]![c]!; if (Math.abs(pv) < 1e-12) continue;
    for (let k = c; k <= p; k++) A[c]![k] /= pv;
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r]![c]!; for (let k = c; k <= p; k++) A[r]![k] -= f * A[c]![k]!; }
  }
  return A.map((r) => r[p]!);
}

export type Side = "L" | "R";

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
// Batter/pitcher hand code. The training CSVs store B/T as LETTERS (R/L/S); map to the
// catalog convention 1=R, 2=L, 3=S. Falls back to num() if a source uses numeric codes.
const handCode = (v: unknown): number => { const s = String(v ?? "").trim().toUpperCase(); return s === "R" ? 1 : s === "L" ? 2 : s === "S" ? 3 : num(v); };

export interface FileTag { file: string; league: string; side: Side; year: number }

/** Parse league / side / year from a training filename, robust to token order. */
export function parseTrainingFilename(name: string): { league: string; side: Side; year: number } | null {
  const base = name.replace(/\.csv$/i, "").trim();
  const tokens = base.split(/\s+/);
  let side: Side | null = null;
  let year: number | null = null;
  const rest: string[] = [];
  for (const tok of tokens) {
    if (side == null && /^v[lr]$/i.test(tok)) { side = tok.toUpperCase().endsWith("L") ? "L" : "R"; continue; }
    if (year == null && /^(19|20)\d{2}$/.test(tok)) { year = Number(tok); continue; }
    rest.push(tok);
  }
  if (side == null || year == null || rest.length === 0) return null;
  // Canonicalize the league name across the (inconsistent) per-year naming: 37/38
  // use "HD 450", 39 uses "HD450". Strip internal spaces so the same league keys
  // identically across years (needed for combined windows + leave-one-pool-out).
  return { league: rest.join(" ").replace(/\s+/g, ""), side, year };
}

export interface HitOutcomes { PA: number; AB: number; H: number; b1: number; b2: number; b3: number; HR: number; BB: number; IBB: number; HP: number; SH: number; SF: number; K: number; GIDP: number }
export interface PitchOutcomes { BF: number; IP: number; AB: number; b1: number; b2: number; b3: number; HR: number; BB: number; IBB: number; K: number; HP: number; SH: number; SF: number }

// Realized SP/RP opponent-hand splits (M6 — role-conditional platoon exposure).
// Same-side BF share by realized role: `r` = RHP's share of BF vs RHB, `l` = LHP's
// share vs LHB — i.e. the existing `r/l_pitch_split` convention, split by role.
// Computed at RAW-ROW grain (one team-season deployment) BEFORE CID aggregation,
// because a single card is deployed as a starter by some owners and a reliever by
// others; aggregating to the card first washes the role difference out. Role comes
// from each deployment's own GS_1/G_1 (game-level, replicated across the vL/vR split
// files — so read per-row, never summed across sides); BF is partitioned by opponent.
export interface PitchRoleSplits { sp: { r: number; l: number }; rp: { r: number; l: number } }

export interface TrainObs {
  key: string;            // `${cid}|${variant ? "V" : "B"}|${side}`
  cid: string; variant: boolean; side: Side;
  name: string; pos: string; bats: number; throws: number;
  ratings: { hit: HittingRatings; pitch: PitchingRatings };
  hit: HitOutcomes;
  pitch: PitchOutcomes;
  sources: { league: string; year: number; pa: number; bf: number }[];
}

type Row = Record<string, string>;

const hitRatings = (r: Row, side: Side): HittingRatings => ({
  babip: num(r[`BA v${side}`]), gap: num(r[`GAP v${side}`]), pow: num(r[`POW v${side}`]),
  eye: num(r[`EYE v${side}`]), kRat: num(r[`K v${side}`]),
  speed: num(r["SPE"]), steal: num(r["STE"]), run: num(r["RUN"]),
});
const pitchRatings = (r: Row, side: Side): PitchingRatings => ({
  stu: num(r[`STU v${side}`]), con: num(r[`CON v${side}`]), pbabip: num(r[`PBABIP v${side}`]), hrr: num(r[`HRA v${side}`]),
});
const hitOutcomes = (r: Row): HitOutcomes => ({
  PA: num(r["PA"]), AB: num(r["AB"]), H: num(r["H"]), b1: num(r["1B_1"]), b2: num(r["2B_1"]), b3: num(r["3B_1"]),
  HR: num(r["HR"]), BB: num(r["BB"]), IBB: num(r["IBB"]), HP: num(r["HP"]), SH: num(r["SH"]), SF: num(r["SF"]),
  K: num(r["K"]), GIDP: num(r["GIDP"]),
});
const pitchOutcomes = (r: Row): PitchOutcomes => ({
  BF: num(r["BF"]), IP: num(r["IP"]), AB: num(r["AB_1"]), b1: num(r["1B_2"]), b2: num(r["2B_2"]), b3: num(r["3B_2"]),
  HR: num(r["HR_1"]), BB: num(r["BB_1"]), IBB: num(r["IBB_1"]), K: num(r["K_1"]), HP: num(r["HP_1"]), SH: num(r["SH_1"]), SF: num(r["SF_1"]),
});
const addHit = (a: HitOutcomes, b: HitOutcomes) => { for (const k of Object.keys(a) as (keyof HitOutcomes)[]) a[k] += b[k]; };
const addPitch = (a: PitchOutcomes, b: PitchOutcomes) => { for (const k of Object.keys(a) as (keyof PitchOutcomes)[]) a[k] += b[k]; };
const zeroHit = (): HitOutcomes => ({ PA: 0, AB: 0, H: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, HP: 0, SH: 0, SF: 0, K: 0, GIDP: 0 });
const zeroPitch = (): PitchOutcomes => ({ BF: 0, IP: 0, AB: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, K: 0, HP: 0, SH: 0, SF: 0 });

export interface CellStat { league: string; side: Side; year: number; rows: number; pa: number; bf: number }
export interface TrainingSummary {
  dir: string;
  window?: number[]; // selected year set (undefined = all years)
  files: (FileTag & { rows: number; pa: number; bf: number })[];
  unparsedFiles: string[];
  leagues: string[]; years: number[];
  cells: CellStat[];
  excludedCells: string[]; // "league|year" cells dropped from modeling as corrupt (still shown, flagged)
  observations: number; hitterObs: number; pitcherObs: number;
  baseObs: number; variantObs: number;
  totalPA: number; totalBF: number;
}

export interface LoadedTraining { summary: TrainingSummary; observations: TrainObs[]; pitchRoleSplits: PitchRoleSplits; wobaWeights: WobaWeights }

// Recursively discover training CSVs under a root (per-year folders OR a flat
// folder — the year is parsed from each filename either way). Files whose name
// doesn't yield (league, side, year) are reported as unparsed.
interface FoundFile { file: string; abs: string; tag: { league: string; side: Side; year: number } | null }
function discover(root: string): FoundFile[] {
  const rels = readdirSync(root, { recursive: true }) as string[];
  return rels.filter((r) => /\.csv$/i.test(r))
    .map((rel) => ({ file: rel.replace(/\\/g, "/"), abs: join(root, rel), tag: parseTrainingFilename(basename(rel)) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Years present under a root (for the window selector). */
export function availableYears(root: string): number[] {
  return [...new Set(discover(root).filter((f) => f.tag).map((f) => f.tag!.year))].sort();
}

// Aggregate a set of parsed files into grouped (CID, variant, side) observations.
function aggregate(found: FoundFile[], root: string, window: number[] | null): LoadedTraining {
  const obs = new Map<string, TrainObs>();
  const repPA = new Map<string, number>(); // highest hitting PA seen per key (rating pick)
  const files: (FileTag & { rows: number; pa: number; bf: number })[] = [];
  const unparsedFiles = found.filter((f) => !f.tag).map((f) => f.file);
  const cells: CellStat[] = [];
  // Role-conditional opponent-hand BF accumulator: acc[role][hand][opponentSide].
  // Filled at row grain (see PitchRoleSplits) inside the same windowed file loop.
  const rsAcc = { sp: { R: { R: 0, L: 0 }, L: { R: 0, L: 0 } }, rp: { R: { R: 0, L: 0 }, L: { R: 0, L: 0 } } };
  // wOBA-weight reverse-engineering: per (league,season,side) file we regress wRAA on
  // the raw events (each file shares one league wOBA scale/baseline), recover the event
  // weights RELATIVE to 1B, and PA-weight-blend across files — so larger leagues (more
  // teams ⇒ more PA, e.g. PEL) carry proportionally more weight. n2/n3 accumulate the
  // global 2B:3B mix for the single combined XBH weight. See deriveWobaWeights note.
  const wwAcc = { bb: 0, hbp: 0, b2: 0, b3: 0, hr: 0 }; let wwPA = 0, n2tot = 0, n3tot = 0;

  // PASS 1 — parse each windowed file + record its per-(league,side,year) cell stats. We must
  // know the cell stats BEFORE aggregating so clearly-corrupt cells can be excluded from EVERY
  // modeling input (observations, role splits, wOBA weights), not just flagged.
  const parsedFiles: { tag: { league: string; side: Side; year: number }; rows: Row[] }[] = [];
  for (const f of found) {
    if (!f.tag) continue;
    if (window && !window.includes(f.tag.year)) continue;
    const parsed = Papa.parse<Row>(readFileSync(f.abs, "utf8"), { header: true, skipEmptyLines: true });
    const rows = (parsed.data ?? []).filter((r) => r && r["CID"]);
    let fpa = 0, fbf = 0;
    for (const r of rows) { fpa += num(r["PA"]); fbf += num(r["BF"]); }
    files.push({ file: f.file, ...f.tag, rows: rows.length, pa: fpa, bf: fbf });
    cells.push({ league: f.tag.league, side: f.tag.side, year: f.tag.year, rows: rows.length, pa: fpa, bf: fbf });
    parsedFiles.push({ tag: f.tag, rows });
  }
  // Clearly-corrupt cells (duplicate vL/vR, reversed split) → excluded from modeling entirely.
  const excludedKeys = corruptCellKeys(cells);

  // PASS 2 — aggregate observations + role splits + wOBA weights from the CLEAN files only.
  for (const { tag, rows } of parsedFiles) {
    if (excludedKeys.has(`${tag.league}|${tag.year}`)) continue;
    let fpa = 0;
    const wbX: number[][] = [], wbY: number[] = []; // per-file wRAA regression rows
    for (const r of rows) {
      const cid = String(r["CID"]); const variant = String(r["VAR"] ?? "").toUpperCase() === "Y";
      const key = `${cid}|${variant ? "V" : "B"}|${tag.side}`;
      const h = hitOutcomes(r); const p = pitchOutcomes(r);
      fpa += h.PA;
      // wRAA ≈ (1/scale)·Σ(w_e·event) − (lg/scale)·PA — exactly linear in events + PA
      // with NO intercept, so a no-intercept regression recovers the game's weights.
      if (h.PA >= 50) { wbX.push([h.BB, h.HP, h.b1, h.b2, h.b3, h.HR, h.PA]); wbY.push(num(r["wRAA"])); n2tot += h.b2; n3tot += h.b3; }
      // Role-conditional split: classify THIS deployment by its own start-share and
      // add its per-side BF. thr 1=R/2=L only (no switch pitchers); g>0 guards rookies.
      if (p.BF > 0) {
        const thr = handCode(r["T"]); const g = num(r["G_1"]); const gs = num(r["GS_1"]);
        if ((thr === 1 || thr === 2) && g > 0) {
          rsAcc[gs / g >= 0.5 ? "sp" : "rp"][thr === 1 ? "R" : "L"][tag.side] += p.BF;
        }
      }
      let o = obs.get(key);
      if (!o) {
        o = {
          key, cid, variant, side: tag.side,
          name: String(r["Name"] ?? ""), pos: String(r["POS"] ?? ""),
          bats: handCode(r["B"]), throws: handCode(r["T"]),
          ratings: { hit: hitRatings(r, tag.side), pitch: pitchRatings(r, tag.side) },
          hit: zeroHit(), pitch: zeroPitch(), sources: [],
        };
        obs.set(key, o); repPA.set(key, -1);
      }
      // Representative ratings = the source with the most hitting PA (best sample).
      if (h.PA > (repPA.get(key) ?? -1)) { o.ratings = { hit: hitRatings(r, tag.side), pitch: pitchRatings(r, tag.side) }; repPA.set(key, h.PA); }
      addHit(o.hit, h); addPitch(o.pitch, p);
      o.sources.push({ league: tag.league, year: tag.year, pa: h.PA, bf: p.BF });
    }
    // Per-file wOBA weights, relative to 1B, PA-weighted into the blend.
    if (wbX.length >= 20) {
      const b = solveNormal(wbX, wbY); const oneB = b[2]!;
      if (Math.abs(oneB) > 1e-9) {
        wwAcc.bb += (b[0]! / oneB) * fpa; wwAcc.hbp += (b[1]! / oneB) * fpa;
        wwAcc.b2 += (b[3]! / oneB) * fpa; wwAcc.b3 += (b[4]! / oneB) * fpa; wwAcc.hr += (b[5]! / oneB) * fpa;
        wwPA += fpa;
      }
    }
  }

  const observations = [...obs.values()];
  const summary: TrainingSummary = {
    dir: root, window: window ?? undefined,
    files, unparsedFiles,
    leagues: [...new Set(files.map((f) => f.league))].sort(),
    years: [...new Set(files.map((f) => f.year))].sort(),
    cells: cells.sort((a, b) => a.league.localeCompare(b.league) || a.year - b.year || a.side.localeCompare(b.side)),
    excludedCells: [...excludedKeys.keys()],
    observations: observations.length,
    hitterObs: observations.filter((o) => o.hit.PA > 0).length,
    pitcherObs: observations.filter((o) => o.pitch.BF > 0).length,
    baseObs: observations.filter((o) => !o.variant).length,
    variantObs: observations.filter((o) => o.variant).length,
    totalPA: observations.reduce((s, o) => s + o.hit.PA, 0),
    totalBF: observations.reduce((s, o) => s + o.pitch.BF, 0),
  };
  // Same-side share per (role, hand). Fallbacks: an empty role bucket falls back to
  // the other role's same-hand share, then to the role-blind hand share, then 0.5 —
  // so a thin RP/SP sample never yields a degenerate weight.
  const ss = (a: number, b: number, fb: number) => (a + b > 1e-9 ? a / (a + b) : fb);
  const handSame = (acc: { R: number; L: number }, hand: "R" | "L", fb: number) => hand === "R" ? ss(acc.R, acc.L, fb) : ss(acc.L, acc.R, fb);
  const blind = (hand: "R" | "L") => handSame({ R: rsAcc.sp[hand].R + rsAcc.rp[hand].R, L: rsAcc.sp[hand].L + rsAcc.rp[hand].L }, hand, 0.5);
  const roleShare = (role: "sp" | "rp", hand: "R" | "L") => handSame(rsAcc[role][hand], hand, blind(hand));
  const pitchRoleSplits: PitchRoleSplits = {
    sp: { r: roleShare("sp", "R"), l: roleShare("sp", "L") },
    rp: { r: roleShare("rp", "R"), l: roleShare("rp", "L") },
  };
  // Blend the PA-weighted relative weights, anchor 1B to the conventional value (keeps
  // wOBA on its usual scale), and collapse 2B+3B to one XBH weight by their actual
  // frequency. Empty window ⇒ the historical defaults.
  let wobaWeights: WobaWeights = DEFAULT_WOBA_WEIGHTS;
  if (wwPA > 0) {
    const A = DEFAULT_WOBA_WEIGHTS.b1; // anchor 1B
    const w2 = (wwAcc.b2 / wwPA) * A, w3 = (wwAcc.b3 / wwPA) * A;
    const xbh = n2tot + n3tot > 0 ? (n2tot * w2 + n3tot * w3) / (n2tot + n3tot) : DEFAULT_WOBA_WEIGHTS.xbh;
    wobaWeights = { bb: (wwAcc.bb / wwPA) * A, hbp: (wwAcc.hbp / wwPA) * A, b1: A, xbh, hr: (wwAcc.hr / wwPA) * A };
  }
  return { summary, observations, pitchRoleSplits, wobaWeights };
}

/** Load a specific window (year set) from a root; omit `years` for all of them. */
export function loadWindow(root: string, years?: number[]): LoadedTraining {
  return aggregate(discover(root), root, years && years.length ? years : null);
}

/** Load + aggregate every training CSV under a directory (all years). */
export function loadTrainingDir(dir: string): LoadedTraining {
  return aggregate(discover(dir), dir, null);
}

/** Load a window scoped to specific (canonical, space-stripped) league names — e.g.
 *  ["PEL"] or ["HD450","HD451",…]. Outcomes still sum across the INCLUDED leagues
 *  only. For diagnostics (per-league vs pooled training); not used by the app. */
export function loadWindowLeagues(root: string, years: number[] | null, leagues: string[]): LoadedTraining {
  const keep = new Set(leagues);
  const found = discover(root).filter((f) => f.tag && keep.has(f.tag.league));
  return aggregate(found, root, years && years.length ? years : null);
}
