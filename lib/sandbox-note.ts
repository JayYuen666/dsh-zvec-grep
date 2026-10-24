// lib/sandbox-note.ts —— 把执行器交出的沙箱事实翻成给人看的一句。
//
// 为什么单列：前台工具的执行结局与后台重建的轮询投影读的是**同一批事实**（runner
// 失败 / 策略拒绝），两处各写一份措辞就会出现「同一个沙箱故障，检索说 A、重建卡片说 B」。
// 措辞本体在 lib/messages.ts，这里只做归因。

import type { ShellExecution, ShellSandboxInfo } from "@deepseek-ai/dsh-shell";
import { fill } from "./messages.ts";
import type { ZvecGrepMessages } from "./messages.ts";

/**
 * 沙箱事实的公共后缀（把 mode/enforcement 一并交代清楚，避免只说「被拒」）。
 * enforcement 只认非空串：经序列化/反序列化的运行态数据可能交回空串，拼进模板
 * 会产出「enforcement=」这类残缺后缀——缺席与空白同归「不交代」。
 */
export function sandboxFacts(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  const enforcement =
    info.enforcement === undefined || info.enforcement.length === 0
      ? ""
      : fill(messages.sandboxEnforcement, { value: info.enforcement });
  return fill(messages.sandboxFacts, { mode: info.mode, enforcement });
}

/**
 * 把「事实后缀」填进一条模板的统一入口：本文件与 host.ts 的 runnerFailed 共用，
 * 新增失败类别时漏掉 `sandboxFacts` 包裹或参数名写错都会在编译期红。
 */
export function noteWithFacts(
  template: string,
  info: ShellSandboxInfo,
  messages: ZvecGrepMessages,
): string {
  return fill(template, { facts: sandboxFacts(info, messages) });
}

/** 沙箱策略拒绝的可读说明（拒绝 ≠ 崩溃：既用于失败消息，也用于成功但残缺的结果）。 */
export function deniedNote(info: ShellSandboxInfo, messages: ZvecGrepMessages): string {
  return noteWithFacts(messages.sandboxDenied, info, messages);
}

/**
 * 后台进程的沙箱事实提示。runner 失败 / 策略拒绝都不许被显示成「完成」：
 * dsh-shell 只在有沙箱的执行器下填 proc.sandbox，读了它才能把「zg 自己失败」
 * 与「zg 根本没跑起来」分开。
 *
 * 分支次序是刻意的：runnerFailed 优先于 denied——runner 都没起来时 zg 未被执行，
 * 策略根本没有可拒绝的动作，denied 那一位在那一档不成立；调整次序会无声改变
 * 同时携带两位时的归因。
 */
export function procSandboxNote(proc: ShellExecution, messages: ZvecGrepMessages): string | null {
  const info = proc.sandbox;
  if (info === undefined) {
    return null;
  }
  if (info.runnerFailed === true) {
    return noteWithFacts(messages.rebuildRunnerFailed, info, messages);
  }
  if (info.denied) {
    return fill(messages.rebuildDenied, { denied: deniedNote(info, messages) });
  }
  return null;
}
