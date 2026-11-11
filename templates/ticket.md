# <Ticket id> — <short title>

## The ask

Three plain sentences the owner can judge without opening anything else. No file names, acronyms
or jargon in these three.

- **Change:** <what will be different, for whom>
- **Could break:** <the most likely way this goes wrong>
- **You'll know I'm wrong:** <the thing the owner will see if it did>

## Scope

- <what this ticket delivers, as observable behavior>

## Out of scope

- <what it deliberately does not do, and where that lives instead>

## Designated builder

<one agent or person; sub-agents only for breadth or adversarial review>

## Independent reviewers

<a reviewer from a different provider than the builder; or a fresh-context same-provider reviewer,
labelled as such; plus a visual reviewer where pictures decide>

## Files and reuse

- **Owns:** <paths this ticket may write; disjoint from any parallel ticket>
- **Reuses:** <existing code, schemas or skills it builds on>
- **Blocked by:** <ticket ids, or none>

## Acceptance

- **Observable:** <what someone can see or run at a test seam to know it works>
- **Machine checks:** <the repo's checks from istack.yaml, each must exit 0>

## Required evidence

- <red → green reproduction for each behavior; before/after pictures for anything visible; output
  pairs otherwise>

## Decided for you

- <taste choices made while planning, so the owner can overrule them; or "none">

## Before asking for the yes

- [ ] The ask is three plain sentences with no file names or acronyms.
- [ ] Every section above is filled or marked "none" with a reason.
- [ ] Facts checked against the current repo, at commit <sha>.
- [ ] No open pull request touches the files this ticket owns.
- [ ] Challenges are listed as questions, not decided.
- [ ] No product code written.
