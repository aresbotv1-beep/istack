---
name: ship
description: Take a proven change to a pull request the owner can merge — a review loop with a reviewer from another AI provider, a look-back every run that fixes the run's own problems on its branch, the PR yes asked with the packet in hand, one PR body in a fixed shape, then one watcher that answers every finding and ends at a full stop. Use when a change is proven and ready for review, when opening, describing or watching a PR, or when asked whether a PR is ready.
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

### Look back before you ask

Every run, once the loop ends and before you ask for the PR yes. It is not optional and needs no
one's say-so: what went wrong in a run gets fixed before the merge, not filed after it. Read the
run's own record (the reviewer's findings, every failed check or command and why it failed, any
attempt you reverted, every `noVisibleChange` escape) and ask of each: would this hurt the owner
after the merge?

- **Inside this change**, meaning anything the ticket covers, including a doc or test the change
  made wrong, wherever it lives (a missed case, a claim with a weak receipt, a test that only
  passed on retry, a README that now describes the old behaviour): fix it on this branch before
  you ask, re-prove it, and update the receipts for the new head. A fix that changes code or
  docs starts a fresh review loop and a fresh ledger; keep the earlier rounds' verdicts in the body.
- **Outside it** (setup, tooling, anything the ticket did not ask for): one line under
  **Risks and follow-ups**, with the line of the record that shows it.

It opens no tickets and no second PR. The owner sees what is left at the PR yes, with the packet.
The setup [retro](../retro/SKILL.md) stays separate and runs only when asked.

## 3. Ask for the PR yes with the packet in hand

Opening a PR needs the owner's yes for **that** PR. Ask once, after the loop, with: the rendered
body, the reviewer verdicts (unhappy ones too), the open disputes, and the receipts. A yes to
the ticket or to an earlier PR is not a yes to this one.

## 4. Write the body

```sh
mitchstack ship body --from body.json > body.md
```

The body is a one-minute briefing for the owner, not a lab notebook. The shape is fixed by
[pr-body.md](pr-body.md): **Problem** (one or two plain sentences, no heading) → **Summary** (the
smallest picture: pseudocode, a call tree, a file tree, a diagram or a diff sketch) →
**Evidence** (before/after) → **Not tested** → **Merge danger** (door and blast radius) → **Try it
yourself** → **Review** → **Open disputes** (only when there are any) → **Risks and follow-ups** →
the one `receipts` block.

- **Problem** says what was wrong or missing, and for whom, before anything about the code.
  BAD: "Done when: the renderer emits slots in order; adds `problem` to `body.json`."
  GOOD: "Saving the settings twice added two rows, so every setting showed up twice."
- **Not tested** names what the proof does not cover. When the proof covers everything, write
  "Nothing left out." Never leave it to Risks.
- **Review** is one line per reviewer: its real verdict (bold when not approved), the rounds used
  and "no score" when no council scored it. The round-by-round log, the findings table and any
  council scores sit inside a folded `<details>` block below it; the receipts block is folded the
  same way. An unhappy verdict is never folded away.
- Keep the visible body (everything outside `<details>`) to about 2,500 characters. The command
  warns above that; move detail into the folded blocks or a linked file rather than the body.

The command refuses to render without the problem, the not-tested line, a door or try-it-yourself
steps, and refuses receipts that would fail the check. Never edit the verdicts by hand.

## 5. Open it

Check the client first; some `gh` releases have no `--attach` (2.93.0 does not):

```sh
if gh pr create --help | grep -q -- --attach; then
  gh pr create --title "..." --body-file body.md --attach before.png --attach after.png
else
  gh pr create --title "..." --body-file body.md   # pictures: Actions artifact, linked below
fi
```

`--attach` uploads pictures to GitHub so they render on private repos; it needs push access too.
Without it (a `gh` lacking the flag, forks, no push access, an older host), open the PR with the
second command, upload the pictures as an Actions artifact, and link the run in **Evidence**.
Never put a picture with secrets or customer data anywhere.

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
it off (`gh pr merge <n> --disable-auto`; take it out of the queue).

Once the watcher says `ready`, offer the retro in one line ([retro](../retro/SKILL.md)). If the
owner asks for it, its record is one more commit on this branch: push it, update the `receipts`
block for the new head, watch again, and come back here. Then present the URL.

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
- the look-back done, its in-change fixes made and the rest listed;
- the owner's yes for this PR, asked with the packet;
- a body the command rendered, pictures attached or linked;
- every finding fixed or answered, auto-merge off, not queued, the retro offered, and the URL presented.
