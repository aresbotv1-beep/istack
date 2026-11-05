---
name: plan
description: Turn settled decisions into a spec and tracer-bullet tickets the owner can say yes to. Agrees test seams first, slices the work into vertical tickets with blocking edges, one context window each, sorts every open choice into mechanical, taste or challenge, and ends at gate 1 with the owner's yes. Use after groundbreak or a grill, when asked to write a spec, plan a feature, break work into tickets, or prepare a ticket for approval. Never builds.
---

# plan

Decisions in, a yes-able ticket (or ticket graph) out. Plan writes no product code; it ends at
gate 1.

**Inputs:** the ledger and launch post from groundbreak, the research doc, or the draft ticket
from the express lane. Read them; do not re-ask what they settle.

## 1. Size it

- **One ticket** (most express-lane work): skip the spec. Check the draft ticket against
  [ticket-template.md](ticket-template.md), fill the gaps, go to step 5.
- **Several tickets:** write the spec first, then the tickets.

## 2. The spec, in your own words

Save as `docs/spec/<topic>.md`. Keep it to what a builder needs:

- **The ask** — three plain sentences: what changes, what it could break, how you will know it is
  wrong.
- **North star and budget** — from the launch post; the budget is a number.
- **Decisions** — link the ledger; restate nothing it already says.
- **Test seams, agreed first.** Before any ticket, name the few highest places where behavior can
  be checked from outside (a CLI's output, an HTTP response, a rendered screen, a fixture repo).
  Prefer fewer, higher seams to many low ones. Put them to the owner and agree them before slicing:
  the seams decide what every ticket must prove.
- **Out of scope** and **open decisions**, each stated plainly.
- **Self-review:** your own list of the spec's known flaws.

## 3. Slice into tracer-bullet tickets

- Each ticket is a **vertical slice**: it cuts through every layer it needs to reach something
  observable at a seam. "Store the setting" is a layer; "the setting changes what `status --json`
  prints" is a slice.
- The first ticket is the thinnest slice that runs end to end. Later tickets thicken it.
- Draw **blocking edges** as a graph; anything without an edge can run in parallel.
- **One context window each:** a ticket a builder cannot finish and prove in one session is two
  tickets.
- Each ticket uses [ticket-template.md](ticket-template.md) and opens with the ask. Save the graph as
  `docs/spec/<topic>-tickets.md`, or in the tracker named by the repo.

## 4. Sort every open choice

Three classes. Say which class each choice is in.

- **Mechanical** — one right answer from the repo's conventions or a fact (a file location, a
  naming pattern, which test runner). Decided silently.
- **Taste** — reasonable people could pick differently, and either works (a flag name, a section
  order). Decided and surfaced: listed under "Decided for you" so the owner can overrule at gate 1.
- **Challenge** — it contradicts something the owner said or a LOCKED ledger item, grows the
  scope, adds cost, or is a one-way door. Never auto-decided: asked once, with a recommendation.

## 5. Spec-run shape

A spec with several tickets ships as one run:

- **One integration branch** for the spec; each ticket in its own worktree branched from it.
- **At most two implementers at once**, on disjoint files declared in each ticket.
- Tickets merge into the integration branch with merge commits; one draft pull request opened after
  the first merge, one integration review at the end, **one pull request**. Never one per ticket.

The `build` skill runs this; plan only declares it in the ticket graph's header.

## 6. Gate 1

Before asking, run the ticket's "Before asking for the yes" checklist. Then present, short:

1. the ask (each ticket's three sentences, or the graph's);
2. the graph and the run shape, if more than one ticket;
3. "Decided for you" (taste choices);
4. open challenges, each with a recommendation.

Ask for the yes through the harness's question tool, naming the file and commit it covers. Stop
there. The yes is single-use and covers only what it names; building starts in `build`.
