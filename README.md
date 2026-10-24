<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-zvec-grep@main/icon.svg" width="96" height="96" alt="dsh-zvec-grep logo" />
</p>

<h1 align="center">dsh-zvec-grep</h1>

<p align="center"><em>Semantic workspace search for dsh agents: hybrid BM25 + vector + RRF over a local zg index, with a search-first gate on grep and rg.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-zvec-grep"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-zvec-grep?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-zvec-grep"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-zvec-grep?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-zvec-grep/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-zvec-grep/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

---

**A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the model semantic workspace search: three `zg_*` tools driving the local `zg` CLI (BM25 + vector + RRF), a search-first gate on grep/rg, and a settings card with daemon readiness and a rebuild button. The `zg` binary and the index stay on your machine.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
  - [Shared version floor](#shared-version-floor)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [Tools exposed to the model](#tools-exposed-to-the-model)
  - [zg_search](#zg_search)
  - [zg_index](#zg_index)
  - [zg_status](#zg_status)
  - [The rg switch](#the-rg-switch)
  - [Root rules](#root-rules)
- [The search-first gate](#the-search-first-gate)
- [Settings](#settings)
  - [Remote embedding](#remote-embedding)
  - [Asking before an explicit root](#asking-before-an-explicit-root)
- [Support surface](#support-surface)
- [External dependency](#external-dependency)
- [Daemon (server mode)](#daemon-server-mode)
- [Public interface](#public-interface)
- [The background job surface](#the-background-job-surface)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **Three model tools, one CLI underneath.** `zg_search` / `zg_index` / `zg_status` drive the `zg` CLI through the host shell. Transport defaults to `--mode auto`: server when the daemon is ready, silent fallback to direct otherwise - nothing starts a daemon for you.
- **A search-first gate.** In an indexed workspace, grep/rg (shell command or native tool) is refused until a successful `zg_search` has run; each search re-arms a quota for a time window.
- **A systemPrompt routing section** (`zvec-grep-routing`, order 1550) plus a `tools.guard` backstop: `zg_index` requires an explicit confirm, and every root passes one shared predicate in both guard and execute.
- **A web settings card** ("zvec-grep (zg)"): default embedding, limit, gate values, a daemon-readiness line, and a "rebuild workspace" button whose jobs live in the official host job registry.
- **No index required to start.** `zg_search` can fall back to zg's exhaustive lexical channel (the `rg` switch); a never-indexed root fails loudly instead of being indexed silently.

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-zvec-grep
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-zvec-grep`. The package is on the public npm registry; no credentials, no scoped-registry line.

- **Node.js `>= 22.12`** (ESM-only; that floor is what makes `require()` of an ESM entry work, hence `engines.node`).
- **Host `dsh` on the `0.2.1-rc.3` line.** The host reads `engines.dsh` (`^0.2.1-rc.3`) and it **decides alone** - with that field present, compatibility is judged before `peerDependencies` is ever consulted, prereleases included. Any `0.2.x` at or above `0.2.1-rc.3` passes; `0.3.0` and later need the risk grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts`). Profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there becomes a real second copy; `@deepseek-ai/dsh-tools` keys its scheduler with a plain `Symbol`, so **every native tool call throws** in that profile while build, typecheck and coverage stay green. The `dsh-*` peers are pinned exactly at the `@deepseek-ai/dsh` peer's version - a compile-time discipline against a second host type surface, not a claim the host consults.
- **Value imports are required peers.** `@deepseek-ai/schemastery` is the host fork (only its `resolve` wraps `.volatile()` fields); `@deepseek-ai/dsh-typert-protocol` provides `TypertRemoteService`, a class to `extends`; shared's `lib/text` value-imports `@deepseek-ai/dsh-output-retention`. Each sits in `peerDependencies` plus the same exact pin in `devDependencies` - missing one is `ERR_MODULE_NOT_FOUND` at load, not a graceful downgrade. The only `dependencies` entry is `@jayyuen66/dsh-plugin-shared`.
- **What ships**: `host.js`, `client.js`, `cordis.patch.yml`, `icon.svg`, both READMEs, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`. Artifacts are rebuilt by `prepack`, never committed.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names imported at runtime, and the host reports `N entries did not activate` with `does not provide an export named ...` at boot - installs fine, never loads, invisible to per-repository CI.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-zvec-grep` plus `- id: zvec-grep`. That command is the only accepted signal and is **not read-only** - read layer lines from stdout **and** check stderr separately; accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The tools answer.** Ask the model to run `zg_status` on the current workspace: it executes and passes zg's own output through. "Unknown tool" means the bundle layer is not mounted.
3. **The gate refuses - in an indexed workspace.** With `enforceSearchFirst` on and a manifest under `<root>/.zvec-grep/`, grep/rg is refused with the "no zg_search has run yet" message until one successful search. Without an index there is nothing to gate.
4. **The card renders.** The settings page lists "zvec-grep (zg)" with the six editable values, the readiness line (empty when the probe cannot answer) and the rebuild button; a toggle plus **Save** round-trips with a 200.
5. **No host copy in the profile.** A scratch profile's `node_modules/` holds `@jayyuen66/` and no `@deepseek-ai/` directory.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **No HTTP route of its own.** The card's data plane is the official Typert Remote namespace `zvecGrepRebuild` through the host `/api` gateway; auth, Host/DNS-rebinding/Origin checks and body limits are all the gateway's.
- **No CLI subcommand.** `dsh zvec-grep …` does not exist.
- **No daemon lifecycle.** `zg server on` is the user's action; this package only reads readiness.
- **No ripgrep dependency.** rg appears only inside the gate predicate.
- **Nothing written to the host data directory.** The only on-disk shape is zg's own `.zvec-grep/` under the indexed root.
- Required surfaces: `settings` / `shell` / `tools` / `systemPrompt` / `timer` (all in `inject`). The host `jobs` service is optional - without it the rebuild paths refuse and spawn nothing; the three tools keep working.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` points at `cordis.patch.yml`, whose single line is `- id: zvec-grep` with `name: "@jayyuen66/dsh-zvec-grep"` - the **bare package name** is what makes the host scan the client half. Bundle installation goes through pnpm (>= 12.3.0).
- A missing injected surface keeps cordis from activating the entry (startup diagnostic: `pending (waiting for service: …)`); a malformed ctx throws `required services … missing` from apply.
- The card is registered in the `plugins.bundle.config` slot keyed by the **bundle package name**; the settings namespace and `configForms` reads stay the bare entry id `zvec-grep` (implicit registration by entry id).
- The rebuild read surface is installed on the apply fiber - no `webServer` dependency, no child fiber. On a TUI host the service still registers; the card simply has nowhere to render.
- The status poll is the client's own timer (2000 ms), not a server push; every read answers a result object, never a thrown error.
- Deployment defaults go on the registration line's `config:`; precedence is card runtime value > row config > schema `.default()`.

## <img src="https://api.iconify.design/lucide/search.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Tools exposed to the model

Output is plain text; timeouts 5 min (search) / 10 min (index) / 60 s (status); stdout capped at 400000 bytes, truncated to the tail with a note. Sandbox runner failure, policy denial and a genuine zg failure are told apart; incomplete results are flagged. A `root` must be a string, and the constructed command is capped in UTF-8 bytes (not code units): a non-string root or an over-long command is refused instead of falling back to the session workspace or hitting the OS argument limit.

### zg_search

- At least one of query / queries / fts / vector (32 routes max, 4000 chars each); the four filter fields (`globs` / `insensitiveGlobs` / `fileTypes` / `excludedFileTypes`) take a single string or an array (128 items, 1024 chars each).
- `symbolTypes` is zg's closed set, **lowercase only** (`module` / `class` / `interface` / `function` / `value` / `alias`); invalid values are refused before the command is built, without case folding.
- `preview`: `none` / `short` (default) / `full`. `refresh`: `wait` (default) / `off` / `background` - `background` needs a **ready daemon** and is refused before the command is built when there is none (the way out is `zg server on`, or unpinning `clientMode` from `direct`).
- A **hit summary** at the tail reports two counts separately: the sum of per-group `hits:` and distinct locations after dedup (relative path + line range) - one location hit by several groups must not pass as the hit total. A group at exactly `--limit` is an observation only; zg gives no truncation signal.
- `trace` passes through `--trace` (per-hit recall routes, ranks, scores); the dedup key strips the score, which differs per group.

### zg_index

- `confirm` is required and must be true (rejected twice, by the required check and by the guard). Building never happens implicitly.
- `background=true` spawns the zg process, registers it in the host job registry, attaches the timeout reaper and **returns a job id immediately**. It reuses the **same** spawn/register/claim steps as the card (one shared function), the per-root claim is mutually exclusive across both entry points, and without a job registry it **does not spawn at all**. Until it settles, search on that root waits and retries, and the gate is suspended.
- An explicit embedding goes through an **assembly-time allowlist** (the local catalog - the card's dropdown list); anything else is refused. Switching embedding only takes effect with `rebuild=true`.
- `resetPaths=true` clears the inherited file-selection settings and composes with this call's filters; it is refused together with `drop`.
- `drop=true` refuses every index-side parameter (filters, rebuild, embedding, depth, …) instead of silently ignoring it; the command then contains only the deletion.
- `ignoreFiles` entries must name an existing, readable file. A missing or unreadable path is rejected before zg runs; upstream would otherwise fail the whole index and leave that tree's index state broken.

### zg_status

- root + checkReady, for diagnosing a missing/failed/cancelled index or watching progress.
- `checkReady=true`: the report still goes to stdout and only the exit code expresses readiness - not-ready is a conclusion, not a failure. The report is returned verbatim with one appended line; an empty report with a non-zero exit still throws.
- While a rebuild of the same root is running, the tool returns the rebuild projection and starts no subprocess.

### The rg switch

- `rg` unset: with no index in the workspace **or any ancestor**, the search falls back to exhaustive matching with a prepended note ("literal line matches, not semantic ranking"). `rg=true` forces it; `rg=false` refuses the fallback (zg then reports `WORKSPACE_INDEX_NOT_FOUND`).
- Exhaustive search grants **no** grep/rg quota: it reads no index. Flag conflicts (`preview` / `refresh` / `symbol-type` / `prefer-symbol` / `fuse` / `fts` / `vector`, `trace`) are refused at assembly time with the conflicts listed; there is no hit summary (no `hits:` lines to count).

### Root rules

- `root` is optional in all three tools (defaults to the session workspace). Validation: absolute path starting with `/`, lexically normalised; empty/non-string/NUL/relative/escaping `..` and `/` itself are refused; a missing directory is reported as such, not as a spawn ENOENT.
- A root outside the session workspace passes only via the "ancestor or descendant" branch of the shared predicate (`judgeRoot`), and every accepted root is registered in the observed-workspace whitelist the card's rebuild draws on. Guard and execute share the predicate - nothing is refused twice with different wording.

## <img src="https://api.iconify.design/lucide/ban.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The search-first gate

- **What counts as searching**: after quote/comment-aware tokenising of a bash/pwsh command string, grep/egrep/fgrep/rg at a command position, plus the native grep tool. `--help` / `--version`, `echo "grep x"` and commit messages do not.
- **Quota per "session x index root"**: each successful `zg_search` re-arms `grepBudgetPerSearch` calls valid for `unlockWindowMin` minutes; the index root is the root itself or its nearest indexed ancestor (up to 8 levels up).
- **Partitioning uses the root session** (walked up `header.parentSession`): the main agent and its subagents **share one quota**. Degradation never throws - a missing parent stops at the last known hop, a cycle stops before the first repeat.
- **"Indexed" means `<root>/.zvec-grep/manifest.json` exists *and* parses** with `manifestVersion` strictly 1 and `rootPaths` covering this directory (normalized equality, `/private` prefix stripped on macOS). The directory name alone is not enough - it is also zg's global home (`~/.zvec-grep`), and an existence-only check misreads a truncated or foreign manifest as "indexed", deadlocking both search and the gate.
- The whitelist and unlock tables live in bounded memory (64 roots / 256 partitions) with touch-on-hit, expiry-then-LRU eviction; whitelist entries carry a one-day validity.
- `enforceSearchFirst=false` disables only the gate; the confirm and root backstops stay.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Namespace `zvec-grep` equals the settings entry id; the schema has 16 fields with built-in defaults, 6 of them volatile and on the card.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `defaultEmbedding` | string | `local/qwen3-embedding-0.6b` | Embedding for **new** indexes; switching an existing one needs a rebuild |
| `defaultLimit` | natural, 1-50 | `10` | Default hit limit for `zg_search` |
| `hfEndpoint` | string | China-reachable HF-compatible mirror | Another mirror, or empty for the official HF |
| `enforceSearchFirst` | boolean | `true` | The search-first gate |
| `grepBudgetPerSearch` | natural, 1-20 | `3` | grep/rg calls each successful search re-arms |
| `unlockWindowMin` | natural, 1-240 | `10` | Minutes that quota stays valid |

There are also **non-volatile deployment values**, 10 of them off the card; the row `config:` in `cordis.yml` is the only way to change them: `searchTimeoutMs=300000`, `statusTimeoutMs=60000`, `indexTimeoutMs=600000` (also the rebuild kill timer), `stdoutMaxBytes=400000`, `clientMode=auto`, `rebuildWaitMs=120000`, the remote-embedding trio and `requireApprovalForExplicitRoot` (below). Precedence: card value > row config > `.default()`; an explicitly absent row field does not override.

### Remote embedding

Off by default: `allowRemoteEmbedding=false`, `remoteEmbeddingEndpoint=""`, `remoteEmbeddingApiKeyFrom=""`. While off, an explicit embedding must be in the local catalog at assembly time. Once open:

- Endpoint and credential reach zg **only via environment variables** (`ZVEC_GREP_ENDPOINT` / `ZVEC_GREP_API_KEY`), never argv - the command string is echoed as a job label on the card.
- The credential field holds the **name** of the host env var carrying the secret, not the secret; the host scrubs inherited KEY/SECRET/TOKEN names, so only an explicit forward reaches zg.
- The plugin does **not** pass `--allow-remote`: zg still requires a one-time `zg auth grant <root> --capability embedding --scope workspace`.

### Asking before an explicit root

`requireApprovalForExplicitRoot=false` by default. When on, an explicit `root` that would pass via the "ancestor or descendant" branch triggers one user confirmation (`tools/pre-execute` → `{kind:'ask'}` → `ctx.approval`). The ask shares the root predicate (`judgeRoot`), so calls that would be refused anyway - or need no authorization - are not bothered. Three dead ends are known: `never`-approval presets reject the ask deterministically, delegated subagents are pinned to `never` (the switch has no effect there), and a missing approval service fails closed. The confirmation **only ever adds** a step: an out-of-scope root stays refused even after approval.

## <img src="https://api.iconify.design/lucide/monitor.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Support surface

- **POSIX hosts (Linux / macOS).** The root predicate accepts only `/`-rooted absolute paths, the command line is POSIX-shaped (`shq()` escaping into `bash -c`), and the manifest comparison splits on `/`.
- **Windows is out of scope, fail-fast.** A `C:\Users\…` workspace makes all three tools refuse at the root check with the reason - no wrong-path zg command is ever built. Real support means changing the predicate itself (drive letters/UNC, a second command form, `/`-based tokenising); that is a design change this package does not pretend to make.
- **CI splits accordingly**: the ubuntu job is the full gate (including the four 100% coverage thresholds); other platforms run only the checks that need no on-disk workspace and do not judge coverage. The reasoning lives in `.github/workflows/ci.yml`.

## <img src="https://api.iconify.design/lucide/cpu.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> External dependency

- The binary dependency is **zg** (`npm install -g @zvec/zvec-grep`). Not on PATH → exit 127 → "zg is not installed or not on PATH", kept separate from "the sandbox runner never started".
- Upstream is `@zvec/zvec-grep` (provides the `zg` bin), repository https://github.com/zvec-ai/zvec-grep, **Apache-2.0**. This package shells out to the CLI; it contains and redistributes no upstream source.
- Version floor `0.2.2` (`MINIMUM_ZG_VERSION` in `lib/zg-version.ts`): below it the plugin stops before dispatch and names the actual version - older releases can parse the same argv as something else entirely.
- Local embeddings load through zg's backends (qwen3/embeddinggemma via llama-cpp, potion-* via model2vec, the rest via transformers-js); weights download with `HF_ENDPOINT` injected from `hfEndpoint`.

## <img src="https://api.iconify.design/lucide/server.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Daemon (server mode)

- Direct and server are **two capability surfaces**, not a speed knob: direct cold-loads the embedding model on every query; watcher-driven incremental refresh, `refresh=background` and a resident model pool exist only in server mode. Upstream probes readiness for `auto` but never starts a daemon.
- This package does not start one either - `zg server on` leaves a detached process and a token file, which is the user's decision. It makes the difference **explicit** instead: the exit code of `zg server status --check-ready` is cached for 60 s (a failed probe counts as "not ready", never an infrastructure error), gates `refresh=background`, and is echoed once in `zg_status` output and once on the card. Only the `roots()` read issues the probe.
- The card's `serverReady` is only ever `true` / `false`; when the probe cannot answer, that arm renders nothing rather than "not ready". To get the benefits, run `zg server on` in a terminal.

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

One official Typert Remote namespace, `zvecGrepRebuild`, installed on the apply fiber. No `/_dsh/*` routes, no CSRF token, no package-owned body cap - the host `/api` gateway owns all of that.

| Method | Input | Reply |
| --- | --- | --- |
| `roots()` | - | `{ roots, serverReady }` - observed whitelist plus the readiness line; `serverReady` is `undefined` when the probe cannot answer |
| `rebuild({ root })` | an absolute root | `{ ok: true, jobId, reused? }` or `{ ok: false, error, status }` |
| `status({ jobId })` | a job id from this package | `{ status, exitCode, root, output }` (plus `sandbox` when present) or `{ ok: false, error, status: 404 \| 503 }` |

- `rebuild` refuses non-`/`-rooted paths, roots outside the observed whitelist and vanished directories; with no `jobs` service nothing is spawned (503 arm). The per-root claim is taken before the first `await` - a second click follows the running rebuild (`reused: true`) instead of starting a second `zg` on the same index; a failed start releases the claim, so no tree stays "rebuilding".
- `status` answers only for ids in this package's side table (the last 10 settled records; running ones are never displaced) - somebody else's job cannot be read through it. The card polls every 2 s. A refusal's `status` is a **retained semantic code, not an HTTP status**, and no method throws through the gateway - a rejected call would read as one generic failure and stop the polling on a rebuild that is still running.
- Concurrency is decided by the **host registry** (measured default: the unowned bucket holds 10); when full, `rebuild` returns the official refusal naming the limit and never kills a running rebuild.

## <img src="https://api.iconify.design/lucide/boxes.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The background job surface

A "rebuild workspace" run is one **unowned** job in the host's `ctx.jobs` (`kind: "zvec-grep-rebuild"`, id `zvec-grep-rebuild-<hex>`). Consequences:

- **The model can see it.** The official `job_list` / `job_output` / `job_kill` tools list the rebuild (exit code / signal in `detail`, same shape as the host's bash tool); output rides the official pull source, so the ring advances even with the panel closed.
- **Unowned means visible to every session** - a known, accepted exposure of adopting the official registry; rolling the adoption back is the only way to close it. The `status` read still answers only this package's side table.
- **Two more status words**: `stopping` (cancellation issued, not settled - shown as still running) and `failed` (the registry's own verdict, with its own message).
- The output ring keeps **UTF-8 bytes** (measured host default 262144) while the card's tail window counts **UTF-16 code units** - for CJK output the window is about 1/3 smaller than before the adoption. "Truncated" means the ring evicted its head; "buffer overflow" means bytes are really gone. The timeout notice and sandbox facts are synthesized at projection time, never written into the ring, and polling folds a reloaded registry's "unknown job" into a refusal instead of throwing through.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Content |
| --- | --- |
| Written to disk | Nothing by this package. The only on-disk shape is the `.zvec-grep/` index directory under the searched root, written by zg; nothing lands in the host data directory |
| What it reads | The index probe: one existence check plus one manifest read |
| Network | Only the embedding-weight download driven by `hfEndpoint`, performed by zg. Remote embedding is off by default and is a deployment decision |
| Secret exclusion | Excluded by default, case-insensitively and after your own path rules: `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.keystore` / `*.jks` / `*.ppk` / `id_rsa*` / `id_ed25519*` (excludeSecrets=false to allow). Extensionless key files are not covered - declare them via ignoreFiles |
| Hidden files | Skipped; ignore files honoured, unless noIgnore is set |
| Echoes | Bounded: stdout over the cap keeps the tail; the last 400 chars of stderr are appended. Only recognised indexing progress is dropped from stderr - degradation notices, lock conflicts and any unrecognised warning are kept; `Indexing complete` matches on whole-line equality so the partial-failure variant is never swallowed |
| Rebuild paths | Model-side `zg_index` (rebuild=true, confirm=true) or the card button; deleting is `zg_index` with drop=true. On unload the side table is reclaimed and running jobs are killed through the registry |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **Windows hosts are not supported** - the failure is an explicit refusal, not a wrong answer.
- **Extensionless key files** are outside the secret-exclusion rules; `id_rsa*` / `id_ed25519*` cover only the OpenSSH default names.
- **An unowned rebuild job is visible to every session** - accepted exposure of the official job registry.
- **The CJK output window shrank about a third** with the official ring (UTF-8 bytes vs UTF-16 code units).
- **zg failures without a `Code:` line cannot be attributed by code**; such replies carry a pointer to `--debug` (not passed by default - it would bloat the bounded echo these tools share).
- **Exhaustive search grants no quota and no semantic conclusion**; every automatic fallback says so up front.
- **The ask switch has three dead ends** (never-ask presets, delegated subagents, no approval service) - spelled out under Settings, not hidden.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| grep/rg refused with "no zg_search has run yet" | The search-first gate; run zg_search. Quota spent or expired - re-search with a sharper query to refresh it, no need to disable the plugin. |
| Search times out | Default `--refresh wait` refreshes synchronously; narrow with globs/fileTypes, lower the limit, or start the daemon - direct mode cold-loads the embedding model on every call, which is why that budget is 5 minutes. |
| Rebuild refused with "not in the workspace whitelist" | That directory never had a session in this daemon; start one there first, or let the model call zg_index with confirm=true. |
| Card reports a failed rebuild although zg looks finished | Success is "completed with exit 0" - exit 127 (zg missing) also lands in completed; read the output tail. |
| A root that was never indexed | zg_search fails loudly; building happens only via zg_index on an explicit request. |
| Changed the embedding but semantic hits are missing | Switching embedding takes effect only after a rebuild with rebuild=true. |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck (three tsconfig programs) → lint → both bundle builds → vitest with coverage → format check
```

- Tests come in three tiers: `test/*.test.ts` (unit + mocked host context), `test/integration/*` (real host services driven through `ctx.tools.execute()` / actual `fetch`), and `test/e2e/zg-cli.test.ts` (no plugin, no mock - the built command lines against the **real zg CLI**). Host-contract bugs surface in the middle tier: a mocked context can only agree with what this package already believes.
- Coverage is **100%** across four metrics over the opted-in surface (`host.ts` + `lib/**`); the client half (`src/**`) is deliberately outside the denominator and is exercised through the bundle.
- `host.js` / `client.js` are not committed; `prepare` / `prepack` rebuild them and two tests compare the on-disk bundle against an in-memory build byte for byte. Never hand-edit the bundles.
- Manifest gates (`test/publish-manifest.test.ts`) guard the published surface: entry targets covered by `files`, host packages out of `dependencies`, `dsh-*` pinned exactly, no local paths in artifacts. `test/dist-size.test.ts` budgets bundle bytes; `test/readme-parity.test.ts` keeps both READMEs structurally in sync.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT - see [LICENSE](LICENSE). Source at [github.com/JayYuen666/dsh-zvec-grep](https://github.com/JayYuen666/dsh-zvec-grep). Issues go to that repository's tracker.

The `zg` CLI is upstream `@zvec/zvec-grep`, licensed **Apache-2.0**. This package contains no upstream source and bundles no upstream license text; if you redistribute the two together, keep each project's notices intact. [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records that boundary.
