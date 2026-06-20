// M2d — file-based persistence (D7). Repository round-trips + an M2 capstone:
// persist config (era/park/tournament/account), reload from disk, and drive the
// full chain (account rows → eligible pool → calibrate) off the reloaded objects.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository, COLLECTIONS } from "../src/persistence/repository.ts";
import { buildAccountRows, type AccountOverlay } from "../src/data/account.ts";
import { buildEligiblePool } from "../src/config/eligibility.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { calibrate, computeDerived, TARGET_WOBA, type Coeffs } from "../src/scoring-core/index.ts";
import type { Tournament, Era, Park } from "../src/config/tournament.ts";

const root = mkdtempSync(join(tmpdir(), "ootp-repo-"));
const repo = new Repository(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tournament: Tournament = {
  id: "tourney-1", name: "Test Cup",
  card_value_min: 60, card_value_max: 89, total_cap: 1858,
  roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
  variants_allowed: true, max_variants_on_roster: 5,
  eraId: "era-1", parkId: "park-1",
  softcaps: {} as Tournament["softcaps"],
  eligibility: { mode: "ALL", rules: [] },
};
const era: Era = { id: "era-1", name: "Neutral", bb: 1, k: 1, avg: 1, hr: 1, bip: 1, gap: 1, thr_toggle: false, thr: 1.15 };
const park: Park = { id: "park-1", name: "Neutral", avg_l: 1, avg_r: 1, hr_l: 1, hr_r: 1, gap: 1 };

describe("Repository round-trips", () => {
  it("save / load / list / loadAll / delete (JSON collections)", async () => {
    await repo.save(COLLECTIONS.tournaments, tournament.id, tournament);
    await repo.save(COLLECTIONS.eras, era.id, era);
    await repo.save(COLLECTIONS.parks, park.id, park);

    expect(await repo.load<Tournament>(COLLECTIONS.tournaments, "tourney-1")).toEqual(tournament);
    expect(await repo.list(COLLECTIONS.tournaments)).toEqual(["tourney-1"]);
    expect(await repo.loadAll<Era>(COLLECTIONS.eras)).toEqual([era]);

    expect(await repo.load(COLLECTIONS.tournaments, "missing")).toBeNull();

    await repo.delete(COLLECTIONS.tournaments, "tourney-1");
    expect(await repo.list(COLLECTIONS.tournaments)).toEqual([]);
  });

  it("CSV import round-trips into a catalog", async () => {
    const csv = readFileSync("docs/pt_card_list.csv", "utf8");
    await repo.saveImport("acct-A", csv);
    expect(await repo.listImports()).toContain("acct-A");
    const catalog = await repo.loadImport("acct-A");
    expect(catalog?.cards.length).toBe(3376);
  });
});

describe("M2 capstone — reload config from disk and drive the pipeline", () => {
  it("account rows → eligible pool → calibrate, all from reloaded objects", async () => {
    const overlay: AccountOverlay = { id: "acct-A", name: "Acct A", owned: {}, variantCardIds: [] };
    await repo.save(COLLECTIONS.accounts, overlay.id, overlay);
    await repo.save(COLLECTIONS.tournaments, tournament.id, tournament);

    // reload everything fresh from disk
    const t = (await repo.load<Tournament>(COLLECTIONS.tournaments, "tourney-1"))!;
    const acct = (await repo.load<AccountOverlay>(COLLECTIONS.accounts, "acct-A"))!;
    const catalog = (await repo.loadImport("acct-A"))!;

    const rows = buildAccountRows(catalog, acct);
    const pool = buildEligiblePool(rows, t);
    expect(pool.length).toBeGreaterThan(100);

    const coeffs = (JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")) as { coeffs: Coeffs }).coeffs;
    const scales = calibrate(pool, { coeffs, derived: computeDerived(coeffs) });
    expect((scales.anchorMeanVR as number) * (scales.hitScaleVR as number)).toBeCloseTo(TARGET_WOBA, 9);
  });
});
