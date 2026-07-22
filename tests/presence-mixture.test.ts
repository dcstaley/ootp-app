// THE PRESENCE-WEIGHTED POOL LEG IS EXACT, NOT APPROXIMATE (C2', 2026-07-22).
//
// Arm C — "fields variant-inclusive everywhere" — was refuted: it produced a pool field 84-96%
// variant against a training leg that is 2.5% variant by qualifying pitcher usage. The replacement
// weights an eligible card's v5 at p and its base at 1-p, with p = 0.30 (Fable ruling (t), the centre
// of the measured conditional band).
//
// A mixture cannot be handed to `computeUnifiedFieldStats`, which takes a card array and an integer
// top-N, so it is represented by INTEGER REPLICATION. That is only legitimate if replication itself
// distorts nothing — which is what the first test here proves, and it is the load-bearing claim of
// the whole construction. If it were false, every field statistic downstream would be quietly wrong.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { resolveCoeffs } from "../src/config/coeff-resolve.ts";
import { computeUnifiedFieldStats, makeRawPolyModel, applyWobaWeights, FIELD_N } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, cardId, type Card } from "../src/data/catalog.ts";
import { presenceMixture, PRESENCE_P, PRESENCE_M, canHaveVariant, isVariant } from "../src/data/variants.ts";
import type { EventForm } from "../src/model/curves.ts";

type RS = { mu: number; sd: number };
type Stats = { hit: { vR: Record<string, RS>; vL: Record<string, RS> }; pit: { vR: Record<string, RS>; vL: Record<string, RS> } };

const cards = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

describe("presence mixture", () => {
  it("REPLICATION DISTORTS NOTHING: p=0 reproduces the plain pool's field stats exactly", async () => {
    // THE claim the construction rests on. Top-(N*m) over m copies of each card must equal top-N
    // over the cards themselves — same members, same moments — or every downstream field statistic
    // is silently wrong by an amount nobody would ever see.
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm; wobaWeights?: unknown };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm || !trained.wobaWeights) { console.warn("[presence] no active model — SKIPPED"); return; }
    const rp = makeRawPolyModel(trained.eventForm);
    const model = (await repo.loadAll<{ id: string }>("models"))[0]!;
    const era = (await repo.loadAll<{ id: string }>("eras"))[0]!;
    const park = (await repo.loadAll<{ id: string }>("parks"))[0]!;
    const coeffs = resolveCoeffs(model as never, era as never, park as never, undefined as never);
    applyWobaWeights(coeffs, trained.wobaWeights as never);

    const plain = computeUnifiedFieldStats(cards, coeffs, rp, FIELD_N, true) as never as Stats;
    const replicated = computeUnifiedFieldStats(presenceMixture(cards, 0, PRESENCE_M), coeffs, rp, FIELD_N * PRESENCE_M, true) as never as Stats;

    // NOT bit-equality, and the reason matters. `ratingStats` uses a POPULATION sd (divide by n, not
    // n-1), so replication is mathematically exact — but summing 1000 terms instead of 50 accumulates
    // floating-point rounding in a different order. Measured residual: mu EXACTLY equal (0.00e+0 on
    // every channel), sd differing by ~1e-13 on values of ~27, i.e. ~1e-15 relative.
    //
    // The bar is set to catch what would actually be a defect. Had the core used a SAMPLE sd, the
    // n-1 correction would change with the replication factor and every sd would shift by ~1%
    // (sqrt(49/50) vs sqrt(999/1000)) — three orders of magnitude above this tolerance, and caught.
    let worstMu = 0, worstSdRel = 0;
    for (const role of ["hit", "pit"] as const) {
      for (const side of ["vR", "vL"] as const) {
        for (const k of Object.keys(plain[role][side])) {
          const a = plain[role][side][k]!, b = replicated[role][side][k]!;
          worstMu = Math.max(worstMu, Math.abs(a.mu - b.mu));
          worstSdRel = Math.max(worstSdRel, Math.abs(a.sd - b.sd) / Math.max(Math.abs(a.sd), 1e-12));
        }
      }
    }
    expect(worstMu, "cohort MEANS must be exactly reproduced — any drift here is a real selection change").toBe(0);
    expect(worstSdRel, "sd drift beyond float-summation order means replication is distorting the cohort").toBeLessThan(1e-9);
  }, 180_000);

  it("weights eligible cards only, and leaves ineligible ones alone", () => {
    const sample = cards.slice(0, 300);
    const m = presenceMixture(sample, PRESENCE_P, PRESENCE_M);
    expect(m.length).toBe(sample.length * PRESENCE_M);
    const k = Math.round(PRESENCE_P * PRESENCE_M);
    for (const c of sample.slice(0, 40)) {
      const mine = m.filter((x) => cardId(x) === cardId(c));
      expect(mine).toHaveLength(PRESENCE_M);
      const variants = mine.filter(isVariant).length;
      // An ineligible card has no v5 to weight: it contributes its base at full weight.
      expect(variants, `${c["//Card Title"]}`).toBe(canHaveVariant(c) ? k : 0);
    }
  });

  it("p=0 and p=1 are the exact endpoints", () => {
    const sample = cards.slice(0, 200);
    expect(presenceMixture(sample, 0, PRESENCE_M).some(isVariant)).toBe(false);
    const full = presenceMixture(sample, 1, PRESENCE_M);
    const eligible = sample.filter(canHaveVariant);
    // At p=1 every eligible card is all-v5 and every ineligible one is still all-base — which is why
    // p=1 is the ELIGIBILITY-GATED endpoint and not the refuted ungated arm C.
    expect(full.filter(isVariant)).toHaveLength(eligible.length * PRESENCE_M);
  });

  it("refuses a p it cannot represent, instead of silently rounding it", () => {
    // The trap this guards: Math.round would turn an unrepresentable p into a neighbouring one and
    // the shipped constant would no longer be the fitted constant, with nothing reporting it.
    expect(() => presenceMixture(cards.slice(0, 10), 0.33, PRESENCE_M)).toThrow(/not representable/);
    // The shipped p and both sensitivity re-check points must be exactly representable.
    for (const p of [PRESENCE_P, 0.25, 0.35]) {
      expect(Math.abs(p * PRESENCE_M - Math.round(p * PRESENCE_M)), `p=${p} must be exact at m=${PRESENCE_M}`).toBeLessThan(1e-9);
    }
  });

  it("PRESENCE_P is the ruled 0.30, inside the tripwire band", () => {
    expect(PRESENCE_P).toBe(0.30);
    // The drift-doctrine tripwire: re-pulls compare realized conditional presence against this and
    // flag a p-update if it leaves 0.25-0.35. Pinned so the band and the constant cannot drift apart.
    expect(PRESENCE_P).toBeGreaterThanOrEqual(0.25);
    expect(PRESENCE_P).toBeLessThanOrEqual(0.35);
  });
});
