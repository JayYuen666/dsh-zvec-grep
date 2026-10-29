# Zvec indexed search

Searches the workspace through a local index instead of raw grep, and can require an indexed search before plain `grep` / `rg` are allowed.

## What the card changes

- **Search model** — `defaultEmbedding` (default `local/qwen3-embedding-0.6b`, about 640 MB) applies to **new** indexes only; an existing index keeps its model until it is rebuilt. `defaultLimit` (1–50, default 10) is how many hits each result group returns.
- **Network and indexing** — `hfEndpoint` defaults to the ModelScope mirror (`https://modelscope.cn/models`); leaving it empty means huggingface.co, which this environment typically cannot reach, so the default should stay. `enforceSearchFirst` (on) gates `grep` / `rg` inside indexed workspaces. `grepBudgetPerSearch` (default 3) is how many plain searches each successful `zg_search` unlocks, and `unlockWindowMin` (default 10) how many minutes that unlock stays valid — unlock entries age out on their own TTL and LRU, so they do not wait for a restart. When the step's tool admission does not include `zg_search`, the gate stands down rather than forcing a call the step cannot make.

These are read per call and take effect without restarting the host.

## The Rebuild action is not a setting

The card's Rebuild button runs the equivalent of `zg index --rebuild` for a workspace the daemon has already observed; it is an action with an approval prompt, not a stored preference.

## Restart-only values

Ten deployment values stay off the card: `searchTimeoutMs` (300000), `statusTimeoutMs` (60000), `indexTimeoutMs` (600000), `stdoutMaxBytes` (400000), `rebuildWaitMs`, `clientMode` (`auto` / `direct` / `server`), `allowRemoteEmbedding` (false), `remoteEmbeddingEndpoint`, `remoteEmbeddingApiKeyFrom`, `requireApprovalForExplicitRoot` (false).

Whether workspace content may leave the machine at all is treated as a deployment decision rather than a model-visible choice, which is why the remote-embedding trio appears in neither the card nor the tool parameters; and even when it is enabled, `zg` itself still requires `--allow-remote` or `zg auth grant`. Set all of these in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

## What it needs from outside

The external `zg` CLI (`@zvec/zvec-grep`, installed with `npm install -g @zvec/zvec-grep`). The plugin enforces a version floor of **0.2.2** before it builds any command and says so when the installed one is older; a missing CLI is reported as such instead of failing a search. Incremental index refresh, `refresh=background` and the resident model pool need the daemon running (`zg server on`) — when it is offline the card says so. Local embedding backends may require their own native dependency (llama-cpp needs `node-llama-cpp`; model2vec and transformers-js are pure JavaScript). `ZVEC_GREP_ENDPOINT` and `ZVEC_GREP_API_KEY` are read as environment references; the key is forwarded explicitly because the host's subprocess layer strips secret-shaped variables.

## Further detail

The error-code table, the argument guards and the background-job surface are in the package README (`README.md` / `README.zh-CN.md`).
