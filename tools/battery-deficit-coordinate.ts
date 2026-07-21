// ═══ PROPERTY BATTERY — ITEM 1: THE COMPUTED-DEFICIT COORDINATE ══════════════
//
// PER-OPPONENT INTEGRATION (Fable ruling, 2026-07-21). For each card i the model's one-sided
// prediction is evaluated once PER OPPOSING CARD j, with each channel shifted by that opponent's
// OWN rating instead of by the pool mean:
//
//     shift(channel of i) = mu_train_opp(paired channel) − r_j(paired channel)
//
// using buildFrameShift's channel map (pit.con←hit.eye, pit.stu←hit.kRat, pit.hrr←hit.pow,
// pit.pbabip←hit.babip; mirrored for hitters, with hit.gap also ←pit.pbabip). The card's line is the
// average over opponents; the pool's predicted spread is the SD across cards of those
// opponent-averaged lines.
//
// WHY THIS IS NOT THE EXISTING MACHINERY. The scalar path shifts by (mu_train_opp − mu_pool_opp) —
// it collapses the opponents to their MEAN before predicting. Since mean_j(shift) = mu_train_opp −
// mu_pool_opp exactly, this is a strict GENERALISATION: evaluating at the mean shift reproduces the
// scalar path, and the gap between the two is the curvature term over the opponent distribution.
// That degenerate identity is pinned in tests/battery-deficit.test.ts — if it ever breaks, this tool
// is measuring something other than what it claims.
//
// NO TWO-SIDED MODEL is used or implied; there is no interaction term anywhere in the core, so this
// construction carries curvature-mediated heterogeneous response, NOT matchup structure.
//
// POOLS ARE COMPLETE ENVIRONMENTS: every eligible card of the opposing role is an opponent.
// Weighting is EX-ANTE (eligible-pool uniform) — the production candidate per ruling 3. A realized-
// usage weighting is a separate run; a usage proxy would become a named dependency only if
// validation demanded it.
//
// MEASUREMENT ONLY. Nothing here fits, ships, or proposes a form.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived,
  type EventForm, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, isPit, n_ } from "../src/eval/cwhit/sample.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
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

console.log(`\n╔═══ BATTERY ITEM 1 — COMPUTED-DEFICIT COORDINATE (per-opponent integration) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | eligible-pool UNIFORM weighting (the ex-ante production candidate)`);
console.log(`pools are COMPLETE ENVIRONMENTS: every eligible card of the opposing role is an opponent.`);

const HIT_COL = { eye: "Eye vR", pow: "Power vR", kRat: "Avoid K vR", babip: "BABIP vR", gap: "Gap vR" } as const;
const PIT_COL = { con: "Control vR", stu: "Stuff vR", hrr: "pHR vR", pbabip: "pBABIP vR" } as const;
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};

interface Cell { tier: string; role: "pit" | "hit"; n: number; nOpp: number; ratio: Record<string, number>; scalar?: Record<string, number> }
const cells: Cell[] = [];

