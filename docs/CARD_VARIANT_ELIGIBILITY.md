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


---

# CONFIRMED RULE (Derek, 2026-07-22)

Derek confirmed Card Type 1 / LE / PTMS and named four more classes: **PTWC, PTCS, Clubhouse,
Mission Edition**. Those live in a column this document's first draft never looked at — **`Card
Badge`**, which has only four values (`''`, `CS`, `ME`, `PTCS`). The mapping is exact:

| named class | how it is identified | N | played | seen as v5 |
|---|---|---|---|---|
| Live | `Card Type == "1"` | 1274 | 717 | 0 |
| LE | `Card Sub Type == "LE"` | 90 | 81 | 0 |
| PTMS | `Card Sub Type == "PTMS"` | 10 | 7 | 0 |
| **Clubhouse** | **`Card Badge == "CS"`** — all 144 "Clubhouse …" titles carry it, 1:1 | 144 | 106 | 0 |
| **Mission Edition** | **`Card Badge == "ME"`** | 52 | 37 | 0 |
| **PTCS** | **`Card Badge == "PTCS"`** — 1:1 with the "PTCS …" title prefix | 36 | 20 | 0 |
| **PTWC** | **title prefix `"PTWC "` — NO badge, NO type, NO sub-type** | 4 | — | 0 |

The seven rules are **mutually disjoint** — every match is unique to its own rule — and their union is
**1610 of 3669 cards = 43.9%**. Per value window, the share of the eligible pool that cannot have a
variant is **iron 51.4%, bronze 48.2%, silver 46.3%, gold 44.7%, diamond 43.9%** — worst at iron,
which is precisely the tier where fabricated v5s were measured to reach the top-50 and move the gap.

## Two structural facts that shape how this must be implemented

**1. THE DEV OVERRIDE MEANS A CLASS RULE CAN NEVER BE AUTHORITATIVE.** Derek: the developers can
manually add a variant for a card whose class forbids it — his example is Tris Speaker, who is in
this catalog as `badge ME, Card Type 7, VAL 100, "Live Full Collection - Snapshot CF Tris Speaker BOS
1910"` and now has a variant regardless. The capture corpus cannot see it (no CS/ME/PTCS card appears
at VLvl 5 anywhere in it) because VAL-100 cards sit outside all five Quick windows. So the rule is
**class default + an explicit override list**, and the override list cannot be derived from the
catalog — it has to be observed or supplied. Any implementation that treats the class rule as
complete will be wrong every time the devs make an exception, and silently.

**2. PTWC IS IDENTIFIABLE ONLY BY ITS TITLE.** It carries no badge, no distinguishing type and no
sub-type — only the literal `"PTWC "` title prefix. That is a fragile key: a title-format change
would silently re-admit those four cards. It should be pinned, and flagged as the one rule in the set
that reads a display string rather than a field.

## Consequence for the field-modelling question

This is the eligibility half only — *can* a card have a variant. It does not answer *does one exist
and get played*, which is the separate question raised by the measured presence gap: league play is
**2.5%** variant by qualifying pitcher usage, tournament play **15–29%**, while an unrestricted
arm-C construction produces **84–96%**. Eligibility narrows the theoretical population by 44%;
presence is what closes the rest of the distance, and it is still open.
