// M3 (D6) — account + catalog bootstrap. Accounts are a NEW concept (no old-app
// parity): they share one card catalog and differ only in `owned` quantities and
// variants. The card catalog (ratings) is GLOBAL in OOTP — a card scores the same
// regardless of who owns it — so we keep one shared catalog and a thin per-account
// owned/variant overlay (a card never scores differently between accounts).
//
// Crucially the catalog is NOT a frozen committed file (new cards release
// constantly) — it is rebuilt from the latest uploaded pt_card_list CSV. Each
// account CSV is a complete current card list, so any upload refreshes the shared
// catalog (and that account's ownership). On first run we seed both accounts from
// the user's OOTP `online_data` folder; thereafter uploads (re)seed.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCatalogCsv } from "./catalog.ts";
import { overlayFromCatalog, type AccountOverlay } from "./account.ts";
import type { Repository } from "../persistence/repository.ts";

// Where the user's OOTP exports live. Overridable for other machines / CI.
const DEFAULT_SEED_DIR = join(
  homedir(), "OneDrive", "Documents", "Out of the Park Developments", "OOTP Baseball 27", "online_data",
);
export const SEED_DIR = process.env.SEED_ACCOUNTS_DIR ?? DEFAULT_SEED_DIR;

const CARD_LIST_RE = /^pt_card_list(.*)\.csv$/i;

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";

/** "pt_card_list CDMX.csv" → "CDMX"; "pt_card_list.csv" → "Default". */
export function accountNameFromFilename(file: string): string {
  const m = CARD_LIST_RE.exec(file);
  const tail = (m?.[1] ?? "").trim();
  return tail || "Default";
}

export interface SeedAccountsResult {
  seeded: boolean;
  accountIds: string[];
  catalogSourceId: string | null;
}

/**
 * Seed accounts + the catalog source from CSVs in the seed dir, if no accounts
 * exist yet. Each CSV becomes: a saved import (data/imports/<id>.csv), an account
 * overlay (owned from its `owned` column), and a candidate catalog source. The
 * most complete list (most cards) becomes the shared catalog. Idempotent.
 */
export async function seedAccounts(repo: Repository): Promise<SeedAccountsResult> {
  const existing = await repo.list("accounts");
  if (existing.length > 0) {
    const st = await repo.load<{ catalogSourceId?: string }>("state", "app");
    return { seeded: false, accountIds: existing, catalogSourceId: st?.catalogSourceId ?? null };
  }

  if (!existsSync(SEED_DIR)) return { seeded: false, accountIds: [], catalogSourceId: null };
  const files = readdirSync(SEED_DIR).filter((f) => CARD_LIST_RE.test(f));
  if (!files.length) return { seeded: false, accountIds: [], catalogSourceId: null };

  const ids: string[] = [];
  let best: { id: string; cards: number } | null = null;

  for (const file of files) {
    const name = accountNameFromFilename(file);
    const id = slug(name);
    const text = readFileSync(join(SEED_DIR, file), "utf8");
    const imported = parseCatalogCsv(text);
    await repo.saveImport(id, text);
    await repo.save<AccountOverlay>("accounts", id, overlayFromCatalog(imported, id, name));
    ids.push(id);
    if (!best || imported.cards.length > best.cards) best = { id, cards: imported.cards.length };
  }

  const catalogSourceId = best?.id ?? null;
  await repo.save("state", "app", { activeAccountId: ids[0] ?? null, catalogSourceId });
  return { seeded: true, accountIds: ids, catalogSourceId };
}
