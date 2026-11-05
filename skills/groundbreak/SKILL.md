---
name: groundbreak
description: Decide what to build before building it. Two lanes - an express lane (a short, ranked grill that ends in a draft ticket) for settled work like adding a flag or fixing a bug, and a full engine (research hunt, board audit, wall of ideas, break it, verbatim ledger) for open questions. Use on brainstorm, grill me, make this better, next level, audit this, how should we, what do you think of X, or before planning any feature. Hands off to plan; never builds.
---

# groundbreak

The front door. Questions are for decisions; facts get looked up. The owner decides; the agent
does the legwork and argues honestly. Nothing here writes product code.

## Pick the lane

Decide in one look, before asking anything. Say which lane and why in one line.

**Express lane** — the rebuilt grill, in [express.md](express.md). Take it when **all** hold:

1. The ask names a change, not a problem to explore ("add `--json` to `status`", not "how should
   status work?").
2. You could write the acceptance check now.
3. It is a two-way door: cheap to undo, no data migrated, no public contract broken.
4. Nobody asked for ideas, a makeover, an audit or "next level".

**Full engine** — the 8 phases below. Take it when **any** holds: the ask is a problem or an
ambition, the owner asks for ideas or says "groundbreak", it is a one-way door, or the subject
spans more than one product area.

**When unsure, start express.** The express lane escalates itself: if two answers in a row are "I
don't know, what are the options?", or the owner asks for ideas, switch to the full engine and say
so. Never drag settled work through the brainstorm.

## The 8 phases

Full engine only. One task per phase. Small loops: one-page outputs, depth where the owner points.

**1 · Anchor.** Name the exact current state: branch and commit, live build, doc version. Read
before asking. Name the subject's domain (construction, payments, dev tools...) — it decides where
steals come from.

**2 · Hunt.** Research before opinions. An orchestrator splits the question into channels, the
subject's own domain first, and runs researchers on several providers in parallel. Output is always
a research doc with sources and a "Not found" section. Budgeted. Details: [hunt.md](hunt.md).
Reuse a fresh research doc that covers the subject; hunt only its gaps.

**3 · Zero-to-one.** Before any decision, write the launch post first: the headline and the short
post a real user would share the day it ships, naming what is 10x better and for whom. Get the
owner's reaction; every later idea is judged against it. In the same breath declare the budget —
this screen holds N things, this release holds N items. A budget makes every addition cost
something.

**4 · Board audit.** Audit the current state with the board: three standing seats (Musk, Thiel,
Feynman) and 2–3 seated from the bench for this subject. Seats apply tests, never personas.
Output: ranked findings on one page, plus the fights where seats disagree. Details:
[board.md](board.md).

**5 · Wall & pin.** A conversation, not a quiz.

- **The wall:** every idea that survives a one-line pitch, no cap and no padding; the discard pile
  shown with a reason per cut. Each idea carries a rung: **Polish** (fix what is weak),
  **Rethink** (next level), **Landscape** (never seen before). A Landscape item must claim 10x on
  a named axis (time to first estimate, error rate, cost per job...) or it drops to Rethink. A
  removal is a valid idea.
- **Real steals only**, written as industry → mechanism → mapping ("aviation → challenge-response
  checklist → the pre-send estimate check"), from the subject's own domain first, far fields after.
  A name-drop without a mechanism is not a steal.
- **Pin** an idea the owner warms to: change one variable, render the options side by side in the
  subject's real system (its renderer, its templates), mark your pick.
- **Every pick names what it pushes out** of the budget; "nothing" needs a reason. The owner picks;
  no change is applied without their vote.
- Each round ends on one sharp question only the owner can answer.

**6 · Break it.** Attack the ideas, not the current state, before anything locks:

- **Fights** (from the hunt, the board, or two accepted ideas that contradict) resolve by
  **separation** — in time (onboarding vs day 30), in place (the office vs the job site), or on a
  condition (first job vs repeat customer) — never by compromise. If no separation exists, the
  owner picks a side.
- **Deletion:** every requirement and step gets Musk's rule — a named owner, or it goes; delete
  before simplifying, simplify before automating. Ideas are judged honestly with no kill quota: a
  pass that finds nothing to cut says so.
- **Shape-check** each Landscape item: first contact with a real user, what breaks at scale, what
  it depends on that does not exist. Mark it `SPEC-READY` or `NEEDS-SHAPING`.
- **Pre-mortem:** a year on, this shipped and it is embarrassing. Why?

**7 · Ledger & assembled re-screen.** Append each ruling to the ledger
(`docs/groundbreak/<date>-ledger.md`): the owner's words verbatim, marked LOCKED or OPEN, one line
of why. A reopen is explicit. At each round boundary, assemble everything LOCKED into one candidate
and re-run the board on the whole; incoherence and drift only show up assembled.

**8 · Hand-off to `plan`.** Done when every wall item is accepted, rejected or deferred, every
round's question is answered, and the assembled whole has been screened once. Hand `plan` the ledger,
the research doc and the launch post. Groundbreak never slides into building.

## Laws, every lane

- **Facts are yours, decisions are the owner's.** Never ask what reading the code or a search
  answers.
- **Plain words.** Describe the person, not the system. A question that does not fit on a screen
  is two questions.
- **Honest artifacts.** Real data or a marked placeholder; no invented research, quotes or numbers.
- **Review your own work first.** Every output carries your list of its weak points, so the owner
  never finds a flaw you could have.
- **Ask through the harness's question tool** when one exists, with a recommendation on every
  question.
