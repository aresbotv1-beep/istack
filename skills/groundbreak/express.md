# Express lane — the grill

For settled work. The goal is a ticket the owner can say yes to, in as few questions as it takes.
Usually one or two rounds; sometimes the only question is the last one.

## 1. Look before asking

Read the code, the ticket, the open pull requests and the docs the change touches. Every fact you
find is a question you do not ask. Slow lookups go to a sub-agent; only the questions that depend
on them wait.

## 2. Draw questions from lenses

Pick the 3–5 lenses that fit this subject and write candidate questions under each. Typical lenses:

- **The person using it** — who hits this, at what moment, with what in their hands.
- **What already exists** — the conventions this must match, the thing it could duplicate.
- **Failure** — the bad input, the empty state, the half-finished run.
- **Reversibility** — what is hard to undo once shipped (a flag name, a file format, an output
  shape other tools parse).
- **Proof** — what the receipt will be, and what would make it lie.

Lenses are for finding questions. They are never shown to the owner as a list.

## The bar

Every candidate question must pass all four checks, or it is cut:

1. **Not answerable from the code.** You checked first. If a file, a test or a search answers it,
   it is a fact, not a question.
2. **Splits the plan.** Different answers produce different tickets, scope or tests. If every
   answer leads to the same build, cut it.
3. **Concrete scenario.** It is asked through a real moment ("a script pipes `status --json` into
   `jq` while a job is half-done: does it see the partial job?"), not in the abstract ("how should
   errors work?").
4. **Carries a recommendation.** Your pick in one sentence and the reason in one more, so the owner
   can agree in a word or argue with something specific.

## 3. Ask a ranked batch

- Rank survivors by how much the answer moves the plan. Ask **at most 5** per round, through the
  harness's question tool when there is one (otherwise numbered in one message).
- Show the **cut count** with the reason buckets, so the owner can see the bar working:
  `Asked 3 · cut 9 (5 answered from code, 3 don't split the plan, 1 abstract)`.
- A question whose answer depends on another question in the same round waits for the next round.
- Each question: a few words of title, the scenario, two options (three at most), the
  recommendation.

## 4. From round two, react to a draft ticket

After the first answers, write the draft ticket from [ticket-template.md](ticket-template.md) and show it. The owner
reacts to something real instead of answering a questionnaire. Remaining questions are asked
against the draft ("the draft says X; in this scenario that means Y — keep it?").

## 5. The last question

"How will you know I'm wrong?" is always the last question, in every grill, even when nothing else
survived the bar. The answer becomes the ticket's third sentence of the ask and its acceptance
check. If the owner's answer cannot be observed, propose one that can.

## Escalate or finish

- **Escalate** to the full engine if two answers in a row are "I don't know, what are the
  options?", or the owner asks for ideas. Say so in one line and start at phase 1.
- **Finish** when no question passes the bar and the last question is answered. Record rulings
  verbatim in the ticket, then hand to `plan` — for one ticket, plan only checks it and asks for the
  yes.
