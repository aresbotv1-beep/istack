# Agent-kit landscape teardown — 2026-11-04

Research for mitchstack. Four research agents read primary sources (GitHub repos, raw
`SKILL.md` files, LICENSE files, auto-captions of Theo's videos). **Verified** means read at the
source URL on 2026-11-04. **Inferred** is marked. Star counts are as shown on the repo pages that day.

## The kits

| Kit | Author | License | Stars | Thesis | Install |
|---|---|---|---|---|---|
| [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock | MIT | ~311.7k | Small composable skills; explicitly anti "process-heavy frameworks" | plugin (Claude/Codex/Copilot) or `npx skills add` |
| [obra/superpowers](https://github.com/obra/superpowers) | Jesse Vincent | — (not checked) | ~312k | "Evidence over claims" (tests/commands, not PR artifacts) | 15+ harnesses |
| [garrytan/gstack](https://github.com/garrytan/gstack) | Garry Tan | MIT | ~138.9k | "A process, not a collection of tools"; virtual team | `./setup --host …` (needs Bun) |
| [github/spec-kit](https://github.com/github/spec-kit) | GitHub | — | ~146.8k | specify → plan → tasks → implement | `uv` |
| [t3dotgg/tstack](https://github.com/t3dotgg/tstack) | Theo Browne | MIT | ~2.8k | Personal skills: council, sol-loop, full-send/full-stop | copy into skills dir |
| [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack) | Lauren Tan (poteto) | MIT | — | ~70 skills + 23 playbooks run by `poteto-mode` | `/plugin install pstack@cursor-plugins` |
| [michaelshimeles/rstack](https://github.com/michaelshimeles/rstack) | Michael Shimeles | **none** (README says so) | ~1.4k | Isolate → Build → Prove → Ship | `npx skills add michaelshimeles/rstack` |
| [EveryInc/compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) | Every | — | ~25.9k | Each unit of work makes the next easier | plugin |

"Potato / pstack" = **poteto** (Lauren Tan, Cursor, React core). Earlier guess that "P stack" meant
gstack was wrong; both exist.

## License consequences (verified)

- MIT (Pocock, gstack, tstack, pstack, unslop): adapting is fine; keep notice/credit.
- **rstack has no license** → all rights reserved by default. Do not copy its text.
- **`before-and-after`** (`@vercel/before-and-after`) is **PolyForm Shield 1.0.0** (© James
  Clements): non-compete clause. Call it via `npx`; never vendor it.
- Pocock's `pr` credits Dex Horthy / HumanLayer `show-me` (license not checked).
- **Decision (Isaac, 2026-11-04):** rewrite every mechanism in our own words, ship our own MIT,
  credit each source in `CREDITS.md`.

## Mechanisms worth adapting, by beat

**Grill / plan / ticket** — Pocock `grilling` (asks the whole decision frontier each round, each
with a recommendation; facts go to subagents, decisions to the human); `to-spec` (agree test seams
first); `to-tickets` (tracer-bullet vertical slices with blocking edges, one context window each);
gstack `/autoplan` (mechanical choices decided silently, taste choices decided and surfaced, a
"user challenge" never auto-decided; one final gate).

**Isolate** — rstack `new-feature`: check for existing isolation first, scope-check open PRs,
suffixed branch name, verify.

**Build (Theo)** — verified from captions:
- Talks it through first, no plan mode; then "full send" / "full stop" (5Bmp9cz1JN8 15:18).
- Prompt brief: impact, no-compromise priority, pushback zone, unknowns, the ask, early exit, end
  state (q1D90-uGvBg 7:08–10:16). "Every prompt should have a pretty clear place where it stops."
- One agent by default; sub-agents only for breadth or adversarial review, with file ownership
  declared (e1snsuY4lTI 8:04).
- Builder Opus 5.5, reviewer GPT-6.1 Sol "the Rottweiler"; the stable pattern is cross-provider.
- Proof = "evidence you observed yourself": reproduce the failure → same repro passes → CI checks
  → one focused test only if none exists → for UI, run the app and look. Can't prove it → ask.
- "Tests are good, endless smoke tests… much less good." No TDD.
- PR must state the reviewer verdict: "Opus almost wants to hide the fact that Sol wasn't happy."
- Pocock `tdd` / `implement-spec` (task graph, worktree per ticket, one integration branch, one
  review at the end). gstack `/qa`: regression test with a value card (protects / fails_when /
  why_new / no_claim); stop after 2 reverts or one unrelated-file edit; cap 50 fixes.

**Prove** — rstack: capture the before while reproducing. pstack `interrogate`: a finding survives
only with a command + output the orchestrator reruns. pstack `blast-radius`: name "the one fact
it's safe because of" and prove it on a 5-rung evidence ladder.

**Ship / review** — tstack `council`: 3 providers in parallel, X/10 per reviewer per round, score
table in the PR, "no score" never invented, no round cap. tstack `sol-loop`: 3 rounds (5 for
security/auth/data-loss/concurrency), stop on nits-only round, finding ids, blocker/should/nit,
`VERDICT: APPROVE/CHANGES`, timeout ≠ approval, disputed twice → human. `babysit-pr` / `pr-wait`
(one watcher per PR, flock lock, exit codes 0/1/2). `full-stop` (disable auto-merge, leave merge
queue, recheck before every push). `leaving-pr-comments` (attribution header, secret scan).
Pocock `pr` body shape. gstack `/codex` (review / challenge / consult modes).

**Retro** — Pocock `retro` (severity-ranked; mechanical violations → deterministic checks).
pstack `reflect` (Accepted / Rejected / Backlog; lintable → backlog as a check; human approves
edits). gstack `/retro` (git metrics).

**Hill climb** — Theo's video series (hill climbing): UI climb scored by a council on screenshots,
target hidden from judges, cheapest judge first, stop at ≥9/10; MCP eval of 85–88 cases from his
own misuse history → perfect score committed as baseline → tool descriptions shrunk 52% at
held score; the committed eval caught a regression to 63/85. "If you can find a way to turn
something into an eval you can hill climb it." **Judges drifted:** unchanged comparison
screenshots scored higher over rounds. Cost ~$250 (UI) / ~$400 (stream) — secondary source
(BigGo summary), unverified. pstack `hillclimb` playbook: target + minimum attempts, frozen
sensitive harness, median of N, `decision.tsv`, one change per iteration, keep only if it beats
noise with regressions green, never relax the target.

## Excluded — conflicts with "agent never merges"

tstack `full-send` merge step; gstack `/land-and-deploy`, `/captain` merge trains, `/ship` opening
PRs without a per-PR yes; Theo's "proof permission overrides ask-first" (would bypass ownership
gates).

## The gap (inference)

No kit makes proof **merge-blocking and machine-checked**: everyone says screenshots "when they
help". Cross-vendor review (tstack, gstack) and two-gate framing are taken. Open: receipts +
a CI enforcer, judge-drift control, retro → tickets, one-integration-branch spec runs.

## Distribution (inference)

Kits spread through the author's audience (Theo: 2.8k stars on 5 commits). An unknown author needs
receipts (public PRs carrying proof, measured numbers), one install line on every harness, a named
philosophy of ≤5 words, one sayable command, and a shareable artifact.

## GitHub mechanics for a receipts check (verified 2026-11-04)

- The GitHub CLI's `--attach` flag on PR/issue create, edit and comment uploads media to GitHub
  user-attachments; GA on all plans (changelog 2026-09-01). Caps: images 10 MB, video 10 MB free /
  100 MB paid. Needs push access; not on GHES yet.
  https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli
- Private-repo attachments are viewable only by people with repo access; no documented read API.
- Fork PRs: secrets are not passed; `GITHUB_TOKEN` is read-only.
- A required check whose workflow is skipped by a `paths:` filter stays **Pending** and blocks
  merge; a job skipped by an `if:` conditional reports Success.

Consequence: CI cannot see private screenshots, so a presence-only check is gameable. A `verified`
tier must re-run evidence in CI (test fails at base + new test, passes at head; Playwright
re-capture at base and head).

## Not found

A primary Theo announcement of tstack; the primary link for the hill-climbing video (X returned
HTTP 402); HumanLayer `show-me` license.
