// EVALUATION-ONLY tournament-outcome ingestion.
//
// HARD INVARIANT (correctness-critical): tournament outcomes are EVALUATION-ONLY. They
// must be structurally INCAPABLE of entering any training fit. This module is a SEPARATE
// path from src/training/loader.ts — it shares NO code with parseTrainingFilename /
// windowObs / loadWindow / getFit, and its output type (TournamentObs) is DISTINCT from
// the trainer's TrainObs and carries `evalOnly: true`. Nothing here fits a model, and no
// fit function anywhere imports this module. See the guard test in tests/tournament-eval.ts.
//
// WHY separate: tournament CSVs are COMBINED stat lines — one line per card with NO vL/vR
// split (unlike the league training files, which are per-side). Feeding a combined line into
// the per-side trainer would silently corrupt the fit. So there is no side-detection here and
// no path back into the loader.
//
// Parse conventions mirror tools/tournament-kslope.ts and tools/quicks-levelbias.ts (the
// diagnostic prototypes for these exact CSVs): numeric fields via Number()||0; ratings read
// from `<COL> vR`/`<COL> vL` columns; aggregation keyed by (CID, VLvl) so a base card and its
// variant levels — which carry different ratings — never merge. The ghost-cleaner is passed
// IN by the caller (dependency injection); this module never imports it.

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeDerived } from "../scoring-core/index.ts";
import type { Coeffs } from "../config/types.ts";
import type { EventModel, HittingRatings, PitchingRatings } from "../model/types.ts";

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
// Hand code, catalog convention: 1=R, 2=L, 3=S (mirrors loader.ts handCode). CSV B/T are letters.
const handCode = (v: unknown): number => { const s = String(v ?? "").trim().toUpperCase(); return s === "R" ? 1 : s === "L" ? 2 : s === "S" ? 3 : num(v); };
// Throwing hand collapsed to the R/L axis for the pitcher exposure blend (no switch pitchers).
const thr = (throws: number): 1 | 2 => (throws === 1 ? 1 : 2);

type Row = Record<string, unknown>;
const R = (r: Row, side: "vR" | "vL", col: string): number => num(r[`${col} ${side}`]);

const hitRatings = (r: Row, side: "vR" | "vL"): HittingRatings => ({
  eye: R(r, side, "EYE"), pow: R(r, side, "POW"), kRat: R(r, side, "K"),
  babip: R(r, side, "BA"), gap: R(r, side, "GAP"),
  speed: 0, steal: 0, run: 0, // not per-side; the level table never reads them (mirrors kslope/quicks)
});
const pitRatings = (r: Row, side: "vR" | "vL"): PitchingRatings => ({
  con: R(r, side, "CON"), stu: R(r, side, "STU"), pbabip: R(r, side, "PBABIP"), hrr: R(r, side, "HRA"),
});

/** Per-600 event levels (uBB = unintentional BB, HmHR = non-HR hits). One block per role. */
export interface EventLevels { uBB: number; K: number; HR: number; HmHR: number }

/**
 * A single EVALUATION-ONLY tournament observation: one card's COMBINED (no vL/vR split) stat
 * line, aggregated across every running in the directory. TAGGED `combined`/`evalOnly` so it
 * is structurally distinct from the trainer's TrainObs and can never be fed to a fit.
 */
export interface TournamentObs {
  cid: string;
  vlvl: number;          // variant level (0 = base); part of the aggregation key so ratings never mix
  combined: true;        // combined stat line (no side split) — structural tag
  evalOnly: true;        // NEVER enters a training fit — structural tag
  pa: number;            // total batting PA (hitter weight + threshold)
  bf: number;            // total batters faced (pitcher weight + threshold)
  bats: number;          // 1=R 2=L 3=S
  throws: number;        // 1=R 2=L 3=S
  ratings: {
    hit: { vR: HittingRatings; vL: HittingRatings };
    pit: { vR: PitchingRatings; vL: PitchingRatings };
  };
  actual: {
    hit: EventLevels;    // per-600 PA
    pit: EventLevels;    // per-600 BF
  };
}

interface Agg {
  cid: string; vlvl: number; bats: number; throws: number;
  ratings: TournamentObs["ratings"];
  hPA: number; hBB: number; hIBB: number; hK: number; hHR: number; hH: number;
  pBF: number; pBB: number; pIBB: number; pK: number; pHR: number; p1B: number; p2B: number; p3B: number;
}

