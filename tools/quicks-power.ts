// Statistical-power check for the quicks: how many more runnings to trust (a) the FIT (aggregate s*
// slope) vs (b) per-card RANKINGS. Per tier: card-count by PA threshold, the realized per-card wOBA
// SPREAD (talent signal) vs the per-card sampling NOISE (∝ 1/√PA), the resulting signal-to-noise, and
// the runnings-multiple needed to reach S/N targets. Ghost-cleaned in-memory.
//
//   run: node tools/quicks-power.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);

const sd = (xs: number[]) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };

// Realized wOBA per card (raw event weights) + its per-card PA/BF. HBP = model constant (cancels).
for (const [name, TDIR, TID, runs] of [["Open", "Tournament Data/Quicks - Open", "default-neutral", 7], ["Bronze", "Tournament Data/Quicks - Bronze", "bronze-quick", 7], ["Gold", "Tournament Data/Quicks - Gold", "gold-quick", 5]] as const) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const w = wobaWeightsFromCoeffs(coeffs);
  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });

  const realHit = (a: any) => (w.bb * a.uBB + w.hbp * coeffs.adv_hbp + w.b1 * (a.HmHR - (a.XBH ?? 0)) + w.xbh * (a.XBH ?? 0) + w.hr * a.HR) / 600;
  const realPit = (a: any) => (w.bb * a.uBB + w.hbp * coeffs.adv_hbp + w.b1 * (a.HmHR - (a.XBH ?? 0)) + w.xbh * (a.XBH ?? 0) + w.hr * a.HR) / 600;

  console.log(`\n======== QUICKS ${name} (${runs} runnings) ========`);
  for (const [role, key, real] of [["HIT", "pa", realHit], ["PIT", "bf", realPit]] as const) {
    for (const TH of [300, 500, 800] as const) {
      const cards = obs.filter((o: any) => o[key] >= TH);
      if (cards.length < 4) { console.log(`  ${role} ≥${TH} ${key.toUpperCase()}: only ${cards.length} cards`); continue; }
      const wobas = cards.map((o: any) => real(role === "HIT" ? o.actual.hit : o.actual.pit));
      const paMed = cards.map((o: any) => o[key]).sort((a: number, b: number) => a - b)[Math.floor(cards.length / 2)];
      const spread = sd(wobas);                       // observed spread = talent + noise (in quadrature)
      const noise = 0.45 / Math.sqrt(paMed);          // per-card sampling SD (wOBA per-PA SD ≈ 0.45)
      const talent = Math.sqrt(Math.max(spread * spread - noise * noise, 1e-8)); // de-noised signal
      const snr = talent / noise;
      // to reach S/N = target, need per-card PA × (target/snr)² → runnings × that factor.
      const need2 = Math.pow(2 / snr, 2), need3 = Math.pow(3 / snr, 2);
      console.log(`  ${role} ≥${TH} ${key.toUpperCase()}: N=${String(cards.length).padStart(3)}  medPA=${paMed}  spread=${spread.toFixed(4)}  noise=${noise.toFixed(4)}  talent≈${talent.toFixed(4)}  S/N=${snr.toFixed(2)}  → S/N2 needs ×${need2.toFixed(1)} runnings (${Math.ceil(need2 * runs)} total), S/N3 ×${need3.toFixed(1)} (${Math.ceil(need3 * runs)})`);
    }
  }
}
process.exit(0);
