# gyoz-ai Ecosystem

Everything under `~/Projects/gyoz-ai/` is one integrated stack: two upstream forks (`herdr`, `omp`) that talk to each other over a local socket, plus six standalone OMP extension repos that plug into the `omp` fork's coding agent at runtime. All seven repos are independent git checkouts under the `gyoz-ai` GitHub org; none of the six plugin repos are forks of anything — they are original, purpose-built OMP extensions.

## The two forks

### herdr — terminal multiplexer fork (https://github.com/gyoz-ai/herdr)

- Upstream: `ogulcancelik/herdr` (never pushed to). Fork remote: `gyoz-ai/herdr`, branch `master`, a one-feature-one-commit ledger rebased onto upstream by the `fork-sync` workflow.
- What it is: a terminal multiplexer and runtime for coding agents. It organizes terminals into workspaces, tabs, and panes, detects agent identity/status inside each pane, and exposes the running session through the `herdr` CLI and a local control socket.
- Difference from upstream: upstream `herdr` is a general-purpose terminal multiplexer with no knowledge of coding agents beyond generic pane content. The fork adds an entire agent-awareness layer on top:
  - An agent sidebar that renders reported subagents as rows, grouped by session title, sorted running-first, with live work descriptions in the subtitle and the agent name in the title.
  - Deep-focus navigation: jump directly to the Nth subagent from the agent panel or via a keyboard deep-focus sequence, scoped to the active space.
  - A `pane.report_subagents` socket method with per-pane subagent storage, so an `omp` session can push its live subagent tree into herdr instead of herdr guessing from pane text.
  - Selection/mouse-tracking fixes specific to running an interactive agent (click-tracking panes eating drag-selection, wheel-scroll routing, right-click context menu to remove/stop an agent row).
- Local install: a plain-file copy at `/opt/homebrew/bin/herdr` (not a symlink, not `cargo install`) — rebuilt with `cargo build --release` and copied over after every source change; a running herdr process must be restarted to pick it up.

### omp (oh-my-pi) — coding agent fork (https://github.com/gyoz-ai/oh-my-pi)

- Upstream: `can1357/oh-my-pi` (never pushed to), itself a fork of `badlogic/pi-mono` by `mariozechner`. Fork remote: `gyoz-ai/oh-my-pi`, branch `main`, same one-feature-one-commit ledger discipline as herdr, baseline v16.3.15.
- What it is: "a coding agent with the IDE wired in" — the CLI installed as `omp`, a Rust core (~55k lines) plus a TypeScript coding-agent package, 40+ model providers, 32 built-in tools, LSP and DAP integration. This is the runtime that loads everything else in this document (extensions, tools, agents, skills).
- Difference from upstream: upstream `oh-my-pi` has no concept of herdr. The fork's feature ledger is almost entirely the mirror image of herdr's — wiring the coding agent into herdr's socket protocol:
  - Native herdr subagent state reporting (`feat(coding-agent): native herdr subagent state reporting`), flushed on shutdown, with stable per-agent sequence addressing shared between the TUI, the wire protocol, and herdr's registry order.
  - Clickable agent rows and `agent://` report hyperlinks in the TUI that resolve to a transcript or subagent HUD row and focus that agent's session in herdr.
  - Live output tails and expanded per-agent detail rows for running subagents, both in-TUI and reported outward to herdr.
  - `ctrl+o`/`ctrl+k` chords and a deep-focus escape sequence to jump between subagents, and SGR click tracking kept alive for the app's whole lifetime (not just alt-screen overlays) so herdr can route clicks correctly.
  - Assorted TUI/task-plumbing fixes (job-poll suppression for running tasks, terminate-abort silencing on a successful terminal yield, width-wrapped IRC message bodies) that exist to make the herdr-attached experience solid.
- Local install: `~/.bun/bin/omp` is a symlink to `packages/coding-agent/scripts/omp`, a dev launcher (`exec bun --preload scripts/omp.ts ../src/cli.ts`). There is no build step in the loop — `src/` runs live off a restart. `bun install` only when `package.json`/`bun.lock` change.

## The extensions running inside omp

Everything below is discovered by the `omp` fork's extension/tool/agent loader at `~/.omp/agent/{extensions,tools,agents}/` (user-wide) or `<project>/.omp/{extensions,tools,agents}/` (project-scoped), via symlinks from each repo checkout into that tree — see each repo's own `README.md` "Install" section for the exact `ln -s` command. None of these are forks; each is a from-scratch repo owning one piece of agent behavior.

### omp-governance — plugin (https://github.com/gyoz-ai/omp-governance)

