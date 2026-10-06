# OBULU Prediction Model — `poisson-dixon-coles` v1.0.0

Informational only. The model produces **statistical estimates**, never
guarantees. Every prediction response carries the disclaimer:

> "Predictions are statistical estimates based on available data and are not guarantees of match results."

## 1. Overview

The pipeline (`src/model/poisson.js`, exported as `predictMatch`) has five
separated stages:

1. **ingest** — normalize inputs, tolerate missing fields (defaults to league averages)
2. **features** — per-team attack/defence strengths
3. **model** — Poisson score matrix + Dixon–Coles correction → P(home/draw/away)
4. **calibration** — optional blend with market-implied probabilities
5. **output** — percentages summing to exactly 100.0, outcome, confidence, factors

## 2. Features (stage 2)

For each team we aggregate recency-weighted goals scored/conceded over the
last 10 matches (most recent first):

- weight of the *i*-th most recent match: `w_i = 0.9^i` (exponential decay)
- **Home team's attack/defence** use home matches only; **away team's** use
  away matches only. If a venue split has fewer than 3 matches, we fall back
  to all matches (venue splits that thin are noise).

Strengths are relative to the league average scoring rate
`avgScored = (avgHomeGoals + avgAwayGoals) / 2`:

```
attack_H  = (weightedGF_H / weightedPlayed_H) / avgScored
defence_H = (weightedGA_H / weightedPlayed_H) / avgScored   (>1 = leaky defence)
```

### Shrinkage

Teams with fewer than 6 effective matches are shrunk toward the league
average (strength = 1.0):

```
strength = (n * observed + k * 1.0) / (n + k),   k = 4
```

This prevents a team with 2 lucky games from getting an absurd rating.

### Home advantage

Expected goals:

```
xG_home = attack_H * defence_A * avgHomeGoals * homeAdv_H
xG_away = attack_A * defence_H * avgAwayGoals * homeAdv_A
```

- When league averages come from real data (`credible: true`), the home
  advantage is already embedded in `avgHomeGoals` vs `avgAwayGoals`, so the
  extra multipliers are `1.0`.
- Otherwise (no league data) we apply defaults: `homeAdv_H = 1.18`,
  `homeAdv_A = 0.90` — **tunable**; 1.18/0.90 are rough cross-league priors,
  not sacred constants. Per-league fitted values would be better.

xG is clamped to `[0.05, 5]` for numerical safety.

## 3. Model (stage 3)

Goals are modelled as independent Poissons. For scorelines `i, j ∈ 0..10`:

```
P(i, j) = Poisson(i; xG_home) * Poisson(j; xG_away)
```

### Dixon–Coles correction (τ = 0.05)

Low scorelines are empirically under-predicted by independent Poissons, so we
apply the Dixon–Coles tau adjustment:

```
P(0,0) *= 1 - xG_home * xG_away * τ
P(0,1) *= 1 + xG_home * τ
P(1,0) *= 1 + xG_away * τ
P(1,1) *= 1 - τ
```

The matrix is then renormalized to sum to 1, and cells are summed into
P(home win) (`i > j`), P(draw) (`i = j`), P(away win) (`i < j`).

## 4. Calibration (stage 4)

If decimal odds are provided (The Odds API or sample odds — used **only** as
model input, never displayed):

```
implied_k = (1 / odd_k) / Σ_j (1 / odd_j)     # overround removed
blend_k   = w * model_k + (1 - w) * implied_k # w = MODEL_ODDS_WEIGHT (default 0.75)
```

then renormalized. `w` is configurable via the `MODEL_ODDS_WEIGHT` env var.

### Future calibration work

- **Platt scaling / isotonic regression**: fit a monotonic map from raw model
  probabilities to observed outcome frequencies on a held-out set of past
  predictions (the `predictions` table persists everything needed).
- **League-specific home advantage**: estimate `homeAdv` per league/season
  from results instead of the 1.18/0.90 fallback.
- **Team-specific draw bias**: Dixon–Coles' full model includes a team draw
  propensity; currently we use the global τ only.
- **Injury/suspension weighting**: injuries are surfaced in analysis but not
  yet fed into xG.
- **Expected-goals (xG) data**: if a provider supplies shot-based xG, replace
  raw goal rates — far less noisy over small samples.

## 5. Output (stage 5)

- Percentages are rounded to 1 decimal with **largest-remainder** so they sum
  to exactly 100.0.
- `predictedOutcome` = argmax (HOME / DRAW / AWAY) — never worded as a guarantee.
- **Confidence**: `score = round(100 * (1 - entropy / ln 3) * dataCompleteness)`.
  A peaked distribution scores high; a near-uniform one scores low, scaled by
  how much data backed the estimate. Labels: ≥75 Very high, ≥55 High,
  ≥35 Moderate, else Low.
- **dataCompleteness** ∈ [0,1]: `0.35*homeCoverage + 0.35*awayCoverage +
  0.15*leagueAvgsCredible + 0.15*h2hAvailable`, where coverage is
  `min(matches, 10)/10`.
- **factors**: 3–4 short plain-language sentences selected from observed
  signals (attack/defence vs league average, last-5 form, head-to-head,
  position gap, model/market agreement). No betting language.

## 6. How to retrain / improve

1. The model has **no learned weights** — it is a closed-form statistical
   pipeline, so "retraining" means re-tuning constants (`RECENCY_DECAY`,
   `SHRINKAGE_K`, `DIXON_COLES_TAU`, home-advantage defaults) at the top of
   `poisson.js`.
2. To fit them properly: collect finished matches + pre-match predictions
   from the `predictions` table, then grid-search each constant to minimize
   log-loss (or ranked probability score) on a held-out season.
3. Bump `MODEL_VERSION` whenever constants or methodology change, so
   historical predictions stay comparable.
4. Add unit tests in `test/model.test.js` for any new behaviour.
