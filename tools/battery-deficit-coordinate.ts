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
import { QUICK, inValueWindow, isPit, n_, cardName, handLetter } from "../src/eval/cwhit/sample.ts";
import { formatByLegacySlug, captureObsPath, CAPTURE_DIR_2026_07_21 } from "../src/eval/cwhit/corpus.ts";
import { unescapeName } from "../src/eval/cwhit/scorecard.ts";

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

// ── REALIZED-USAGE WEIGHTING (opt-in: `--realized`) ──────────────────────────
//
// DEFAULT (no flag) IS UNCHANGED AND BIT-IDENTICAL to the pre-flag tool: every eligible opposing card
// is an opponent, weighted UNIFORMLY (the ex-ante production candidate, ruling 3).
//
// WITH `--realized` the average over opponents becomes a WEIGHTED average whose weight is that
// opponent's REALIZED USAGE — observed PA (hitter opponents) / IP (pitcher opponents) in the same five
// Quick tiers' capture tables. An eligible card with no observed row carries weight 0: it did not play.
// This exists because the realized opposing field was measured to differ from the eligible-pool field
// by 0.18–1.36 pool-SD, so uniform weighting may be integrating over the wrong opponent distribution.
//
// EXACTLY ONE THING MOVES. The crossed-channel shift, the frame-conditions baseline, the SCALAR CONTROL
// and the ratio definition are untouched. Note the consequence for the scalar column: it collapses
// opponents to their UNIFORM mean, so it is IDENTICAL in both runs by construction — and therefore the
// degenerate identity documented at the top of this file (scalar == integration evaluated at the mean
// shift) relates the scalar to the UNIFORM integration only, not to the realized one. That is a
// reporting caveat, not a defect: the control is deliberately held fixed across the two weightings.
//
// VLvl-5 VARIANT ROWS ARE EXCLUDED. Variants are generated at runtime (`makeVariant`) and are absent
// from the catalog CSV this tool reads, so they cannot be opponents here; their observed usage is
// simply missing from the realized weighting. The per-tier drop counts are printed below.
const REALIZED = process.argv.includes("--realized");

const wKey = (name: string, val: number, hand: string) => `${name}|${val}|${hand}`;

interface WeightStats {
  tier: string; oppRole: "pit" | "hit";
  nEligible: number; nNonzero: number; top10Share: number; top10Count: number;
  obsRowsV0: number; obsRowsV5: number;
  dupObsKeys: number; dupObsRows: number; dupCatKeys: number; dupCatCards: number;
  obsKeysUnmatched: number; usageJoined: number; usageV0Total: number;
}
const wStats: WeightStats[] = [];

/** Realized-usage weight for each card in `cards` (aligned by index), joined on (Name, VAL, Hand)
 *  against the tier's observed capture table, restricted to observed VLvl == 0. Keys that are
 *  non-unique on EITHER side are dropped (weight 0) and counted. */
