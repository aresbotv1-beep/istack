---
name: retro
description: Look back at a finished run and turn what slowed it down into tickets the owner picks — severity-ranked findings in six categories, sorted Accepted, Rejected or Backlog, with anything a lint could catch turned into an automated check. Offered in one line at the end of a run; run only when the owner asks. Use when asked for a retro, a post-mortem, lessons learned, or what to fix in the setup.
---

# retro

A retro looks at the environment, not the people: what made this run slower, riskier or
noisier than it had to be, and what would stop it happening next time. It changes nothing by
itself. Every fix becomes a ticket, and only the ones the owner picks.

## 1. Offer it, do not run it

When presenting the PR URL, offer the retro in **one line**, for example:
`Want a retro on this run? It lists setup fixes by severity; you pick which become tickets.`
Then stop. Run it only when the owner asks. Never start one on your own, never on a schedule.

## 2. Gather the record

Work from what happened, not from memory. Read:

- the run's transcript or log, the brief and the ticket;
- the PR: review rounds, findings and replies, watcher rounds, CI failures;
- the receipts, and every `no-visible-change:` escape used (count them: each one is a claim
  nobody checked);
- `decision.tsv` from any climb;
- git: commits, reverts, force-pushes, time from first commit to PR.

Leave out secrets, keys, tokens and customer data, even when the record contains them.

## 3. Find what cost the run

Look in six places. Each finding is something that happened in this run, with the line of the
record that shows it.

| Category | Look for |
|---|---|
| **Navigation** | time spent finding files, commands or owners; wrong file edited first |
| **Automated checks** | a mistake caught by a human or a reviewer that a script could have caught; a slow or flaky check |
| **Standards** | a convention the agent had to guess, or guessed wrong; two documents that disagree |
| **Steering-file bloat** | instructions that were ignored, repeated, contradictory, or too long to follow |
| **Tool economy** | tool calls repeated, wasted or too costly; a missing tool that forced a workaround |
| **Information access** | something the agent needed and could not read: a doc, a log, a credential it had to ask for |

## 4. Rank and shape each finding

Give each finding an id (`R1`, `R2`, …) and a severity:

- **high**: it produced a wrong result, or cost the run a large share of its time;
- **medium**: it cost real time or a review round, and will happen again;
- **low**: friction worth fixing when it is cheap.

List them most severe first. Each one says: what happened (with its evidence), the category,
the proposed fix, and its size.

**If a lint, test or script could catch it, the fix is a check, not a sentence.** A rule added
to a steering file is read sometimes; a check runs every time. Write the proposed check
concretely: what it scans, what makes it fail.

## 5. The owner sorts

Present the findings with your recommended sort, then let the owner decide each one:

- **Accepted**: becomes a ticket now;
- **Rejected**: recorded with the owner's reason, so it is not proposed again;
- **Backlog**: recorded, offered again at the next retro.

Do not file anything before the owner has sorted.

## 6. Picks become tickets

For each accepted finding, write a ticket that opens with **the ask** (what changes, what it
could break, how the owner will know it was wrong; see `AGENTS.md`). Show the exact commands
first:

```sh
gh issue create --title "Check: fail CI when a skill links to a missing file" \
  --body-file .artifacts/retro/R2.md --label retro
```

Run them only after the owner says yes to these commands. Report each issue URL. A ticket is
not a yes to build it: it still needs its own yes at gate 1.

## 7. Record it

Write the retro to `docs/factory/retros/<YYYY-MM-DD>.md` (add `-2` for a second one that day):

```markdown
# Retro <date> — <run or PR>
Record read: <PR URL, transcript, logs>
## Findings
| id | severity | category | what happened | fix | check? |
## Accepted        (id → issue URL)
## Rejected        (id → owner's reason)
## Backlog         (id)
```

The file goes on a branch like any other change; a PR for it needs the owner's yes for that PR.

## Never

- run a retro nobody asked for;
- edit a steering file, a check or a skill as part of the retro: that is what the tickets are for;
- file an issue the owner did not pick, or before showing the command;
- name or blame a person. Findings are about the setup.

The severity ranking and "mechanical findings become checks" come from Matt Pocock's `retro`;
the Accepted / Rejected / Backlog sort from Lauren Tan's `reflect` in pstack.
