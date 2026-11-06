# Developing mitchstack

Use Node 22 and install with `npm ci --ignore-scripts --no-audit --no-fund`. Run the commands in
`mitchstack.yaml` in order: build, config validation, `npm test`, typecheck and lint. The build
comes first because config validation uses the compiled CLI.

The default unit suite runs files sequentially. Several integration files create Git repositories
and launch subprocesses; concurrent files caused a test to exceed its existing five-second limit.
No assertions, tests or timeouts were removed or relaxed. Budget additional wall-clock time.

Browser tests remain separate: `npx playwright install chromium`, then `npm run test:browser`.
They are regression coverage to run locally when appropriate; they are not part of the new required
quality job. They need a machine that can launch Chromium.

## What CI establishes

`mitchstack/quality` checks the exact PR head, with a read-only token and no persisted checkout
credentials. Every configured check must succeed. It does not test a synthetic merge with main,
run the browser suite or verify an agent's evidence claims. Requiring the branch to be up to date
before merging complements the head-only checkout.

The package scripts, test exclusions, compiler/linter settings and workflow contract test also
come from the PR head. CODEOWNERS covers these definitions, but the contract test is a regression
guard, not an independent security boundary against a PR that changes its own checks.

`mitchstack/receipts` remains the separately pinned present-tier checker. Its green result means
the receipt structure passed, not that every claimed command ran. `mitchstack/receipts-verified`
remains opt-in and is not proposed as a required check.

## Proposed main protection — owner action, not active configuration

After this PR's quality job succeeds on GitHub, the proposed branch protection for `main` is:

- Require `mitchstack/quality` and `mitchstack/receipts` from GitHub Actions.
- Require the branch to be up to date before merging (`strict: true`).
- Require a pull request, with zero required approving reviews for the current single-account
  workflow; retain the owner's merge decision. Dismiss stale approvals if reviews are used.
- Apply the checks to administrators; disallow force pushes and branch deletion.
- Keep auto-merge disabled. Do not require the optional verifier or a merge queue.

CODEOWNERS can request the owner's review for changes from other accounts. It makes no such
request when the owner is also the PR author, as in the current agent workflow, and remains
**advisory** under these settings. [GitHub does not let a PR author approve their own PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews), and agents currently
open PRs on the owner's account. Therefore, requiring code-owner approval from that same account
would block those PRs. To enforce a separate human approval, first use a distinct agent author
account (or add another trusted human reviewer), then require code-owner review and one approving
review. Until then, workflow ownership and human-versus-agent identity remain policy, not a
machine-enforced boundary. Do not report otherwise.

These settings require explicit owner approval and API readback after application. This change
adds the workflow and ownership file; it does not modify GitHub settings or claim protections are
enabled. The existing instruction to protect the receipt workflow is not fully satisfied until
the separate review identity is arranged and enforced.
