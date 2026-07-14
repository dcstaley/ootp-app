// H3 — EG-HITTER COMPRESSION CHANNEL DECOMPOSITION. Under frame-v2 (additive) EG hitters compress
// 1.08→0.67 (§11.31). The concavity mechanism (item 21) says the additive shift moves hitters up the CONCAVE
// LOG contact/discipline curves (bb→1b/xbh via BIP) → those channels' output spread collapses; the QUAD HR
// channel (convex, no concavity) should NOT compress. TEST: per-channel predicted per-600 SD under own-gap
// (mult, spread-neutral on logs) vs frame-v2 (add) for EG hitters. If the compression lives in bb/1b/xbh and
// HR holds, the mechanism is confirmed (not an eval-stack bookkeeping artifact).
//   run: node tools/h3-eghitter-decomp.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, computeDerived } from "../src/scoring-core/index.ts";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { applyAffine, applyFrameShift } from "../src/model/pool-transform.ts";
import { loadTournamentOutcomes, tournamentExposure, type TournamentObs } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);

const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "early-gold")!;
const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
const ptOwn = buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined);
const fs = buildFrameShift(trained.trainingMeans, poolField);
const obs = loadTournamentOutcomes("Tournament Data/Early Gold", { clean: (rows) => cleanTournamentRows(rows).cleaned });
const exposure = tournamentExposure(obs);
const wRhit = exposure.wRhit;
const qual = obs.filter((o: TournamentObs) => o.pa >= TH);

// per-channel predicted per-600 for a hitter card under a transform ("own" | "add").
function chans(o: TournamentObs, mode: "own" | "add") {
  const side = (s: "vR" | "vL") => {
    const raw = o.ratings.hit[s]; const th = mode === "own" ? ptOwn.hit[s] : undefined; const fsh = mode === "add" ? fs.hit[s] : undefined;
    const rat = {
      ...raw,
      eye: applyFrameShift(applyAffine(raw.eye, th?.eye), fsh?.eye), pow: applyFrameShift(applyAffine(raw.pow, th?.pow), fsh?.pow),
      kRat: applyFrameShift(applyAffine(raw.kRat, th?.kRat), fsh?.kRat), babip: applyFrameShift(applyAffine(raw.babip, th?.babip), fsh?.babip),
      gap: applyFrameShift(applyAffine(raw.gap, th?.gap), fsh?.gap),
    };
    const e = rp.predictHitting(rat, coeffs);
    const k = hittingComponents(e, 1, 1, o.bats, s, coeffs, derived, ef);
    return { uBB: k.BB_fin, oneB: k.oneB_fin, xbh: k.GAP_fin, HR: k.HR_fin };
  };
  const R = side("vR"), L = side("vL"); const bl = (a: number, b: number) => wRhit * a + (1 - wRhit) * b;
  return { uBB: bl(R.uBB, L.uBB), oneB: bl(R.oneB, L.oneB), xbh: bl(R.xbh, L.xbh), HR: bl(R.HR, L.HR) };
}
const wsd = (v: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); const m = v.reduce((a, x, i) => a + w[i]! * x, 0) / sw; return Math.sqrt(v.reduce((a, x, i) => a + w[i]! * (x - m) ** 2, 0) / sw); };
const W = qual.map((o) => o.pa);
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");

console.log(`H3 — EG-hitter compression channel decomposition. Predicted per-600 SD per channel: own-gap(mult) vs frame-v2(add).`);
console.log(`Mechanism (item 21): additive compresses the CONCAVE LOG channels (uBB, 1B, XBH); the QUAD HR should HOLD.\n`);
console.log(`channel  curve   SD own-gap   SD frame-v2   add/own  (compression)`);
for (const [ch, curve] of [["uBB", "log"], ["oneB", "log(via BIP)"], ["xbh", "log-share"], ["HR", "QUAD"]] as const) {
  const own = wsd(qual.map((o) => (chans(o, "own") as any)[ch]), W), add = wsd(qual.map((o) => (chans(o, "add") as any)[ch]), W);
  console.log(`${ch.padEnd(8)} ${curve.padEnd(12)} ${f(own).padStart(7)}      ${f(add).padStart(7)}      ${f(add / own)}`);
}
console.log(`\nRead: add/own < 1 on uBB/1B/XBH (log channels compress under the additive shift) and ≈1 on HR (quad holds)`);
console.log(`⇒ the EG-hitter compression is the additive-through-concave-log mechanism, channel-localized as predicted —`);
console.log(`NOT an eval-stack bookkeeping artifact. If HR ALSO compresses, the mechanism story is incomplete (investigate).`);
process.exit(0);
