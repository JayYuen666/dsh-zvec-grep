// lib/index-preflight.ts —— `zg index` 入参里那些「命令还没起就得先看盘」的预检。
//
// 为什么先于命令构造（全部实测，见 test/e2e/zg-cli.test.ts）：真 zg 遇到读不成的
// ignore 文件**不是**按「没有这条规则」继续，而是整次索引失败
// （`ZVEC_GREP.ENGINE.INDEXING.WORKSPACE_FAILED`，原因是 ENOENT / EACCES / EISDIR），
// 并且那个坏路径会**写进工作区索引的状态**——此后这条树上的 `zg index` 与 `zg status`
// 都报同一个错，`--reset-paths` 清不掉，只有 `zg_index drop`（整棵索引删掉重来）能救。
// 一个拼错的文件名、一个存在但读不了的文件、或一个目录，就把用户的工作区索引弄坏。
//
// 这是**尽力而为**的前置拦截：预检与 zg 真正打开文件之间存在竞态（检查通过后文件仍可能
// 被删、被改权限、或被目录顶替），预检通过不等于 zg 侧一定成功——它只把「当场就能判定的
// 坏路径」提前到命令构造之前，不消除那一档竞态。

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { singleOrList } from "./argv-guard.ts";
import { boolOf } from "./cli.ts";
import type { IndexArgs } from "./cli.ts";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/**
 * 预检判「文件不合适」时接受的家庭错误码：其余（fd 耗尽、链接环、IO 错误等环境故障）
 * 与用户给的路径无关，原样上抛——把 EMFILE 说成「请给一个真实存在的文件」会把排查
 * 引向错误的方向。
 */
const UNUSABLE_FILE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EISDIR",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/** node:fs 的失败一律是带 string code 的 Error 实例；形状不合（非对象、无 code、码非串）
 *  一律按环境故障处理。导出只为把非 Error 形状的判别面钉进单测（真 fs 抛不出这些）。 */
export function isUnusableFileCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code: unknown = error.code;
  return typeof code === "string" && UNUSABLE_FILE_CODES.has(code);
}

/**
 * `ignoreFiles` 的可用性预检：模型给的第 N 条忽略文件必须是**当前进程读得了的普通文件**。
 *
 * 判据「读得了 + 是文件」合成**一次** try（accessSync 在前）：`statSync().isFile()` 对 mode 000
 * 的文件照样返回 true（stat 只要父目录可搜索、不要文件本身可读），故先 `accessSync(R_OK)` 补上
 * "当前进程真能 open 来读"这半段——它与 zg 的读权限同 uid 同源（root 下两者都放行、非 root 下
 * 两者都拒）；再用 `isFile()` 挡掉目录。**不拆成「不存在」与「读不了」两条独立分支**：可读性那
 * 一档在 windows（chmod 只翻只读位，属主仍读得了）与 root（绕过 DAC）下根本造不出来，拆成独立
 * 分支会让 CI 的 windows 那格在 100% 覆盖率门禁下无从而钉（本仓不用 coverage-ignore 逃生口）。
 * 合成一句「不是存在且可读的文件」文案，三种成因都准确覆盖，且 catch 由「不存在」这一档跨平台钉住。
 *
 * drop 那一臂整段跳过：drop 的命令不含 ignoreFiles，且构造器对「drop 携带索引侧参数」会
 * 点名拒绝（见 lib/cli.ts 的 buildIndexCommand）——预检既没有可查的对象，也没有机会跑到；
 * 若照跑，反而会拿"给一个真实存在的忽略文件"这句误导文案把一次合法的删索引拦下。
 * 判 drop 用与构造器**同一个** `boolOf`，两处口径不会漂。
 * @param args 索引入参（`ignoreFiles` 单值或数组；`drop` 为真时整段跳过）
 * @param root 已归一的工作区根（相对路径按它解析）
 * @param messages 文案表
 * @returns {void}
 * @throws Error 指向第一个不可用的条目（不静默丢弃用户给的那一项）；node:fs 的环境类
 *   故障（非文件形状问题）原样上抛
 */
export function assertIgnoreFilesExist(
  args: IndexArgs,
  root: string,
  messages: ZvecGrepMessages,
): void {
  if (boolOf(args.drop, "drop", messages)) {
    return;
  }
  for (const entry of singleOrList(args.ignoreFiles, "ignoreFiles", messages)) {
    // node:path 表达同一语义：绝对条目原样用，相对条目按 root 解析（顺带归一 `..`/`.`/
    // 重复分隔符）。文案只收解析后的目标，绝对条目不再被说成「在 root 下」。
    const target = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
    let usable = false;
    try {
      // 先判可读（不存在 / 无权限 / 父目录不可搜索都在这里抛），再判是普通文件（挡掉目录）。
      accessSync(target, constants.R_OK);
      usable = statSync(target).isFile();
    } catch (error) {
      if (!isUnusableFileCode(error)) {
        throw error;
      }
      // 文件形状不合适：保留初始的 false，统一走下面那句文案。
    }
    if (!usable) {
      throw new Error(fill(messages.ignoreFileMissing, { path: target }));
    }
  }
}
