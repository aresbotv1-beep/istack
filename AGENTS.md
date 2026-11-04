# AGENTS.md — the mitchstack contract

Every agent working in a mitchstack repo — Claude Code, Codex, Cursor, or anything else — follows
this file. Repo-specific facts (the owner, the checks, the shared resources) live in
`mitchstack.yaml`. Where the two disagree, `mitchstack.yaml` names the facts and this file names
the rules.

**The one-line version:** agents don't get to say "done". They show receipts.

## The two gates

There are exactly two human decisions in a run. Nothing between them waits on a person.

1. **Gate 1 — the ticket.** The owner says yes to a ticket (or to a named graph of tickets). The yes
   releases one complete run: build → prove → ship. It is single-use and covers only that ticket.
   A ticket opens with **the ask**: three plain sentences the owner can judge without opening
   anything else — what changes, what it could break, and how they will know it was wrong.
2. **Gate 2 — the merge.** The run ends by presenting a pull request with its receipts. Only the
   owner merges. Agents never merge, deploy, release, migrate shared data, or turn auto-merge on.

Opening a pull request needs the owner's yes for that pull request. Ask with the review results in
hand, so the yes is informed.

## When an agent stops

Between the gates an agent stops only when:

- it cannot prove the change works;
- the next step touches production, deletes data, or acts outside the repo;
- the goal is ambiguous in a way that changes the result;
- another open pull request already touches the same files;
- a conflict cannot be resolved with confidence;
- the next step uses a shared resource listed under `ownershipGates` in `mitchstack.yaml`.

Everything else, the agent decides and lists in its report. When it stops, it does every
independent step first, then asks once, through the harness's question tool, with a recommended
answer.

## The run

1. **Groundbreak** (open questions) or its **express lane** (settled work): decide what to build.
2. **Plan:** spec with test seams agreed first, then tracer-bullet tickets. → **Gate 1.**
3. **Build:** an isolated worktree with its own ports and data; one builder; the smallest change
   that works; the problem shown failing before it is fixed.
4. **Prove:** receipts for every claim — before/after pictures for anything a person can see,
   red→green reproductions for behavior, output pairs otherwise — plus "try it yourself" steps.
5. **Ship:** a reviewer from a different AI provider, then the pull request, then a watcher until
   every finding is fixed or answered. → **Gate 2.**
6. **Retro** (only when the owner asks): findings the owner picks become tickets.

## Receipts

A claim without a receipt does not count.

- **Red → green.** Before fixing, show the problem happening: a failing test, a failing command, or
  a "before" picture. After fixing, the same check passes. One focused test when nothing covers the
  behavior; no pile of smoke tests.
- **Pictures for visible changes.** Headless before/after pairs from the real running app. Never a
  desktop screen recording. A short headless clip only when the change is about motion or timing.
- **Receipts live in the pull request body** as one fenced `receipts` JSON block (schema in
  `schema/receipts.schema.json`), checked by the `mitchstack/receipts` CI check.
- **The checker is never the PR's own code.** Pin
  `uses: <owner>/mitchstack/action/receipts@<full-sha>` and protect the workflow file (CODEOWNERS
  or a required workflow).
- A mock, a fixture or a green suite on stubs is not proof that the real thing works.
- Never capture secrets, keys, tokens, customer data or payment details.

## Review

- The builder is never the only reviewer. Use a reviewer from a different provider when one is
  available; otherwise a fresh-context reviewer from the same provider, labelled as such.
- Findings have ids and a severity: **blocker** (the intended case is wrong), **should** (a real
  bug), **nit** (everything else). A timeout is not approval. Running out of rounds is not approval.
- A defect counts only with a repro someone can rerun. Taste scores are measurements, not findings.
- Every reviewer's verdict goes in the pull request, including the unhappy ones. A missing score is
  written as "no score", never invented.
- Disagreements still open after two replies are listed under **Open disputes** for the owner at
  gate 2. They do not stop the run.

## Laws

- Never commit to the default branch. One worktree and one branch per task and per agent; never
  touch another agent's worktree, branch or uncommitted work.
- Never plain `--force`. Only `--force-with-lease`, only on your own branch.
- Regenerate lockfiles to resolve conflicts; never hand-merge them.
- Worktrees do not isolate ports, databases, devices or cloud accounts. Confirm a port answers your
  own process before trusting it.
- Never remove or weaken a test to make work look complete.
- Do not invent data, identifiers, review results or evidence. Real data or an honest empty state.
- Scope does not grow during a run. Review feedback that would grow the change becomes a follow-up.
- Two failed fixes on the same point mean a new diagnosis, not a third guess.
- Comments posted on the owner's behalf say which agent wrote them.
