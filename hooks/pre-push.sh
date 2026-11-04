#!/bin/sh
# mitchstack:pre-push
# Written by `mitchstack install --hooks` from this repo's mitchstack.yaml checks.
# Re-run the install after changing the checks; `mitchstack uninstall --hooks` removes this file.
# Skip it once with `git push --no-verify`.
cd "$(git rev-parse --show-toplevel)" || exit 1

mitchstack_check() {
  echo "mitchstack pre-push: $1"
  if ! sh -c "$2" </dev/null; then
    echo "mitchstack pre-push: $1 failed - push stopped" >&2
    exit 1
  fi
}

# @@CHECKS@@
