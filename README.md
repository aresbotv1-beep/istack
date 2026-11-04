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

## Configure

Copy [`mitchstack.yaml.example`](mitchstack.yaml.example) to `mitchstack.yaml` and check it:

```sh
npx mitchstack config check
```

## Why

I came to software from construction, where every change on a job site gets a before photo, an
after photo and a sign-off. mitchstack holds agents to the same standard.

## Credits and license

Standing on the work of Matt Pocock, Theo Browne, Lauren Tan, Garry Tan, Michael Shimeles and
others — see [CREDITS.md](CREDITS.md). MIT, see [LICENSE](LICENSE).
