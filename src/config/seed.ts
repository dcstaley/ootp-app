// M3 — bootstrap the file-based tournaments database (D7) from the local capture
// files. The old app kept saved tournaments in the browser's IndexedDB; the
// rebuild keeps them as plain JSON files in the data folder (eras/, parks/,
// tournaments/, models/), served by the local server. That database starts
// empty, so on first run we seed it from the captures the user already exported
// (each capture carries a real tournament's era/park/softcaps) plus a built-in
// neutral default — giving a working tournament selector with real settings.
// Idempotent: only seeds when the tournaments collection is empty, so later
// hand-edits to the data folder are never clobbered.

import { readFileSync, existsSync } from "node:fs";
import type { Repository } from "../persistence/repository.ts";
import type { Coeffs } from "./types.ts";
import type { Era, Park, Softcaps, Tournament } from "./tournament.ts";
import { eraFromCoeffs, parkFromCoeffs, softcapsFromCoeffs, modelFromCoeffs, type Model } from "./coeff-resolve.ts";

const CAPTURE_DIR = "fixtures/captures";

// Which captures become tournaments, in display order. (real-parkera-basic is a
// basic-metric variant of real-parkera — same era/park — so it is not a separate
// tournament. _synthetic is a dev placeholder.) Card-value 60–89 matches the
// user's real eligibility (SP-1) and the prior hard-coded default.
const SEED_TOURNAMENTS: { file: string; name: string; valueMin: number | null; valueMax: number | null }[] = [
  { file: "real-neutral.json",  name: "League Neutral (60–89)", valueMin: 60, valueMax: 89 },
  { file: "real-thr.json",      name: "Neutral + tHR (60–89)",  valueMin: 60, valueMax: 89 },
  { file: "real-parkera.json",  name: "Full Park + Era (60–89)", valueMin: 60, valueMax: 89 },
];

const MODEL_PREFERENCE = ["real-parkera.json", "real-thr.json", "real-neutral.json", "_synthetic.json"];

// Built-in neutral default's softcaps (mirrors the old app's un-editable default).
const NEUTRAL_SOFTCAPS: Softcaps = {
  cap_k_top: 500, cap_k_bot: 0, pen_k: 0.25,
  cap_babip_top: 500, cap_babip_bot: 0, pen_babip: 0.5,
  cap_gap_top: 500, cap_gap_bot: 0, pen_gap: 0.25,
  cap_pow_top: 500, cap_pow_bot: 0, pen_pow: 0.5,
  cap_eye_top: 500, cap_eye_bot: 0, pen_eye: 0.5,
  cap_p_con_top: 500, cap_p_con_bot: 0, pen_p_con: 0.25,
  cap_p_stu_top: 500, cap_p_stu_bot: 0, pen_p_stu: 0.25,
  cap_p_pbabip_top: 500, cap_p_pbabip_bot: 0, pen_p_pbabip: 0.25,
  cap_p_hrr_top: 500, cap_p_hrr_bot: 0, pen_p_hrr: 0.25,
};
const NEUTRAL_ERA: Era = { id: "era-neutral", name: "Neutral", bb: 1, k: 1, avg: 1, hr: 1, bip: 1, gap: 1, thr_toggle: false, thr: 1 };
const NEUTRAL_PARK: Park = { id: "park-neutral", name: "Neutral", avg_l: 1, avg_r: 1, hr_l: 1, hr_r: 1, gap: 1 };

const loadCoeffs = (file: string): Coeffs | null => {
  const f = `${CAPTURE_DIR}/${file}`;
  if (!existsSync(f)) return null;
  return (JSON.parse(readFileSync(f, "utf8")) as { coeffs: Coeffs }).coeffs;
};

// Classify an era/park into a clean library (id, name), so identical run
// environments across captures collapse to one reusable entry (D4).
const isNeutralEra = (e: Era) => e.bb === 1 && e.k === 1 && e.avg === 1 && e.hr === 1 && e.bip === 1 && e.gap === 1;
const eraIdentity = (e: Era): { id: string; name: string } => {
  if (isNeutralEra(e)) return e.thr_toggle ? { id: "era-thr", name: `Neutral + tHR (${e.thr ?? 1.15})` } : NEUTRAL_ERA;
  return { id: "era-full", name: `Full era${e.thr_toggle ? " + tHR" : ""}` };
};
const isNeutralPark = (p: Park) => p.avg_l === 1 && p.avg_r === 1 && p.hr_l === 1 && p.hr_r === 1 && p.gap === 1;
const parkIdentity = (p: Park): { id: string; name: string } => (isNeutralPark(p) ? NEUTRAL_PARK : { id: "park-full", name: "Full park" });

