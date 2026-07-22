# Card variant eligibility — what can and cannot have a v5

**Status: EMPIRICAL DRAFT, awaiting Derek's confirmation of the game rule.** Created 2026-07-22 after
Derek flagged that not all cards can be variants (Live, Clubhouse, PTCS/PTMS, …) and that some
variants are rare enough to be effectively absent from play. Nothing in the codebase encoded this:
`Card Type` and `Card Sub Type` are read NOWHERE in `src/` or `web/`.

## Why it matters, and where it does NOT

**PRODUCTION IS NOT AFFECTED.** The app only ever materialises a variant the user has declared —
`src/data/account.ts:40` and `src/server/server.ts:432` iterate `variantCardIds`, and
`server.ts:638` gates on `variantIds.has(id) && t.variants_allowed`. It never invents a v5 for a card
that has none, so no user is offered an impossible card.

**THE ANALYSIS PATH IS.** Modelling a "variant-inclusive field" (arm C, and
`opponentSet` in `src/eval/cwhit/realized.ts`) constructs a hypothetical v5 for *every* base card in
order to ask what the field would look like. That fabricates variants for cards which cannot have
them. Measured consequence on the arm-C pitcher gap, current → arm-C-all → arm-C-eligible:

    iron    23.64 → 19.00 → 17.59      s_K 1.731 → 1.596 → 1.554
    bronze  22.76 → 12.29 → 12.68      s_K 1.705 → 1.394 → 1.406
    silver  20.55 → 12.00 → 12.00      unchanged
    gold    15.95 →  6.79 →  6.79      unchanged
    diamond 10.38 → -0.04 → -0.04      unchanged

Concentrated at iron, because only there is the pool small enough that fabricated v5s reach the
top-50; the larger pools have enough genuinely-capable cards to fill the cohort regardless. Iron
carries the largest K correction, so the error lands where it matters most.

## The empirical table

Derived from the 2026-07-21 capture corpus: a card is demonstrably CAPABLE if it was ever observed at
`VLvl 5`. Join is (name, Card Value) with every non-unique key dropped on both sides, so ambiguous
identities cannot contribute. An earlier, sloppier join showed a single Type-1 v5; it was a join
artifact and disappears under the clean join — consistent with Derek's "Live cards can 100% never be
variant".

| class | catalog N | played | seen as v5 | reading |
|---|---|---|---|---|
| **Card Type 1** (Live) | 1274 | 717 | **0** | **INCAPABLE — decisive** |
| **Sub Type LE**, all parent types | 81 | 81 | **0** | **INCAPABLE — decisive** (5/LE 0-of-45, 8/LE 0-of-11, 7/LE 0-of-9, 3/LE 0-of-7, 9/LE 0-of-4, 10/LE 0-of-4, 4/LE 0-of-1) |
| **Sub Type PTMS** | 9 | 7 | **0** | INCAPABLE — *suggestive only*, N too small to be decisive |
| Types 2–10, no sub-type | ~2078 | ~1601 | 54–87% of played | capable |
| Sub Types BBR / HOF / UTIL / WBC | ~130 | ~100 | 43–100% of played | capable |
| Sub Type VB ("Variant Booster") | 7 | 7 | 2 | mixed, N far too small to read |
| 7/HOF, 4/HOF, 8/PTMS | 5 | 0 | — | UNDETERMINED — never played |

Under the two decisive rules alone (Type 1, Sub Type LE), **1355 of 3669 catalog cards — 36.9% —
cannot have a variant.**

## What this table cannot establish, and needs Derek for

1. **PTCS does not appear as a `Card Sub Type` value at all** in `cdmx.csv`. The observed sub-types
   are BBR, LE, HOF, UTIL, WBC, PTMS, VB. Either PTCS lives in another column (`Card Series` has 56
   distinct values including "Live Collection Reward"), or it is absent from this catalog snapshot.
2. **Absence of evidence is not the rule.** LE at 0-of-81 is about as strong as an empirical read
   gets, but it is still an inference from *not observing* something. PTMS (0-of-7) and VB (2-of-7)
   are not readable at all.
3. **The numeric `Card Type` codes are unmapped.** Type 1 behaves exactly as Derek describes Live
   cards, but nothing in the repo says so, and the other nine codes are unnamed.
4. **CAPABILITY IS NOT PRESENCE.** Even among capable classes only 43–100% of *played* cards were
   ever seen as v5, and Derek notes some variants (e.g. perfect 100+) are rare enough to be
   effectively absent. A *field* is meant to estimate the cards actually met, so weighting every
   capable v5 at 1 overstates it — less badly than including impossible ones, but in the same
   direction. Whether the field should weight by capability or by presence is a modelling ruling,
   not a game fact.

## Where the rule should live when confirmed

One predicate, one place — `src/data/variants.ts`, beside `makeVariant`, since that is the single
function that manufactures a variant. `opponentSet` and every arm-C construction consults it; nothing
re-derives eligibility from raw columns. Until the rule is confirmed the predicate is NOT wired: the
arm-C numbers on record are provisional and are flagged as such wherever they appear.

