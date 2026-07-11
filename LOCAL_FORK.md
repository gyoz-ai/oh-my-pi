# Local Fork Guide

Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) at
[gyoz-ai/oh-my-pi](https://github.com/gyoz-ai/oh-my-pi), baseline v16.3.15.

## Remotes and branch model

- `origin` — git@github.com:gyoz-ai/oh-my-pi.git (the fork; the only remote ever pushed to)
- `upstream` — git@github.com:can1357/oh-my-pi.git (never pushed to)

`main` is a one-feature-one-commit ledger: each fork feature lives in exactly one
commit, rebased onto the upstream default branch by the `fork-sync` workflow.
Fixes to an existing feature fold into its commit:

```sh
git commit --no-gpg-sign --fixup=<feature-sha>
git rebase -i --autosquash --no-gpg-sign upstream/main
```

All commits use `--no-gpg-sign`. Push only to origin, always with
`git push --force-with-lease origin main`.

## Running the local fork

`~/.bun/bin/omp` is a symlink to `packages/coding-agent/scripts/omp`, a dev
launcher that ends in `exec bun --preload scripts/omp.ts ../src/cli.ts`. The
fork's `src/` runs live — there is no bundle or build step in the loop.

- Activating a source change = restart `omp`; a running session keeps the old code.
- Run `bun install` only when `package.json` / `bun.lock` change.
- `dist/cli.js` (`bun run gen:bundle`, via `scripts/bundle-dist.ts`) matters only
  for the dormant npm-installed copy; the dev launcher never reads it.

## Gate

From `packages/coding-agent`:

```sh
bun run check:types
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun run test
```

## Settings

Subagent model overrides live in `~/.omp/agent/config.yml` under
`task.agentModelOverrides`. Settings are snapshotted at session start —
restart `omp` to pick up config or source changes.