function realizedWeights(cards: Card[], oppRole: "pit" | "hit", tier: string): number[] {
  const f = formatByLegacySlug(tier);
  if (!f) throw new Error(`no capture format registered for tier '${tier}'`);
  const path = captureObsPath(CAPTURE_DIR_2026_07_21, f, oppRole);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const cols = lines[1]!.split("\t").map((s) => s.trim());
  const iName = cols.indexOf("Name"), iVal = cols.indexOf("VAL"), iVlvl = cols.indexOf("VLvl"),
    iHand = cols.indexOf("Hand"), iUse = cols.indexOf(oppRole === "pit" ? "IP" : "PA");
  if ([iName, iVal, iVlvl, iHand, iUse].some((i) => i < 0))
    throw new Error(`capture ${path}: missing one of Name/VAL/VLvl/Hand/${oppRole === "pit" ? "IP" : "PA"}`);

  // OBSERVED side. Names are HTML-ESCAPED in the captures; unescaping is load-bearing (skipping it
  // silently drops rows rather than failing).
  let obsRowsV0 = 0, obsRowsV5 = 0, usageV0Total = 0;
  const acc = new Map<string, { use: number; rows: number }>();
  for (let li = 2; li < lines.length; li++) {
    const r = lines[li]!.split("\t");
    if (String(r[iVlvl] ?? "").trim() !== "0") { obsRowsV5++; continue; }
    obsRowsV0++;
    const use = n_(r[iUse]); usageV0Total += use;
    const k = wKey(unescapeName(String(r[iName] ?? "").trim()), n_(r[iVal]), String(r[iHand] ?? "").trim());
    const a = acc.get(k); if (a) { a.use += use; a.rows++; } else acc.set(k, { use, rows: 1 });
  }
  let dupObsKeys = 0, dupObsRows = 0;
  for (const [k, a] of acc) if (a.rows > 1) { dupObsKeys++; dupObsRows += a.rows; acc.delete(k); }

  // CATALOG side.
  const catKeys = cards.map((c) =>
    wKey(cardName(c), n_(c["Card Value"]), handLetter(n_(c[oppRole === "pit" ? "Throws" : "Bats"]))));
  const catCount = new Map<string, number>();
  for (const k of catKeys) catCount.set(k, (catCount.get(k) ?? 0) + 1);
  let dupCatKeys = 0, dupCatCards = 0;
  for (const n of catCount.values()) if (n > 1) { dupCatKeys++; dupCatCards += n; }

  const matched = new Set<string>();
  const w = catKeys.map((k) => {
    if ((catCount.get(k) ?? 0) > 1) return 0;      // non-unique on the CATALOG side → dropped
    const a = acc.get(k); if (!a) return 0;         // eligible but never played → weight 0
    matched.add(k); return a.use;
  });

  const nz = w.filter((x) => x > 0).sort((a, b) => b - a);
  const usageJoined = nz.reduce((a, b) => a + b, 0);
  const top10Count = nz.length ? Math.max(1, Math.ceil(0.10 * nz.length)) : 0;
  const top10Share = usageJoined > 0 ? nz.slice(0, top10Count).reduce((a, b) => a + b, 0) / usageJoined : NaN;
  wStats.push({
    tier, oppRole, nEligible: cards.length, nNonzero: nz.length, top10Share, top10Count,
    obsRowsV0, obsRowsV5, dupObsKeys, dupObsRows, dupCatKeys, dupCatCards,
    obsKeysUnmatched: acc.size - matched.size, usageJoined, usageV0Total,
  });
  if (!nz.length) throw new Error(`${tier} ${oppRole}: realized weighting has ZERO opponents with usage — refusing to integrate`);
  return w;
}

