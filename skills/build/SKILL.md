---
name: build
description: Build an approved ticket — in an isolated worktree with its own ports, env files, dependencies and database, from a seven-part brief, one builder, the problem shown failing before it is fixed. Use when starting work on a ticket, feature, fix or refactor that already has the owner's yes, when setting up a worktree for a task, or when running several tickets of one spec.
---

# build

The ticket says what to build. This skill says how to build it so nobody has to take the agent's
word for anything: isolated, briefed, small, and red before green.

## 1. Isolate first

Before writing a line of code:

1. **Check for existing isolation.** Already in a linked worktree on a task branch made for this
   ticket? Use it. On the default branch, or in someone else's checkout? Do not build there.
2. **Scope-check open pull requests.** List them and the files each one changes
   (`gh pr list`, `gh pr diff <n> --name-only`). Also look for uncommitted work in shared
   checkouts. If another PR touches the files this ticket needs, stop and ask.
3. **Make the worktree** from the spec run's integration branch, or from the up-to-date default
   branch when there is none: `git worktree add -b <task-branch> <path> origin/<base>`. Then
   prove it: `istack env check-base origin/<base>` exits 1 when the worktree was made from
   another branch (some harnesses always branch from the default one). Sub-agents run it first.
4. **Give it its own environment:**

```sh
istack env up            # ports, env files, dependency check, database plan
istack env up --install  # also runs the lockfile's install command
istack env up --db       # also creates this worktree's own database
```

`env up` leases ports for this worktree from the range in `istack.yaml` (two worktrees never
get the same ones), copies listed env files from the main checkout with the port keys rewritten,
and names the install command. It never prints env values. The database hook only ever targets a
name derived from the worktree; it refuses the main checkout and any create step that wipes or
migrates.

Before trusting anything on a port, confirm it answers **this** worktree:

```sh
istack env check-port 4123
```

Exit 0 means the listener runs from this worktree. Exit 1 names the pid and directory of whoever
else holds it, or says nothing is listening. Never test against a server you did not start.

`istack env status` shows the lease and who is listening; `istack env down` frees the
ports when the worktree is finished (`--db` also runs the configured drop for its own database).

## 2. Write the brief

Before building, write the brief in seven parts, short enough to read in a minute:

1. **Impact** — who notices when this lands, and how.
2. **No-compromise priority** — the one thing that must be right even if everything else slips.
3. **Pushback zone** — where the builder is expected to argue with the ticket instead of obeying it.
4. **Unknowns** — what nobody knows yet, and how the build will find out.
5. **The ask** — the change, in a sentence or two.
6. **Early exit** — the point where the builder stops and reports instead of pushing on.
7. **End state** — what is true, and what receipts exist, when the work is done.

Every brief has a clear place where it stops. A brief for a sub-agent is the only context that
agent has: give it the files, the owned paths and the stop point.

## 3. One builder, smallest change

- **One builder** writes the change. Sub-agents are for breadth (searching wide, reading many
  files) or for adversarial review. Each sub-agent is told which files it owns; no two write the
  same file.
- **Builder and reviewer come from different AI providers** where one is available. Otherwise use
  a fresh-context reviewer and say that it shares the builder's provider.
- **Smallest change that works.** No drive-by refactors, no speculative options. Review feedback
  that would grow the scope becomes a follow-up ticket.

## 4. Red, then green

1. **Reproduce first.** Make the problem happen and keep the record: a failing test, a failing
   command with its exit code, or a before picture. That is the red receipt (see the `prove`
   skill). It cannot be captured after the fix.
2. **Fix**, then run **the same check** again. It must pass. That is green.
3. **One focused test** when nothing covers the behavior. Not a pile of smoke tests that assert
   the code runs; a test that fails for the bug and passes for the fix.
4. Run the repo's checks from `istack.yaml`. A green suite on stubs proves the stubs; prove
   the real thing too.
5. Two failed fixes on the same point mean the diagnosis is wrong. Re-diagnose; do not guess a
   third time.

## 5. When to stop

Stop and ask only when:

- the change cannot be proven;
- the next step touches production, deletes data, or acts outside the repo;
- the goal is ambiguous in a way that changes the result;
- the next step uses a resource listed under `ownershipGates` (a shared database, a port someone
  owns, a device, a deploy).

Everything else, decide. Do every independent step first, then ask once, with a recommended
answer. List each decision you made in the report so the owner can overrule it.

## 6. Spec runs

A spec with several tickets ships as one run:

- **One integration branch** for the spec. Each ticket gets its own worktree branched from it.
- **At most two implementers at once**, on disjoint files, declared up front.
- Finished tickets merge into the integration branch with **merge commits**, so each ticket stays
  visible in history. Delete a ticket's worktree once it is merged in.
- **Attack each ticket before it merges in.** A short review from another provider whose only job
  is to break it: hostile input, symlinks and paths outside the repo, a PR that edits its own
  check, state left behind after a failure. Its findings get the same red→green fix. The end
  review still runs; it should not be the first to try.
- **One pull request** for the whole spec, from the integration branch. Never one PR per ticket.

## 7. Shape of the code

Guidance, not ceremony: **actions** decide why and when something happens (the command, the
handler, the job); **services** own how (reusable mechanics with explicit inputs and structured
results, no printing, no global state). When two flows repeat the same operational steps, the
steps belong in a service.

## Done means

- built in its own worktree with its own environment, the port checked as this worktree's;
- a brief with a stop point;
- red recorded before the fix, green on the same check after, the repo's checks passing;
- decisions listed; nothing outside the ticket's scope.
