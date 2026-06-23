// THROWAWAY data tool — inject a synthetic NATURAL two-way card into the local
// catalog so the optimizer's auto-two-way path (Top-X hitter ∩ Top-X pitcher) is
// exercised on real data. It clones the eligible pool's BEST hitter and grafts the
// BEST pitcher's arm onto it (Stuff/Movement/Control/pBABIP/pHR/Stamina/pitches),
// so the card is elite at BOTH sides → lands in both Top-X sets for the chosen
// tournament. Appends to data/imports/<catalogSource>.csv and marks it owned in the
// active account. Idempotent (fixed Card ID). NOT app code.
//
//   node tools/make-twoway.ts [tournamentId=real-parkera]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { parseCatalogCsv, cardId, type Card } from "../src/data/catalog.ts";
import { buildEligiblePool } from "../src/config/eligibility.ts";
import { scoreCard, calibrate, computeDerived, valueFor } from "../src/scoring-core/index.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { Repository } from "../src/persistence/repository.ts";
import type { Tournament, Era, Park } from "../src/config/tournament.ts";
import type { AccountOverlay } from "../src/data/account.ts";

const DATA = "data";
const SYNTH_ID = "SYNTH_2WAY_1";
const tid = process.argv[2] || "real-parkera";
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

const repo = new Repository(DATA);
const state = (await repo.load<{ catalogSourceId: string; activeAccountId: string }>("state", "app"))!;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === tid)!;
if (!t) throw new Error(`tournament ${tid} not found`);

const csvPath = join(DATA, "imports", `${state.catalogSourceId}.csv`);
const raw = readFileSync(csvPath, "utf8");
const catalog = parseCatalogCsv(raw);

const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
const derived = computeDerived(coeffs);
const pool = buildEligiblePool(catalog.cards, t);
const cfg = { coeffs, derived, calScales: calibrate(pool, { coeffs, derived }) };
const inValueRange = (c: Card) => {
  const v = n(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max);
};
const eligible = pool.filter(inValueRange);

// Best hitter (by best-side value) and best pitcher (by OVR value).
let bestHit: Card | null = null, bestHitV = -Infinity;
let bestPit: Card | null = null, bestPitV = -Infinity;
for (const c of eligible) {
  const s = scoreCard(c, cfg);
  const hv = Math.max(valueFor(s.hit.woba_vR, "hitter"), valueFor(s.hit.woba_vL, "hitter"));
  const pv = 0.62 * valueFor(s.pitch.woba_vR, "pitcher") + 0.38 * valueFor(s.pitch.woba_vL, "pitcher");
  if (hv > bestHitV) { bestHitV = hv; bestHit = c; }
  if (pv > bestPitV) { bestPitV = pv; bestPit = c; }
}
if (!bestHit || !bestPit) throw new Error("no eligible cards");
console.log(`best hitter: ${bestHit["//Card Title"]} (value ${bestHitV.toFixed(4)})`);
console.log(`best pitcher: ${bestPit["//Card Title"]} (OVR value ${bestPitV.toFixed(4)})`);

// Clone the best hitter, graft the best pitcher's arm.
const merged: Card = { ...bestHit };
const PITCH_RATINGS = ["Stuff", "Movement", "Control", "pBABIP", "pHR"];
for (const base of PITCH_RATINGS) for (const side of ["", " vL", " vR"]) {
  const col = `${base}${side}`;
  if (col in merged && col in bestPit) merged[col] = bestPit[col]!;
}
const PITCH_TYPES = ["Fastball", "Slider", "Curveball", "Changeup", "Cutter", "Sinker", "Splitter", "Forkball", "Screwball", "Circlechange", "Knucklecurve", "Knuckleball"];
for (const col of [...PITCH_TYPES, "Stamina", "Pos Rating P", "Pitcher Role", "Hold", "Throws", "GB Hitter Type", "FB Hitter Type", "BattedBallType"]) {
  if (col in merged && col in bestPit) merged[col] = bestPit[col]!;
}
merged["Card ID"] = SYNTH_ID;
merged["//Card Title"] = "SYNTHETIC Two-Way Test (Ohtani-like)";
merged["FirstName"] = "Synthetic"; merged["LastName"] = "TwoWay";
merged["Variant"] = "";

// Append (idempotent): drop any prior synthetic row, then add.
const kept = catalog.cards.filter((c) => cardId(c) !== SYNTH_ID);
const rows = [...kept, merged];
const out = Papa.unparse({ fields: catalog.columns, data: rows }, { newline: "\n" });
writeFileSync(csvPath, out, "utf8");
console.log(`wrote ${rows.length} rows to ${csvPath} (added ${SYNTH_ID})`);

// Mark owned in the active account.
const acc = (await repo.load<AccountOverlay>("accounts", state.activeAccountId))!;
acc.owned[SYNTH_ID] = Math.max(1, acc.owned[SYNTH_ID] ?? 0);
await repo.save("accounts", acc.id, acc);
console.log(`marked ${SYNTH_ID} owned in account ${acc.name}; Card Value ${merged["Card Value"]}`);
