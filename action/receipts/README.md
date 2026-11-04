# mitchstack receipts actions

Two GitHub Actions check the `receipts` block in a pull request body:

- `action/receipts`: the present tier (`mitchstack/receipts`). It reads the receipts and the PR's
  changed files. It needs no checkout.
- `action/receipts/verified`: the opt-in verified tier (`mitchstack/receipts-verified`). It re-runs
  each claim against the PR's checkout.

Usage examples are in the comments at the top of each `action.yml`.

## Trust: the checker must never come from the pull request

A check that runs the PR's own copy of the checker proves nothing. The PR can edit the checker
so that it always passes. The code that decides the verdict has to come from a revision the PR
cannot change:

1. **Pin the action to a full commit SHA**, such as
   `uses: <owner>/mitchstack/action/receipts@<full-40-char-sha>`. A branch or tag can move. Never
   point `uses: ./...` at a local action inside the PR's own checkout.
2. **Protect the workflow file.** A PR can edit the workflow that runs the check. Make the
   workflow file owned in `CODEOWNERS` and require code-owner review on the default branch. You
   can also enforce the check as a required workflow or ruleset that lives outside the PR's reach.
3. **Use `pull_request`, never `pull_request_target`.** Give the job `permissions: contents: read`
   (plus `pull-requests: read` for the present tier) and `persist-credentials: false` on every
   checkout.

For the verified tier, the PR's checkout is only the thing under test. Its setup and test commands
run there, and the verifier is built from the pinned action. Those commands still run in the same
job as the verifier, so a hostile PR can interfere while the job runs. This is why the tier is
opt-in, and why it should not be the only gate.

### This repository's own workflows

This repo dogfoods its own actions, so it cannot pin a remote SHA of itself.
`.github/workflows/receipts.yml` and `receipts-verified.yml` instead check out the PR's **base**
commit into `./trusted`, then build and run the checker from there. The PR head is only data. For
the verified tier, the head is checked out separately into `./pr` as the thing under test.

**Bootstrap:** the first PR that introduces the checker has none on its base commit. That job
fails with `could not run: checker not present on base`. It never falls back to the PR's copy.
`test/workflows.test.ts` checks both workflow files for this shape.
