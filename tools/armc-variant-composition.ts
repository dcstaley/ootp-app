// ═══ WHAT ARM C ACTUALLY DOES TO THE FIELD — the variant boost is DETERMINISTIC ══
//
// Derek's reminder, and it changes how arm C should be DESCRIBED. `variantBoost` (src/data/
// variants.ts) is a closed-form, monotone function of the rating: v -> v + floor((5v+40)/80) + 2.
// A v5 is therefore not a new card drawn from anywhere — it is a KNOWN SHIFTED COPY of its base.
//
// CONSEQUENCE: the variant-inclusive pool is the base pool plus a deterministic image of itself, so
// arm C does NOT admit an independent population. Because the boost is strictly positive, a card's
// v5 outranks its own base in any predicted-wOBA ordering, and the arm-C top-50 is dominated by v5
// rows — i.e. approximately THE SAME UNDERLYING CARDS, boosted. That is exactly the signature item A
// measured without naming it: ordering preserved, inversions 2->2, Spearman unchanged, and residual
// signs flipping from mixed to uniformly negative (a level shift, not a re-selection).
//
// WHY IT MATTERS FOR THE EVENT: it means diamond's "in-frame" gain is a CONSEQUENCE of the re-basing,
// not independent corroboration of it. The case for arm C rests on the invariant (both legs of a gap
// on the same basis) — which is what it was ruled on. This tool measures the two quantities that
// separate "re-basing" from "re-selection" so the distinction is on the record rather than asserted.
//
// MEASUREMENT ONLY. Nothing fitted, nothing wired.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats, cardSideWobas, FIELD_N } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, isPit, n_ } from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import { variantBoost } from "../src/data/variants.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const st = (await repo.load<any>("state","app")) ?? {};
const tr = (await repo.loadAll<any>("trained-models")).find(x=>x.id===st.activeModelId)!;
const rp = makeRawPolyModel(tr.eventForm);
const model=(await repo.loadAll<Model>("models"))[0]!;
const eras=new Map((await repo.loadAll<Era>("eras")).map(e=>[e.id,e]));
const parks=new Map((await repo.loadAll<Park>("parks")).map(p=>[p.id,p]));
const ts=await repo.loadAll<Tournament>("tournaments");
const bq=ts.find(t=>t.id==="bronze-quick")!;
const coeffs=resolveCoeffs(model,eras.get(bq.eraId)!,parks.get(bq.parkId)!,bq.softcaps);
applyWobaWeights(coeffs,tr.wobaWeights); computeDerived(coeffs);
const base=parseCatalogCsv(readFileSync(`data/imports/${st.catalogSourceId??"cdmx"}.csv`,"utf8")).cards
  .filter(c=>String(c["Variant"]??"").toUpperCase()!=="Y");

console.log("variantBoost magnitude across the rating range:");
for (const v of [40,60,80,100,120,140,160,180]) console.log(`  ${v} -> ${variantBoost(v)}  (+${variantBoost(v)-v})`);

console.log("\nIs the ARM-C top-50 field all variants? (pool = base + v5, ranked by predicted wOBA)");
for (const win of QUICK) {
  for (const role of ["pit","hit"] as const) {
    const ents = opponentSet(base, win, role);
    const scored = ents.map(e=>{
      const w = cardSideWobas(e.card as any, coeffs, rp, true);
      const v = role==="pit" ? -(w.pitVR+w.pitVL)/2 : (w.hitVR+w.hitVL)/2;
      return { vlvl: e.vlvl, v };
    }).sort((a,b)=>b.v-a.v).slice(0, FIELD_N);
    const nv = scored.filter(x=>x.vlvl===5).length;
    console.log(`  ${win.tier.padEnd(8)} ${role}: ${nv}/${FIELD_N} of the top-${FIELD_N} are v5`);
  }
}

console.log("\nMean boost on the STUFF channel over each pool's base top-50 (the gap's own coordinate):");
for (const win of QUICK) {
  const pool = base.filter(c=>inValueWindow(c,win) && isPit(c));
  const top = pool.map(c=>{
    const w = cardSideWobas(c as any, coeffs, rp, true);
    return { c, v: -(w.pitVR+w.pitVL)/2 };
  }).sort((a,b)=>b.v-a.v).slice(0,FIELD_N);
  const d = top.reduce((a,x)=>a+(variantBoost(n_(x.c["Stuff vR"]))-n_(x.c["Stuff vR"])),0)/top.length;
  console.log(`  ${win.tier.padEnd(8)} mean stu boost on the base top-50 = +${d.toFixed(2)}`);
}
