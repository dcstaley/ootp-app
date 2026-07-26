# FORMAT FACTS — per-format instances that determine how work must be designed

Companion to SYSTEM_MAP.md. Check the row for EVERY format BEFORE designing a measurement
on it. "Stratum": A = neutral uncapped quick (core), B = env-bearing uncapped daily,
C = budget/restricted/decoupled. Windows: tiers are always nested, floor 40.

| capture key / config | era / park | window & mode | stratum | THE FACTS THAT BITE |
|---|---|---|---|---|
| iron quick (no config; QUICK ladder) | 2010 / park-1 | ≤59, none | A | Largest own-gap of the quicks; K need highest (~1.8). |
| bronze-quick | 2010 / park-1 | ≤69, none | A | Baseline pair for bronze-cap-weekly. |
| silver quick (no config) | 2010 / park-1 | ≤79, none | A | — |
| gold-quick | 2010 / park-1 | ≤89, none | A | HISTORY OF ANOMALIES: old G2 overrule, off-curve K need (resolved: weak-tail + selection artifacts, not a mechanism). Treat gold cells with care; check the record before claiming anything new about gold. |
| diamond quick (no config) | 2010 / park-1 | ≤99, none | A | Closest to frame (need ≈1). Historically thin cells; ~N=36 at the 600 bar. |
| earlygolddaily / early-gold | 1920 / park-169 (near-flat hr) | ≤89, none | B | era-K residual 1.53 (task-1 target). OPEN MYSTERY: hit BABIP ~1.50 residual, era_h≈1, unexplained. |
| bronzeheartdaily / bronze-heart | 1939 / park-191 | ≤69, none | B | era-K residual 1.64. Park hr_l 1.15 / hr_r 0.66 — biggest handedness split in the set. |
| late-bronze | 1979 / park-114 | ≤69, none | B | Mid-era point k=0.675. Residual #6: G2 ordering −0.120 (era layer; event-neutral). |
| diamond-heart | 1958 / park-156 | ≤99 + YEAR 1930–1980 cut, DH off | B | Era point k=0.702. The year cut is a COMPOSITION caveat on any era conclusion. |
| goldcapdaily / gold-cap | 2010 / park-156 (Fenway-55: hr split, gap 1.13) | ≤89, cap 1580 | C | CAP×PARK DEGENERATE for the HR channel (can never separate them here). K channel park-clean. |
| diamondcapdaily / diamond-cap-daily | 1998 / park-101 | ≤99, cap 1755 | C | — |
| bronze-cap-weekly | 2010 / park-1 | ≤69, cap 1331 | C | THE clean cap pair (vs bronze-quick: same era, park, window — budget isolated). |
| gold-slots | 2010 / park-1 | ≤89, slots | C | THE clean slots pair (vs gold-quick). Cap Value / Slots Value cols in its projections are CWHIT-DERIVED metrics — never inputs. |
| live-open-daily | 2010 / park-1 | open, none, LIVE CARDS ONLY (Card Type 1) | C (decoupled) | MAXIMALLY DECOUPLED POOL — elite overall, floor Avoid-K by modern-meta design. The gap coordinate PROVABLY BREAKS here (g≈44 vs measured need ≈1.0). NEVER a "clean"/neutral control for anything. Flat-hold clamp + published live residual live here. Live tiers (live-bronze etc.) share QUICK windows with DIFFERENT populations = the identification instrument for composition properties. |

Cross-format facts:
- Captures: full depth (min IP 10), coverage ended ~2026-07-19; aging; MEASUREMENT ok,
  FITS BLOCKED until the wide re-pull (Derek's action). Floors at read: BF≥600 / PA≥500.
- Variant eligibility: 8 disjoint classes CANNOT be variants (44% of catalog; Card Badge
  column matters); dev overrides exist (Tris Speaker, Campanella) → class default +
  override list; detector grows the list from sightings. Corpus conditional presence
  ≈ 33.7% (in tripwire band). Presence prior p=0.30 stamped on constants.
- Observed tables: top-by-usage sort; hitter SO% is K/AB on cwhit's side; ROW vs CARD
  grain must be stated on every observed-side stat; cluster inflation is
  statistic-specific — compute it, never assume it.
- The observed ranking disagrees with ITSELF across season halves (20/26, 11/14 at
  top-N): every top-N claim carries this reliability ceiling.
- No matchup-level data exists anywhere, ever — only per-card aggregates. Within a format,
  opposition is deterministic; identification of opponent effects needs cross-format
  contrasts (which are confounded) or the live-vs-quick window-matched pairs.

PROVENANCE CORRECTION (2026-07-26, Derek): there is NO SUCH THING as a Derek tournament
export. League Files/ = Derek's league exports (fitting truth). EVERYTHING tournament-side
— captures, observed tables, AND Tournament Data/'s realized-PA rosters — is cwhit-site
data: one provenance, one set of conventions/windows/limitations. Any fit on any of it is
governed by the no-fits-until-re-pull rule.

SUPERSEDING NOTE (2026-07-26, Derek): the provenance correction above is refined —
`Tournament Data/` DOES contain Derek's OLD MANUAL EXPORTS from the early program era.
They are DEPRECATED: never read those files again, for anything. All tournament data,
present and future, is cwhit-site captures (fixtures/cwhit*). Consequence: the realized-PA
roster dataset (487 rosters) lived in the deprecated folder ⇒ the usage-model calibration
is PARKED pending one recon question: does cwhit expose per-team rosters with playing
time? Yes ⇒ capture target, calibration revives; no ⇒ usage model stays as-is,
refutation noted as historical context.

FINAL RULE (2026-07-26, Derek — supersedes both notes above on this topic):
`Tournament Data/` (Derek's old manual exports) is NOT dead — it is RESTRICTED: use it
ONLY for usage-model work or for data genuinely unavailable from the cwhit site. For
everything else, cwhit fixtures are the sole tournament source.
PRIORITY RULE: the usage model and ANYTHING ELSE related to CAPS AND SLOTS (the deployment
layer, the cap/slots double-count fix, cap-tightness instruments, budget-pair fits) sits
BELOW the DEFENSE frontier in the roadmap. Order: current measurement work → era +
composition (non-budget parts: decoupling, gold, live, hitter tail) → DEFENSE → then
caps/slots/usage.
