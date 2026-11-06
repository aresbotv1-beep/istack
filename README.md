<img src="assets/icon.svg" width="64" height="64" alt="">

# mitchstack

**Receipts, not vibes.** An agent workflow for Claude Code, Codex and Cursor where every pull request
carries checked proof: the problem shown failing before the fix, before/after pictures of anything a
person can see, and an honest note on what could break.

> Status: under construction. Built with itself — every PR in this repo carries its own receipts.

## How it works

```
groundbreak ─▶ plan ─▶ [you say yes to the ticket]
build ─▶ prove ─▶ ship ─▶ [you merge]
```

Exactly two human decisions: you approve the ticket, and you merge. Everything between is the
agent's job, and the agent has to show its work. The full contract is in [AGENTS.md](AGENTS.md).

## See it

The proof travels with the pull request, and a check on every pull request reads it. Proof made
on an older version of the change doesn't count:

![The check failing: the proof was made on an older version of the change](assets/demo/receipts-fail.png)

Proof made on the exact change being merged passes:

![The check passing: the proof matches the change being merged](assets/demo/receipts-pass.png)

Both are the real checker's output on two sample pull requests. Rebuild them with
`npm run build && node scripts/demo-pictures.mjs`.

## Install

One line per host:

| Host | Command |
|---|---|
| Claude Code | `/plugin install mitchstack --marketplace aresbotv1-beep/mitchstack` |
| Codex | `npx mitchstack install --host codex` |
| Cursor | `npx mitchstack install --host cursor` |

- **Claude Code** installs it as a plugin, so every skill is namespaced (`/mitchstack:groundbreak`)
  and can never clash with one of yours. On Claude Code older than 2.1.275, use two steps:
  `claude plugin marketplace add aresbotv1-beep/mitchstack` then
  `claude plugin install mitchstack@mitchstack`.
- **Codex** gets the skills in `~/.agents/skills/` and the contract in `~/.codex/AGENTS.md`.
  **Cursor** gets the skills in `~/.cursor/skills/`. Add `--project <repo>` to install into one
  repository instead (skills under `.agents/skills/` or `.cursor/skills/`, the contract in the
  repo's `AGENTS.md`), and `--hooks` to add a git pre-push hook that runs the checks in
  `mitchstack.yaml`. `--host all` does all three; `--dry-run` shows what would change.
- **It never overwrites anything it didn't write.** If you already have a skill called `plan` or
  `ship`, that one is skipped and reported (add `--prefix` to install ours as `mitchstack-plan`).
  The contract goes between `<!-- mitchstack:begin -->` and `<!-- mitchstack:end -->` markers;
  your text outside them is never touched. An existing pre-push hook, skill file or contract block
  is left alone and never recorded as mitchstack's, even when it is byte-identical. With
  `--prefix`, links between skills (`../ship/council.md`) are rewritten to the prefixed folders.
  Running the install again changes nothing.
- **Uninstall** with `npx mitchstack uninstall --host codex` (same flags). It removes only the
  files it recorded in `.mitchstack/install.json`, and keeps any you edited since. A record that
  names any path outside the host folders (`..`, an absolute path, or out through a symlink) is
  refused whole: exit 2, nothing changed.
- The skills also follow the [`npx skills`](https://github.com/vercel-labs/skills) layout
  (`npx skills add aresbotv1-beep/mitchstack`); the no-overwrite promise above covers
  `mitchstack install` only.

## Configure

Copy [`mitchstack.yaml.example`](mitchstack.yaml.example) to `mitchstack.yaml` and check it:

```sh
npx mitchstack config check
```

## Why

For local checks, CI scope and proposed branch protection, see [Developing mitchstack](docs/development.md).

I came to software from construction, where every change on a job site gets a before photo, an
after photo and a sign-off. mitchstack holds agents to the same standard.

## Credits and license

Standing on the work of Matt Pocock, Theo Browne, Lauren Tan, Garry Tan, Michael Shimeles and
others — see [CREDITS.md](CREDITS.md). MIT, see [LICENSE](LICENSE).
