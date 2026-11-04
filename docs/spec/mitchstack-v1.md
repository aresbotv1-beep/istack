# mitchstack v1 — spec

Status: **draft for Isaac's approval.** Approving this spec releases nothing to build; it releases
`to-tickets`, whose ticket graph then needs its own yes (gate 1).
Decisions: [../groundbreak/2026-11-04-ledger.md](../groundbreak/2026-11-04-ledger.md) ·
Research: [../research/2026-11-04-agent-kit-landscape.md](../research/2026-11-04-agent-kit-landscape.md)

## The ask

Build mitchstack: one public, MIT, own-words agent workflow that takes the best mechanisms from
Pocock, Theo, poteto, gstack and rstack and adds the thing none of them have — PRs that carry
checked receipts, with a CI check that blocks a PR without them. It installs in one line on Claude
Code, Codex and Cursor, and it is built with itself so its own PR history is the proof. You'll know
it's wrong if your next real feature, run through mitchstack, produces a PR you'd still have to
re-test from scratch before trusting.

## North star

Agents don't get to say "done"; they show receipts. A stranger's first mitchstack PR looks
different from anything else on GitHub.

**Budget:** 7 skills · 1 contract (`AGENTS.md`) · 1 CI check · 1 install line · 1 demo.

## The spine

```
groundbreak ─▶ plan ─▶ [GATE 1: Isaac's yes on the ticket/graph]
   (express lane = grill)
build (isolate + env + brief + repro-first) ─▶ prove (receipts) ─▶ ship (review ▸ council ▸ PR ▸ watch)
   ─▶ [GATE 2: human merges] ─▶ retro (human-picked → tickets)
climb: separate mode, also used to improve mitchstack's own skills
```

## The seven skills

### 1. `groundbreak` — the front door (v2)
- **Two lanes.** Open questions get the full engine; settled work gets the **express lane**, which
  is the rebuilt grill.
- **8 phases:** anchor → hunt → zero-to-one → board audit → wall & pin → break it → ledger &
  assembled re-screen → hand-off to `plan`.
