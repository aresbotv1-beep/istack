---
name: prove
description: Produce the receipts for a change before calling it done — a reproduction that fails before the fix and passes after, headless before/after pictures for anything a person can see, try-it-yourself steps, and the one fenced receipts block for the PR body. Use when proving, verifying, demonstrating or showing evidence that a change works, when asked for before/after screenshots, or before saying a fix is finished.
---

# prove

A change is done when someone else can see the evidence and rerun it, not when the agent says so.

## 1. Red first

Before touching the fix, make the problem happen on purpose and keep the record. That is the
**red** receipt. Pick the cheapest one that shows the problem:

- a failing test (one focused test if nothing already covers the behavior);
- a failing command with its exit code;
- a **before** picture of the broken screen.

Record the command, the commit SHA and the non-zero exit code. Red cannot be captured after the
fix, so do it first.

After the fix, run **the same check** again. It must exit 0 at the new SHA. That is **green**.
Same command, same test, same screen. A different check proves something else.

Record both runs with `istack prove run -- <command>`. It prints `{ "command", "run" }`: the
claim's `command`, and `run` (`sha` = HEAD, `exitCode` = the command's own) to paste as the `red`
or `green` entry as is. It exits with the command's code. Never read an exit code from `echo $?` after a pipe: that is the last command's code
(`tail`'s), not the test's. It warns when the tree has uncommitted changes, because the run is
then not exactly that commit.

## 2. Pictures for anything visible

If a person could see the difference, it needs a before/after pair.

- Shoot the **real running app**, not a mock or a storybook stub, at the same URL, viewport and
  state before and after.
- **Headless only.** Never record the desktop. Use a short headless clip only when the change is
  about motion or timing; otherwise a still is the standard.
- **Brand-new screen:** there is no before. Say so with `before: "absent"` instead of inventing one.
- Shoot with the capture command so two shots of an unchanged page hash the same:

```sh
istack prove capture --url http://localhost:3000/settings --out before.png \
  --viewport 1280x800 --mask '[data-testid=avatar]' --mask .timestamp
```

It prints `<sha256>  <path>`. The capture pins the viewport and pixel ratio, stops CSS animations
and transitions, hides the caret, asks for reduced motion, freezes `Date.now()`, fixes locale and
timezone, and waits for network idle and web fonts. Use `--mask` for regions that change on every
load for reasons unrelated to the change (avatars, random ids, ads). If before and after hash the
same, the picture shows no change: find out why before claiming one. Upload each PNG where the
PR can render it and keep the URL next to its hash.

## 3. Never capture secrets

Before any picture, clip or log leaves the machine, look at it. No keys, tokens, passwords,
customer data, personal data or payment details. Use test accounts and seeded data. Mask or
crop; if it cannot be made clean, do not upload it and say so.

## 4. Try it yourself

Every PR gets a block a reviewer can finish in about 30 seconds:

```md
### Try it yourself
1. `npm run dev`
2. Open http://localhost:3000/settings at 375px wide.
3. Click **Save** twice.
4. Expect one row in the table, not two.
```

Exact URL, exact command, exact clicks, and what they should see. No "should work".

## 5. Name why it is safe

State the **one fact** the change is safe because of — for example "only the settings route
imports this component" or "the new column is nullable and nothing reads it yet" — and the
receipt that proves that fact. This feeds the merge-danger note: is the door one-way (hard to
undo: data, migrations, public contracts) or two-way (a revert undoes it), and what is the blast
radius if it is wrong.

## 6. Findings need a repro

A defect someone reports — including you — counts only with steps another person can rerun and
see fail. An opinion or a score is a measurement, not a defect. Turn it into a repro or leave it
as a remark.

## 7. Write the receipts block

Collect the claims into a JSON file:

```json
{
  "head": "<PR head commit SHA>",
  "door": { "kind": "two-way", "blastRadius": "the settings page only" },
  "claims": [
    { "id": "c1", "kind": "red-green", "statement": "saving twice no longer adds two rows",
      "command": "npm test -- save", "red": { "sha": "<sha>", "exitCode": 1 },
      "green": { "sha": "<sha>", "exitCode": 0 } },
    { "id": "c2", "kind": "visual", "statement": "save button visible on small screens",
      "surface": "http://localhost:3000/settings",
      "before": { "sha256": "<hash>", "url": "<uploaded url>" },
      "after": { "sha256": "<hash>", "url": "<uploaded url>" } }
  ]
}
```

Claim kinds: `red-green` (behavior), `visual` (pictures; `before` may be `"absent"`), `output`
(a command's output before and after, for changes with no screen). A change with nothing visible
says why in `noVisibleChange`.

```sh
istack prove receipts --from claims.json
```

It validates against the receipts schema and prints one fenced `receipts` block, or names the
field that is wrong. Paste the block into the PR body exactly once. Receipts live in the PR body,
never in a committed file. Rerun the command whenever the head SHA changes.

## Done means

- red recorded before the fix, green on the same check after;
- a before/after pair (or `before: "absent"`) for every visible change, headless, clean;
- try-it-yourself steps; the one safety fact; door and blast radius;
- one receipts block that the command accepted, for the current head.

If any of these cannot be produced, say which and why. Do not fill the gap with a guess.
