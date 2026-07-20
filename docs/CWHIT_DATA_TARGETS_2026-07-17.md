# cwhitstats.com Data Capture Targets — 2026-07-17

Derived from our own tournament configs (`data/tournaments/*.json`), era configs
(`data/eras/*.json`), the open defect queue (`cwhit-program-batch-state.md`), and what we've
already hand-captured (`fixtures/cwhit/*.tsv`, `fixtures/cwhit-proj/*.tsv`).

This is a list of what **we want**, keyed to our config names — not a claim about what exists on
cwhitstats.com. Derek matches these against the actual site listing.

PTCS-prefixed configs (`ptcs-bronze`, `ptcs-cap`, `ptcs-diamond`, `ptcs-gold`, `ptcs-open`,
`ptcs-live`) are excluded throughout — no cwhit data exists for those.

## Ranked capture table

| # | Tournament / format name | Our config (id — era year / park) | Feeds defect | Priority | Note |
|---|---|---|---|---|---|
| 1 | **Nightmare Cap** | `nightmare-cap` — era-1955 / park-182, cap 1559, card 50–74 | ERA-SPREAD (era_k over-compression) + Cap-mode coverage | **P1** | 3rd distinct extreme-era point (k=0.615, hr=0.939 — less extreme than the two we have but a genuinely different year). Config is brand new (Derek just added it) — likely a format he's actively playing, so real depth should be gettable. Also directly fills the cap-mode gap (we have only Gold Cap + a config-less Diamond Cap so far). |
| 2 | **Cwhit Cap** | `cwhit-cap` — era-1896 / park-1, cap 1700, card 60–74 | ERA-SPREAD (era_k over-compression) + Cap-mode coverage | **P1** | 4th distinct extreme-era point — and the MOST extreme era factor in our whole config set (k=0.306, hr=0.266), even more extreme than Early Gold's 1920 (k=0.352) and Bronze Heart's 1939 (k=0.411). Named after Derek's own tournament, so plausibly a format he plays with real depth. Also a 3rd cap-mode config. |
| 3 | **Bronze Cap Weekly** | `bronze-cap-weekly` — era-2010 / park-1, cap 1331, card ≤69 | era-2010-daily BABIP overshoot + Cap-mode coverage | **P1** | We currently have only 2 directional points for the era-2010-ish BABIP overshoot (Gold Cap Daily, Diamond Cap Daily-no-config). A 3rd era-2010/modern cap format confirms or kills the "N-thin, flagged" 0.80/0.87 slope reading. Neutral era/park (era-2010, park-1 = the default park), so it's a clean same-frame confirm. |
| 4 | **Diamond Quick** (deeper capture) | `— ` (Quick ladder, era-2010, already captured) | Diamond pit dead cell + Elite top-decile spread | **P2** | Not a new format — a deeper window of the SAME format. Current diamond pitcher sample is N=1 well-sampled (18/123 tournaments covered) — the pit cell is flat-out dead. Diamond hitter N=17 is thin too. More instances/pages, same tier. |
| 5 | **Gold Quick** (deeper capture) | `gold-quick` — era-2010 (already captured) | Elite top-decile spread | **P2** | Not a new format. This is the tier where the K-spread G2 gate cell came back CI-clear-fail (thin, N=15) — more depth here directly answers whether that's real or a sampling artifact, and generally tightens the elite-spread read. |
| 6 | **Silver Cap** | `silver-cap` — era-1998 / park-1, cap 1475, card ≤79 | era-2010-daily BABIP overshoot (secondary confirm) + Cap-mode coverage | **P2** | era-1998 is close-to-modern (k=0.916, not far from 1) — a softer confirm point for the BABIP-overshoot question than Bronze Cap Weekly's exact era-2010, but adds a 4th/5th cap-mode format and broadens the cap-mode sample generally. |
| 7 | **Gold Sporer Sandlot** | `gold-sporer-sandlot` — era-1993 / park-189, cap 1858, card 60–89 | Cap-mode coverage (breadth only) | **P2** | Mildly non-neutral era (k=0.815) — not extreme enough to move the era-spread needle much, but rounds out cap-mode coverage across a wider card-value band (60–89 vs. the others' narrower windows). |
| 8 | Late Silver | `late-silver` — era-1929 / park-208, card ≤79 | ERA-SPREAD (backup/optional) | **P3** | Very extreme era (k=0.288) — as extreme as Cwhit Cap — but not a cap/daily config, so capture depth is uncertain. Only pursue if #1/#2 turn out thin or don't exist on the site. |
| 9 | Wonky Slots | `wonky-slots` — era-1945 / park-28, card ≤89 | ERA-SPREAD (backup/optional) | **P3** | Extreme era (k=0.391, right in Bronze Heart's range) but SLOTS kind — likely bracket-structured with thinner natural depth than a daily/cap grind. Backup only. |
| 10 | Silver Deadball Slots / Live Time Slots | `silver-deadball-slots`, `live-time-slots` — era-1919 / park-228, park-203 | ERA-SPREAD (backup/optional) | **P3** | Extreme era (k=0.440), two configs on the same era — SLOTS kind again, same depth caveat as #9. Only worth chasing if the P1/P2 extreme-era targets don't pan out. |
| 11 | Live Gold | `live-gold` — era-2019 / park-7, card ≤89 | ERA-SPREAD (bonus, opposite direction) | **P3** | Not one of the pre-registered defect asks. era-2019 is extreme in the OTHER direction — high offense (k=1.241, hr=1.455) rather than deadball. Optional curiosity: would tell us whether era_k over-compression is symmetric (both directions) or a deadball-specific artifact. Nice-to-have, not required. |

## Already covered / don't bother

These are already in `fixtures/cwhit/*.tsv` or `fixtures/cwhit-proj/*.tsv` — no need to recapture
unless going for the "deeper window" asks (#4/#5 above, which reuse the same formats):

- **Bronze / Silver / Gold / Iron / Diamond Quick** (all era-2010, ladder tiers) — full 5-tier
  scorecard captured (top-100 each side, hand-captured projections too).
- **Early Gold Daily** → `early-gold` (era-1920/park-169) — extreme-era point #1, captured.
- **Bronze Heart Daily** → `bronze-heart` (era-1939/park-191) — extreme-era point #2, captured.
- **Gold Cap Daily** → `gold-cap` (era-2010/park-156, cap 1580) — era-2010 BABIP-overshoot point #1,
  captured.
- **Diamond Cap Daily** — no matching config exists in our `data/tournaments/`; already captured
  anyway and stands as BABIP-overshoot point #2. Per 2026-07-16 note: don't chase a config for it
  again unless Derek supplies era/park/cap directly.

`default-neutral` and `oaxaca-league` are league configs (training data sources), not tournament
formats — not applicable to cwhit capture at all.

## 3-line summary for Derek

1. **Highest value, capture first:** Nightmare Cap (era-1955) and Cwhit Cap (era-1896) — these are
   your two newest/most-extreme-era cap configs and give us the 3rd/4th distinct extreme-era points
   the K-spread era defect needs, plus real cap-mode coverage (we've had almost none).
2. **Second:** Bronze Cap Weekly (era-2010 cap) confirms or kills the thin BABIP-overshoot read from
   Gold Cap Daily / Diamond Cap Daily; Silver Cap and Gold Sporer Sandlot are lower-value seconds for
   the same two purposes.
3. **No new formats needed for the other two open items** — Diamond pit (dead, N=1) and elite
   top-decile spread just need MORE PAGES of Diamond Quick and Gold Quick, the ladder tiers we
   already capture.

## 2026-07-20 REVISION — cap-composition ruling reshuffle

Derek ruling: quick/daily/weekly have NO functional difference; the live anomaly hypothesis is
CAP-MODE POOL COMPOSITION (salary caps force bad/cheap cards into play → wider realized pool).
Consequence: Nightmare Cap + Cwhit Cap are era×cap CONFOUNDED — still wanted, but they can't
identify the era effect alone. Config re-scan (budget_mode lens) adds:

| Priority | Format | Config | Why |
|---|---|---|---|
| P1 NEW | Bronze Cap | `bronze-cap` — era-1955, cap 1275, ≤69 | Same era as Nightmare Cap (1559) ⇒ within-era cap-TIGHTNESS contrast, era held constant. |
| P1 UPGRADED (was P3) | Late Silver | `late-silver` — era-1929, uncapped, ≤79 | Clean extreme-era point (k=0.288), no budget confound ⇒ identifies s(era_k) with EG/BH. |
| P2 NEW | Silver Slots / Gold Slots | `silver-slots`, `gold-slots` — era-2010 | Slots force weak cards too; matched vs captured quicks (same era+window) ⇒ tests budget-general vs cap-specific. |
| P2/P3 NEW | Low Gold Retrospective (1962), Golden Heart (1977), Golden Childhood (1984), Gold Rush (1989) | all uncapped | Confound-free mid-era points tracing the s(era_k) curve. Any 2–3 with depth. |

Matched pairs now available: bronze-cap-weekly vs bronze-quick (era-2010, ≤69, cap on/off);
gold-cap vs gold-quick (era-2010, ≤89, captured); nightmare-cap vs bronze-cap (era-1955,
tightness); silver/gold-slots vs silver/gold-quick (slots on/off).
Wonky Slots + Silver Deadball Slots DEMOTED to last (double-confounded: extreme era AND slots).
Minimum identifying set if depth is scarce: Bronze Cap, Nightmare Cap, Late Silver,
Bronze Cap Weekly, one 2010 slots format.
