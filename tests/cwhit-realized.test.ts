// REALIZED USAGE MUST SEE VARIANTS (blocking battery fix, 2026-07-21).
//
// The battery's realized-usage weighting was built from a private join restricted to observed
// `VLvl == 0`, which discarded every v5 row: 25.5% of all observed play, concentrated in the best
// cards. These pins hold the two properties that failure violated.
//
//  1. THE OPPONENT SET AND THE JOINED SET AGREE. Every card the builder matched to an observed row
//     must exist in `opponentSet` — if the builder's eligibility and this module's ever desynchronise,
//     usage would be silently dropped again (orphan cids), which is exactly the old failure mode with
//     a different cause.
//  2. THE VARIANT SHARE IS NON-TRIVIAL. Pinned as a floor, so a regression to VLvl-0-only weighting
//     (or any filter that has that effect) fails loudly instead of quietly re-weighting the field.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, type FieldStats, type RatingEnvelope, type TrainingMeans } from "../src/scoring-core/index.ts";
import { resolveCoeffs } from "../src/config/coeff-resolve.ts";
import { computeDerived } from "../src/config/derived.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { buildCwhitSample, QUICK, FIELD_N, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { realizedUsage, opponentSet, coverage, cellKey, type Opponent } from "../src/eval/cwhit/realized.ts";
import type { EventForm } from "../src/model/curves.ts";
import type { WobaWeights } from "../src/eval/cwhit/audit.ts";

describe("realized usage is variant-aware", () => {
  it("has no orphan cids and carries a material v5 share", async () => {
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) {
      console.warn("[cwhit-realized] no active trained model — pin SKIPPED, not passed");
      return;
    }
    const rp = makeRawPolyModel(trained.eventForm);
    const model = (await repo.loadAll<{ id: string }>("models"))[0]!;
    const eras = new Map((await repo.loadAll<{ id: string }>("eras")).map((e) => [e.id, e]));
    const parks = new Map((await repo.loadAll<{ id: string }>("parks")).map((p) => [p.id, p]));
    const tourneys = await repo.loadAll<{ id: string; eraId: string; parkId: string; softcaps: unknown }>("tournaments");
    const bq = tourneys.find((t) => t.id === "bronze-quick")!;
    const coeffs = resolveCoeffs(model as never, eras.get(bq.eraId) as never, parks.get(bq.parkId) as never, bq.softcaps as never);
    applyWobaWeights(coeffs, trained.wobaWeights as never);
    const derived = computeDerived(coeffs);
    const srcId = state.catalogSourceId ?? "cdmx";
    const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
      .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
    const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
    const deps: SampleDeps = {
      baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as never, ref,
      envelope: trained.ratingEnvelope,
      pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
      hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
    };

    const res = buildCwhitSample(deps);
    const usage = realizedUsage(res);
    const opps = new Map<string, Opponent[]>();
    for (const win of QUICK) for (const role of ["pit", "hit"] as const)
      opps.set(cellKey(win.tier, role), opponentSet(baseCards, win, role));

    const rows = coverage(usage, opps);
    expect(rows.length).toBe(10);
    for (const r of rows)
      expect(r.orphanCids, `${r.tier} ${r.role}: joined cards missing from the opponent set`).toBe(0);

    const usageVar = rows.reduce((a, r) => a + r.usageVar, 0);
    const usageAll = rows.reduce((a, r) => a + r.usageBase + r.usageVar, 0);
    expect(usageAll).toBeGreaterThan(0);
    // Floor, not a snapshot: the measured share sits well above this, and any change that
    // re-excludes v5 rows drives it to exactly 0.
    expect(usageVar / usageAll, "v5 share of realized usage — a VLvl-0-only weighting makes this 0").toBeGreaterThan(0.05);
    for (const r of rows)
      expect(r.playedVar, `${r.tier} ${r.role}: no v5 opponent carries usage`).toBeGreaterThan(0);
  }, 180_000);
});
