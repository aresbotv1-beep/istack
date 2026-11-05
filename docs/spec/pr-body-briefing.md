# PB1 — The PR body becomes a one-minute briefing

## The ask

- **Change:** Pull requests from a run open with the problem in plain words and fit on about one
  screen; the full review history and the machine-read proof stay in the pull request, folded away
  until someone opens them.
- **Could break:** The automatic proof check could stop finding the proof once it is folded away,
  or an unhappy review result could end up hidden where the owner does not see it before merging.
- **You'll know I'm wrong:** A pull request's proof check goes red, a "not approved" review is not
  visible without clicking, or a new pull request is still several screens long.

## Why

Compared on 2026-11-05 against 40 PRs by Theo Browne, 100 by Matt Pocock, 14 by Michael Shimeles
and 15 by Lauren Tan (poteto). Their bodies run about 2,000–3,000 characters and open with the
problem; ours ran 9,275 (#2) and 12,752 (#1) and opened with "Done when / Will not invent / Goes
red / Write owner". We keep what they lack (CI-checked receipts, a different-provider reviewer,
owner-only merge) and take what they do better: problem first (Theo's `file-pr`), a "Not tested"
line (Pocock, Shimeles), detail out of the visible body (poteto's ~40-line cap).

## Scope

The body `mitchstack ship body` renders becomes, in order:

1. **Problem** — 1–2 plain sentences: what was wrong or missing, for whom. New required input; the
   renderer refuses without it.
2. **Summary** — the smallest picture (unchanged).
3. **Evidence** — before/after (unchanged input).
4. **Not tested** — what the proof does not cover. New required input; "Nothing left out" is
   allowed but must be said.
5. **Merge danger** — door and blast radius (unchanged).
6. **Try it yourself** (unchanged).
7. **Review** — one line per reviewer: provider, verdict, rounds used. A verdict other than
   approved is shown in bold. The round-by-round ledger and any council scores follow inside a
   `<details>` block.
8. **Open disputes** — shown only when there are any (contract still lists every one).
9. **Risks and follow-ups** (unchanged).
10. The single `receipts` block, inside `<details><summary>Receipts</summary>`.

The renderer measures the visible body (everything outside `<details>`) and prints a warning to
stderr above 2,500 characters. It does not refuse.

The ship skill text (`skills/ship/SKILL.md` §4, `skills/ship/pr-body.md`) describes the new shape,
with one BAD/GOOD pair for the problem line.

## Out of scope

- The receipts check, its schema and the pinned action SHA: unchanged. (The checker's fence regex
  already matches a block inside `<details>`; a test pins that, nothing in the checker changes.)
- Review rules, rounds, severities, the watcher: unchanged.
- Isaac's `~/.claude/CLAUDE.md` ship-beat notes and the `aresbotv1-beep/workflow` repo: outside
  this repo; a one-line follow-up if wanted.
- Rewriting PRs #1 and #2.

## Designated builder

Claude Code (claude-opus-5-5), one builder.

## Independent reviewers

Codex (gpt-6.1-sol, openai) via `delegate_task`, budget 3 rounds.

## Files and reuse

- **Owns:** `templates/pr-body.md`, `skills/ship/pr-body.md`, `src/ship/body.ts`,
  `src/ship/cli.ts` (warning line only), `src/review/markdown.ts`, `skills/ship/SKILL.md`,
  `test/ship-body.test.ts`, `test/ship-skill.test.ts`, `test/receipts-*.test.ts` (one added case),
  `evals/ship/*` and `evals/baselines/ship.json`, `docs/spec/mitchstack-v1.md` (body shape lines).
- **Reuses:** `renderReviewerVerdicts`, `renderOpenDisputes`, `renderCouncilScores`,
  `writeReceipts`, `extractReceipts`.
- **Blocked by:** none. No open pull requests in the repo (checked 2026-11-05).

## Test seams (agreed first)

1. `mitchstack ship body --from <fixture>.json` output: section order, folded ledger and receipts,
   bold unhappy verdict, refusals for a missing problem or not-tested line, the length warning.
2. `extractReceipts` on that rendered output: finds exactly one valid block.
3. The ship skill eval: an agent following the skill writes a problem-first body.

## Acceptance

- **Observable:** rendering PR #2's real content (as a fixture) gives a visible body under 2,500
  characters that opens with the problem, shows "**not approved**" for the second reviewer without
  expanding anything, and passes `extractReceipts`.
- **Machine checks:** `npx vitest run` · `npx tsc --noEmit` · `npx biome check .` ·
  `git diff --check`, each exit 0.

## Required evidence

- Red → green: the new `ship-body` tests fail at base, pass at head.
- Output pair: PR #2's body before (9,275 chars) and the same content re-rendered after (visible
  character count), both in the PR.
- Ship eval baseline re-run (claude -p, 3 runs) with cost stated.

## Decided for you

- Visible-length target 2,500 characters, warning only, not a refusal.
- "Not tested" is required (it may say "Nothing left out").
- Open disputes heading appears only when there are disputes.
- Council scores fold into the same `<details>` as the review ledger.
- `body.json` gains `problem` and `notTested`; old inputs without them are refused, with an error
  saying what to add.

## Before asking for the yes

- [x] The ask is three plain sentences with no file names or acronyms.
- [x] Every section above is filled or marked "none" with a reason.
- [x] Facts checked against the current repo, at commit 2336407 (origin/main, PR #2 merged).
- [x] No open pull request touches the files this ticket owns.
- [x] Challenges are listed as questions, not decided (none found).
- [x] No product code written.
