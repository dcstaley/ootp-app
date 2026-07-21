// ═══ PROPERTY BATTERY — ITEM 5: WITHIN-TIER HETEROGENEITY (variant-corrected) ══
//
// Is each tier's K need a whole-pool property, or driven by a sub-population? Gold is the anomaly:
// need 1.78 at gap 15.9, nearly iron's 1.82 at gap 23.6.
//
// SUPERSEDES tools/battery-item5-heterogeneity.py. Two defects in that version:
//
//  1. IT PARSED THE CAPTURE ITSELF. Its unit was an observed ROW keyed by (Name, VAL, VLvl, Hand),
//     with colliding keys dropped. That is a private join — not this program's join, which
//     disambiguates collisions on an event-space fingerprint and yields `Rec.cid` = CardID|VLvl.
//  2. IT HAD NO CARD GRAIN. Base and v5 are separate rows, so a card whose play is SPLIT between its
//     base and its variant appears as two half-used cards. The "inverted usage" result (gold's
//     high-K tercile used ~half as much as its mid group) is exactly the shape a split would fake,
//     which is why it could not be read until the split was accounted for.
//
// So this version reports BOTH grains. ROW grain reproduces the python's unit; CARD grain merges a
// card's base and v5 rows (IP summed, K9 IP-weighted) and asks whether the finding survives.
// Variant composition is reported per tier and per tercile, since "which rows are v5" is the whole
// question about the previous reading.
//
// OBSERVED DATA ONLY for every statistic below — the builder supplies the join, not a prediction.
// Descriptive; establishes no cause.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { QUICK, buildCwhitSample, wellSampled, FIELD_N, type Rec, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { bfFromIp } from "../src/eval/cwhit/parse.ts";

const NEED: Record<string, number> = { iron: 1.82, bronze: 1.62, silver: 1.48, gold: 1.78, diamond: 1.04 };

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const res = buildCwhitSample(deps);

/** One unit of analysis. ROW grain: one per matched observed row. CARD grain: base + v5 merged. */
interface Unit { id: string; ip: number; k9: number; gs: number; vlvl: number; anyVar: boolean }

const rowUnits = (tier: string): Unit[] =>
  res.recs.filter((r: Rec) => r.tier === tier && r.role === "pit" && wellSampled(r))
    .map((r) => ({ id: r.cid, ip: r.raw.ip!, k9: r.obs.k9!, gs: r.raw.gsPer!, vlvl: r.vlvl, anyVar: r.vlvl === 5 }));

/** CARD grain: merge a card's variant levels. IP sums (it is the same card being used); K9 is
 *  IP-WEIGHTED, because an unweighted mean of a 400-IP base and a 20-IP v5 line is not the card's
 *  realized K rate. The well-sampled bar is applied to the MERGED total, so a card split below the
 *  floor on both rows can now clear it — that is the point of the grain, not a leak. */
