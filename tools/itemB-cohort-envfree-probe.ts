// ITEM B — COHORT AUDIT: is the field-SELECTION basis genuinely environment-free?
//   run: node tools/itemB-cohort-envfree-probe.ts
//
// THE CLAIM UNDER TEST. `referenceFieldStats` (src/server/server.ts:281-287) caches the
// full-catalog reference field on `${activeModelId}|${catalogSource}` with NO tournament in
// the key. That is asserted benign because the raw-wOBA selection is "env-free" (comment at
// server.ts:277-279; restated in fixtures/cwhit-itemA-variant-sizing-2026-07-21.txt §1). If the
// selection basis carries ANY per-tournament term, the cached reference field is whichever
// tournament resolved it FIRST, for every tournament after it, with no error and no warning.
//
// WHAT THE READING OF THE CODE SAYS (verified by hand, then measured here):
//   · pitcher leg  — assembleRawPitchingWoba (src/scoring-core/woba.ts:51-55) reads wOBA weights
//     + adv_hbp only. Both are MODEL-scoped. Genuinely env-free.
//   · hitter leg   — assembleRawHittingWoba (woba.ts:43-49) adds baserunningWoba(...), which reads
//     adv_speed / adv_run / adv_steal / adv_stealRate / adv_stealInt (woba.ts:35-38). resolveCoeffs
//     SCALES all of those by the ERA's runVal and sbFreq (src/config/coeff-resolve.ts:136-141).
//     ⇒ the hitter selection basis is ERA-DEPENDENT.
//   · the event model itself ignores coeffs entirely (raw-poly.ts predictHitting/predictPitching
//     take `_c`), and softcaps never reach this path (softcap() is read only by basic.ts and the
//     retired log path), so era is the ONLY per-tournament term in play.
//
// MEASUREMENT ONLY. No production behaviour, default or constant is changed; nothing is wired.
// No scoring math is written here — every number comes from the shared core (resolveCoeffs /
// computeUnifiedFieldStats / cardSideWobas / buildFrameShift / the shipped ramps). FIELD_N is
// imported from src/scoring-core/pool-stats.ts, never re-declared.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  FIELD_N, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats, cardSideWobas,
  buildFrameShift, kSpreadPitRamp, pitSpreadHrRamp,
  type EventForm, type WobaWeights, type TrainingMeans, type Coeffs, type FieldStats,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow } from "../src/eval/cwhit/sample.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; trainingMeans?: TrainingMeans };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const srcId = state.catalogSourceId ?? "cdmx";
// The reference cohort exactly as production builds it: full catalog, isBaseCard predicate
// (server.ts:238 / 358). Variant policy is item A's question and is held at production's here.
const baseCards: Card[] = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

// PARK + SOFTCAPS HELD FIXED at one tournament's, so the ONLY thing varying below is the era.
const anchorT = tournaments.find((t) => t.id === "gold-quick") ?? tournaments[0]!;
const mkCoeffs = (eraId: string): Coeffs => {
  const c = resolveCoeffs(model, eras.get(eraId)!, parks.get(anchorT.parkId)!, anchorT.softcaps);
  applyWobaWeights(c, trained.wobaWeights!);
  return c;
};

// The eras the corpus actually uses (item A §2a) + the neutral baseline.
const ERAS = ["era-2010", "era-1920", "era-1939", "era-1998"];
const HIT_CH = ["eye", "pow", "kRat", "babip", "gap"] as const;
const PIT_CH = ["con", "stu", "pbabip", "hrr"] as const;
const F = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const S = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, w: number) => s.padEnd(w);

console.log("╔" + "═".repeat(94) + "╗");
console.log("║  ITEM B — IS THE FIELD-SELECTION BASIS ENV-FREE? (the referenceFieldStats cache-key question)  ║".slice(0, 96));
console.log("╚" + "═".repeat(94) + "╝");
console.log(`model '${trained.id}' | catalog '${srcId}' (${baseCards.length} base cards) | FIELD_N = ${FIELD_N} (imported)`);
console.log(`park + softcaps HELD at '${anchorT.id}' — the ONLY thing varying below is the era.`);
console.log("MEASUREMENT ONLY — no production behaviour, default or constant is changed.\n");

// ── 1. the era-scaled baserunning coefficients (the suspected channel) ──────────────────────
console.log("╔═══ 1. THE SUSPECTED CHANNEL: era-scaled baserunning coeffs (coeff-resolve.ts:136-141) ═══╗");
console.log("  assembleRawHittingWoba (woba.ts:47-48) adds baserunningWoba, which reads exactly these.");
console.log("  assembleRawPitchingWoba (woba.ts:51-55) reads NONE of them.\n");
console.log(`  ${pad("era", 12)} ${pad("runVal", 10)} ${pad("sbFreq", 10)} ${pad("adv_speed", 13)} ${pad("adv_run", 13)} ${pad("adv_stealRate", 15)} adv_stealInt`);
for (const e of ERAS) {
  const era = eras.get(e)!, c = mkCoeffs(e);
  console.log(`  ${pad(e, 12)} ${pad(F(era.runVal ?? 1, 6), 10)} ${pad(F(era.sbFreq ?? 1, 6), 10)} ${pad((c.adv_speed as number).toExponential(4), 13)} ${pad((c.adv_run as number).toExponential(4), 13)} ${pad((c.adv_stealRate as number).toExponential(4), 15)} ${(c.adv_stealInt as number).toExponential(4)}`);
}

