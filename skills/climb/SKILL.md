---
name: climb
description: Hill-climb toward a measured target — plan a ladder of candidate moves first, then try them one at a time against a frozen harness proven sensitive, keeping a change only when it beats the measured noise with regressions green and reverting everything else, logged in decision.tsv. Use when asked to make something faster, smaller, or score higher on an eval or a council, or to keep going until a number is reached.
---

# climb

A climb turns "make it better" into a number and keeps only the changes that move it. The rule
that matters most: **the climb never improves by noise.** A change that does not clearly beat
the harness's own wobble is taken back, completely, every time.

## 1. Ladder first

Before measuring anything, list the candidate moves. For each: what it changes, the **expected
gain** (in the harness's units) and the **cost** (any unit, the same for all). Order them lowest
hanging first: highest gain per cost, then the cheaper one.

```sh
mitchstack climb ladder --plan climb.json   # prints the moves in the order the climb will try them
```

A move is one change: one idea, small enough to revert. "Refactor and add a cache" is two moves.

## 2. Fix the target before the first run

Write down the **target** and the **minimum attempts** in the plan. Both are fixed for the
whole climb. **Never relax the target.** A climb that falls short reports `short` with the
number it reached; it does not lower the bar so it can say `reached`. If the moves run out under
the minimum attempts, the result is `too-few-attempts`: plan more moves before anyone calls the
target unreachable.

## 3. Freeze the harness and prove it sensitive

The harness is the command that prints the score (one number on its last line, higher is
better; for a lower-is-better metric, print its negative). List every file it reads under
`frozen`. A change that edits a frozen file is reverted, whatever its score: improving the ruler
is not improving the thing.

Then prove the harness can see a difference. The plan names a **planted bad change**
(`sensitivity`) known to make things worse. The climb measures it first. If it does not drop
the score by more than the noise, the climb **refuses to start** (`insensitive`): a harness that
cannot see worse cannot see better either.

## 4. The keep rule

Every measurement is **N runs** of the harness (`runs`, at least 3); its score is the median.

```
noise = max(noiseFloor, k × MAD(baseline runs), k × MAD(candidate runs))
keep  only if  median(candidate) − median(baseline) > noise
      and the regression checks are green
      and a fresh confirm measurement also beats the baseline by more than its noise
```

MAD is the median absolute deviation. The wider of the two spreads is used, so a change that
makes the harness jumpier must clear a higher bar. The confirm run catches a lucky draw; its
runs become the new baseline because they played no part in picking the winner. A run that
prints no number counts as an incomplete measurement: revert.

Everything that fails the rule is **fully reverted** (`git reset --hard` plus `git clean -fd`
back to the last kept commit). If the tree is not clean afterwards the climb stops as `broken`.

## 5. One change per iteration, one commit per win

Try the moves in ladder order, one at a time. Each kept change becomes **one commit**
(`climb: keep <id> (median a -> b)`), so every win can be reverted on its own later. The climb
stops when the median reaches the target.

## 6. Run it

Start from a clean tree on the task branch. The plan:

```json
{ "target": 9, "minAttempts": 3, "runs": 5, "noiseFloor": 0.25, "k": 2,
  "harness": "node bench.mjs", "frozen": ["bench.mjs", "fixtures/"],
  "regressions": ["npm test"],
  "sensitivity": { "id": "planted-bad", "apply": "git apply climb/bad.patch" },
  "moves": [ { "id": "cache-lookups", "apply": "git apply climb/01.patch",
               "expectedGain": 2, "cost": 1 } ] }
```

```sh
mitchstack climb run --plan climb.json --log .artifacts/climb/decision.tsv
```

Each `apply` is a shell command that makes one change. Keep patch files committed or outside the
repo: the revert cleans untracked files. Exit 0 means the target was reached; 1 means short,
refused or broken; 2 means it could not run.
The log must be outside the repo or git-ignored (it would dirty the tree otherwise).

## 7. decision.tsv

One row per decision, written as it is made:
`iteration · change · baseline_median · candidate_median · noise · decision · reason`.
Row 0 is the sensitivity check. `decision` is `keep`, `revert` or `refuse`. The file is the
climb's receipt: attach it to the PR as is. Never edit it by hand.

## 8. UI climbs: the council is the harness

For a visible change, the score comes from the council (see the `ship` skill's
[council rules](../ship/council.md)). The harness captures the after picture, then:

```sh
mitchstack climb council-score --after after.png --control control.png \
  --log .artifacts/climb/council.json [--budget 25]
```

It prints one number: the median, across judges, of each judge's median score for the after
picture. The **target stays hidden**: judges get the neutral rubric and hash-named files, never
the goal or the number hoped for. A **control** picture is scored on every call; a round whose
control drifts out of the band gives no score, which the climb treats as an incomplete
measurement. Keep one council log for the whole climb so bands are learned once.

## 9. Report

The final status, start and end medians, the target (unchanged), every kept commit, and the
`decision.tsv`. "We reached 7 of 9" is an honest result. A kept change that does nothing on a
re-run means the rule was broken somewhere: say so and stop.

Skill edits are climbs too: once skill evals exist, a skill change must not lower its eval score.

The ladder comes from Theo Browne's hill-climbing videos; the frozen, proven-sensitive harness,
keep-or-revert rule and decision log come from Lauren Tan's `hillclimb` playbook in pstack.
