// CONFIG HYGIENE SWEEP — inherited trained values, template junk, DH/roster inconsistencies.
//   run: node tools/config-hygiene.ts
//
// WHY (Fable directed unit, 2026-07-21c): tournament configs are HAND-AUTHORED plus, historically,
// copied from one another. Copying carries TRAINED values (platoon splits) and template defaults
// into configs where they were never measured or intended — exactly what happened when I built the
// four new formats by cloning templates (live-open came out with topHitters/topPitchers UNDEFINED,
// late-bronze inherited max_variants=10 from bronze-quick with no such rule stated).
//
// THIS TOOL ONLY REPORTS. It changes nothing. Output is a per-config anomaly list for ONE Derek
// confirmation pass. Anything flagged is a QUESTION, not a defect — many are legitimate.
//
// PROVENANCE CLASSES used below:
//   TRAINED-IN-CONFIG  a MODEL-derived value frozen into a config. `platoon`/platoonVR/VL are SEEDED
//                      FROM THE ACTIVE MODEL AT CREATE TIME (server.ts:2207-2220), so configs created
//                      under the same model vintage share a value — it is a stale snapshot, not a
//                      per-tournament measurement. The resolver
//                      prefers MODEL exposure (server.ts:840 `exp?.x ?? t.x ?? default`), so a
//                      stored block is dead weight while a model is active — and silently WRONG
//                      if it was copied from a different tournament.
//   MISSING-DEFAULT    a field the optimizer reads with no in-config value (falls back to a
//                      hardcoded default, or to `undefined` which is a real defect).
//   (KNOB-DRIFT REMOVED 2026-07-21, Derek: topHitters/topPitchers 50s and golden-childhood 30 are
//    INTENTIONAL user config, as are roster counts. Comparing user config to a factory default is not
//    a finding. Only genuinely machine-authored or structurally broken values are flagged now.)
//   STRUCTURAL         budget_mode disagrees with total_cap/slot_counts, or similar.

import { readFileSync, readdirSync } from "node:fs";

interface Cfg { [k: string]: unknown }
const DIR = "data/tournaments";
const cfgs = readdirSync(DIR).filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, c: JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as Cfg }));

// newTournamentCfg / TOURNAMENT_DEFAULTS (web/shared.ts) — the "not stated" baseline.
const FACTORY = {
  roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 55,
  min_pitch_types: 3, topHitters: 100, topPitchers: 100, minPlayersPerPosition: 2,
  max_variants_on_roster: 0,
} as const;

type Finding = { id: string; cls: string; msg: string };
const out: Finding[] = [];
const add = (id: string, cls: string, msg: string) => out.push({ id, cls, msg });

