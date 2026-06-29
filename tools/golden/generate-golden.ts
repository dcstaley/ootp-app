// GOLDEN GENERATOR (throwaway validation tooling) — snapshots the DEPLOYED #2 path.
//
// Re-baselined from the old log-linear oracle to a #2 REGRESSION snapshot: runs the
// rebuilt core's scoreCard with the frozen active eventForm (fixtures/eventform-active.json)
// over each capture, computing #2 calScales via the core's own calibrate(). Writes one
// snapshot per capture to fixtures/golden/. tests/parity.test.ts diffs the live core
// against these — so an unintended change to the #2 scoring/calibration path fails the test.
//
// (The old-app log-linear extracts in tools/golden/old/* are retired — kept only as history;
// log-linear is no longer the deployed model. #2's structural correctness — scoreCard ==
// the bake-off model — is guarded separately by tests/raw-poly.test.ts.)
//
// Run:  npm run golden        re-baseline the #2 goldens (do this only when #2 INTENTIONALLY
//                             changes — a new active model, or a deliberate scoring change)
//       npm run golden -- docs/pt_card_list.csv   override the card CSV path

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import Papa from "papaparse";

import { scoreCard, calibrate, computeDerived, type Coeffs, type EventForm } from "../../src/scoring-core/index.ts";

const CARDS_CSV = process.argv[2] ?? "docs/pt_card_list.csv";
const CAPTURES_DIR = "fixtures/captures";
const GOLDEN_DIR = "fixtures/golden";
const EVENTFORM_PATH = "fixtures/eventform-active.json";

interface Capture { label?: string; coeffs: Coeffs }

const isBase = (c: Record<string, unknown>) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

function loadCards(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) throw new Error(`Card CSV not found: ${path}`);
  const parsed = Papa.parse(readFileSync(path, "utf8"), { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) console.warn(`[golden] CSV parse warnings (${parsed.errors.length}); first: ${parsed.errors[0]?.message}`);
  return parsed.data as Record<string, unknown>[];
}

// One capture's #2 snapshot: the FULL deployed config (coeffs + #2 era/derived + computed
// #2 calScales + the frozen eventForm), then scoreCard per card. NO pool transform — that's
// a server-layer concern, ill-defined over an all-cards golden (no tournament eligibility).
function buildGolden(capture: Capture, cards: Record<string, unknown>[], eventForm: EventForm) {
  const coeffs = capture.coeffs;
  const derived = computeDerived(coeffs, true); // #2 ⇒ tHR removed (era_effective_hr = era_hr)
  const calScales = calibrate(cards.filter(isBase), { coeffs, derived, eventForm });
  const config = { coeffs, derived, calScales, eventForm };
  const rows = cards.map((card) => {
    const s = scoreCard(card, config);
    return { cardId: card["Card ID"], variant: card["Variant"] ?? "", title: card["//Card Title"], bats: Number(card["Bats"]), throws: Number(card["Throws"]), hit: s.hit, pitch: s.pitch };
  });
  return { label: capture.label ?? "unlabeled", cardCount: rows.length, derived, rows };
}

function main() {
  if (!existsSync(EVENTFORM_PATH)) {
    console.log(`[golden] No ${EVENTFORM_PATH} — activate a #2 model and export its eventForm first (server freezes it on save).`);
    return;
  }
  const eventForm = JSON.parse(readFileSync(EVENTFORM_PATH, "utf8")).eventForm as EventForm;
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
  const captureFiles = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((f) => f.endsWith(".json")) : [];
  if (captureFiles.length === 0) {
    console.log(`[golden] No captures in ${CAPTURES_DIR}/. Drop a capture there and re-run.`);
    return;
  }
  const cards = loadCards(CARDS_CSV);
  console.log(`[golden] #2 snapshot — ${cards.length} cards from ${CARDS_CSV}, eventForm ${EVENTFORM_PATH}`);
  for (const file of captureFiles) {
    const capture = JSON.parse(readFileSync(join(CAPTURES_DIR, file), "utf8")) as Capture;
    if (!capture.coeffs) { console.warn(`[golden] ${file}: no coeffs, skipping`); continue; }
    const golden = buildGolden(capture, cards, eventForm);
    const out = join(GOLDEN_DIR, `${basename(file, ".json")}.golden.json`);
    writeFileSync(out, JSON.stringify(golden));
    console.log(`[golden] ${file} → ${out}  (${golden.cardCount} cards)`);
  }
}

main();