Enforces the fixed, session-wide engineering rules: dispatch discipline for the chief agent (only `task`/`todo`/`ask`/`irc`/`job`/`resolve`/`memorysearch`/`search_tool_bm25` are allowed at the chief level — everything else must run inside a subagent), a comment ban on `write`/`edit` to code files, a test skip-marker ban (`TODO`/`FIXME`/"for now"/etc. in test files), a `Cargo.lock` write guard, a memory-search-before-first-dispatch gate, and a mandatory post-`task` verification checklist appended to every subagent result. It used to also own bash-command filtering; that responsibility has moved out to `omp-bash-guard` (see below) so the two plugins now compose instead of overlapping.

### omp-bash-guard — plugin (https://github.com/gyoz-ai/omp-bash-guard)

Split out of `omp-governance`. Intercepts every `bash` tool call, splits it into segments on `;`/`&&`/`||`/`|`/newlines, and checks each segment through three tiers: hard blocks with no override (`git commit`, `git push`, `git reset --hard`, `git push --force`, package-registry `publish` commands, `rm -rf /...`, `sudo`), project-scoped blocks (e.g. `cargo test` → use `cargo nextest run`, gated on detecting a Rust project via `Cargo.toml`), and ask-first commands that get denied with a reason telling the agent to surface them to the user instead (`rm`, `git reset`, `curl`, `wget`, `chmod`, `dd`, `eval`, `source`, package-manager `install` commands).

### omp-memory — plugin + tool (https://github.com/gyoz-ai/omp-memory)

A session-memory system backed by a local Typesense instance (bundled `docker-compose.yml`, auto-started on `session_start` if not already running). On `session_stop` it LLM-summarizes the session transcript into reusable facts and stores them tagged by project; every 5th capture also rolls facts up into a cross-project user-preference profile. It wraps `task` calls to diff the git working tree before/after and record what each subagent dispatch changed, and injects the most recent memory summaries plus the user profile into the chief's system prompt on `before_agent_start`. The companion `memorysearch` tool (vendored under `tools/`) lets the agent explicitly hybrid keyword+vector search past session memory mid-task — this is the tool step 8 of `omp-governance`'s rules requires before the chief's first dispatch each session.

### omp-project-tools — tools only (no plugin) (https://github.com/gyoz-ai/omp-project-tools)

Two standalone `CustomToolFactory` tools with no lifecycle hooks: `project_format` (runs `cargo fmt` for Rust, or the first matching `package.json` script out of `format`/`fmt`/`lint:fix`/`lint`/`prettier`/`biome:fix`/`biome:check` for TS/JS, package manager auto-detected from the lockfile) and `project_test` (runs `cargo nextest run`, optionally filtered, for Rust; or the first matching build/typecheck script followed by `test` for TS/JS). Both share a `lib/project-kind.ts` detector (Rust wins over TS if both markers are present).

### omp-ponytail — plugin (https://github.com/gyoz-ai/omp-ponytail)

Injects the minimality ("ponytail") doctrine into every agent's system prompt on `before_agent_start` — the YAGNI ladder (does this need to exist → stdlib → native platform feature → an already-installed dependency → one line → minimum code) plus a standing reminder that validation, error handling, security, and accessibility are never fair game for cutting. On `session_stop` (chief only — subagents never fire this event) it checks the last assistant message for a `PONYTAIL: PASS` marker; if missing, it returns one extra turn with a reminder instead of blocking, so the session always settles regardless of what the agent does with the nudge — it can never wedge a session.

### omp-smith-agent — agent definition (https://github.com/gyoz-ai/omp-smith-agent)

Not a plugin or a tool — a single agent markdown file (`omp-smith.md`) that becomes the `omp-smith` subagent role once symlinked into `~/.omp/agent/agents/`. Its system prompt bakes in the loader semantics and safe-cutover discipline documented across this whole ecosystem (top-level `index.ts` = one plugin, shared code must be vendored or live outside `extensions/`, tools are standalone factories, never `rm` — only `mv` into a backup directory) so that engineering work on any of the extensions above starts from the real rules instead of a re-explanation each time.

## How it fits together

A user runs `omp` (the fork) inside a `herdr`-managed pane (the other fork); `omp` reports its live subagent tree to `herdr` over the socket protocol both forks were extended to speak, and `herdr`'s sidebar renders and lets you navigate that tree. Inside the `omp` process, `omp-governance` and `omp-bash-guard` constrain what the agent is allowed to do, `omp-memory` and `omp-smith-agent` give it continuity and expertise across sessions, `omp-project-tools` gives it project-agnostic build/test/format commands, and `omp-ponytail` keeps its output lean. Every one of the six extension repos is installed by symlinking the repo (or a file inside it) into `~/.omp/agent/`, so upgrading any single piece is a `git pull` in that repo with no redeploy step — the loader live-reloads on file-change mtime.
