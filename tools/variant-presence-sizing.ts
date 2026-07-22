// ═══ p-SENSITIVITY SIZING — how much does the frame move with the presence prior? ══
//
// Fable ruling (o): arm C is replaced by EMPIRICAL COMPARABILITY. The pool leg becomes
// eligibility-gated and PRESENCE-WEIGHTED — an eligible card contributes its v5 at weight p and its
// base at weight 1-p — and the prior is measured, not chosen. SIZE FIRST: insensitive across the
// plausible p range ⇒ a global p ships; sensitive ⇒ a property-conditioned p comes back as a proposal.
//
// p IS ON THE CONDITIONAL SCALE (Fable amendment, from Derek): v5 usage / ELIGIBLE-CLASS usage.
// Measured in fixtures/cwhit-variant-presence-conditional-2026-07-22.txt as 25.7-42.6% (pitchers)
// and 21.8-42.3% (hitters) — NOT the raw 15-29%, which carried ineligible-class play in its
// denominator. The sweep therefore spans 0 … 0.40 and the eligibility-only endpoint, bracketing the
// measured range rather than the raw one.
//
// THE CONSTRUCTION, and why it needs no new maths. A mixture cannot be handed to
// `computeUnifiedFieldStats`, which takes a plain card array and an integer top-N. But for rational
// p = k/m the mixture is EXACTLY representable by INTEGER REPLICATION: emit each ineligible card m
// times, and each eligible card as (m-k) base copies plus k v5 copies, then ask for top-N × m.
// Duplicates carry identical predicted value, so the top-(N·m) of the replicated population is
// exactly the weighted top-N of the mixture, and its moments are exactly the weighted moments. The
// SHARED CORE does all of it — no weighted-moment variant is written here, which would have been a
// second copy of scoring maths and is forbidden.
//
// ELIGIBILITY comes from the landed predicate (7 disjoint classes + dev-override list). p = 0 is
// today's production pool exactly; p = 1 is the eligibility-gated version of what arm C would have
// done; the old ungated arm C is not on this sweep at all, because it is refuted.
//
// MEASUREMENT ONLY. Nothing fitted, nothing wired.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats, buildFrameShift,
  FIELD_N, type EventForm, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { canHaveVariant, makeVariant } from "../src/data/variants.ts";
import { QUICK, inValueWindow } from "../src/eval/cwhit/sample.ts";
import { kSpreadPitRamp, pitSpreadHrRamp } from "../src/model/pool-transform.ts";

const M = 10;                                    // replication denominator ⇒ p resolvable to 1/10
const PS = [0, 0.2, 0.3, 0.4, 1.0] as const;     // brackets the measured conditional range 0.22-0.43

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.trainingMeans) throw new Error("active model missing eventForm/wobaWeights/trainingMeans");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

/** The mixture population at presence p, by exact integer replication (see header). */
function mixture(pool: Card[], p: number): Card[] {
  const k = Math.round(p * M);
  const out: Card[] = [];
  for (const c of pool) {
    if (!canHaveVariant(c)) { for (let i = 0; i < M; i++) out.push(c); continue; }
    const v = k > 0 ? makeVariant(c) : null;
    for (let i = 0; i < M - k; i++) out.push(c);
    for (let i = 0; i < k; i++) out.push(v!);
  }
  return out;
}

console.log(`\n╔═══ p-SENSITIVITY SIZING — presence-weighted pool leg ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | replication M=${M} (exact for p in 0.1 steps)`);
console.log(`p is CONDITIONAL (v5 usage / eligible-class usage); measured 0.26-0.43 pit, 0.22-0.42 hit`);
console.log(`p=0 reproduces production exactly; p=1 is the ELIGIBILITY-GATED full-inclusion endpoint`);
console.log(`\n  tier      quantity        ${PS.map((p) => `p=${p.toFixed(1)}`.padStart(9)).join("")}   span over measured p (0.2-0.4)`);

const rows: { tier: string; gaps: number[]; sK: number[] }[] = [];
for (const win of QUICK) {
  const pool = baseCards.filter((c) => inValueWindow(c, win));
  const gaps: number[] = [], sK: number[] = [], sHR: number[] = [];
  for (const p of PS) {
    const pf = computeUnifiedFieldStats(mixture(pool, p), coeffs, rp, FIELD_N * M, true);
    const fs = buildFrameShift(trained.trainingMeans!, pf);
    const g = fs.pit.vR.stu ?? 0;
    gaps.push(g); sK.push(kSpreadPitRamp(g)); sHR.push(pitSpreadHrRamp(fs.pit.vR.hrr ?? 0));
  }
  rows.push({ tier: win.tier, gaps, sK });
  const band = (xs: number[]) => `${(xs[1]! - xs[3]!).toFixed(3)}`;  // p=0.2 minus p=0.4
  console.log(`  ${win.tier.padEnd(9)} gap pit.stu    ${gaps.map((g) => g.toFixed(2).padStart(9)).join("")}   ${band(gaps).padStart(8)}`);
  console.log(`  ${" ".padEnd(9)} shipped s_K    ${sK.map((s) => s.toFixed(3).padStart(9)).join("")}   ${band(sK).padStart(8)}`);
  console.log(`  ${" ".padEnd(9)} shipped s_HR   ${sHR.map((s) => s.toFixed(3).padStart(9)).join("")}`);
}

console.log(`\n── THE PRE-REGISTERED QUESTION: is s_K insensitive across the measured p band? ──`);
console.log(`   Comparator: the correction's own magnitude at p=0 (production today), s_K − 1.`);
console.log(`\n  tier      s_K(0.2)  s_K(0.4)   swing   correction at p=0   swing as % of correction`);
for (const r of rows) {
  const sw = Math.abs(r.sK[1]! - r.sK[3]!), corr = r.sK[0]! - 1;
  console.log(`  ${r.tier.padEnd(9)} ${r.sK[1]!.toFixed(3).padStart(8)} ${r.sK[3]!.toFixed(3).padStart(9)} ${sw.toFixed(3).padStart(7)}   ${corr.toFixed(3).padStart(17)}   ${(100 * sw / corr).toFixed(1).padStart(22)}%`);
}
console.log(`\n(end of p-sensitivity sizing — measurement only)`);
