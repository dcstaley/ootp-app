// Demo: real catalog hitters across the 5 steal archetypes, wOBA BEFORE vs AFTER baserunning.
// BEFORE = baserunning coeffs zeroed + recalibrated without them; AFTER = deployed config. The delta
// includes the anchor re-centering (turning baserunning on raises the bar slightly for everyone).
//   run: node tools/baserunning-examples.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { scoreCard, calibrate, computeDerived, makeRawPolyModel, applyWobaWeights, computeUnifiedFieldStats, buildPoolTransform, type EventForm, type Coeffs } from "../src/scoring-core/index.ts";
import { baserunningWoba } from "../src/scoring-core/woba.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const ef: EventForm = trained.eventForm;
const rp = makeRawPolyModel(ef);
const tourneys = await repo.loadAll<Tournament>("tournaments");
const t = tourneys.find((x) => x.id === "bronze-quick")!; // neutral era-2010 (sbFreq/runVal = 1) for the clearest demo
const era = eras.get(t.eraId)!;
const coeffsOn = resolveCoeffs(model, era, parks.get(t.parkId)!, t.softcaps);
applyWobaWeights(coeffsOn, trained.wobaWeights);
const coeffsOff: Coeffs = { ...coeffsOn, adv_speed: 0, adv_run: 0, adv_steal: 0, adv_stealRate: 0, adv_stealInt: 0 };
const derived = computeDerived(coeffsOn);
const cat = parseCatalogCsv(readFileSync(`data/imports/${state.catalogSourceId ?? "cdmx"}.csv`, "utf8"));
const base = cat.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y" && String(c["Position"]) !== "1");
const mkCfg = (coeffs: Coeffs) => {
  const pool = computeUnifiedFieldStats(base, coeffs, rp, 50, true);
  const pt = buildPoolTransform(pool, pool, trained.ratingEnvelope);
  return { coeffs, derived, calScales: calibrate(base, { coeffs, derived, eventForm: ef, poolTransform: pt }), eventForm: ef, poolTransform: pt };
};
const cfgOn = mkCfg(coeffsOn), cfgOff = mkCfg(coeffsOff);
const woba = (c: any, cfg: any) => scoreCard(c, cfg).hit.offense_ovr;
console.log(`Tournament '${t.id}' (era ${era.id}: sbFreq ${(era.sbFreq ?? 1).toFixed(2)}, runVal ${(era.runVal ?? 1).toFixed(2)})\n`);

// Buckets on ability (Stealing) × aggressiveness (Steal Rate).
// Scale tops ~124: ability (Stealing) p50 70/p90 90; aggressiveness (Steal Rate) p50 45/p90 86.
const loA = (x: number) => x <= 50, midA = (x: number) => x >= 62 && x <= 82, hiA = (x: number) => x >= 100;
const loG = (x: number) => x <= 30, midG = (x: number) => x >= 50 && x <= 72, hiG = (x: number) => x >= 52;
// steal-only contribution (mwOBA) — isolates the tendency×ability term from UBR (speed/baserunning).
const stealMwoba = (c: any) => baserunningWoba(0, n(c["Steal Rate"]), n(c["Stealing"]), 0, coeffsOn) * 1000;
const cells: { label: string; abil: (x: number) => boolean; aggr: (x: number) => boolean }[] = [
  { label: "low ability  / low aggressive ", abil: loA, aggr: loG },
  { label: "low ability  / high aggressive", abil: loA, aggr: hiG },
  { label: "high ability / low aggressive ", abil: hiA, aggr: loG },
  { label: "high ability / high aggressive", abil: hiA, aggr: hiG },
  { label: "mid ability  / mid aggressive ", abil: midA, aggr: midG },
];
const title = (c: any) => String(c["//Card Title"]).replace(/^(T\d+ Ep\. \d+ - |Unsung Heroes |Hardware Heroes |Snapshot )/, "");
console.log(`archetype                        player                          Spd/Base/Steal/Rate   wOBA off→on   totalΔ  stealΔ (mwOBA)`);
for (const cell of cells) {
  const cands = base.filter((c) => cell.abil(n(c["Stealing"])) && cell.aggr(n(c["Steal Rate"])) && n(c["Speed"]) > 0);
  if (!cands.length) { console.log(`${cell.label}   (no catalog card in this cell — the game rarely pairs these)`); continue; }
  // recognizable (top value) and, among those, the clearest steal signal for the demo.
  const p = cands.map((c) => ({ c, off: woba(c, cfgOff), on: woba(c, cfgOn), val: n(c["Card Value"]) }))
    .sort((a, b) => b.val - a.val).slice(0, 20).sort((a, b) => Math.abs(stealMwoba(b.c)) - Math.abs(stealMwoba(a.c)))[0]!;
  const r = (k: string) => String(n(p.c[k])).padStart(3);
  console.log(`${cell.label}   ${title(p.c).slice(0, 30).padEnd(31)} ${r("Speed")}/${r("Baserunning")}/${r("Stealing")}/${r("Steal Rate")}   ${p.off.toFixed(4)}→${p.on.toFixed(4)}  ${((p.on - p.off) * 1000 >= 0 ? "+" : "")}${((p.on - p.off) * 1000).toFixed(1).padStart(5)}  ${(stealMwoba(p.c) >= 0 ? "+" : "")}${stealMwoba(p.c).toFixed(1)}`);
}
process.exit(0);
