#!/bin/sh
# istack:post-checkout
# Written by `istack install --hooks`. Agents build in worktrees, never in the main checkout
# (AGENTS.md: one worktree and one branch per task); this stops a branch switch there going unseen.
# Allow one switch with ISTACK_ALLOW_MAIN_CHECKOUT=1; `istack uninstall --hooks` removes this file.

# $1 old HEAD, $3 = 1 for a branch checkout. A clone (old HEAD all zeros) and file checkouts pass.
[ "$3" = "1" ] || exit 0
case "$1" in *[!0]*) ;; *) exit 0 ;; esac
[ "${ISTACK_ALLOW_MAIN_CHECKOUT:-}" = "1" ] && exit 0

# A linked worktree has its own git dir; only the main checkout's is the common one.
[ "$(cd "$(git rev-parse --git-dir)" && pwd -P)" = "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)" ] || exit 0

# Detached HEAD (a rebase, a bisect) passes; only a named branch other than the default fails.
branch=$(git symbolic-ref --quiet --short HEAD) || exit 0
default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [ -z "$default" ]; then
  for name in main master trunk; do
    if git show-ref --verify --quiet "refs/heads/$name"; then default=$name; break; fi
  done
fi
[ -z "$default" ] || [ "$branch" = "$default" ] && exit 0

echo "istack: the main checkout is now on $branch, not $default." >&2
echo "istack: build in a worktree instead:" >&2
echo "  git switch $default && git worktree add .claude/worktrees/<task> $branch" >&2
echo "istack: (a deliberate switch: ISTACK_ALLOW_MAIN_CHECKOUT=1 git switch $branch)" >&2
exit 1
