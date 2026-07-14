# syntax=docker/dockerfile:1.7-labs
###############################################################################
# oh-my-pi — pi image
#
# Stages:
#   natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
#   wheel-builder   — omp_rpc Python wheel
#   pi-base         — python + bun + rustup launcher + natives + omp_rpc
#                     + /usr/local/bin/omp shim
#   pi-runtime      — pi-base + pi source + bun install      (DEFAULT, runnable)
#   pi-container    — pi-base + mise + socat; host runner for scripts/omp-container
#
# Build:
#     docker build -t oh-my-pi/pi:dev .                          # default = pi-runtime
#     docker build --target pi-base -t oh-my-pi/pi-base:dev .    # base for derived images
#     docker build --target pi-container -t oh-my-pi/pi:container .   # see scripts/omp-container
#
# Run:
#     docker run --rm oh-my-pi/pi:dev --help
#     docker run --rm -it -v "$PWD":/work oh-my-pi/pi:dev cli    # interactive omp
#
# Consume as a base in another Dockerfile (see Dockerfile.robomp):
#     ARG PI_BASE=oh-my-pi/pi:dev
#     FROM ${PI_BASE} AS pi-base
###############################################################################

ARG BUN_VERSION=1.3.14

############################
# 1) natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /pi

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /pi/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/robomp/web/package.json \
    crates/*/Cargo.toml \
    /pi/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /pi/

# Layer 4 — compile pi-natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps + the workspace
# target dir.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/pi/target \
    set -eux; \
    rustup show; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/pi_natives.linux-*.node /out/

############################
# 2) wheel-builder — omp-rpc wheel
############################
FROM python:3.12-slim-bookworm AS wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY python/omp-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) pi-base — python + bun + rustup + natives + omp_rpc + omp shim
#
# Sharable runtime base. Derived images (pi-runtime below, Dockerfile.robomp)
# extend this and overlay their own source tree. Default PI_ROOT=/work/pi is
# friendly to derived images that mount a host pi checkout there; pi-runtime
# overrides it to /pi because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS pi-base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PI_ROOT=/work/pi \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by pi's `rust-toolchain.toml`. Keeps the
# image small while sharing the toolchain across reboots when /data is mounted.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# pi-natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/pi_natives.linux-*.node /opt/bun/bin/

# omp-rpc Python wheel.
COPY --from=wheel-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/omp_rpc-*.whl && rm -rf /tmp/wheels

# `omp` shim — runs the coding-agent CLI against $PI_ROOT via Bun. Derived
# images override PI_ROOT to point at wherever their pi source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${PI_ROOT:=/work/pi}"' \
    'if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then' \
    '  echo "pi: PI_ROOT=$PI_ROOT does not look like a pi checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$PI_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/omp \
    && chmod +x /usr/local/bin/omp

############################
# 4) pi-runtime — pi-base + pi source + bun install (DEFAULT)
#
# A self-contained, runnable omp image. `docker run oh-my-pi/pi:dev --help`
# Just Works without a host checkout.
############################
FROM pi-base AS pi-runtime

ENV PI_ROOT=/pi
WORKDIR /pi

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/robomp/web/package.json \
    /pi/

RUN bun install --frozen-lockfile --ignore-scripts

# Pi source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /pi/

# Regenerate the tool views that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles these on a vanilla install.
RUN bun --cwd=packages/coding-agent run gen:tool-views

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/omp"]
CMD ["--help"]

############################
# 5) pi-container — pi-base + mise + socat, host runner for scripts/omp-container
#
# Host counterpart: scripts/omp-container. Bind-mounts a host repo at its own
# absolute path and lets the entrypoint provision *that* repo's own toolchain
# via mise (its mise.toml/.tool-versions, not pi's own) before handing off to
# the pi-base omp shim. mise's own installer detects the container's arch, so
# this stage carries no arch-specific logic. socat is installed here to run a
# UNIX-to-TCP relay when HERDR_SOCKET_PATH/HERDR_BRIDGE_PORT are set, bridging
# herdr's live sidebar agent-status socket across the container boundary.
############################
FROM pi-base AS pi-container

RUN apt-get update && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://mise.run | sh
ENV PATH=/root/.local/share/mise/shims:/root/.local/bin:$PATH

RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'if [ -n "${HERDR_SOCKET_PATH:-}" ] && [ -n "${HERDR_BRIDGE_PORT:-}" ]; then' \
    '  mkdir -p "$(dirname "$HERDR_SOCKET_PATH")"' \
    '  rm -f "$HERDR_SOCKET_PATH"' \
    '  socat UNIX-LISTEN:"$HERDR_SOCKET_PATH",fork TCP:host.docker.internal:"$HERDR_BRIDGE_PORT" &' \
    'fi' \
    'cd "$PWD"' \
    'if [ -f mise.toml ] || [ -f .mise.toml ] || [ -f .tool-versions ]; then' \
    '  mise trust --quiet' \
    '  mise install --quiet' \
    'fi' \
    'exec /usr/local/bin/omp "$@"' \
    > /usr/local/bin/omp-container-entrypoint \
    && chmod +x /usr/local/bin/omp-container-entrypoint

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/omp-container-entrypoint"]
