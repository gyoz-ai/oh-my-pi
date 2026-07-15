# omp-container

`omp-container` runs `omp` inside the fork's `pi-container` Docker image against
whatever repo you're standing in, instead of your host's `~/.bun/bin/omp` dev
launcher. It bind-mounts `$PWD` read-write at the same absolute path inside
the container, shares your `~/.omp` config/session store, and auto-provisions
that repo's own toolchain via [mise](https://mise.jdx.dev/) from its
`mise.toml`/`.tool-versions` on every launch — useful for keeping a repo's
native build deps (openssl, build-essential, etc.) out of your host machine
entirely, or for running an agent against a repo whose toolchain you don't
want to install locally.

## Prerequisites

- Docker (or a Docker-compatible daemon — OrbStack, Docker Desktop, Colima)
  installed and running.
- This fork (`gyoz-ai/oh-my-pi`) cloned somewhere on disk. `pi-container`
  doesn't bake omp's own source into the image — like the host dev
  launcher, it runs the fork's `src/` live, bind-mounted read-only from your
  checkout on every launch — so keep the checkout in place after setup.
- A host `omp` (bun-linked via `scripts/link-omp.sh`) is optional — you only
  need `scripts/omp-container` on `PATH`, not a working host `omp`.
- A symlink into `~/.local/bin` also works instead of the `PATH` export
  below — see `scripts/omp-container`'s own self-locate logic — as long as
  `~/.local/bin` is itself on `PATH`.

## Setup

Add the fork's `scripts/` directory to `PATH`. Replace `~/path/to/oh-my-pi`
with your actual checkout path.

bash (`~/.bashrc`):

```sh
export PATH="$HOME/path/to/oh-my-pi/scripts:$PATH"
```

zsh (`~/.zshrc`):

```sh
export PATH="$HOME/path/to/oh-my-pi/scripts:$PATH"
```

Reload your shell (or `source` the rc file), then `omp-container` is on
`PATH` everywhere.

## Usage

```sh
cd ~/code/some-repo
omp-container                  # builds pi-container on first run, then launches omp
```

For repos whose test suite spins up its own containers via testcontainers
(e.g. any local project), pass `--docker-socket` as the first argument to additionally
mount the host Docker socket into the container:

```sh
cd ~/code/your-project
omp-container --docker-socket
```

All other arguments are forwarded to `omp` unchanged, so `omp-container
--resume=<id>` and friends work exactly like `omp`.

## mise auto-install

On every launch, the container entrypoint checks the mounted repo's own
working directory for `mise.toml`, `.mise.toml`, or `.tool-versions` (never
the fork's own mise config) and, if found, runs `mise trust` and `mise
install` before handing off to `omp`. Installed toolchains and mise's
download cache live in the `omp-mise-cache` named Docker volume, so a given
tool version is only ever installed once across container invocations, not
once per launch.

## Networking

The container gets `--add-host=host.docker.internal:host-gateway`, so
services published on the host's `localhost` (Postgres, Redis, etc. from a
`docker-compose.yml` stack) are reachable from inside the container via
`host.docker.internal` instead of `localhost`.

## Mounts

`omp-container` runs as `root` inside the container (`HOME=/root`), so every
host mount targets `/root`, not the host's own `$HOME`:

- `$PWD` — bind-mounted read-write at the same absolute path inside the
  container.
- the fork checkout (`repo_root`) — bind-mounted read-only at `/work/pi`.
- `~/.omp` — bind-mounted read-write at `/root/.omp`, sharing your config
  and session store with the host.
- `~/.gitconfig` — bind-mounted read-only at `/root/.gitconfig`, when it
  exists, sharing your git identity with the host.
- the effective `core.excludesfile` — bind-mounted read-only, when it
  exists, so `git status`/`git diff` inside the container match the host.
  An explicit `git config --get core.excludesfile` on the host is mounted
  at its own literal path; otherwise git's implicit default
  (`$XDG_CONFIG_HOME/git/ignore`, falling back to `~/.config/git/ignore`)
  is mounted at `/root/.config/git/ignore`.
- `omp-mise-cache` — a named Docker volume at `/root/.local/share/mise`.

`docker run` always gets `-i`; it only gets `-t` when both stdin and stdout
are attached to a tty, so piped or redirected invocations (`omp-container
--resume=x | tee log`, `omp-container --version </dev/null`) work the same
as an interactive terminal session.

## herdr

`omp-container` works transparently inside a herdr pane over PTY — herdr
spawns it like any other agent binary and its shell/terminal handling is
unaffected. herdr's *live sidebar agent-status* feature depends on an
outbound unix-domain-socket connection from inside the omp process to a
herdr-owned socket file on the host; that connection does not work if the
socket file itself is bind-mounted into the container on VM-backed Docker
(confirmed failing on OrbStack, and expected to fail identically on Docker
Desktop and Colima, since all three run containers inside a Linux VM behind
a virtualized filesystem boundary).

`omp-container` bridges this instead of bind-mounting the socket. When
`HERDR_ENV=1`, `HERDR_SOCKET_PATH` is set and points at an existing socket
file, and the host has `socat` on `PATH` (`brew install socat`), the wrapper
picks a free host TCP port, backgrounds a host-side
`socat TCP-LISTEN:<port>,reuseaddr,fork UNIX-CONNECT:$HERDR_SOCKET_PATH`
relay, and passes `HERDR_ENV`/`HERDR_SOCKET_PATH`/`HERDR_PANE_ID`/
`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID` plus the chosen `HERDR_BRIDGE_PORT` into
the container. The `pi-container` entrypoint, in turn, backgrounds
`socat UNIX-LISTEN:$HERDR_SOCKET_PATH,fork TCP:host.docker.internal:$HERDR_BRIDGE_PORT`
before handing off to `omp`, recreating the socket file at the same path
inside the container — the herdr omp extension connects to it unchanged. The
host-side relay is killed via an `EXIT`/`INT`/`TERM` trap when the wrapper
exits, so no bridge process outlives the `omp-container` invocation.

Without `socat` on the host (or without `python3`, used to pick the bridge
port), the wrapper prints one notice to stderr and falls back to today's
behavior: no `HERDR_*` env forwarded, sidebar status stays inert while PTY
screen-scrape detection keeps working.

## Troubleshooting

- **Rebuild the image** after changing `Dockerfile` or `pi-base`:
  `OMP_CONTAINER_REBUILD=1 omp-container`.
- **Wipe the mise cache** if a toolchain install gets corrupted or you want a
  clean re-provision: `docker volume rm omp-mise-cache`.
