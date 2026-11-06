# Repository quality checks

## The ask

Run this repository's build, tests, typecheck, and lint on every PR, with a stable default test
command and a real repo config. This can expose existing failures and increase CI time. It is
wrong if a deliberately failing check still produces a green quality job, or an unchanged
checkout cannot pass the documented default checks.

Approved by the owner on 2026-11-06 following the repository audit.

## Scope

- Serialize unit-test files to prevent the Git/process integration tests competing with every
  other file; retain every assertion and the existing per-test timeout.
- Add an unconditional PR-head quality workflow with read-only permissions, no persisted checkout
  credentials, pinned actions, and a stable `mitchstack/quality` check name.
- Add this repo's `mitchstack.yaml` with its actual owner and checks. No app services or database.
- Prepare workflow ownership and exact main-protection settings for the owner's approval.
- Leave receipt workflows, package publishing, runtime defects and skill behavior unchanged.

## Test seams

1. Missing config fails the CLI before the fix and validates afterward.
2. One workflow/config contract test verifies all checks execute against the PR head, without
   conditional skips, error suppression, path filters or write permissions.
3. The normal `npm test` command passes the full suite; assertions and timeouts are unchanged.
4. A failing assertion planted in a disposable copy makes the workflow's actual test command
   exit nonzero. Local execution and YAML checks do not establish a hosted Actions result.
5. Build, typecheck, lint and browser regression checks pass. Hosted CI is observed only after
   approval to open the PR; branch protections are not claimed active until read back from GitHub.

## Safety and rollout

Two-way door: reverting restores the previous test scheduling and workflow. The change affects
contributors' test duration and PR checks, not application behavior. Owner approval to open the
specific PR is requested with review results; protection settings are a separate owner decision.