console.log(`\n╔═══ BATTERY ITEM 1 — COMPUTED-DEFICIT COORDINATE (per-opponent integration) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | ${REALIZED ? "REALIZED-USAGE weighting (--realized): opponents weighted by observed PA/IP" : "eligible-pool UNIFORM weighting (the ex-ante production candidate)"}`);
console.log(REALIZED
  ? `opponent field = the REALIZED one: eligible cards with no observed VLvl-0 row carry weight 0.`
  : `pools are COMPLETE ENVIRONMENTS: every eligible card of the opposing role is an opponent.`);

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
    // Aligned by index with `opp`. `null` ⇒ the uniform default path, which is left literally untouched
    // below so it stays bit-identical rather than "1×-identical".
    const oppW = REALIZED ? realizedWeights(hits, "hit", win.tier) : null;
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
      let sK = 0, sB = 0, sH = 0, sBab = 0, sW = 0;
      for (let j = 0; j < opp.length; j++) {
        const o = opp[j]!;
        const wj = oppW ? oppW[j]! : 1;
        if (oppW && wj === 0) continue;   // did not play — contributes nothing
        const e = rp.predictPitching({
          con: b.con + ((TM.hit["eye"] ?? 0) - o.eye),
          stu: b.stu + ((TM.hit["kRat"] ?? 0) - o.kRat),
          hrr: b.hrr + ((TM.hit["pow"] ?? 0) - o.pow),
          pbabip: b.pbabip + ((TM.hit["babip"] ?? 0) - o.babip),
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.K - e.HR, 1);
        if (oppW) { sK += wj * e.K; sB += wj * e.BB; sH += wj * e.HR; sBab += wj * (e.nHH / bip); sW += wj; }
        else { sK += e.K; sB += e.BB; sH += e.HR; sBab += e.nHH / bip; }
      }
      const m = oppW ? sW : (opp.length || 1);
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
    const oppW = REALIZED ? realizedWeights(pits, "pit", win.tier) : null;
    const poolCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    const frameCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    for (const h of hits) {
      const b = {
        eye: n_(h[HIT_COL.eye]), pow: n_(h[HIT_COL.pow]), kRat: n_(h[HIT_COL.kRat]),
        babip: n_(h[HIT_COL.babip]), gap: n_(h[HIT_COL.gap]),
        speed: n_(h["Speed"]), steal: n_(h["Stealing"]), run: n_(h["Baserunning"]),
      };
      let sSO = 0, sBB = 0, sHR = 0, sBab = 0, sW = 0;
      for (let j = 0; j < opp.length; j++) {
        const o = opp[j]!;
        const wj = oppW ? oppW[j]! : 1;
        if (oppW && wj === 0) continue;   // did not play — contributes nothing
        const e = rp.predictHitting({
          eye: b.eye + ((TM.pit["con"] ?? 0) - o.con),
          kRat: b.kRat + ((TM.pit["stu"] ?? 0) - o.stu),
          pow: b.pow + ((TM.pit["hrr"] ?? 0) - o.hrr),
          babip: b.babip + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          gap: b.gap + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          speed: b.speed, steal: b.steal, run: b.run,
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.SO - e.HR, 1);
        if (oppW) { sSO += wj * e.SO; sBB += wj * e.BB; sHR += wj * e.HR; sBab += wj * ((e.oneB + e.GAP) / bip); sW += wj; }
        else { sSO += e.SO; sBB += e.BB; sHR += e.HR; sBab += (e.oneB + e.GAP) / bip; }
      }
      const m = oppW ? sW : (opp.length || 1);
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
if (REALIZED) {
  console.log(`\n── REALIZED-WEIGHT COVERAGE (join: Name+VAL+Hand, observed VLvl==0 only) ──`);
  console.log(`   VLvl-5 VARIANT rows are EXCLUDED: variants are runtime-generated and absent from the catalog CSV,`);
  console.log(`   so their observed usage is MISSING from the realized weighting entirely.`);
  console.log(`   opp = the OPPOSING role being weighted (pitchers integrate over 'hit', hitters over 'pit').`);
  console.log(`\n  tier      opp  nonzero/eligible   top10%  share   obsV0  obsV5(dropped)  dupObs  dupCat  obsUnmatched`);
  for (const s of wStats)
    console.log(`  ${s.tier.padEnd(9)} ${s.oppRole}  ${String(s.nNonzero).padStart(5)}/${String(s.nEligible).padEnd(6)} ${String(s.top10Count).padStart(6)} ${(Number.isFinite(s.top10Share) ? (100 * s.top10Share).toFixed(1) + "%" : "n/a").padStart(7)}  ${String(s.obsRowsV0).padStart(6)} ${String(s.obsRowsV5).padStart(9)}      ${String(s.dupObsKeys).padStart(6)}  ${String(s.dupCatKeys).padStart(6)}  ${String(s.obsKeysUnmatched).padStart(12)}`);
  console.log(`\n   dupObs / dupCat = join keys dropped for being NON-UNIQUE on the observed / catalog side`);
  console.log(`     (dupObs also covers ${wStats.reduce((a, s) => a + s.dupObsRows, 0)} observed rows; dupCat ${wStats.reduce((a, s) => a + s.dupCatCards, 0)} catalog cards).`);
  console.log(`   obsUnmatched = surviving observed keys with NO eligible catalog opponent (their usage is not carried).`);
  console.log(`   top10% share = usage held by the heaviest ceil(10%) of the NONZERO-weight opponents.`);
  console.log(`   NOTE ON THE SCALAR CONTROL: it is unchanged (uniform-mean collapse) and is therefore the SAME`);
  console.log(`   column in both runs — it is a held-fixed control here, not the degenerate case of this integration.`);
}
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
console.log(`\n(end of battery item 1 — ${REALIZED ? "REALIZED-usage weighting" : "eligible-pool uniform weighting"})`);