for (const win of QUICK) {
  const pool = baseCards.filter((c) => inValueWindow(c, win));
  const pits = pool.filter((c) => isPit(c));
  const hits = pool.filter((c) => !isPit(c));

  // ---- PITCHERS integrated over this pool's hitters ----
  {
    const opp = hits.map((h) => ({ eye: n_(h[HIT_COL.eye]), kRat: n_(h[HIT_COL.kRat]), pow: n_(h[HIT_COL.pow]), babip: n_(h[HIT_COL.babip]) }));
    // THE CONTROL: the SCALAR path — opponents collapsed to their mean, one prediction per card.
    // The difference between this and the per-opponent integration IS the curvature term, and it is
    // the only thing that distinguishes item 1 from machinery the program already had.
    const mu = (k: keyof typeof opp[0]) => opp.reduce((a, o) => a + o[k], 0) / (opp.length || 1);
    const muO = { eye: mu("eye"), kRat: mu("kRat"), pow: mu("pow"), babip: mu("babip") };
    const poolCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    const frameCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    const scalarCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    for (const p of pits) {
      const b = { con: n_(p[PIT_COL.con]), stu: n_(p[PIT_COL.stu]), hrr: n_(p[PIT_COL.hrr]), pbabip: n_(p[PIT_COL.pbabip]) };
      let sK = 0, sB = 0, sH = 0, sBab = 0;
      for (const o of opp) {
        const e = rp.predictPitching({
          con: b.con + ((TM.hit["eye"] ?? 0) - o.eye),
          stu: b.stu + ((TM.hit["kRat"] ?? 0) - o.kRat),
          hrr: b.hrr + ((TM.hit["pow"] ?? 0) - o.pow),
          pbabip: b.pbabip + ((TM.hit["babip"] ?? 0) - o.babip),
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.K - e.HR, 1);
        sK += e.K; sB += e.BB; sH += e.HR; sBab += e.nHH / bip;
      }
      const m = opp.length || 1;
      poolCh["k9"]!.push(sK / m); poolCh["bb9"]!.push(sB / m); poolCh["hr9"]!.push(sH / m); poolCh["babip"]!.push(sBab / m);
      // FRAME conditions = the model's own training frame, i.e. no re-basing at all.
      const f = rp.predictPitching(b, coeffs);
      const fb = Math.max(600 - f.BB - f.K - f.HR, 1);
      frameCh["k9"]!.push(f.K); frameCh["bb9"]!.push(f.BB); frameCh["hr9"]!.push(f.HR); frameCh["babip"]!.push(f.nHH / fb);
      const sc = rp.predictPitching({
        con: b.con + ((TM.hit["eye"] ?? 0) - muO.eye), stu: b.stu + ((TM.hit["kRat"] ?? 0) - muO.kRat),
        hrr: b.hrr + ((TM.hit["pow"] ?? 0) - muO.pow), pbabip: b.pbabip + ((TM.hit["babip"] ?? 0) - muO.babip),
      }, coeffs);
      const scb = Math.max(600 - sc.BB - sc.K - sc.HR, 1);
      scalarCh["k9"]!.push(sc.K); scalarCh["bb9"]!.push(sc.BB); scalarCh["hr9"]!.push(sc.HR); scalarCh["babip"]!.push(sc.nHH / scb);
    }
    const ratio: Record<string, number> = {}, scalar: Record<string, number> = {};
    for (const k of Object.keys(poolCh)) {
      const pl = sd(poolCh[k]!), sc = sd(scalarCh[k]!), fr = sd(frameCh[k]!);
      ratio[k] = pl > 0 ? fr / pl : NaN; scalar[k] = sc > 0 ? fr / sc : NaN;
    }
    cells.push({ tier: win.tier, role: "pit", n: pits.length, nOpp: hits.length, ratio, scalar });
  }

  // ---- HITTERS integrated over this pool's pitchers ----
  {
    const opp = pits.map((p) => ({ con: n_(p[PIT_COL.con]), stu: n_(p[PIT_COL.stu]), hrr: n_(p[PIT_COL.hrr]), pbabip: n_(p[PIT_COL.pbabip]) }));
    const poolCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    const frameCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    for (const h of hits) {
      const b = {
        eye: n_(h[HIT_COL.eye]), pow: n_(h[HIT_COL.pow]), kRat: n_(h[HIT_COL.kRat]),
        babip: n_(h[HIT_COL.babip]), gap: n_(h[HIT_COL.gap]),
        speed: n_(h["Speed"]), steal: n_(h["Stealing"]), run: n_(h["Baserunning"]),
      };
      let sSO = 0, sBB = 0, sHR = 0, sBab = 0;
      for (const o of opp) {
        const e = rp.predictHitting({
          eye: b.eye + ((TM.pit["con"] ?? 0) - o.con),
          kRat: b.kRat + ((TM.pit["stu"] ?? 0) - o.stu),
          pow: b.pow + ((TM.pit["hrr"] ?? 0) - o.hrr),
          babip: b.babip + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          gap: b.gap + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          speed: b.speed, steal: b.steal, run: b.run,
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.SO - e.HR, 1);
        sSO += e.SO; sBB += e.BB; sHR += e.HR; sBab += (e.oneB + e.GAP) / bip;
      }
      const m = opp.length || 1;
      poolCh["so"]!.push(sSO / m); poolCh["bb"]!.push(sBB / m); poolCh["hr"]!.push(sHR / m); poolCh["babip"]!.push(sBab / m);
      const f = rp.predictHitting(b, coeffs);
      const fb = Math.max(600 - f.BB - f.SO - f.HR, 1);
      frameCh["so"]!.push(f.SO); frameCh["bb"]!.push(f.BB); frameCh["hr"]!.push(f.HR); frameCh["babip"]!.push((f.oneB + f.GAP) / fb);
    }
    const ratio: Record<string, number> = {};
    for (const k of Object.keys(poolCh)) { const pl = sd(poolCh[k]!); ratio[k] = pl > 0 ? sd(frameCh[k]!) / pl : NaN; }
    cells.push({ tier: win.tier, role: "hit", n: hits.length, nOpp: pits.length, ratio });
  }
  console.log(`  … ${win.tier} done (${pits.length} pit × ${hits.length} hit)`);
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3).padStart(8) : "     n/a");
console.log(`\n── CANDIDATE NEED = SD(frame conditions) / SD(pool conditions) ──`);
console.log(`   >1 ⇒ the pool COMPRESSES predicted spread relative to the training frame, i.e. a correction is needed.`);
for (const role of ["pit", "hit"] as const) {
  const ks = role === "pit" ? ["k9", "bb9", "hr9", "babip"] : ["so", "bb", "hr", "babip"];
  console.log(`\n  ${role === "pit" ? "PITCHERS" : "HITTERS "}  cards/opp   │ ${ks.map((k) => k.padStart(8)).join(" ")}`);
  for (const c of cells.filter((x) => x.role === role))
    console.log(`  ${c.tier.padEnd(9)} ${String(c.n).padStart(4)}/${String(c.nOpp).padEnd(5)} │ ${ks.map((k) => f3(c.ratio[k]!)).join(" ")}${c.scalar ? `  │ scalar ${ks.map((k) => f3(c.scalar![k]!)).join(" ")}` : ""}`);
}

console.log(`\n── THE MEASURED NEEDS THIS MUST REPRODUCE (cwhit-battery-targets-2026-07-21.txt) ──`);
console.log(`   K      iron 1.82  bronze 1.62  silver 1.48  gold 1.78  diamond 1.04   ← non-monotone; gold is the break`);
console.log(`   HR     iron 1.17  bronze 1.13  silver 1.19  gold 1.27  diamond 1.32   ← measured gap-FLAT`);
console.log(`   BABIP  iron 1.26  bronze 1.34  silver 1.40  gold 1.01  diamond 0.91   ← rises then falls; only sub-1.0 cells`);
console.log(`\n   Validation is MULTI-CHANNEL WITH ZERO PER-CHANNEL TUNING: one construction, all three shapes, or the`);
console.log(`   miss pattern localises which curve or distribution assumption is wrong. Do not tune to fix a miss.`);
console.log(`\n(end of battery item 1 — eligible-pool uniform weighting)`);
