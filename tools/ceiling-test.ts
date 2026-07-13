// PHASE-1c STEP 0 — CEILING TEST (Fable/Derek). Deconvolved value spread-ratio WITHIN strict role
// cohorts (SP = GS/G ≥ 0.8, RP = GS/G ≤ 0.2, drop swingmen) on league IN-FRAME pitchers, under BOTH the
// deployed form (StuffAug, K=log) AND rawquad_pit. The pair decomposes the pooled in-frame pit spread
// (~0.62 deployed / ~0.76 rawquad) into ROLE-MIX variance (present under both) vs FORM-recoverable spread
// (log worse than rawquad within role). If within-role ≈0.9+, the residual is role-mix (ratings-blind to
// SP/RP) → record as the measured ceiling; role-aware scoring is the future ceiling-raiser (out of scope).
//   run: node tools/ceiling-test.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { fitPitForm, STUFFAUG_PIT, RAWQUAD_PIT } from "../src/training/forms.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);

// Per-CID role from raw league CSVs (window years): sum GS_1/G_1 across all rows for the card.
const gsAcc = new Map<string, { gs: number; g: number }>();
const TRAIN = "League Files";
for (const de of readdirSync(TRAIN, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const d = de.name;
  const yr = Number((d.match(/(\d{4})/) ?? [])[1]);
  if (win.length && !win.includes(yr)) continue;
  for (const f of readdirSync(join(TRAIN, d)).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    for (const r of Papa.parse(readFileSync(join(TRAIN, d, f), "utf8"), { header: true, skipEmptyLines: true }).data as any[]) {
      const cid = String(r.CID ?? ""); if (!cid) continue;
      const a = gsAcc.get(cid) ?? { gs: 0, g: 0 }; a.gs += num(r.GS_1); a.g += num(r.G_1); gsAcc.set(cid, a);
    }
  }
}
const roleOf = (cid: string): "SP" | "RP" | "swing" => { const a = gsAcc.get(cid); if (!a || a.g === 0) return "swing"; const r = a.gs / a.g; return r >= 0.8 ? "SP" : r <= 0.2 ? "RP" : "swing"; };

const lgObs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const lgPit = lgObs.filter((o) => PITCHER.qualifies(o, minPA));

// Neutral coeffs for in-frame scoring.
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);
const DUMMY_HIT = trained.eventForm.hit as FittedHit; // hitter form irrelevant to pit scoring

const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const seW = (uBB: number, HmHR: number, HR: number, XBH: number, d: number) => { const t: [number, number][] = [[w.bb, uBB / 600], [w.b1, (HmHR - XBH) / 600], [w.xbh, XBH / 600], [w.hr, HR / 600]]; const E = t.reduce((a, [ww, p]) => a + ww * p, 0), E2 = t.reduce((a, [ww, p]) => a + ww * ww * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };

interface Row { pred: number; real: number; w: number; se: number; role: "SP" | "RP" | "swing" }
function rows(ef: EventForm): Row[] {
  const m = makeRawPolyModel(ef);
  return lgPit.map((o) => {
    const e = m.predictPitching(o.ratings.pitch, coeffs);
    const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, ef);
    const pred = (w.bb * k.BB_fin + w.hbp * coeffs.adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.XBH_fin + w.hr * k.HR_fin) / 600;
    const uBB = per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), HmHR = per600(o.pitch.b1 + o.pitch.b2 + o.pitch.b3, o.pitch.BF), HR = per600(o.pitch.HR, o.pitch.BF), XBH = per600(o.pitch.b2 + o.pitch.b3, o.pitch.BF);
    const real = (w.bb * uBB + w.hbp * coeffs.adv_hbp + w.b1 * (HmHR - XBH) + w.xbh * XBH + w.hr * HR) / 600;
    return { pred, real, w: o.pitch.BF, se: seW(uBB, HmHR, HR, XBH, o.pitch.BF), role: roleOf(o.cid) };
  });
}
const ratio = (rs: Row[]) => { if (rs.length < 6) return NaN; const sPred = Math.sqrt(wvar(rs.map((r) => r.pred), rs.map((r) => r.w))); const sTrue = Math.sqrt(Math.max(wvar(rs.map((r) => r.real), rs.map((r) => r.w)) - wmean(rs.map((r) => r.se ** 2), rs.map((r) => r.w)), 1e-9)); return sPred / sTrue; };
function boot(rs: Row[]) { const pt = ratio(rs); const bs: number[] = []; for (let b = 0; b < 400; b++) { const s = Array.from({ length: rs.length }, () => rs[Math.floor(Math.random() * rs.length)]!); bs.push(ratio(s)); } bs.sort((a, b) => a - b); return { pt, lo: bs[10]!, hi: bs[389]! }; }

const deployed: EventForm = { hit: DUMMY_HIT, pit: fitPitForm(STUFFAUG_PIT, lgObs) };
const rawq: EventForm = { hit: DUMMY_HIT, pit: fitPitForm(RAWQUAD_PIT, lgObs) };
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const cnt = { SP: lgPit.filter((o) => roleOf(o.cid) === "SP").length, RP: lgPit.filter((o) => roleOf(o.cid) === "RP").length, swing: lgPit.filter((o) => roleOf(o.cid) === "swing").length };
console.log(`CEILING TEST — league in-frame pitchers (window ${win.join("+")}), strict cohorts SP(GS/G≥0.8)=${cnt.SP} RP(≤0.2)=${cnt.RP} swing(dropped)=${cnt.swing}\n`);
console.log(`  deconvolved value spread-ratio (σ_pred/σ_true) ± 95% boot CI:\n`);
for (const [label, ef] of [["deployed (StuffAug, K=log)", deployed], ["rawquad_pit", rawq]] as const) {
  const rs = rows(ef);
  const line = (cohort: "SP" | "RP" | "all") => { const sub = cohort === "all" ? rs : rs.filter((r) => r.role === cohort); const b = boot(sub); return `${cohort.padEnd(3)} N=${String(sub.length).padStart(3)}  ${f2(b.pt)} [${f2(b.lo)},${f2(b.hi)}]`; };
  console.log(`  ${label.padEnd(28)}  ${line("all")}   ${line("SP")}   ${line("RP")}`);
}
console.log(`\nRead: pooled 'all' vs within-SP/within-RP. If within-role ≈0.9+ under rawquad, the pooled residual is ROLE-MIX (record as ceiling); if within-role still <0.9, form leaves spread on the table. deployed-vs-rawquad within role = the form-recoverable piece.`);
process.exit(0);
