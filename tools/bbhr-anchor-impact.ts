// THROWAWAY diagnostic — quantify the elite-50 BB/HR anchor's ranking impact (2026-06-29).
//
// The per-event BB/HR calibration (calibrate.ts sBB/sHR) pins the ELITE-50's BB/HR to
// LEAGUE-AVERAGE Section-3 targets → sBB/sHR < 1 (population mismatch). The common
// deflation is re-absorbed by the final wOBA scale (uniform → ranking-invariant), so what
// actually moves rankings is the RESIDUAL: sBB ≠ sHR, plus BIP→hits coupling. This measures
// that residual by ranking the catalog WITH the anchored sBB/sHR vs FORCED to 1.0.
//
// Also demonstrates the tournament angle: re-run the anchor on an ELITE-ONLY pool (all
// top-tier cards, like a tournament) — sBB/sHR get MORE extreme, so the distortion is a
// LOWER bound for tournaments (where we also have no outcome data — see roadmap pool-adj).

import Papa from "papaparse";
import { readFileSync, existsSync } from "node:fs";
import { scoreCard, calibrate, computeDerived, type Coeffs, type CalScales, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, availableYears } from "../src/training/loader.ts";
import { defaultWindow } from "../src/training/evaluate.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, RAWPOLY_PIT } from "../src/training/forms.ts";

const cards = (Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[]).filter((c) => c["Card ID"]);
const coeffs = JSON.parse(readFileSync("fixtures/captures/real-neutral.json", "utf8")).coeffs as Coeffs;
const derived = computeDerived(coeffs);
const ROOT = ["League Files", "Model 2037 and 2038"].find(existsSync)!;
const WINDOW = ROOT === "League Files" ? defaultWindow(availableYears(ROOT)) : [2037, 2038];
const { observations } = loadWindow(ROOT, WINDOW);
const eventForm: EventForm = {
  hit: fitHitForm(RAWPOLY_HIT, observations.filter((o) => o.hit.PA >= 1000)),
  pit: fitPitForm(RAWPOLY_PIT, observations.filter((o) => o.pitch.BF >= 1000)),
};

const deployed = calibrate(cards, { coeffs, derived, eventForm });
// Force the per-event BB/HR scales to 1 (= #2's native rates, no elite-anchor deflation);
// keep the final wOBA scale (uniform → doesn't affect ranking).
const flat: CalScales = { ...deployed, hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1 };

const f3 = (x: number | undefined) => (x ?? 1).toFixed(3);
console.log(`pool = full catalog (${cards.length} cards); anchor = top-50 by wOBA`);
console.log(`HITTER  anchored  sBB ${f3(deployed.hitBBScaleVR)}/${f3(deployed.hitBBScaleVL)}  sHR ${f3(deployed.hitHRScaleVR)}/${f3(deployed.hitHRScaleVL)}  (vR/vL)`);
console.log(`PITCHER anchored  sBB ${f3(deployed.pBBScaleVR)}  sHR ${f3(deployed.pHRScaleVR)}`);

function impact(label: string, metric: (s: any) => number) {
  const vD = cards.map((c) => ({ id: String(c["Card ID"]), v: metric(scoreCard(c, { coeffs, derived, calScales: deployed, eventForm })) }));
  const vF = cards.map((c) => ({ id: String(c["Card ID"]), v: metric(scoreCard(c, { coeffs, derived, calScales: flat, eventForm })) }));
  const rank = (arr: typeof vD) => new Map([...arr].sort((a, b) => b.v - a.v).map((x, i) => [x.id, i] as const));
  const rD = rank(vD), rF = rank(vF);
  const ordD = [...rD.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const overlap = (n: number) => { const top = new Set(ordD.slice(0, n)); const fTop = new Set([...rF.entries()].sort((a, b) => a[1] - b[1]).slice(0, n).map(([id]) => id)); let c = 0; for (const id of top) if (fTop.has(id)) c++; return (c / n) * 100; };
  // rank movement among the top-100 (the roster-relevant band)
  const top100 = ordD.slice(0, 100);
  const moves = top100.map((id) => Math.abs(rD.get(id)! - rF.get(id)!));
  const mean = moves.reduce((s, x) => s + x, 0) / moves.length;
  console.log(`\n${label}: top26 overlap ${overlap(26).toFixed(1)}%  top50 ${overlap(50).toFixed(1)}%  top100 ${overlap(100).toFixed(1)}%`);
  console.log(`   among top-100: mean |Δrank| ${mean.toFixed(1)}, max ${Math.max(...moves)}; cards moving >5 ranks: ${moves.filter((m) => m > 5).length}/100`);
}
impact("HIT ovr (anchored vs sBB=sHR=1)", (s) => s.hit.woba_ovr);
impact("PITCH ovr (anchored vs sBB=sHR=1)", (s) => -s.pitch.woba_ovr); // lower allowed-wOBA = better

// ── Tournament angle: re-anchor on an ELITE-ONLY pool (top-tier cards only) ──────
const flatScore = cards.map((c) => ({ c, w: scoreCard(c, { coeffs, derived, calScales: flat, eventForm }).hit.woba_ovr }));
const elitePool = flatScore.sort((a, b) => b.w - a.w).slice(0, 150).map((x) => x.c);
const eliteCal = calibrate(elitePool, { coeffs, derived, eventForm });
console.log(`\n── elite-only pool (top 150 hitters, ~tournament) ──`);
console.log(`HITTER  anchored  sBB ${f3(eliteCal.hitBBScaleVR)}/${f3(eliteCal.hitBBScaleVL)}  sHR ${f3(eliteCal.hitHRScaleVR)}/${f3(eliteCal.hitHRScaleVL)}  (vR/vL)`);
console.log(`   vs full-pool sBB ${f3(deployed.hitBBScaleVR)} sHR ${f3(deployed.hitHRScaleVR)} — more extreme ⇒ bigger anchor deflation in tournaments`);