for (const { c } of cfgs) {
  const id = String(c.id ?? "(no id)");

  // TRAINED-IN-CONFIG — platoon splits copied between tournaments are unverifiable after the fact.
  if (c.platoon) add(id, "TRAINED-IN-CONFIG", `has a stored \`platoon\` split block — the resolver prefers MODEL exposure, so this is dead weight while a model is active and silently wrong if copied from another tournament`);
  if (c.platoonVR !== undefined || c.platoonVL !== undefined) add(id, "TRAINED-IN-CONFIG", `has stored platoonVR/VL team-exposure weights (${c.platoonVR}/${c.platoonVL}) — same issue; falls back to model exposure then 0.62/0.38`);

  // MISSING-DEFAULT — undefined where the optimizer expects a number.
  for (const k of ["topHitters", "topPitchers", "roster_size", "hitters", "pitchers", "minPlayersPerPosition"] as const) {
    if (c[k] === undefined) add(id, "MISSING-DEFAULT", `\`${k}\` is UNDEFINED (optimizer reads it; no in-config value)`);
  }

  // STRUCTURAL — budget_mode vs the fields that back it.
  const mode = c.budget_mode as string | undefined;
  const cap = c.total_cap as number | null | undefined;
  const slots = c.slot_counts as Record<string, number> | undefined;
  const nSlots = slots ? Object.values(slots).filter((n) => n > 0).length : 0;
  if (mode === "cap" && !(typeof cap === "number" && cap > 0)) add(id, "STRUCTURAL", `budget_mode="cap" but total_cap=${JSON.stringify(cap)}`);
  if (mode === "slots" && nSlots === 0) add(id, "STRUCTURAL", `budget_mode="slots" but slot_counts has no positive entries`);
  if (mode === "none" && typeof cap === "number" && cap > 0) add(id, "STRUCTURAL", `budget_mode="none" but total_cap=${cap} is set (cap ignored)`);
  if (mode === "none" && nSlots > 0) add(id, "STRUCTURAL", `budget_mode="none" but slot_counts is populated (slots ignored)`);
  if (mode === undefined) add(id, "STRUCTURAL", `budget_mode ABSENT — derived as slots>cap>none at read time`);

  // variants: 0 means UNLIMITED (web/TournamentsPage label, roster-lp only constrains if >0).
  if (c.variants_allowed === false && (c.max_variants_on_roster as number) > 0) {
    add(id, "STRUCTURAL", `variants_allowed=false but max_variants_on_roster=${c.max_variants_on_roster} (the cap is moot; variants are excluded at eligibility)`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const f = (n: number) => String(n).padStart(3);
console.log(`\nCONFIG HYGIENE SWEEP — ${cfgs.length} configs in ${DIR}\n`);
console.log(`Reports only; changes nothing. Every line is a QUESTION for confirmation, not a defect.\n`);

const byClass = new Map<string, Finding[]>();
for (const x of out) { if (!byClass.has(x.cls)) byClass.set(x.cls, []); byClass.get(x.cls)!.push(x); }

for (const cls of ["TRAINED-IN-CONFIG", "MISSING-DEFAULT", "STRUCTURAL"]) {
  const rows = byClass.get(cls) ?? [];
  console.log(`═══ ${cls} — ${rows.length} finding(s) across ${new Set(rows.map((r) => r.id)).size} config(s) ═══`);
  if (!rows.length) { console.log("  (none)\n"); continue; }
  const byId = new Map<string, string[]>();
  for (const r of rows) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id)!.push(r.msg); }
  for (const [id, msgs] of [...byId].sort()) {
    console.log(`  ${id}`);
    for (const m of msgs) console.log(`      · ${m}`);
  }
  console.log("");
}

// Cross-config summary of the fields most likely to be silent drift.
const tally = (k: string) => {
  const m = new Map<string, string[]>();
  for (const { c } of cfgs) { const v = JSON.stringify(c[k]); if (!m.has(v)) m.set(v, []); m.get(v)!.push(String(c.id)); }
  return [...m].sort((a, b) => b[1].length - a[1].length);
};
console.log(`═══ DISTRIBUTIONS (is the majority value the intended one?) ═══`);
for (const k of ["dh", "max_variants_on_roster", "topHitters", "topPitchers", "min_starter_stamina", "hitters", "pitchers"]) {
  console.log(`  ${k}:`);
  for (const [v, ids] of tally(k)) console.log(`      ${String(v).padEnd(6)} ×${f(ids.length)}  ${ids.length <= 6 ? ids.join(", ") : ids.slice(0, 6).join(", ") + ", …"}`);
}
console.log(`\nDH NOTE (audited 2026-07-21): \`dh\` ONLY selects lineup slots —`);
console.log(`  lineupPositions(dh) = 8 FIELD_POSITIONS + "DH" when true, 8 when false (optimizer/types.ts:198).`);
console.log(`  Consumers: the optimizer (assign/generate/lp/roster-lp/lineup-match) and src/eval/{offense,set-eval}.ts.`);
console.log(`  It has ZERO effect on the scoring core (src/scoring-core, src/model contain no \`dh\`) and ZERO effect on`);
console.log(`  the cwhit eval path (src/eval/cwhit/*, cwhit-scorecard, fit-*). So per-card scores and the era fit are`);
console.log(`  dh-AGNOSTIC. Two real gaps: (1) \`hitters\` roster count is independent of dh (a DH-off format still`);
console.log(`  requires 14 hitters but starts 8 — never stated); (2) with dh=false our model fields 8 bats and simply`);
console.log(`  OMITS the 9th, whereas real DH-off play bats the pitcher, so DH-off team offense is modelled slightly`);
console.log(`  HIGH. Both are optimizer-side; neither blocks the era fit.\n`);