- **Hunt:** an orchestrator splits the question into channels in order — the subject's own domain
  first (including clean-room `rea` teardowns of competitors' public UI/UX/marketing), primary
  docs/repos, practitioner complaints, far-field mechanisms last. Researchers run on several
  providers in parallel; a synthesizer marks a claim **verified** only when two independent
  sources/models agree, flags single-source claims, and turns contradictions into fights. Output is
  always `docs/research/<date>-<topic>.md` with sources and "not found". Budgeted (agent count, two
  heavy at once, time box).
- **Zero-to-one:** write the launch post first (working backwards); declare the budget.
- **Board:** standing seats Musk (5-step algorithm; every requirement has an owner), Thiel (secret,
  10x, monopoly), Feynman (you must not fool yourself). 2–3 more seated per subject from the bench
  (Munger, Bezos, Jobs, Carmack, Karpathy, Ohno, Kelly Johnson, Rams, Graham, Taleb). They apply
  tests, never personas; Isaac decides.
- **Wall:** real steals only (industry → mechanism → mapping), domain-native first. Landscape items
  must claim 10x on a named axis or drop to Rethink. Fights resolve by **separation** (time, place,
  condition), never by compromise.
- **Deletion:** Musk's rule for requirements and steps; ideas honest-only, no kill quota.
- **Express lane (grill):** lens-derived questions; every question must pass the bar — not
  answerable from code (checked first), splits the plan, concrete scenario, carries a
  recommendation. Ranked batch of ≤5 per round, cut count shown, asked via the question tool; from
  round two, react to a draft ticket; last question is always "how will you know I'm wrong?"

### 2. `plan` — spec, tickets, autoplan
Own-words rewrite of Pocock `to-spec` (agree test seams first) + `to-tickets` (tracer-bullet
vertical slices, blocking edges, one context window each) + gstack `autoplan` decision classes
(mechanical decided silently, taste decided and surfaced, challenges never auto-decided). Ticket
template opens with **the ask**. Ends at gate 1.

### 3. `build` — isolate + Theo's build
- **Isolate:** check for existing isolation, scope-check open PRs, worktree from `origin/main`.
  **`mitchstack env`** gives the worktree its own ports, env files, dependencies and DB branch or
  schema, and verifies the port answers *this* worktree's process.
- **Brief** (7 parts): impact, no-compromise priority, pushback zone, unknowns, the ask, early exit,
  end state.
- **One builder, smallest change.** Sub-agents only for breadth or adversarial review, file
  ownership declared. Builder and reviewer on different providers where available.
- **RED = reproduction receipt** (failing test, failing command, or before screenshot), then GREEN
  on the same check. One focused test when no test covers the behavior; no smoke-test slop.
- **Stop rules:** can't prove it; next step touches production/data/outside the repo; ambiguity
  that changes the result. Everything else is decided and listed in the report. Spec runs: one
  integration branch, ≤2 parallel implementers on disjoint files, one PR.
- Service-layer shape (actions own why/when, services own how) as guidance, not ceremony.

### 4. `prove` — receipts
- Headless Playwright before/after pairs (fixed viewport, animations off, frozen clock, masked
  dynamic regions). `before: absent` allowed for new screens. `@vercel/before-and-after` optional,
  pinned, never vendored.
- **Try it yourself** block: exact URL/command/clicks to test in 30 seconds.
- Defects count only with a rerunnable repro (pstack `interrogate`); name the one fact the change is
  safe because of (`blast-radius`).
- Receipts live as a fenced JSON block in the PR body (claims → evidence → head SHA), never a
  committed file.

### 5. `ship` — review, council, PR, watch
1. **Review loop** (sol-loop rules): one cross-provider reviewer; 3 rounds, 5 for
   security/auth/data/concurrency; stop on a nits-only round; finding ids; blocker/should/nit;
   `VERDICT: APPROVE/CHANGES`; timeout or budget exhaustion ≠ approval. Disputed after two replies
   → listed under **Open disputes** for gate 2, not a mid-run stop. `solo`: same-provider
   fresh-context reviewer, labelled. Without T3: `codex exec` / `claude -p` / `cursor-agent`.
2. **Council** (`factory` profile; visible changes or one-way doors): 3 providers score before/after
   out of 10, target hidden, cheapest judge first, randomized order, median of 3. A **control
   screenshot** with a tolerance band learned from baseline scorings; a round whose control leaves
   the band is discarded. Rescored only when visible files changed. Per-PR budget cap → "no
   council" when exhausted. Scores are measurements; a council remark blocks only once turned into
   a repro.
3. **Ask for the PR yes with the packet in hand**, then open it. Body: Summary (smallest picture) →
   Evidence → Merge danger (door + blast radius) → Try it yourself → reviewer verdicts + score table
   (unhappy ones included, "no score" never invented) → Open disputes → risks. Media via
   `gh --attach`; Actions artifacts as fallback (forks).
4. **Watch:** one watcher per PR; every actionable finding fixed or answered in writing after every
   push; comments carry an author header. **Full-stop ending:** auto-merge off (already-off is fine),
   not in a merge queue, rechecked before every push; verdict ready / waiting / blocked; present the
   URL.

### 6. `retro` — human-picked, becomes tickets
Offered in one line; run only on request. Categories: navigation, automated checks, standards,
steering-file bloat, tool economy, information access. Sorted Accepted / Rejected / Backlog;
anything a lint could catch becomes a check. Picks become `gh issue create` tickets. Recorded in
`docs/factory/retros/`.

### 7. `climb` — hill climbing
Theo's ladder first: list candidate moves with expected gain and cost, lowest-hanging first. Then
poteto's discipline: target + minimum attempts, frozen and proven-sensitive harness, median of N,
one change per iteration, keep only if it beats noise with regressions green, full revert
otherwise, `decision.tsv`, one commit per kept win, never relax the target. UI climbs use the
council with hidden target and control. **mitchstack climbs itself:** skill edits must not lower
the eval score.

## The CI check — `mitchstack/receipts`
- Reads the receipts block from the PR body with the read-only token; needs no secrets or LLM calls;
  triggers on `pull_request`, never `pull_request_target`; no `paths:` filter (decides in-job).
- **Present tier (default):** visible-change patterns from `mitchstack.yaml` changed → requires a
  before/after pair with differing hashes tied to the head SHA, a merge-danger door, and a red→green
  record; labels the PR "receipts: present, not verified". Escape: `no-visible-change: <reason>`,
  counted by retro.
- **Verified tier (opt-in):** CI re-runs the evidence — the claimed test fails at base + new test
  and passes at head; the repo's Playwright script re-captures at base and head.

## Packaging
- `AGENTS.md`: the contract (two gates, stop rules, laws), one canonical copy; generated into Codex
  and Cursor locations.
- `mitchstack.yaml`: owner, profile (`solo` / `team` / `factory`), checks table, visible-change
  patterns, ownership gates (generalized LOCAL-WORLD), council budget.
- Install: `npx skills add aresbotv1-beep/mitchstack` + Claude plugin manifest. Hooks shipped in the
  repo (Claude) with a git pre-push equivalent elsewhere.
- `LICENSE` (MIT), `CREDITS.md` naming each mechanism's source.
- Demo: a one-minute recording of a real PR built and shipped by mitchstack, receipts visible.

## Test seams (agreed first, per `to-spec`)
1. **Receipts check** — highest seam: fixture repos + PR bodies at base/head → pass/fail/label.
   Includes the gaming cases (same image twice, stale SHA, missing door, path-only PR).
2. **Installer** — given host(s) → expected files in each harness location; idempotent; never
   touches another host's install.
3. **`mitchstack env`** — two worktrees → distinct ports and DBs; port-ownership check rejects a
   foreign process.
4. **Skills** — eval scenarios per skill, scored by council with control (this session is eval #1
   for `groundbreak`). Baseline committed before any skill edit.

## Out of scope (v1)
Agent merges or deploys; persona role-play; Obsidian integration; Greptile; the design-taste skills;
GitHub Enterprise Server; any Kestrel/BuilderWrx-specific rules; a hosted service.

## Order (plan)
1. Contract + `mitchstack.yaml` schema + LICENSE/CREDITS — everything else references them.
2. Receipts check (present tier) — the wedge; unblocks dogfooding.
3. `prove` + `ship` (review loop first, council second).
4. `build` + `mitchstack env`.
5. `groundbreak` v2 + `plan`.
6. `retro`, `climb`, then the skill eval harness.
7. Installer + plugin manifest; verified tier; demo.
Parallel-safe: 2 with 1's schema frozen; 4 alongside 3. Not doing yet: the open receipt-format
standard, proof-score badge, door labels.

## Open decisions
- Fold isolate into `build` (keeps budget at 7) vs a separate `isolate` skill (8).
- Branding: construction "as-built" framing vs pure software.
- How the local-proof hook treats docs-only repos (it blocked a docs append on 2026-11-04).

## Self-review — known flaws
- Skill quality is only as good as the evals; until the eval harness lands (step 6), "climbs
  itself" is a promise, not a receipt.
- Council needs 2–3 paid providers; most users will only ever see `solo`/`team`.
- The present tier can still be gamed by a determined agent; only the verified tier is honest
  proof, and it requires a repo with runnable tests and a Playwright script.
- "Visible-change patterns" will misfire both ways until tuned per repo.
- Theo's methods for build come partly from auto-captions and one secondary summary.
- Seven skills each fold several upstream mechanisms; individual skills may exceed a context-
  friendly size and need splitting into references.
