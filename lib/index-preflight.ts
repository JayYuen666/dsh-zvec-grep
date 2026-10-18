// lib/index-preflight.ts —— `zg index` 入参里那些「命令还没起就得先看盘」的预检。
//
// 为什么先于命令构造（全部实测，见 test/e2e/zg-cli.test.ts）：真 zg 遇到读不成的
// ignore 文件**不是**按「没有这条规则」继续，而是整次索引失败
// （`ZVEC_GREP.ENGINE.INDEXING.WORKSPACE_FAILED`，原因是 ENOENT / EACCES / EISDIR），
// 并且那个坏路径会**写进工作区索引的状态**——此后这条树上的 `zg index` 与 `zg status`
// 都报同一个错，`--reset-paths` 清不掉，只有 `zg_index drop`（整棵索引删掉重来）能救。
// 一个拼错的文件名、一个存在但读不了的文件、或一个目录，就把用户的工作区索引弄坏。

import { accessSync, constants, statSync } from "node:fs";
import { singleOrList } from "./argv-guard.ts";
import { boolOf } from "./cli.ts";
import type { IndexArgs } from "./cli.ts";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

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
 * drop 那一臂整段跳过：`--drop` 的命令只有 `zg index <root> --drop --yes`，ignoreFiles 被
 * buildIndexCommand 静默丢掉、根本不进 zg（见 lib/cli.ts 的 drop 分支），预检它没有意义，还会
 * 拿"给一个真实存在的忽略文件"这句误导文案把一次合法的删索引拦下。判 drop 用与构造器**同一个**
 * `boolOf`，两处口径不会漂。
 * @param args 索引入参（`ignoreFiles` 单值或数组；`drop` 为真时整段跳过）
 * @param root 已归一的工作区根（相对路径按它解析）
 * @param messages 文案表
 * @returns {void}
 * @throws Error 指向第一个不可用的条目（不静默丢弃用户给的那一项）
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
    const target = entry.startsWith("/") ? entry : `${root}/${entry}`;
    let usable = false;
    try {
      // 先判可读（不存在 / 无权限 / 父目录不可搜索都在这里抛），再判是普通文件（挡掉目录）。
      accessSync(target, constants.R_OK);
      usable = statSync(target).isFile();
    } catch {
      // 读不到就不是可用文件：保留初始的 false，统一走下面那句文案。
    }
    if (!usable) {
      throw new Error(fill(messages.ignoreFileMissing, { path: entry, root }));
    }
  }
}