// ── 2. the REFERENCE field (the cached one) under each era ──────────────────────────────────
const topIds = (cards: Card[], c: Coeffs, side: "hit" | "pit"): string[] => {
  const recs = cards.map((x) => ({ id: String(x["Card ID"]), w: cardSideWobas(x, c, rp, true) }));
  // Mirrors computeUnifiedFieldStats' own selection: hitters per-side (vR shown), pitchers combined.
  const sorted = side === "hit"
    ? [...recs].sort((a, b) => b.w.hitVR - a.w.hitVR)
    : [...recs].sort((a, b) => (a.w.pitVR + a.w.pitVL) - (b.w.pitVR + b.w.pitVL));
  return sorted.slice(0, FIELD_N).map((r) => r.id);
};
const overlap = (a: string[], b: string[]) => a.filter((x) => new Set(b).has(x)).length;

const refStats = new Map<string, FieldStats>();
const refHitTop = new Map<string, string[]>();
const refPitTop = new Map<string, string[]>();
for (const e of ERAS) {
  const c = mkCoeffs(e);
  refStats.set(e, computeUnifiedFieldStats(baseCards, c, rp, FIELD_N, true));
  refHitTop.set(e, topIds(baseCards, c, "hit"));
  refPitTop.set(e, topIds(baseCards, c, "pit"));
}
console.log("\n╔═══ 2. THE CACHED REFERENCE FIELD (server.ts:281-287) RE-COMPUTED UNDER EACH ERA ═══╗");
console.log("  The cache key is `${activeModelId}|${catalogSource}` — no era. If any row below differs");
console.log("  from era-2010, the cached reference field is whichever tournament resolved it FIRST.\n");
console.log(`  ${pad("era", 12)} ${pad("hit top-50 ∩ 2010", 19)} ${pad("pit top-50 ∩ 2010", 19)} hitter field μ per channel (Δ vs era-2010)`);
for (const e of ERAS) {
  const s = refStats.get(e)!, s0 = refStats.get("era-2010")!;
  const d = HIT_CH.map((k) => `${k} ${F(s.hit.vR[k]!.mu, 2)} (${S(s.hit.vR[k]!.mu - s0.hit.vR[k]!.mu, 3)})`).join("  ");
  console.log(`  ${pad(e, 12)} ${pad(`${overlap(refHitTop.get(e)!, refHitTop.get("era-2010")!)}/${FIELD_N}`, 19)} ${pad(`${overlap(refPitTop.get(e)!, refPitTop.get("era-2010")!)}/${FIELD_N}`, 19)} ${d}`);
}
console.log("\n  pitcher field μ per channel (Δ vs era-2010) — expected EXACTLY 0 (no baserunning term):");
for (const e of ERAS) {
  const s = refStats.get(e)!, s0 = refStats.get("era-2010")!;
  console.log(`  ${pad(e, 12)} ${PIT_CH.map((k) => `${k} ${F(s.pit.vR[k]!.mu, 2)} (${S(s.pit.vR[k]!.mu - s0.pit.vR[k]!.mu, 4)})`).join("  ")}`);
}

// ── 3. the POOL field + the frame gap the SHIPPED ramps read ────────────────────────────────
// Same pool (one value window), varied era ⇒ isolates the era's effect on the ramp INPUT.
console.log("\n╔═══ 3. THE RAMP INPUT: same pool, varied era ═══╗");
console.log("  buildFrameShift's PITCHER channels are HITTER-field gaps (the §10.2 crossing): ");
console.log("  pit.stu = train.hit.kRat − pool.hit.kRat, pit.hrr = train.hit.pow − pool.hit.pow.");
console.log("  trainingMeans was itself selected under era-2010 + a NEUTRAL park (server.ts:1496-1497),");
console.log("  so a non-2010 tournament subtracts two legs selected under different baserunning weights.\n");
if (!trained.trainingMeans) {
  console.log("  active model carries NO trainingMeans — ramp-input section skipped.");
} else {
  const tm = trained.trainingMeans;
  for (const win of QUICK) {
    const pool = baseCards.filter((c) => inValueWindow(c, win));
    console.log(`  ── ${win.tier} (value ≤ ${win.valueMax}, ${pool.length} base cards) ──`);
    console.log(`     ${pad("era", 12)} ${pad("hit top-50 ∩ 2010", 19)} ${pad("gap pit.stu", 13)} ${pad("s_K", 9)} ${pad("gap pit.hrr", 13)} s_HR`);
    let base: { stu: number; hrr: number } | null = null;
    for (const e of ERAS) {
      const c = mkCoeffs(e);
      const pf = computeUnifiedFieldStats(pool, c, rp, FIELD_N, true);
      const fs = buildFrameShift(tm, pf);
      const stu = fs.pit.vR.stu ?? 0, hrr = fs.pit.vR.hrr ?? 0;
      if (!base) base = { stu, hrr };
      const ov = overlap(topIds(pool, c, "hit"), topIds(pool, mkCoeffs("era-2010"), "hit"));
      console.log(`     ${pad(e, 12)} ${pad(`${ov}/${FIELD_N}`, 19)} ${pad(`${F(stu, 3)} (${S(stu - base.stu, 3)})`, 13)} ${pad(F(kSpreadPitRamp(stu), 4), 9)} ${pad(`${F(hrr, 3)} (${S(hrr - base.hrr, 3)})`, 13)} ${F(pitSpreadHrRamp(hrr), 4)}`);
    }
  }
}
console.log("\n(end of probe — measurement only; nothing here changes production behaviour)");