export interface LoadTournamentOpts {
  /** Fixed team count for the ghost-cleaner (Bronze = 128). Passed THROUGH to `clean` as its
   *  2nd arg — a plain `(rows) => rows` cleaner simply ignores it. */
  expectedTeams?: number;
  /** Ghost-cleaner, INJECTED by the caller (do NOT import it here). Applied per-running (per CSV).
   *  Receives (rows, expectedTeams) so the caller can either pre-bake the count or read it here. */
  clean?: (rows: Row[], expectedTeams?: number) => Row[];
}

/**
 * Read the combined-line tournament CSVs in `dir`, optionally ghost-clean each running via the
 * injected `opts.clean`, aggregate by (CID, VLvl), and return EVAL-ONLY tagged observations.
 * NO filename side-detection (these lines are combined). This function fits nothing.
 */
export function loadTournamentOutcomes(dir: string, opts: LoadTournamentOpts = {}): TournamentObs[] {
  const m = new Map<string, Agg>();
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    const parsed = Papa.parse<Row>(readFileSync(join(dir, f), "utf8"), { header: true, skipEmptyLines: true });
    let rows = (parsed.data ?? []).filter((r) => r && r["CID"] != null && String(r["CID"]) !== "");
    // Ghost-clean this running (one CSV = one running) via the injected cleaner. DI — the
    // cleaner is a caller concern; this module stays data-shape-agnostic and import-free of it.
    if (opts.clean) rows = opts.clean(rows, opts.expectedTeams);
    for (const r of rows) {
      const cid = String(r["CID"]);
      const vlvl = num(r["VLvl"]);
      const key = `${cid}|${vlvl}`;
      let a = m.get(key);
      if (!a) {
        a = {
          cid, vlvl, bats: handCode(r["B"]), throws: handCode(r["T"]),
          ratings: {
            hit: { vR: hitRatings(r, "vR"), vL: hitRatings(r, "vL") },
            pit: { vR: pitRatings(r, "vR"), vL: pitRatings(r, "vL") },
          },
          hPA: 0, hBB: 0, hIBB: 0, hK: 0, hHR: 0, hH: 0,
          pBF: 0, pBB: 0, pIBB: 0, pK: 0, pHR: 0, p1B: 0, p2B: 0, p3B: 0,
        };
        m.set(key, a);
      }
      a.hPA += num(r["PA"]); a.hBB += num(r["BB"]); a.hIBB += num(r["IBB"]); a.hK += num(r["K"]); a.hHR += num(r["HR"]); a.hH += num(r["H"]);
      a.pBF += num(r["BF"]); a.pBB += num(r["BB_1"]); a.pIBB += num(r["IBB_1"]); a.pK += num(r["K_1"]); a.pHR += num(r["HR_1"]);
      a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]);
    }
  }
  const per600 = (x: number, denom: number) => (denom > 0 ? (x * 600) / denom : 0);
  return [...m.values()].map((a) => ({
    cid: a.cid, vlvl: a.vlvl, combined: true as const, evalOnly: true as const,
    pa: a.hPA, bf: a.pBF, bats: a.bats, throws: a.throws, ratings: a.ratings,
    actual: {
      hit: { uBB: per600(a.hBB - a.hIBB, a.hPA), K: per600(a.hK, a.hPA), HR: per600(a.hHR, a.hPA), HmHR: per600(a.hH - a.hHR, a.hPA) },
      pit: { uBB: per600(a.pBB - a.pIBB, a.pBF), K: per600(a.pK, a.pBF), HR: per600(a.pHR, a.pBF), HmHR: per600(a.p1B + a.p2B + a.p3B, a.pBF) },
    },
  }));
}

/** vR/vL blend weights, realized from the running's own handedness mix (mirrors kslope/quicks). */
export interface TournamentExposure {
  /** Hitter vR weight = league RHP share of BF (a hitter faces RHP this fraction of the time). */
  wRhit: number;
  /** Pitcher vR weight by throwing hand: {1: RHB share, 2: (RHB+switch) share vs a LHP}. */
  wRpit: Record<number, number>;
}