// Intern by value signature; if a desired id collides with a *different*
// signature, suffix it so distinct environments never alias.
function interner<T extends { id: string; name: string }>() {
  const bySig = new Map<string, T>();
  const usedIds = new Set<string>();
  return (entry: T, sigVals: unknown[], desired: { id: string; name: string }): T => {
    const sig = JSON.stringify(sigVals);
    const hit = bySig.get(sig);
    if (hit) return hit;
    let id = desired.id, n = 1;
    while (usedIds.has(id)) id = `${desired.id}-${++n}`;
    usedIds.add(id);
    const finalEntry = { ...entry, id, name: desired.name } as T;
    bySig.set(sig, finalEntry);
    return finalEntry;
  };
}

export interface SeedResult { seeded: boolean; tournaments: number; eras: number; parks: number; modelName: string }

/** Seed the data folder from local captures if the tournaments collection is empty. */
export async function seedDefaults(repo: Repository): Promise<SeedResult> {
  const existing = await repo.list("tournaments");
  if (existing.length > 0) {
    const model = (await repo.loadAll<Model>("models"))[0];
    return { seeded: false, tournaments: existing.length, eras: (await repo.list("eras")).length, parks: (await repo.list("parks")).length, modelName: model?.name ?? "(none)" };
  }

  // One shared trained model (identical across captures).
  const modelFile = MODEL_PREFERENCE.find((f) => existsSync(`${CAPTURE_DIR}/${f}`));
  if (!modelFile) return { seeded: false, tournaments: 0, eras: 0, parks: 0, modelName: "(no captures)" };
  const model = modelFromCoeffs(loadCoeffs(modelFile)!, "primary", `Trained model (${modelFile.replace(".json", "")})`);
  await repo.save("models", model.id, model);

  const internEra = interner<Era>();
  const internPark = interner<Park>();
  const eraIds = new Set<string>();
  const parkIds = new Set<string>();

  const saveEra = async (eRaw: Era) => {
    // tHR multiplier is unused when the toggle is off → normalize so neutral eras
    // (default thr=1 vs a capture's thr=1.15) collapse to one library entry.
    const e: Era = { ...eRaw, thr: eRaw.thr_toggle ? eRaw.thr : 1 };
    const id = eraIdentity(e);
    const final = internEra(e, [e.bb, e.k, e.avg, e.hr, e.bip, e.gap, e.thr, e.thr_toggle], id);
    if (!eraIds.has(final.id)) { await repo.save("eras", final.id, final); eraIds.add(final.id); }
    return final.id;
  };
  const savePark = async (p: Park) => {
    const id = parkIdentity(p);
    const final = internPark(p, [p.avg_l, p.avg_r, p.hr_l, p.hr_r, p.gap], id);
    if (!parkIds.has(final.id)) { await repo.save("parks", final.id, final); parkIds.add(final.id); }
    return final.id;
  };

  const tournaments: Tournament[] = [];

  // Built-in neutral default first (always present, like the old app's default).
  await saveEra(NEUTRAL_ERA);
  await savePark(NEUTRAL_PARK);
  tournaments.push({
    id: "default-neutral", name: "League Neutral (Default)",
    card_value_min: null, card_value_max: null, total_cap: null,
    roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
    variants_allowed: true, max_variants_on_roster: 0,
    eraId: NEUTRAL_ERA.id, parkId: NEUTRAL_PARK.id, softcaps: NEUTRAL_SOFTCAPS, eligibility: { mode: "ALL", rules: [] },
  });

  // Capture-derived tournaments.
  for (const s of SEED_TOURNAMENTS) {
    const bag = loadCoeffs(s.file);
    if (!bag) continue;
    const eraId = await saveEra(eraFromCoeffs(bag, "tmp", "tmp"));
    const parkId = await savePark(parkFromCoeffs(bag, "tmp", "tmp"));
    tournaments.push({
      id: s.file.replace(".json", ""), name: s.name,
      card_value_min: s.valueMin, card_value_max: s.valueMax, total_cap: 1858,
      roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
      variants_allowed: true, max_variants_on_roster: 5,
      eraId, parkId, softcaps: softcapsFromCoeffs(bag), eligibility: { mode: "ALL", rules: [] },
    });
  }

  for (const t of tournaments) await repo.save("tournaments", t.id, t);

  return { seeded: true, tournaments: tournaments.length, eras: eraIds.size, parks: parkIds.size, modelName: model.name };
}
