// lib/sandbox-note.ts —— 把执行器交出的沙箱事实翻成给人看的一句。
//
// 为什么单列：前台工具的执行结局与后台重建的轮询投影读的是**同一批事实**（runner
// 失败 / 策略拒绝），两处各写一份措辞就会出现「同一个沙箱故障，检索说 A、重建卡片说 B」。
// 措辞本体在 lib/messages.ts，这里只做归因。

import type { ShellExecution, ShellSandboxInfo } from "@deepseek-ai/dsh-shell";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/** 沙箱事实的公共后缀（把 mode/enforcement 一并交代清楚，避免只说「被拒」）。 */
export function sandboxFacts(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  const enforcement =
    info.enforcement === undefined
      ? ""
      : fill(messages.sandboxEnforcement, { value: info.enforcement });
  return fill(messages.sandboxFacts, { mode: info.mode, enforcement });
}

/** 沙箱策略拒绝的可读说明（拒绝 ≠ 崩溃：既用于失败消息，也用于成功但残缺的结果）。 */
export function deniedNote(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  return fill(messages.sandboxDenied, { facts: sandboxFacts(info, messages) });
}

/**
 * 后台进程的沙箱事实提示。runner 失败 / 策略拒绝都不许被显示成「完成」：
 * dsh-shell 只在有沙箱的执行器下填 proc.sandbox，读了它才能把「zg 自己失败」
 * 与「zg 根本没跑起来」分开。
 */
export function procSandboxNote(proc: ShellExecution, messages: ZvecGrepMessages): string | null {
  const info = proc.sandbox;
  if (info === undefined) {
    return null;
  }
  if (info.runnerFailed === true) {
    return fill(messages.rebuildRunnerFailed, { facts: sandboxFacts(info, messages) });
  }
  if (info.denied) {
    return fill(messages.rebuildDenied, { denied: deniedNote(info, messages) });
  }
  return null;
}
