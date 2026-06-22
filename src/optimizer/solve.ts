// M4 — HiGHS-WASM solver, in-process (SP-4/6 validated). One lazily-loaded
// instance reused across solves. The model is passed as a CPLEX LP-format string
// (the format the old app proved out); the result mirrors highs-js:
//   { Status, ObjectiveValue, Columns: { <var>: { Primal } } }.

import highsLoader from "highs";

export interface SolveResult {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, { Primal: number }>;
}

type Highs = { solve: (lp: string) => SolveResult };
let _highs: Highs | null = null;

/** Lazily load the WASM solver (≈10–20ms once), then reuse it. */
export async function getSolver(): Promise<Highs> {
  if (!_highs) {
    _highs = (await highsLoader({ locateFile: (f: string) => "node_modules/highs/build/" + f })) as Highs;
  }
  return _highs;
}
