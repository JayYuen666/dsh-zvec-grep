# Zvec indexed search

Searches the workspace through a local index instead of raw grep, and can require an indexed search before plain `grep` / `rg` are allowed.

## What the card changes

- **Search model** — `defaultEmbedding` (default `local/qwen3-embedding-0.6b`, about 640 MB) applies to **new** indexes only; an existing index keeps its model until it is rebuilt. The dropdown has a local and a remote group: the remote qwen models (three, new in 0.3.0) additionally require `allowRemoteEmbedding` in the deployment config — remote embedding sends workspace content to an external endpoint, and the first index build needs a one-time user authorization via `zg --auth grant`. `defaultLimit` (1–50, default 10) is how many hits each result group returns.
- **Network and indexing** — the **search transport** (`transport`, new in 0.3.0) has three settings: auto = searches go through the daemon (MCP) when it is running, CLI otherwise; CLI-only = never touch the daemon; MCP-only = searches always go through the daemon, auto-starting it when absent (opens the `127.0.0.1:7999` loopback port; a failed start is reported explicitly, never silently downgraded). `hfEndpoint` defaults to the ModelScope mirror (`https://modelscope.cn/models`); leaving it empty means huggingface.co, which this environment typically cannot reach, so the default should stay. `enforceSearchFirst` (on) gates `grep` / `rg` inside indexed workspaces. `grepBudgetPerSearch` (default 3) is how many plain searches each successful `zg_search` unlocks, and `unlockWindowMin` (default 10) is how many minutes that unlock stays valid. Expiry is checked whenever the budget is read, so an elapsed window stops granting searches without a restart; the per-session table keeps at most 256 sessions and evicts the least recently used one first. When the step's tool admission does not include `zg_search`, the gate stands down rather than forcing a call the step cannot make.

These are read per call and take effect without restarting the host.

## Concurrency and platforms

- **Within one host**, concurrent cold starts coalesce into one `zg --server on`. **Multiple hosts** sharing the same `ZVEC_GREP_HOME` share one daemon (upstream `instance.lock`; a duplicate start exits 0 with the same PID). The token is claimed atomically with O_EXCL, so later processes read the same value instead of overwriting each other; only the process that created the file stops the daemon it started on unload.
- One zg MCP session handles one `tools/call` at a time (measured: a second concurrent call on the same session hangs until the caller's deadline), so every concurrent tool call gets its own session and idle sessions are reused. Index-job concurrency (default 2) and same-root writer reuse belong to the upstream scheduler.
- Searches wait only while a same-root index rebuild holds the write lock, bounded by `rebuildWaitMs`; cold starts do not queue.
- **Platforms**: POSIX accepts `/…` roots and uses bash single-quote escaping; Windows accepts drive-letter/UNC roots, uses pwsh escaping (embedded `'` becomes `''`), strips executable extensions such as `.exe`/`.cmd` from command names, and lowers the command-size cap to 24,000 bytes for the CreateProcess limit. Real on-disk Windows behavior is exercised by the CI `windows-latest` grid; local runs cover the same predicates with platform-injected win32 fixtures.

## The Rebuild action is not a setting

The card's Rebuild button runs the equivalent of `zg --index --rebuild` for a workspace the daemon has already observed; it is an action, not a stored preference. No approval prompt fires on this path: the pre-execute approval only covers the `zg_*` tools when they name an explicit root, and Remote methods do not go through tool admission. What guards the action is the daemon's list of observed roots (plus its own single-operation lock).

## Restart-only values

Eleven deployment values stay off the card: `searchTimeoutMs` (300000), `statusTimeoutMs` (60000), `indexTimeoutMs` (600000), `stdoutMaxBytes` (400000), `rebuildWaitMs` (120000), `clientMode` (`auto` / `direct` / `server`), `daemonUrl` (`http://127.0.0.1:7999/mcp`, the MCP transport's daemon endpoint), `allowRemoteEmbedding` (false), `remoteEmbeddingEndpoint`, `remoteEmbeddingApiKeyFrom`, `requireApprovalForExplicitRoot` (false). None of these eleven has a card control; the only thing that makes them take effect is the `config:` block of the registration row in the next paragraph, and precedence is row `config:` > the `.default()` in code.

Whether workspace content may leave the machine at all is treated as a deployment decision rather than a model-visible choice, which is why the remote-embedding trio appears in neither the card nor the tool parameters; and even when it is enabled, `zg` itself still requires `--allow-remote` (added automatically by this plugin to remote-reference index commands once the deployment switch is on) or a one-time persistent `zg --auth grant`. Set all of these in the `config:` block of this plugin's row in your profile's `cordis.yml` (the `cordis.patch.yml` shipped in this package carries that row's `id` / `name` plus a second, **id-less** entry for `@jayyuen66/dsh-plugin-shared` that supplies the card components — deleting it leaves the settings card without its component supplier); they take effect on restart.

## What it needs from outside

The external `zg` CLI (`@zvec/zvec-grep`, installed with `npm install -g @zvec/zvec-grep`). The plugin enforces a version floor of **0.3.0** (the Rust rewrite's CLI shape; 0.2.x is rejected at the gate) before it builds any command and says so when the installed one is older; a missing CLI is reported as such instead of failing a search. Incremental index refresh, `refresh=background` and the resident model pool need the daemon running (`zg --server on`, or `transport=mcp` lets the plugin start one) — when it is offline the card says so. Local embedding backends may require their own native dependency (llama-cpp needs `node-llama-cpp`; model2vec and transformers-js are pure JavaScript). When `allowRemoteEmbedding` is on, the plugin forwards two variables to `zg`: `ZVEC_GREP_ENDPOINT` carries the literal value of `remoteEmbeddingEndpoint` (the deployment endpoint, not a variable name), and `ZVEC_GREP_API_KEY` is the secret looked up from the variable named by `remoteEmbeddingApiKeyFrom`. The key is passed explicitly because the host's subprocess layer strips secret-shaped variables.

## Further detail

The error-code table, the argument guards and the background-job surface are in the package README (`README.md` / `README.zh-CN.md`).