function cardUnits(tier: string): Unit[] {
  const acc = new Map<string, { ip: number; kip: number; gsip: number; vars: boolean }>();
  for (const r of res.recs) {
    if (r.tier !== tier || r.role !== "pit") continue;
    const cardKey = r.cid.split("|")[0]!;
    const a = acc.get(cardKey) ?? { ip: 0, kip: 0, gsip: 0, vars: false };
    a.ip += r.raw.ip!; a.kip += r.obs.k9! * r.raw.ip!; a.gsip += r.raw.gsPer! * r.raw.ip!;
    if (r.vlvl === 5) a.vars = true;
    acc.set(cardKey, a);
  }
  const out: Unit[] = [];
  for (const [id, a] of acc) {
    // Same floor as `wellSampled`, applied to the merged total. bfFromIp is imported, never
    // re-derived — the IP→BF constant lives in parse.ts and nowhere else.
    if (bfFromIp(a.ip) < res.floors.minBf) continue;
    out.push({ id, ip: a.ip, k9: a.kip / a.ip, gs: a.gsip / a.ip, vlvl: a.vars ? 5 : 0, anyVar: a.vars });
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
const f = (x: number, w = 6, d = 2) => x.toFixed(d).padStart(w);

console.log(`\n╔═══ BATTERY ITEM 5 — WITHIN-TIER HETEROGENEITY (variant-corrected) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | corpus ${res.source.kind === "capture" ? res.source.dir : "legacy"} | floor BF>=${res.floors.minBf}`);

for (const grain of ["ROW", "CARD"] as const) {
  const units = (t: string) => (grain === "ROW" ? rowUnits(t) : cardUnits(t));
  console.log(`\n\n════════ ${grain} GRAIN ${grain === "ROW" ? "— one unit per matched observed row (base and v5 SEPARATE); reproduces the python's unit" : "— base and v5 MERGED per card (IP summed, K9 IP-weighted)"} ════════`);

  console.log(`\n=== (1) WELL-SAMPLED PITCHER SET PER TIER ===`);
  console.log(`  tier      need     N  meanK9   sdK9     min    p10    p25    med    p75    p90    max   ${grain === "ROW" ? "v5 rows  v5 IP%" : "cards w/ v5"}`);
  const data = new Map<string, Unit[]>();
  for (const w of QUICK) {
    const u = units(w.tier); data.set(w.tier, u);
    const ks = u.map((x) => x.k9);
    const nv = u.filter((x) => x.anyVar).length;
    const vip = u.filter((x) => x.anyVar).reduce((a, x) => a + x.ip, 0) / (u.reduce((a, x) => a + x.ip, 0) || 1);
    console.log(`  ${w.tier.padEnd(9)}${f(NEED[w.tier]!)}${String(u.length).padStart(6)}${f(mean(ks), 8)}${f(sd(ks), 7)}${f(q(ks, 0))}${f(q(ks, .10))}${f(q(ks, .25))}${f(q(ks, .50))}${f(q(ks, .75))}${f(q(ks, .90))}${f(q(ks, 1))}   ${String(nv).padStart(6)}  ${(100 * vip).toFixed(1).padStart(5)}%`);
  }

  console.log(`\n=== (2) TERCILES OF THE CARD'S OWN OBSERVED K9 — the usage profile ===`);
  console.log(`  tier      tercile     N  meanK9   sdK9    meanIP     totIP   v5 share of units`);
  for (const w of QUICK) {
    const rows = [...data.get(w.tier)!].sort((a, b) => a.k9 - b.k9);
    const t = Math.floor(rows.length / 3);
    for (const [lbl, g] of [["low", rows.slice(0, t)], ["mid", rows.slice(t, 2 * t)], ["high", rows.slice(-t)]] as const) {
      if (!g.length) continue;
      const ks = g.map((x) => x.k9);
      console.log(`  ${w.tier.padEnd(9)} ${lbl.padEnd(8)}${String(g.length).padStart(5)}${f(mean(ks), 8)}${f(sd(ks), 7)}${f(mean(g.map((x) => x.ip)), 10, 1)}${f(g.reduce((a, x) => a + x.ip, 0), 10, 0)}     ${(100 * g.filter((x) => x.anyVar).length / g.length).toFixed(1).padStart(5)}%`);
    }
  }

  console.log(`\n=== (3) SHAPE — largest gap between consecutive K9 in the middle 80% ===`);
  for (const w of QUICK) {
    const xs = data.get(w.tier)!.map((x) => x.k9).sort((a, b) => a - b);
    const mid = xs.slice(Math.floor(.10 * xs.length), Math.floor(.90 * xs.length));
    let best = { g: NaN, a: NaN, b: NaN };
    for (let i = 0; i + 1 < mid.length; i++) if (!(mid[i + 1]! - mid[i]! <= best.g)) best = { g: mid[i + 1]! - mid[i]!, a: mid[i]!, b: mid[i + 1]! };
    console.log(`  ${w.tier.padEnd(9)} N=${String(xs.length).padStart(4)}  range ${f(xs[0]!)}-${f(xs[xs.length - 1]!)}  largest mid-80% gap ${best.g.toFixed(3)} at [${best.a.toFixed(2)},${best.b.toFixed(2)}]  (sd ${sd(xs).toFixed(2)})`);
  }

  console.log(`\n=== (4/5) STARTER vs RELIEVER (GSper >= 0.5 = starter) ===`);
  console.log(`  tier      need  startN%  startIP%   K9 st   K9 rp   st-rp`);
  for (const w of QUICK) {
    const u = data.get(w.tier)!;
    const st = u.filter((x) => x.gs >= 0.5), rp_ = u.filter((x) => x.gs < 0.5);
    const ipTot = u.reduce((a, x) => a + x.ip, 0);
    const ks = mean(st.map((x) => x.k9)), kr = mean(rp_.map((x) => x.k9));
    console.log(`  ${w.tier.padEnd(9)}${f(NEED[w.tier]!)}${f(100 * st.length / u.length, 9, 1)}${f(100 * st.reduce((a, x) => a + x.ip, 0) / ipTot, 10, 1)}${f(ks, 8)}${f(kr, 8)}${f(ks - kr, 8)}`);
  }

  console.log(`\n=== (6) NESTING — well-sampled units shared with the tier BELOW ===`);
  let prev: { name: string; ids: Set<string> } | null = null;
  for (const w of QUICK) {
    const ids = new Set(data.get(w.tier)!.map((x) => x.id));
    if (prev) console.log(`  ${w.tier.padEnd(9)} N=${String(ids.size).padStart(4)}   shared with ${prev.name}: ${String([...ids].filter((i) => prev!.ids.has(i)).length).padStart(4)}`);
    prev = { name: w.tier, ids };
  }
}

console.log(`\n(end of battery item 5 — within-tier heterogeneity, variant-corrected)`);
