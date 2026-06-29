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

export type Side = "L" | "R";

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

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
  observations: number; hitterObs: number; pitcherObs: number;
  baseObs: number; variantObs: number;
  totalPA: number; totalBF: number;
}

export interface LoadedTraining { summary: TrainingSummary; observations: TrainObs[] }

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

  for (const f of found) {
    if (!f.tag) continue;
    if (window && !window.includes(f.tag.year)) continue;
    const tag = f.tag;
    const parsed = Papa.parse<Row>(readFileSync(f.abs, "utf8"), { header: true, skipEmptyLines: true });
    const rows = (parsed.data ?? []).filter((r) => r && r["CID"]);
    let fpa = 0, fbf = 0;
    for (const r of rows) {
      const cid = String(r["CID"]); const variant = String(r["VAR"] ?? "").toUpperCase() === "Y";
      const key = `${cid}|${variant ? "V" : "B"}|${tag.side}`;
      const h = hitOutcomes(r); const p = pitchOutcomes(r);
      fpa += h.PA; fbf += p.BF;
      let o = obs.get(key);
      if (!o) {
        o = {
          key, cid, variant, side: tag.side,
          name: String(r["Name"] ?? ""), pos: String(r["POS"] ?? ""),
          bats: num(r["B"]), throws: num(r["T"]),
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
    files.push({ file: f.file, ...tag, rows: rows.length, pa: fpa, bf: fbf });
    cells.push({ league: tag.league, side: tag.side, year: tag.year, rows: rows.length, pa: fpa, bf: fbf });
  }

  const observations = [...obs.values()];
  const summary: TrainingSummary = {
    dir: root, window: window ?? undefined,
    files, unparsedFiles,
    leagues: [...new Set(files.map((f) => f.league))].sort(),
    years: [...new Set(files.map((f) => f.year))].sort(),
    cells: cells.sort((a, b) => a.league.localeCompare(b.league) || a.year - b.year || a.side.localeCompare(b.side)),
    observations: observations.length,
    hitterObs: observations.filter((o) => o.hit.PA > 0).length,
    pitcherObs: observations.filter((o) => o.pitch.BF > 0).length,
    baseObs: observations.filter((o) => !o.variant).length,
    variantObs: observations.filter((o) => o.variant).length,
    totalPA: observations.reduce((s, o) => s + o.hit.PA, 0),
    totalBF: observations.reduce((s, o) => s + o.pitch.BF, 0),
  };
  return { summary, observations };
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
