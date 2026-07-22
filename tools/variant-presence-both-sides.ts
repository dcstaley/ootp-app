// ═══ VARIANT PRESENCE ON BOTH SIDES OF THE FRAME GAP ════════════════════════
//
// Derek, 2026-07-22: "league data will have less variants than tournament data generally, because
// league variants (100+ new cards) are rare." That is a statement about POPULATIONS, and it decides
// whether arm C — "fields variant-inclusive everywhere" — actually satisfies the invariant it was
// ruled to satisfy, or violates it far worse than the status quo does.
//
// THE INVARIANT IS ABOUT COMPARABILITY, NOT ABOUT A FLAG. `buildFrameShift` subtracts a pool-field
// mean from a training-field mean. Applying the same *policy name* to both legs does not make them
// comparable if the two data sources contain wildly different amounts of the thing the policy admits.
//
// The train leg is EMPIRICAL: it is whatever Derek's league actually played, variants included
// (`includeVariants: true` on the artifact). The pool leg under arm C is THEORETICAL: a v5 is
// manufactured for every eligible card, so the variant share is a construction choice, not a fact.
//
// MEASUREMENT ONLY. Nothing fitted, nothing wired.

import { Repository } from "../src/persistence/repository.ts";
import { loadWindow } from "../src/training/loader.ts";

const repo = new Repository("data");
const st = (await repo.load<any>("state", "app")) ?? {};
const tr = (await repo.loadAll<any>("trained-models")).find((x: any) => x.id === st.activeModelId)!;
const minPA = tr.minPA ?? 1000;
const L = loadWindow(tr.datasetRoot ?? "League Files", tr.window?.length ? tr.window : undefined);
const obs = L.observations;

console.log(`model '${tr.id}' | datasetRoot '${tr.datasetRoot}' | window ${JSON.stringify(tr.window)} | floor ${minPA}`);
console.log(`artifact includeVariants = ${tr.includeVariants}  (the train leg DOES admit variants)`);
console.log(`\nall loaded league observations: ${obs.length}, of which variants ${obs.filter((o: any) => o.variant).length}`);
console.log(`\nTHE QUALIFYING COHORT — the population trainingMeans is selected from:`);
for (const [label, sel, use] of [
  ["hitters (PA>=floor)", (o: any) => o.hit.PA >= minPA, (o: any) => o.hit.PA],
  ["pitchers (BF>=floor)", (o: any) => o.pitch.BF >= minPA, (o: any) => o.pitch.BF],
] as const) {
  const q = obs.filter(sel), v = q.filter((o: any) => o.variant);
  const w = q.reduce((a: number, o: any) => a + use(o), 0);
  const wv = v.reduce((a: number, o: any) => a + use(o), 0);
  console.log(`  ${label.padEnd(22)} N=${String(q.length).padStart(4)}  variants ${String(v.length).padStart(3)} (${(100 * v.length / (q.length || 1)).toFixed(1)}% of rows)  USAGE-WEIGHTED ${(100 * wv / (w || 1)).toFixed(1)}%`);
}
console.log(`\n(end of variant-presence measurement)`);
