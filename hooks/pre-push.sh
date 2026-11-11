#!/bin/sh
# istack:pre-push
# Written by `istack install --hooks` from this repo's istack.yaml checks.
# Re-run the install after changing the checks; `istack uninstall --hooks` removes this file.
# Skip it once with `git push --no-verify`.
cd "$(git rev-parse --show-toplevel)" || exit 1

istack_check() {
  echo "istack pre-push: $1"
  if ! sh -c "$2" </dev/null; then
    echo "istack pre-push: $1 failed - push stopped" >&2
    exit 1
  fi
}

# @@CHECKS@@
