# Council: scored pictures with a drift check

The council asks AI judges from several providers to score the before and after pictures of a
visible change out of 10. It measures; it does not decide. A score never blocks or allows a
merge. A council remark becomes a finding only once someone turns it into a repro.

The idea of a multi-provider council comes from Theo Browne's `council` in tstack. So does the
problem this version is built around: in his hill-climbing runs, judges scored an unchanged
screenshot higher round after round. A judge that drifts like that makes every later number a
lie. So every call here includes a **control picture**, and a round where a judge's control score
moves out of its normal range is thrown away.

## When it runs

All of these must hold, or the command prints `council skipped: <why>` and spends nothing:

- `profile: factory` and `council.enabled: true` in `mitchstack.yaml`;
- the PR changes a visible file (per `visibleChange`), or its door is one-way;
- judges from at least **2 distinct providers** are installed (`codex`, `claude`, `cursor-agent`,
  filtered by `council.providers`; 3 is the aim);
- for every round after the first: a visible file changed since the last round's head. Pictures
  are not rescored for code that cannot change them, and a discarded round is **not** rerun until
  a visible file changes, so nobody reruns until the control happens to pass.

## Run it

```sh
git diff --name-only origin/main...HEAD > changed.txt
# after the first round, also: the files changed since the last round's head
git diff --name-only <last-round-head> HEAD > since.txt

mitchstack ship council --before before.png --after after.png --control control.png \
  --head "$(git rev-parse HEAD)" --changed changed.txt [--changed-since-last since.txt] \
  [--door one-way] --log .artifacts/council.json [--prices openai=0.2,anthropic=0.25]
```

`--before` is left out for a brand-new screen. The **control** is a fixed screenshot that never
changes for the life of the PR — a stable page of the app captured once. Use the same file every
round.

The log (`--log`) is the council's memory: bands, every round, every sample, every cent. Keep it
for the whole PR and pass it to the body: `"councilLog": ".artifacts/council.json"` in
`body.json`. Never edit it by hand.

## How a round works

1. **Cheapest judge first.** Judges are called in order of price. If a cheap judge drifts, the
   round is over before the expensive ones are paid.
2. **Target hidden.** Each picture is copied to a temp folder under a name made from its content
   hash. The judge gets those files labelled Picture 1, 2, 3 and a neutral rubric ("how clear,
   polished and easy to use does it look"). It is never told which picture is new, what the
   change was meant to do, or what score is hoped for.
3. **Random order.** Every call shuffles the pictures with a seeded generator (seed from the head
   SHA and round number, or `--seed`), so the order is random but replayable.
4. **Median of 3.** Each judge is called 3 times per round; its score for each picture is the
   median of the 3. A judge with fewer than 3 readable replies gets **no score** for that round.
5. **Baseline and band.** The first time a judge is used on a PR it is called 5 extra times; its
   control scores from those calls set its band:
   `center = median`, `half-width = max(1, 2 × MAD)` (MAD = median absolute deviation). A judge
   that always says 5 gets a band of 4–6. The band is learned once and never widened.
6. **Drift check.** If any judge's control median for the round falls outside its band, the
   **whole round is discarded**: none of its numbers reach the PR body, the drifting judge is
   named, and the remaining judges are not called. The drifted score stays in the log for audit.
7. **Budget.** `council.budgetUsdPerPr` caps the PR's total spend. A round whose estimated cost
   does not fit never starts; a call that would cross the cap is never made. Either way the
   result is **no council (budget)** — never a partial table.

## Cost

Each call is priced from a table (defaults: openai $0.20, anthropic $0.25, cursor $0.20; any other
provider $0.25), override with `--prices`. These are conservative guesses. When a CLI reports
what a call really cost (`claude -p --output-format json` does), the log records it as
**measured** and the budget prices that judge at the higher of the two from then on. The PR body
says how much of the cost was measured and how much estimated.

A first round with 3 judges is (5 + 3) × 3 = 24 calls; later rounds are 9.

## What the PR body shows

Under **Reviewer verdicts**, a **Council scores** block from the latest round only:

- **kept**: a table of each judge's before, after and control medians and its band. A judge
  without a score says "no score" with the reason.
- **discarded**: "No council scores", which judge drifted, and no numbers from that round.
- **no council (budget)**: the reason, no numbers.

Older rounds are listed by status and cost, never by score: they scored older pictures. The
"Score" column of the reviewer table still says "no score" — reviewers are not judges.

## What it does not do

- It does not gate the merge. Read the scores as a measurement next to the pictures.
- It does not call the harness's `delegate_task`; a CLI cannot reach it. Only installed CLIs judge.
- The judge adapters are thin and have not been tested against the live provider CLIs; the
  runner's rules are tested with planted judges.
