// M2d — file-based persistence (D7). One app folder is the single home for all
// libraries + the working session: JSON files per entity in per-type folders,
// plus raw CSV imports. No IndexedDB/localStorage/sessionStorage sprawl. Account
// overlays are first-class (their own collection).
//
//   <root>/
//     tournaments/<id>.json   eras/<id>.json   parks/<id>.json
//     models/<id>.json        accounts/<id>.json   rosters/<id>.json
//     imports/<name>.csv      (raw pt_card_list.csv imports, per account)
//
// A thin, typed-by-caller repository: list / load / loadAll / save / delete per
// collection, plus CSV read/write. Async (fs/promises) for the local server.

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogCsv, type Catalog } from "../data/catalog.ts";

export const COLLECTIONS = {
  tournaments: "tournaments",
  eras: "eras",
  parks: "parks",
  models: "models",
  accounts: "accounts",
  rosters: "rosters",
} as const;
export type Collection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS] | (string & {});

export class Repository {
  constructor(private readonly root: string) {}

  private dir(collection: string): string { return join(this.root, collection); }
  private file(collection: string, id: string): string { return join(this.dir(collection), `${id}.json`); }

  /** Save an entity as <root>/<collection>/<id>.json (pretty-printed). */
  async save<T>(collection: Collection, id: string, obj: T): Promise<void> {
    await mkdir(this.dir(collection), { recursive: true });
    await writeFile(this.file(collection, id), JSON.stringify(obj, null, 2), "utf8");
  }

  /** Load one entity, or null if absent. */
  async load<T>(collection: Collection, id: string): Promise<T | null> {
    const f = this.file(collection, id);
    if (!existsSync(f)) return null;
    return JSON.parse(await readFile(f, "utf8")) as T;
  }

  /** Ids present in a collection. */
  async list(collection: Collection): Promise<string[]> {
    const d = this.dir(collection);
    if (!existsSync(d)) return [];
    return (await readdir(d)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
  }

  /** Load every entity in a collection. */
  async loadAll<T>(collection: Collection): Promise<T[]> {
    const out: T[] = [];
    for (const id of await this.list(collection)) {
      const v = await this.load<T>(collection, id);
      if (v != null) out.push(v);
    }
    return out;
  }

  /** Delete one entity (no-op if absent). */
  async delete(collection: Collection, id: string): Promise<void> {
    const f = this.file(collection, id);
    if (existsSync(f)) await rm(f);
  }

  // ── CSV imports ────────────────────────────────────────────────────────────
  async saveImport(name: string, csvText: string): Promise<void> {
    await mkdir(join(this.root, "imports"), { recursive: true });
    await writeFile(join(this.root, "imports", `${name}.csv`), csvText, "utf8");
  }

  async loadImport(name: string): Promise<Catalog | null> {
    const f = join(this.root, "imports", `${name}.csv`);
    if (!existsSync(f)) return null;
    return parseCatalogCsv(await readFile(f, "utf8"));
  }

  async listImports(): Promise<string[]> {
    const d = join(this.root, "imports");
    if (!existsSync(d)) return [];
    return (await readdir(d)).filter((f) => f.endsWith(".csv")).map((f) => f.slice(0, -".csv".length)).sort();
  }
}
