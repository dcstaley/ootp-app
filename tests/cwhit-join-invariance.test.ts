// THE JOIN MUST NOT DEPEND ON THE CORRECTION UNDER TEST (Fable ruling B, 2026-07-21).
//
// The two fit tools reported different N over the same corpus and floors — bronze 156 vs 158,
// gold-cap joins 504 vs 505. Root cause: the join fingerprint lives in EVENT space (cwhit publishes
// no ratings, so our side must meet the observed side there) and was built from the CORRECTED
// predicted line. Applying the K-spread ramp moves predicted K/BABIP enough to change collision
// disambiguation, so two rows previously dropped as ambiguous became separable and joined. Both
// extra rows were "Bob Miller" — the 3-way name collision join.ts documents.
//
// That is circular: the sample a correction is measured on must not be selected BY that correction.
// The fingerprint is now built from the uncorrected line, and this pin holds it there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanKOwn, applyWobaWeights, type FieldStats, type RatingEnvelope } from "../src/scoring-core/index.ts";
import { resolveCoeffs } from "../src/config/coeff-resolve.ts";
import { computeDerived } from "../src/config/derived.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { kSpreadPitRamp } from "../src/model/pool-transform.ts";
import { buildCwhitSample, inValueWindow, FIELD_N, type SampleDeps, type KSpreadPit, type ValueWindow } from "../src/eval/cwhit/sample.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { WobaWeights } from "../src/eval/cwhit/audit.ts";
import type { TrainingMeans } from "../src/scoring-core/index.ts";

// BRONZE only, pitchers: the tier that actually broke, and the one carrying the Bob Miller collision.
const BRONZE: ValueWindow[] = [{ tier: "bronze", valueMax: 69 }];

describe("cwhit join is invariant to the correction state", () => {
  it("yields identical N and identical card identities with and without the K-spread ramp", async () => {
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon || !trained.trainingMeans) {
      // No active model ⇒ nothing to pin. Skip loudly rather than passing vacuously.
      console.warn("[join-invariance] no active trained model — pin SKIPPED, not passed");
      return;
    }
    const rp = makeRawPolyModel(trained.eventForm);
    const model = (await repo.loadAll<{ id: string; coeffs: unknown }>("models"))[0]!;
    const eras = new Map((await repo.loadAll<{ id: string }>("eras")).map((e) => [e.id, e]));
    const parks = new Map((await repo.loadAll<{ id: string }>("parks")).map((p) => [p.id, p]));
    const tourneys = await repo.loadAll<{ id: string; eraId: string; parkId: string; softcaps: unknown }>("tournaments");
    const bq = tourneys.find((t) => t.id === "bronze-quick")!;
    const coeffs = resolveCoeffs(model as never, eras.get(bq.eraId) as never, parks.get(bq.parkId) as never, bq.softcaps as never);
    applyWobaWeights(coeffs, trained.wobaWeights as never);
    const derived = computeDerived(coeffs);
    const srcId = state.catalogSourceId ?? "cdmx";
    const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
    const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
    const deps: SampleDeps = {
      baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as never, ref,
      envelope: trained.ratingEnvelope,
      pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
      hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
      formats: BRONZE,
    };

    // The shipped ramp, exactly as the fit tools build it.
    const basePool = baseCards.filter((c) => inValueWindow(c, BRONZE[0]!));
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
    const pt = buildPoolTransform(ref, poolField, deps.envelope);
    const shift = buildFrameShift(trained.trainingMeans, poolField);
    const ks = new Map<string, KSpreadPit>([["bronze", {
      s: kSpreadPitRamp(shift.pit.vR.stu ?? 0),
      mean: poolMeanKOwn(basePool, coeffs, rp, pt, FIELD_N).pit,
    }]]);
    expect(ks.get("bronze")!.s, "the ramp must actually be doing something, or this pin is vacuous").not.toBe(1);

    const without = buildCwhitSample(deps);
    const withKs = buildCwhitSample({ ...deps, kSpreadPit: ks });

    const idents = (r: typeof without) => r.recs.filter((x) => x.role === "pit").map((x) => `${x.title}|${x.vlvl}`).sort();
    expect(withKs.recs.length, "total joined rows must not depend on the correction").toBe(without.recs.length);
    expect(idents(withKs), "the joined CARD IDENTITIES must not depend on the correction").toEqual(idents(without));
  }, 120_000);
});
