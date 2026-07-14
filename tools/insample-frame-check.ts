// FRAME ATTRIBUTION CHECK: is the audit's out-of-frame bias (hitter HR-under / BABIP-over, pitcher
// BB) present IN-SAMPLE on our own league data? Fit the deployed forms on league obs, predict each
// channel, compare to observed — overall + binned by the driving rating. If in-frame bias ≈ 0 (flat
// across bins) but the cwhit tournament bias is large, the defect is a FRAME/population effect (own-gap
// can't fully close it). If in-frame bias is itself nonzero / rating-sloped, it's a fittable model defect.
//   run: node tools/insample-frame-check.ts
import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel } from "../src/scoring-core/index.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, PARETO_PIT } from "../src/training/forms.ts";
import { PIT_BIP_ADJ, HIT_BIP_ADJ } from "../src/model/curves.ts";

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const obs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const hitQ = obs.filter((o) => HITTER.qualifies(o, minPA)), pitQ = obs.filter((o) => PITCHER.qualifies(o, minPA));
const rp = makeRawPolyModel({ hit: fitHitForm(RAWPOLY_HIT, hitQ), pit: fitPitForm(PARETO_PIT, pitQ) });
console.log(`[insample-frame-check] window ${win.join("+") || "all"} | ${hitQ.length} hit / ${pitQ.length} pit obs (PA/BF≥${minPA})\n`);

// Weighted bias of pred−obs per 600, overall + by quartile of the driving rating.
function report(rows: TrainObs[], label: string, driver: (o: TrainObs) => number, per600: (o: TrainObs) => number, pred: (o: TrainObs) => number, wOf: (o: TrainObs) => number) {
  const rec = rows.map((o) => ({ d: driver(o), obs: per600(o), pred: pred(o), w: wOf(o) })).filter((r) => Number.isFinite(r.obs) && Number.isFinite(r.pred) && r.w > 0);
  const wbias = (rs: typeof rec) => { const sw = rs.reduce((a, r) => a + r.w, 0); return rs.reduce((a, r) => a + r.w * (r.pred - r.obs), 0) / sw; };
  const srt = [...rec].sort((a, b) => a.d - b.d);
  const q = (i: number) => srt.slice(Math.floor((i / 4) * srt.length), Math.floor(((i + 1) / 4) * srt.length));
  const qb = [0, 1, 2, 3].map((i) => ({ bias: wbias(q(i)), lo: q(i)[0]?.d ?? 0, hi: q(i)[q(i).length - 1]?.d ?? 0 }));
  console.log(`${label.padEnd(28)} overall ${fmt(wbias(rec))}  | by driver quartile: ` + qb.map((b) => `[${b.lo.toFixed(0)}-${b.hi.toFixed(0)}] ${fmt(b.bias)}`).join("  "));
}

const HR = (o: TrainObs) => (o.hit.HR / Math.max(o.hit.PA, 1)) * 600;
const nHH = (o: TrainObs) => ((o.hit.H - o.hit.HR) / Math.max(o.hit.PA, 1)) * 600;
const uBBh = (o: TrainObs) => (Math.max(o.hit.BB - o.hit.IBB, 0) / Math.max(o.hit.PA, 1)) * 600;
const SOh = (o: TrainObs) => (o.hit.K / Math.max(o.hit.PA, 1)) * 600;
const pHR = rp.predictHitting;
console.log("── HITTER channels (per 600 PA), pred − obs ──");
report(hitQ, "HR ← Power", (o) => o.ratings.hit.pow, HR, (o) => pHR(o.ratings.hit, {} as any).HR, (o) => o.hit.PA);
report(hitQ, "non-HR hits ← BABIP", (o) => o.ratings.hit.babip, nHH, (o) => { const e = pHR(o.ratings.hit, {} as any); return e.oneB + e.GAP; }, (o) => o.hit.PA);
report(hitQ, "uBB ← Eye", (o) => o.ratings.hit.eye, uBBh, (o) => pHR(o.ratings.hit, {} as any).BB, (o) => o.hit.PA);
report(hitQ, "SO ← Avoid-K", (o) => o.ratings.hit.kRat, SOh, (o) => pHR(o.ratings.hit, {} as any).SO, (o) => o.hit.PA);

const BFp = (o: TrainObs) => Math.max(o.pitch.BF, 1);
const uBBp = (o: TrainObs) => (Math.max(o.pitch.BB - o.pitch.IBB, 0) / BFp(o)) * 600;
const Kp = (o: TrainObs) => (o.pitch.K / BFp(o)) * 600;
const HRp = (o: TrainObs) => (o.pitch.HR / BFp(o)) * 600;
const pP = rp.predictPitching;
console.log("\n── PITCHER channels (per 600 BF), pred − obs ──");
report(pitQ, "uBB ← Control", (o) => o.ratings.pitch.con, uBBp, (o) => pP(o.ratings.pitch, {} as any).BB, (o) => o.pitch.BF);
report(pitQ, "K ← Stuff", (o) => o.ratings.pitch.stu, Kp, (o) => pP(o.ratings.pitch, {} as any).K, (o) => o.pitch.BF);
report(pitQ, "HR ← pHR", (o) => o.ratings.pitch.hrr, HRp, (o) => pP(o.ratings.pitch, {} as any).HR, (o) => o.pitch.BF);
console.log(`\n→ Flat ~0 across quartiles ⇒ in-frame unbiased ⇒ the cwhit tournament bias is FRAME/population (own-gap residual).`);
console.log(`  A rating-sloped in-sample bias ⇒ a fittable model defect (not purely frame).`);
process.exit(0);
