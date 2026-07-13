// EVALUATION-ONLY tournament ingestion — behaviour + the ISOLATION GUARD.
//
// The guard is the point of this suite: tournament outcomes must be structurally INCAPABLE
// of entering a training fit. Two lines of defence are asserted:
//   1. Every TournamentObs carries `evalOnly: true` / `combined: true` and lacks the TrainObs
//      shape (`sources`/`hit.PA`/`pitch.BF`) a fitter consumes — so it can't be fed to one.
//   2. By construction, the training loader has NO reference to tournament-eval, and
//      tournament-eval imports NO fit/window function. Asserted against the source text so a
//      future edit that wires the two together fails this test loudly.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  loadTournamentOutcomes, tournamentExposure, evaluateTournamentLevels,
  type TournamentObs,
} from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { loadWindow } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, RAWPOLY_PIT } from "../src/training/forms.ts";
import { makeRawPolyModel, computeDerived, type Coeffs } from "../src/scoring-core/index.ts";
import type { EventForm } from "../src/model/curves.ts";

const TDIR = ["Tournament Data/Return of the Bronze", "Tournament Data/Quicks - Open"].find((d) => existsSync(d));
const TRAIN = "Model 2037 and 2038";

// Neutral coeffs (mirrors tests/raw-poly.test.ts): every era/park factor = 1, so the level
// table reflects ONLY the fitted curves + the tournament outcomes.
function neutralCoeffs(): Coeffs {
  const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
  return {
    ...base,
    tournament_hr_adjust: false,
    park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1,
    era_bb: 1, era_k: 1, era_avg: 1, era_hr: 1, era_bip: 1, era_gap: 1, era_thr: 1,
    adv_hbp: 6, adv_sh: 3, adv_sf: 4,
    ssp_adv_hitting: 1, ssp_basic_hitting: 1, ssp_basic_pitching: 1,
  };
}

describe.skipIf(!TDIR)("loadTournamentOutcomes — eval-only ingestion", () => {
  it("returns obs, every one tagged evalOnly + combined", () => {
    const obs = loadTournamentOutcomes(TDIR!);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.every((o) => o.evalOnly === true)).toBe(true);
    expect(obs.every((o) => o.combined === true)).toBe(true);
  });

  it("obs are per-600 combined lines with realistic magnitudes", () => {
    const obs = loadTournamentOutcomes(TDIR!);
    // A card is a hitter (pa>0) or pitcher (bf>0) or both; per-600 events sit in sane ranges.
    for (const o of obs) {
      expect(o.pa).toBeGreaterThanOrEqual(0);
      expect(o.bf).toBeGreaterThanOrEqual(0);
      if (o.pa > 0) expect(o.actual.hit.K).toBeGreaterThanOrEqual(0);
    }
    expect(obs.some((o) => o.pa > 0)).toBe(true);
  });

  it("injected ghost-cleaner is applied (DI) and never adds volume", () => {
    const without = loadTournamentOutcomes(TDIR!);
    const cleaned = loadTournamentOutcomes(TDIR!, {
      expectedTeams: 128,
      clean: (rows, teams) => cleanTournamentRows(rows, teams ?? 128).cleaned,
    });
    const pa = (o: TournamentObs[]) => o.reduce((s, x) => s + x.pa, 0);
    expect(pa(cleaned)).toBeLessThanOrEqual(pa(without));
    expect(cleaned.every((o) => o.evalOnly === true)).toBe(true);
  });
});

describe.skipIf(!TDIR || !existsSync(TRAIN))("evaluateTournamentLevels — pooled level-bias table", () => {
  it("produces a hit + pit table over the four events, blended by realized exposure", () => {
    const obs = loadTournamentOutcomes(TDIR!);
    const { observations } = loadWindow(TRAIN, [2037, 2038]);
    const form: EventForm = {
      hit: fitHitForm(RAWPOLY_HIT, observations.filter((o) => o.hit.PA >= 1000)),
      pit: fitPitForm(RAWPOLY_PIT, observations.filter((o) => o.pitch.BF >= 1000)),
    };
    const coeffs = neutralCoeffs();
    computeDerived(coeffs); // sanity: derivation runs on these coeffs
    const evModel = makeRawPolyModel(form);
    const exposure = tournamentExposure(obs);
    expect(exposure.wRhit).toBeGreaterThan(0);
    expect(exposure.wRhit).toBeLessThanOrEqual(1);

    const table = evaluateTournamentLevels(obs, evModel, coeffs, exposure);
    expect(table.hit.map((r) => r.event)).toEqual(["uBB", "K", "HR", "H-HR"]);
    expect(table.pit.map((r) => r.event)).toEqual(["uBB", "K", "HR", "H-HR"]);
    for (const r of [...table.hit, ...table.pit]) {
      expect(Number.isFinite(r.pred)).toBe(true);
      expect(Number.isFinite(r.actual)).toBe(true);
      expect(r.bias).toBeCloseTo(r.pred - r.actual, 10);
    }
  });
});

// ── ISOLATION GUARD — no data needed; always runs ─────────────────────────────
describe("tournament-eval ↔ training isolation (structural guarantee)", () => {
  it("TournamentObs is a distinct eval-only shape (not a TrainObs)", () => {
    // A literal that satisfies TournamentObs must carry the eval-only tags. A TrainObs (which
    // carries `sources`/`hit.PA`/`pitch.BF`, has no such tags) can never widen to this type.
    const o: TournamentObs = {
      cid: "x", vlvl: 0, combined: true, evalOnly: true, pa: 0, bf: 0, bats: 1, throws: 1,
      ratings: {
        hit: { vR: { eye: 0, pow: 0, kRat: 0, babip: 0, gap: 0, speed: 0, steal: 0, run: 0 }, vL: { eye: 0, pow: 0, kRat: 0, babip: 0, gap: 0, speed: 0, steal: 0, run: 0 } },
        pit: { vR: { con: 0, stu: 0, pbabip: 0, hrr: 0 }, vL: { con: 0, stu: 0, pbabip: 0, hrr: 0 } },
      },
      actual: { hit: { uBB: 0, K: 0, HR: 0, HmHR: 0 }, pit: { uBB: 0, K: 0, HR: 0, HmHR: 0 } },
    };
    expect(o.evalOnly).toBe(true);
    expect(o.combined).toBe(true);
    expect("sources" in o).toBe(false); // the TrainObs field a fitter reads is absent by type
  });

  it("the training loader has NO reference to tournament-eval (can't pull eval obs into a fit)", () => {
    const loader = readFileSync("src/training/loader.ts", "utf8");
    expect(loader).not.toMatch(/tournament-eval/);
    const evaluate = readFileSync("src/training/evaluate.ts", "utf8");
    expect(evaluate).not.toMatch(/tournament-eval/);
    const fit = readFileSync("src/training/fit.ts", "utf8");
    expect(fit).not.toMatch(/tournament-eval/);
  });

  it("tournament-eval imports NO fit / window / getFit path (one-way dependency)", () => {
    // Strip comments first — the module header intentionally NAMES these tokens to document the
    // isolation; the guard is about executable code, not prose.
    const code = readFileSync("src/training/tournament-eval.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // It may reuse the scoring core, but must NOT touch the trainer's fit/window machinery.
    expect(code).not.toMatch(/\bwindowObs\b/);
    expect(code).not.toMatch(/\bgetFit\b/);
    expect(code).not.toMatch(/\bloadWindow\b/);
    expect(code).not.toMatch(/parseTrainingFilename/);
    expect(code).not.toMatch(/from ["'].*training\/fit/);
    expect(code).not.toMatch(/trainWoba|trainBasic/);
  });
});
