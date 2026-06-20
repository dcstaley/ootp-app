// GOLDEN GENERATOR (throwaway tooling).
//
// Reads each capture file in fixtures/captures/*.json (produced by the old app
// via tools/capture-snippet.js) plus the card CSV, runs the OLD app's extracted
// scoring code over them, and writes one golden reference file per capture to
// fixtures/golden/. The rebuilt core's parity test diffs against these.
//
// A capture is one tournament's environment:
//   { label, settings?, coeffs (ootp_coeffs_v2), calScales (ootp.calibrationScales) }
//
// Run:  npm run golden        (processes every capture)
//       npm run golden -- docs/pt_card_list.csv   (override card CSV path)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import Papa from "papaparse";

import { computeAugmentedRows } from "./old/computeRows.ts";
import { computeDerived } from "./old/derived.ts";
import { getHittingScore, getPitchingScore, type ScoreSettings } from "./old/rosterScores.ts";

const CARDS_CSV = process.argv[2] ?? "docs/pt_card_list.csv";
const CAPTURES_DIR = "fixtures/captures";
const GOLDEN_DIR = "fixtures/golden";

interface Capture {
  label?: string;
  settings?: Partial<ScoreSettings>;
  coeffs: any;
  calScales: any | null;
}

// Every score mode, so the golden exercises all branches regardless of which
// metric the capture was taken under. Each entry is the settings passed to the
// trusted score functions.
const HIT_MODES: Array<{ key: string; metric: "woba" | "basic"; side: "vL" | "vR" }> = [
  { key: "woba_vL", metric: "woba", side: "vL" },
  { key: "woba_vR", metric: "woba", side: "vR" },
  { key: "basic_vL", metric: "basic", side: "vL" },
  { key: "basic_vR", metric: "basic", side: "vR" },
];
const PITCH_MODES: Array<{ key: string; metric: "woba" | "basic"; side: "vR" | "vL" | "ovr" }> = [
  { key: "woba_vR", metric: "woba", side: "vR" },
  { key: "woba_vL", metric: "woba", side: "vL" },
  { key: "woba_ovr", metric: "woba", side: "ovr" },
  { key: "basic_vR", metric: "basic", side: "vR" },
  { key: "basic_vL", metric: "basic", side: "vL" },
  { key: "basic_ovr", metric: "basic", side: "ovr" },
];

function loadCards(path: string): any[] {
  if (!existsSync(path)) throw new Error(`Card CSV not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    console.warn(`[golden] CSV parse warnings (${parsed.errors.length}); first: ${first?.message} @ row ${first?.row}`);
  }
  return parsed.data as any[];
}

function buildGolden(capture: Capture, cards: any[]) {
  const derived = computeDerived(capture.coeffs);
  const augmented = computeAugmentedRows(cards, capture.coeffs, derived);

  const rows = augmented.map((card) => {
    const hit: Record<string, number> = {};
    for (const m of HIT_MODES) {
      const ctx = {
        coeffs: capture.coeffs,
        derived,
        calScales: capture.calScales,
        settings: { hittingMetric: m.metric, pitchingMetric: "woba", pitchingSide: "ovr" } as ScoreSettings,
      };
      hit[m.key] = getHittingScore(card, m.side, ctx);
    }
    const pitch: Record<string, number> = {};
    for (const m of PITCH_MODES) {
      const ctx = {
        coeffs: capture.coeffs,
        derived,
        calScales: capture.calScales,
        settings: { hittingMetric: "woba", pitchingMetric: m.metric, pitchingSide: m.side } as ScoreSettings,
      };
      pitch[m.key] = getPitchingScore(card, ctx);
    }
    return {
      cardId: card["Card ID"],
      variant: card["Variant"] ?? "",
      title: card["//Card Title"],
      bats: Number(card["Bats"]),
      throws: Number(card["Throws"]),
      hit,
      pitch,
    };
  });

  return {
    label: capture.label ?? "unlabeled",
    cardCount: rows.length,
    derived,
    rows,
  };
}

function main() {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  const captureFiles = existsSync(CAPTURES_DIR)
    ? readdirSync(CAPTURES_DIR).filter((f) => f.endsWith(".json"))
    : [];

  if (captureFiles.length === 0) {
    console.log(
      `[golden] No captures in ${CAPTURES_DIR}/. Run tools/capture-snippet.js in the old app ` +
      `(one tournament at a time) and drop the downloaded file(s) there, then re-run.`,
    );
    return;
  }

  const cards = loadCards(CARDS_CSV);
  console.log(`[golden] Loaded ${cards.length} cards from ${CARDS_CSV}`);

  for (const file of captureFiles) {
    const capture = JSON.parse(readFileSync(join(CAPTURES_DIR, file), "utf8")) as Capture;
    if (!capture.coeffs) {
      console.warn(`[golden] ${file}: no coeffs, skipping`);
      continue;
    }
    const golden = buildGolden(capture, cards);
    const out = join(GOLDEN_DIR, `${basename(file, ".json")}.golden.json`);
    writeFileSync(out, JSON.stringify(golden));
    console.log(
      `[golden] ${file} → ${out}  (${golden.cardCount} cards, ` +
      `calScales=${capture.calScales ? "present" : "null"})`,
    );
  }
}

main();
