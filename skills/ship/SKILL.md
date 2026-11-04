---
name: ship
description: Take a proven change to a pull request the owner can merge — a review loop with a reviewer from another AI provider, the PR yes asked with the packet in hand, one PR body in a fixed shape, then one watcher that answers every finding and ends at a full stop. Use when a change is proven and ready for review, when opening, describing or watching a PR, or when asked whether a PR is ready.
---

# ship

Shipping ends with a URL handed to the owner and nothing merged. The agent never merges, never
turns on auto-merge, and never calls a PR approved that a reviewer did not approve.

## 1. Pick the reviewer

The builder is never the only reviewer. Find one from a **different provider**:

```sh
mitchstack ship reviewer --builder anthropic [--delegate-task openai,anthropic]
```

Order: the harness's `delegate_task` tool when it reaches another provider (pass what the harness
reports), then `codex exec`, `claude -p`, `cursor-agent`. The command only looks at PATH; it runs
nothing. When the only provider is your own, it returns a fresh-context reviewer with the label
**same-provider reviewer (no second provider available)**. Keep that label everywhere the
verdict appears.

## 2. Run the review loop

Give the reviewer the diff, the receipts and this reply format (it is `REPLY_FORMAT` in
`src/review/parse.ts`; paste it as is):

```
VERDICT: CHANGES
S1 [blocker] what is wrong, where, and the command that shows it
S2 [should] a real bug that is not the intended case
S3 [nit] everything else
```

`VERDICT: APPROVE` or `VERDICT: CHANGES`, then one line per finding. Ids stay the same across
rounds. **blocker**: the intended case is wrong. **should**: a real bug. **nit**: the rest.

After each round answer every finding: **fixed**, **declined** with a reason, or **disputed**
with a reason. Then send the next round. The rules:

- **3 rounds**; **5** when the change is tagged security, auth, data, data-loss or concurrency.
- A round with only nits ends the loop. Without an explicit APPROVE it ends not approved.
- **A timeout is not approval.** Neither is an error, an unreadable reply, or running out of
  rounds. Each ends the loop **not approved**, with the reason written down.
- Approved means: an explicit `VERDICT: APPROVE` with no blocker or should left open and none
  left unanswered.
- A finding you dispute twice moves to **Open disputes** for the owner. It does not stop the run
  and it does not block approval; the owner decides it at the merge.

Record the rounds in a JSON file and let the ledger decide, not your memory:

```sh
mitchstack ship review --from review.json      # markdown; exit 0 only when approved
```

```json
{ "reviewer": "codex exec (openai)", "tags": ["auth"],
  "rounds": [
    { "reply": { "kind": "reply", "text": "VERDICT: CHANGES\nS1 [blocker] ..." },
      "outcomes": { "S1": { "kind": "fixed" } } },
    { "reply": { "kind": "timeout", "seconds": 600 } } ] }
```

## 3. Ask for the PR yes with the packet in hand

Opening a PR needs the owner's yes for **that** PR. Ask once, after the loop, with: the rendered
body, the reviewer verdicts (unhappy ones too), the open disputes, and the receipts. A yes to
the ticket or to an earlier PR is not a yes to this one.

## 4. Write the body

```sh
mitchstack ship body --from body.json > body.md
```

The shape is fixed by [pr-body.md](pr-body.md): **Summary** (the smallest picture: pseudocode, a
call tree, a file tree, a diagram or a diff sketch) → **Evidence** → **Merge danger** (door and
blast radius) → **Try it yourself** → **Reviewer verdicts** → **Open disputes** → **Risks and
follow-ups** → the one `receipts` block. The command refuses to render without a door or
try-it-yourself steps, and refuses receipts that would fail the check. Every reviewer is listed
with its real verdict; a reviewer with no score says "no score". Never edit the verdicts by hand.

## 5. Open it

```sh
gh pr create --title "..." --body-file body.md --attach before.png --attach after.png
```

`--attach` uploads pictures to GitHub so they render on private repos; it needs push access.
Where it cannot work (forks, no push access, an older host), upload the pictures as an Actions
artifact and link the run in **Evidence**. Never put a picture with secrets or customer data
anywhere.

## 6. Watch it

**One watcher per PR.** Before starting one, make sure no other is running for that PR.

```sh
mitchstack ship watch --repo owner/name --pr 123
```

It prints `ready`, `waiting` or `blocked`, with actions. Exit 0 ready, 3 waiting, 1 blocked,
2 could not read the PR.

- **blocked**: do the actions. Fix failing checks. Every thread, comment and review from a
  person or a bot gets a fix or a written answer — after **every** push, not just the first.
- **waiting**: checks are still running. Wait, then watch again.
- **ready**: checks green, every conversation answered, full stop holds.

Every comment you post starts with an author header naming the agent, because you may be
posting from the owner's account:

```md
> **agent: <agent name>** — posted on the owner's behalf
```

The watcher uses that header to tell your answers from the owner's own words.

## 7. Full stop

Before every push and at the end: **auto-merge off** (already off, or not allowed by the repo,
is fine) and the PR **not in a merge queue**. If either is on, the watcher says so and you turn
it off (`gh pr merge <n> --disable-auto`; take it out of the queue). Then present the URL.

**Never merge.** Not with `gh pr merge`, not through a queue, not by enabling auto-merge. The
run ends when the owner has the URL.

## Council (factory profile)

AI judges from several providers score the before/after pictures out of 10, with a control
picture in every call to catch judges drifting. Full rules: [council.md](council.md).

- **Runs only** with `profile: factory`, `council.enabled: true`, a visible change or a one-way
  door, and judges from at least 2 providers. After the first round, only when a visible file
  changed since the last round.
- **Run it** after the pictures are captured and before writing the body:
  `mitchstack ship council --before … --after … --control … --head … --changed … --log …`,
  then add `"councilLog"` to `body.json`.
- **Scores are measurements, never a merge gate.** A round whose control leaves its band is
  discarded and shows no numbers. An exhausted budget shows "no council (budget)". A missing
  score says "no score". Never type a score by hand.

## Done means

- a cross-provider reviewer, or the same-provider label;
- a ledger whose verdict you did not write by hand;
- the owner's yes for this PR, asked with the packet;
- a body the command rendered, pictures attached or linked;
- every finding fixed or answered, auto-merge off, not queued, and the URL presented.
