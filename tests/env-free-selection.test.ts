// FIELD SELECTION MUST BE ENVIRONMENT-FREE (C1 of the 2026-07-22 constants event).
//
// `referenceFieldStats` and `leagueExposureBaseline` cache on `${activeModelId}|${catalogSource}`
// with NO tournament in the key, on the stated assumption that raw-wOBA selection is env-free. The
// item-B audit measured that assumption FALSE on the hitter leg: `assembleRawHittingWoba` adds a
// baserunning term whose `adv_*` coefficients `resolveCoeffs` scales by era.runVal / era.sbFreq, so
// the hitter field selected under era-1920 differed from the same field under era-2010 (reference
// top-50 swapped 1/50, pool fields up to 3/50, stu gap -0.57..+0.74, s_K +/-0.023). Whichever
// tournament resolved a cold cache first then set the field every other tournament read — silent,
// order-dependent, and not reproducible from the saved state.
//
// C1 zeroes baserunning in the SELECTION ranking only (exactly as calibrate's anchor already did),
// which makes those cache keys valid BY CONSTRUCTION. This pin holds that property: if anyone
// re-introduces an env-scaled term into the ranking, the cache silently starts lying again, and only
// a test like this notices.
//
// The PITCHER leg was already env-free exactly; it is asserted too, as the control that proves the
// test can distinguish the two cases rather than passing vacuously.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { resolveCoeffs } from "../src/config/coeff-resolve.ts";
import { computeUnifiedFieldStats, makeRawPolyModel, applyWobaWeights, cardSideWobas, FIELD_N } from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import type { EventForm } from "../src/model/curves.ts";

describe("field selection is environment-free", () => {
  it("gives byte-identical field stats under every era", async () => {
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm; wobaWeights?: unknown };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm || !trained.wobaWeights) { console.warn("[env-free] no active model — pin SKIPPED, not passed"); return; }
    const rp = makeRawPolyModel(trained.eventForm);
    const model = (await repo.loadAll<{ id: string }>("models"))[0]!;
    const eras = await repo.loadAll<{ id: string }>("eras");
    const parks = await repo.loadAll<{ id: string }>("parks");
    const cards = parseCatalogCsv(readFileSync(`data/imports/${state.catalogSourceId ?? "cdmx"}.csv`, "utf8")).cards
      .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

    // Eras chosen to span the baserunning coefficients' range: the run-value and steal-frequency
    // factors differ most between a dead-ball era and a modern one, which is exactly where the old
    // hitter-leg dependence showed up.
    const pick = ["era-2010", "era-1920", "era-1939"].map((id) => eras.find((e) => e.id === id)).filter(Boolean);
    expect(pick.length, "need several eras to make this test meaningful").toBeGreaterThan(1);
    const park = parks[0]!;

    const statsOf = (era: { id: string }) => {
      const coeffs = resolveCoeffs(model as never, era as never, park as never, undefined as never);
      applyWobaWeights(coeffs, trained.wobaWeights as never);
      return computeUnifiedFieldStats(cards, coeffs, rp, FIELD_N, true);
    };
    const base = JSON.stringify(statsOf(pick[0]! as { id: string }));
    for (const e of pick.slice(1)) {
      expect(JSON.stringify(statsOf(e as { id: string })), `field stats moved under ${(e as { id: string }).id} — selection is env-dependent again`).toBe(base);
    }
  }, 180_000);

  it("both legs of the selection ranking are era-invariant per card", async () => {
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm; wobaWeights?: unknown };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm || !trained.wobaWeights) return;
    const rp = makeRawPolyModel(trained.eventForm);
    const model = (await repo.loadAll<{ id: string }>("models"))[0]!;
    const eras = await repo.loadAll<{ id: string }>("eras");
    const parks = await repo.loadAll<{ id: string }>("parks");
    const cards = parseCatalogCsv(readFileSync(`data/imports/${state.catalogSourceId ?? "cdmx"}.csv`, "utf8")).cards
      .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y").slice(0, 400);
    const mk = (id: string) => {
      const era = eras.find((e) => e.id === id)!;
      const coeffs = resolveCoeffs(model as never, era as never, parks[0]! as never, undefined as never);
      applyWobaWeights(coeffs, trained.wobaWeights as never);
      return cards.map((c) => cardSideWobas(c, coeffs, rp, true));
    };
    const a = mk("era-2010"), b = mk("era-1920");
    let worstHit = 0, worstPit = 0;
    for (let i = 0; i < a.length; i++) {
      worstHit = Math.max(worstHit, Math.abs(a[i]!.hitVR - b[i]!.hitVR), Math.abs(a[i]!.hitVL - b[i]!.hitVL));
      worstPit = Math.max(worstPit, Math.abs(a[i]!.pitVR - b[i]!.pitVR), Math.abs(a[i]!.pitVL - b[i]!.pitVL));
    }
    // The pitcher leg was ALREADY exact — it is the control. The hitter leg is what C1 fixed.
    expect(worstPit, "pitcher leg was always env-free; if this moves, the control is broken").toBe(0);
    expect(worstHit, "hitter leg must now be env-free too (C1)").toBe(0);
  }, 180_000);
});