/**
 * Realized vR/vL exposure weights, computed from the aggregated obs' own handedness mix — the
 * same pool-realized shares tools/quicks-levelbias.ts derives from the raw rows (aggregation
 * preserves the totals, so obs-level sums == row-level sums).
 */
export function tournamentExposure(obs: TournamentObs[]): TournamentExposure {
  let bfAll = 0, bfR = 0, paTot = 0, paR = 0, paL = 0, paS = 0;
  for (const o of obs) {
    bfAll += o.bf; if (o.throws === 1) bfR += o.bf;
    paTot += o.pa; if (o.bats === 1) paR += o.pa; else if (o.bats === 2) paL += o.pa; else paS += o.pa;
  }
  const wRhit = bfAll > 0 ? bfR / bfAll : 0.5;
  const denom = paR + paL + paS;
  const wRpit: Record<number, number> = denom > 0
    ? { 1: paR / denom, 2: (paR + paS) / denom }
    : { 1: 0.5, 2: 0.5 };
  return { wRhit, wRpit };
}

/** One row of the pooled level-bias table: predicted vs actual per-600, and their difference. */
export interface LevelBias { event: string; pred: number; actual: number; bias: number }
export interface TournamentLevelTable { hit: LevelBias[]; pit: LevelBias[] }
export interface EvaluateOpts { minPA?: number; minBF?: number }

/**
 * Pooled predicted-vs-actual per-600 level-bias table. Predictions come STRAIGHT from the
 * scoring core (evModel.predictHitting / predictPitching + the coeffs' era factors) — this
 * function writes NO event math of its own (one-core rule). vR/vL predictions are blended by
 * the realized exposure weights, exactly as tools/quicks-levelbias.ts does.
 */
export function evaluateTournamentLevels(
  obs: TournamentObs[], evModel: EventModel, coeffs: Coeffs, exposure: TournamentExposure, opts: EvaluateOpts = {},
): TournamentLevelTable {
  const derived = computeDerived(coeffs, true);
  const eBB = coeffs.era_bb, eK = coeffs.era_k, eHR = derived.era_effective_hr, eH = derived.era_h, eGAP = derived.era_gap;
  const minPA = opts.minPA ?? 100, minBF = opts.minBF ?? 100;
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  interface Row { w: number; pred: EventLevels; actual: EventLevels }
  const hitRows: Row[] = obs.filter((o) => o.pa >= minPA).map((o) => {
    const s = (side: "vR" | "vL") => evModel.predictHitting(o.ratings.hit[side], coeffs);
    const L = s("vL"), Rr = s("vR"), w = exposure.wRhit;
    return {
      w: o.pa,
      pred: {
        uBB: bl(Rr.BB, L.BB, w) * eBB,
        K: bl(Rr.SO, L.SO, w) * eK,
        HR: bl(Rr.HR, L.HR, w) * eHR,
        HmHR: bl(Rr.oneB + Rr.GAP * eGAP, L.oneB + L.GAP * eGAP, w) * eH,
      },
      actual: o.actual.hit,
    };
  });
  const pitRows: Row[] = obs.filter((o) => o.bf >= minBF).map((o) => {
    const w = exposure.wRpit[thr(o.throws)]!;
    const s = (side: "vR" | "vL") => evModel.predictPitching(o.ratings.pit[side], coeffs);
    const L = s("vL"), Rr = s("vR");
    return {
      w: o.bf,
      pred: {
        uBB: bl(Rr.BB, L.BB, w) * eBB,
        K: bl(Rr.K, L.K, w) * eK,
        HR: bl(Rr.HR, L.HR, w) * eHR,
        HmHR: bl(Rr.nHH, L.nHH, w) * eH,
      },
      actual: o.actual.pit,
    };
  });

  const wmean = (rows: Row[], get: (r: Row) => number) => {
    let nn = 0, dd = 0; for (const r of rows) { nn += r.w * get(r); dd += r.w; } return dd ? nn / dd : 0;
  };
  const table = (rows: Row[]): LevelBias[] =>
    (["uBB", "K", "HR", "HmHR"] as (keyof EventLevels)[]).map((event) => {
      const pred = wmean(rows, (r) => r.pred[event]);
      const actual = wmean(rows, (r) => r.actual[event]);
      return { event: event === "HmHR" ? "H-HR" : event, pred, actual, bias: pred - actual };
    });
  return { hit: table(hitRows), pit: table(pitRows) };
}
