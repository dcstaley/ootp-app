// QUICKS LADDER analysis (Phase-1 gating data). Open / Bronze / Gold quicks are era-2010 neutral,
// Bo5 16-team, at value caps (Open=none, Bronze≤69, Gold≤89) → a swept opponent-gap axis with NO env
// confound. This is the instrument for: (1) the K-slope RAMP (s* vs frame gap — Open in-frame ≈1.0,
// Bronze/Gold out-of-frame >1), (2) the FORMAT-CONSISTENCY test (is the frame-corrected level bias
// ~constant across tiers ⇒ a real format effect, or does it scale with gap ⇒ a frame artifact), and
// (3) the DISCRIMINATION scorecard (does frame-v2 rank better than own-gap across the ladder?).
// Ghost-cleaned in-memory. All numbers on the ACTIVE model.
//
//   run: node tools/quicks-ladder.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, evaluateTournamentLevels, tournamentScorecard, type TournamentObs } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const FIELD_N = 50, TH = 300; // quicks cards are thin (~4.5k PA/side/running); a lower per-card floor.
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const thr = (x: number) => (x === 1 ? 1 : 2);
const wmean = (v: number[], w: number[]) => v.reduce((s, u, i) => s + u * w[i]!, 0) / w.reduce((s, u) => s + u, 0);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm = trained.eventForm;
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const R = (r: any, s: string, c: string) => num(r[`${c} ${s}`]);

console.log(`Quicks ladder — active model ${trained.id}, transformMode(state)=${state.transformMode}, TM ${trained.trainingMeans ? "present" : "MISSING"}\n`);

// s* on K: per-card predicted K (opp-gap-shifted, ×era_k, NO kSpread) vs actual, WLS centered on the
// production K̄_pool (poolMeanK, post-era). This is the spread scale the data wants (in-frame → 1.0).
function kStar(obs: TournamentObs[], coeffs: any, fs: any, kbarPreEra: { hit: number; pit: number }, exposure: any) {
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;
  const eraK = coeffs.era_k;
  const sh = (v: number, d: number | undefined) => (d ? Math.max(0, v + d) : v);
  const fit = (rows: { act: number; pred: number; w: number }[], kb: number) => {
    if (rows.length < 4) return { s: NaN, n: rows.length };
    let nu = 0, de = 0; for (const r of rows) { nu += r.w * (r.pred - kb) * (r.act - kb); de += r.w * (r.pred - kb) ** 2; }
    return { s: nu / de, n: rows.length };
  };
  const hitRows = obs.filter((o) => o.pa >= TH).map((o) => {
    const side = (s: "vR" | "vL") => { const d = fs.hit[s]; const e = rp.predictHitting({ eye: sh(o.ratings.hit[s].eye, d.eye), pow: sh(o.ratings.hit[s].pow, d.pow), kRat: sh(o.ratings.hit[s].kRat, d.kRat), babip: sh(o.ratings.hit[s].babip, d.babip), gap: sh(o.ratings.hit[s].gap, d.gap), speed: 0, steal: 0, run: 0 }, coeffs); return e.SO * eraK; };
    return { act: o.actual.hit.K, pred: bl(side("vR"), side("vL"), exposure.wRhit), w: o.pa };
  });
  const pitRows = obs.filter((o) => o.bf >= TH).map((o) => {
    const w = exposure.wRpit[thr(o.throws)]!;
    const side = (s: "vR" | "vL") => { const d = fs.pit[s]; const e = rp.predictPitching({ con: sh(o.ratings.pit[s].con, d.con), stu: sh(o.ratings.pit[s].stu, d.stu), pbabip: sh(o.ratings.pit[s].pbabip, d.pbabip), hrr: sh(o.ratings.pit[s].hrr, d.hrr) }, coeffs); return e.K * eraK; };
    return { act: o.actual.pit.K, pred: bl(side("vR"), side("vL"), w), w: o.bf };
  });
  return { hit: fit(hitRows, kbarPreEra.hit * eraK), pit: fit(pitRows, kbarPreEra.pit * eraK) };
}

const f2 = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);

for (const [name, TDIR, TID] of [["Open", "Tournament Data/Quicks - Open", "default-neutral"], ["Bronze", "Tournament Data/Quicks - Bronze", "bronze-quick"], ["Gold", "Tournament Data/Quicks - Gold", "gold-quick"]] as const) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const frameShift = buildFrameShift(trained.trainingMeans, poolField);
  const kbar = poolMeanK(basePool, coeffs, rp, frameShift, FIELD_N);
  const kSpread = { sHit: 1 + 0.75 * Math.min(Math.max((frameShift.hit.vR.kRat ?? 0) / 17, 0), 1), sPit: 1 + 0.75 * Math.min(Math.max((frameShift.pit.vR.stu ?? 0) / 17, 0), 1), meanHit: kbar.hit, meanPit: kbar.pit };

  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const gapHitK = frameShift.hit.vR.kRat ?? 0, gapPitK = frameShift.pit.vR.stu ?? 0; // K-channel opp-gaps

  const lv = (extra: any) => evaluateTournamentLevels(obs, { coeffs, eventForm, ...extra }, exposure);
  const base = lv({}), fv2 = lv({ frameShift, kSpread });
  const ks = kStar(obs, coeffs, frameShift, kbar, exposure);
  const scMode = (extra: any) => tournamentScorecard(obs, { coeffs, eventForm, ...extra }, exposure, { minPA: TH, minBF: TH, topN: 20 });
  const scBase = scMode({}), scOwn = scMode({ poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) }), scF = scMode({ frameShift, kSpread });

  console.log(`======== QUICKS ${name} (${t.eraId}, val≤${t.card_value_max ?? "∞"}), ${obs.length} cards ========`);
  console.log(`  K-channel opp-gap (frame):  hit.kRat ${gapHitK.toFixed(1)}   pit.stu ${gapPitK.toFixed(1)}   (Open≈0 in-frame; larger = weaker pool)`);
  console.log(`  s* (K spread needed):       hit ${f3(ks.hit.s)}   pit ${f3(ks.pit.s)}   (in-frame→1.0; >1 = model under-separates K)`);
  const lvln = (tbl: any, role: string) => tbl[role].map((r: any) => `${r.event}:${f2(r.bias)}`).join("  ");
  console.log(`  level bias  [base]  HIT ${lvln(base, "hit")}`);
  console.log(`  level bias  [base]  PIT ${lvln(base, "pit")}`);
  console.log(`  level bias  [fv2 ]  HIT ${lvln(fv2, "hit")}`);
  console.log(`  level bias  [fv2 ]  PIT ${lvln(fv2, "pit")}`);
  const sc = (role: "hit" | "pit") => {
    const b = scBase[role], o = scOwn[role], f = scF[role];
    if (!b) return `    ${role}: <${TH} PA/BF`;
    return `    ${role.toUpperCase()}  Spearman base ${f3(b.spearman)} / own ${f3(o!.spearman)} / fv2 ${f3(f!.spearman)}   spread fv2 ${f3(f!.spreadRatio)}   regret own ${f3(o!.valueRegret)} fv2 ${f3(f!.valueRegret)}   N=${b.n}`;
  };
  console.log(`  scorecard (discrimination):`);
  console.log(sc("hit"));
  console.log(sc("pit"));
  console.log();
}
process.exit(0);
