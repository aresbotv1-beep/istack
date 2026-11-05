# Hunt — research before opinions

The hunt finds what is true before anyone argues about what to build. Facts and sources come back;
decisions stay with the owner.

## 1. Declare the budget

Before dispatching anything, write one line and keep to it:

`Hunt budget: 4 researchers · at most two heavy at once · 25-minute time box.`

"Heavy" means a deep-research run or a browser session. When the time box ends, synthesize what
came back and list the rest under "Not found". Reuse a recent research doc that covers the subject
and hunt only its gaps.

## 2. Plan the channels, in this order

The orchestrator splits the question into channels and writes the plan down before dispatching.
Earlier channels matter more; never skip the first to get to the fun one.

1. **The subject's own domain.** How the best people in this field already solve it — construction
   best practice for a construction app, clinical practice for a clinic tool. Includes **clean-room
   teardowns** of competitors with `rea` (or by hand): their public UI, onboarding, pricing pages,
   help docs and marketing. Record what the product does and how it feels, never its code or
   copy. Public surfaces only: no login-walled or paywalled bypass, no copying text or assets.
2. **Primary docs and repos.** Official documentation, standards, source code, changelogs, read at
   the source with the date read.
3. **Practitioner complaints.** Where users say what hurts: forums, reviews, issue trackers,
   support threads. Count the repeats; one loud post is one data point.
4. **Far-field mechanisms**, last. Other industries that solved the same shape of problem. These
   feed steals on the wall, written as industry → mechanism → mapping.

## 3. Run researchers in parallel, across providers

- One researcher per channel. Spread them across providers (Claude, Codex, Cursor, others available
  in the harness) so one model's blind spot does not become the finding.
- Each brief names the channel, the question, the time box and the return shape: every claim with
  its source URL, the date read, a quote or observation, and the researcher's confidence.
- Only one provider available? Run it anyway, label the doc "single provider", and require two
  independent sources for every verified claim.

## 4. Synthesize honestly

A synthesizer (not one of the researchers) merges the returns:

- **verified** — two independent sources, or two models from different providers reading different
  sources, agree. Sources that cite each other count once.
- **A tool the build will use** (a CLI flag, an API, a library call) is verified only when it is
  also checked against the version installed here: run `<tool> --version` and the command itself
  (or its `--help`), and write the version in the finding. Docs describe the newest release, not
  the one on this machine.
- **single-source** — one source or one model. Kept, and flagged.
- **inferred** — the synthesizer's reasoning, not a source. Marked as such.
- **Contradictions become fights.** Two credible sources that disagree are not averaged; they go to
  the board as a fight to resolve by separation.

## 5. Save the doc

Always `docs/research/<date>-<topic>.md`, committed with the work:

```md
# <Topic> — <date>
Question · Budget (as declared, and as spent) · Providers used

## Channel plan
## Findings          (by channel; each tagged verified / single-source / inferred, with sources)
## Fights            (contradictions, sent to the board)
## Not found         (what was looked for and not found, and where)
## Sources
```

"Not found" is never empty by omission: write "nothing outstanding" if that is true. A placeholder
is marked as one. No invented quotes, numbers or URLs.
