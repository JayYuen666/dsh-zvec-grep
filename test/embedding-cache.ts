// test/embedding-cache.ts —— 「这枚本地 embedding 的权重在不在缓存里」的唯一探测。
//
// 为什么单列：四份测试文件原先各抄一遍同一段 existsSync，且每份都把 qwen 的 gguf 也算作
// 「就绪」，而那四份用例递给出的都是 potion-code-16m-v2 —— 于是缺 potion 权重的机器不会跳过，
// zg 转头联网下载模型，用例以超时收场，环境缺件被读成代码缺陷。

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 各枚测试用 embedding 的缓存位置，相对 `<缓存根>/models`。model2vec 后端那一层的形状是
 * `<后端目录>/<HF repo，/ 换成 -->/<revision>/<权重文件>`：前两段与权重文件名分别来自上游
 * engine/models/backends/model2vec.ts 的 cacheDirectory 与 engine/models/catalog.ts 的 artifacts。
 */
const CACHE_PATHS: ReadonlyMap<string, { repo: readonly string[]; artifact: string }> = new Map([
  [
    "local/potion-code-16m-v2",
    {
      repo: ["model2vec", "minishlab--potion-code-16M-v2"],
      artifact: "model.safetensors",
    },
  ],
]);

/**
 * 传进来的那一枚 embedding 是否已离线可用。
 *
 * - 只认传进来的取值：别的模型的权重在场替代不了它。
 * - 取值没登记就抛，而不是返回 false：静默 false 会让整组用例长期 skip，那比红难查得多。
 * - 缓存根按上游那条规则取：`ZVEC_GREP_HOME` 优先于 `~/.zvec-grep`（上游
 *   engine/utils/path.ts 的 defaultHome）。本包从不传 `--model-cache`，所以没有第三种写入位置。
 * - `revision` 那一层不写死 sha：它跟着上游 catalog 的取值变，写死就等于把「有没有权重」
 *   换成「是不是上游当期 pinned 的那一版」，上游改版时整组用例静默消失。
 */
export function embeddingCached(reference: string): boolean {
  const location = CACHE_PATHS.get(reference);
  if (location === undefined) {
    throw new TypeError(`本地缓存探针不认这枚 embedding：${reference}`);
  }
  const home = process.env["ZVEC_GREP_HOME"] ?? path.join(homedir(), ".zvec-grep");
  const repoDir = path.join(home, "models", ...location.repo);
  let revisions: string[];
  try {
    revisions = readdirSync(repoDir);
  } catch {
    return false;
  }
  return revisions.some((revision) => existsSync(path.join(repoDir, revision, location.artifact)));
}
