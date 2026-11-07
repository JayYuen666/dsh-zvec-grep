// lib/daemon-token.ts —— transport=mcp 自启 daemon 的 token 持久化（崩溃/重启可恢复）。
//
// 为什么落盘：token 只在内存里时，插件崩溃/重启后旧 daemon 仍在而令牌已失——CLI 管理命令
// 与 MCP 调用都会撞 401，用户只能按 PID 杀进程。持久化到 zg 自己的 home 下（0600）后，
// 新实例能读同一枚 token 继续认证；只有**本次真正自启** daemon 的会话才会在卸载时停它
// （见 host.ts 的 startedByUs），避免把用户自己起的 daemon 当成自己的停掉。
//
// 安全边界：token 本来就在 daemon 的子进程环境里（同用户进程可读），落盘不扩大同一用户内
// 的暴露面；文件权限仍按 0600 写。路径由 `ZVEC_GREP_HOME`（zg 的运行时目录）决定，
// 默认 `~/.zvec-grep/dsh-zvec-grep.token`；不写进发布包、不写宿主数据目录。

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** 文件名（放在 zg home 下，与 daemon 的 instance.lock / logs 同级）。 */
const TOKEN_FILE_NAME = "dsh-zvec-grep.token";

/** 上游要求 token ≥32 字符且无控制字符；这里用更保守的可见 ASCII 子集。 */
const TOKEN_SHAPE = /^[\u0021-\u007E]{32,}$/u;

/**
 * token 文件的默认路径：`ZVEC_GREP_HOME` 优先于 `~/.zvec-grep`（与上游 daemon 的 home
 * 规则同源），文件名固定。
 * @param env 环境变量表（测试可注入）
 * @returns 绝对路径
 */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["ZVEC_GREP_HOME"] ?? path.join(homedir(), ".zvec-grep");
  return path.join(home, TOKEN_FILE_NAME);
}

/** 读持久化 token；文件缺失/不可读/形状不合一律 undefined（不猜、不半信）。 */
export async function readPersistedToken(file: string): Promise<string | undefined> {
  let token: string | undefined;
  try {
    const raw = await readFile(file, "utf8");
    const trimmed = raw.trim();
    token = TOKEN_SHAPE.test(trimmed) ? trimmed : undefined;
  } catch {
    // 读不到按「没有」处理：调用方会生成新 token 并覆盖。
  }
  return token;
}

/**
 * 原子写入 token（同目录临时文件 → rename），权限 0600。失败**不外抛**：持久化只是恢复
 * 路径的增强，写不进去时本次会话仍用内存 token，恢复退化为 daemonStartFailed 的指引。
 * @param file 目标路径
 * @param token 待写入的 token
 * @returns 是否写入成功（测试用；生产调用可忽略）
 */
export async function persistToken(file: string, token: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${String(process.pid)}.tmp`;
    await writeFile(temporary, token, { mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** 一次 token 认领的结果：最终使用的 token 与「是不是本进程创建的」。 */
export interface ClaimedToken {
  readonly token: string;
  /**
   * 文件由本次调用以 O_EXCL 创建 ⇒ 本进程是持久化 token 的第一位声明者。多进程同时
   * 自启时只有一位拿到 true；只有它会在卸载时停掉自己拉起的 daemon（见 host.ts）。
   */
  readonly owned: boolean;
}

/** `wx` 撞上已有文件时 Node 交回的错误码；只认这一种，其余按「写不进去」处理。 */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

/**
 * 读 token 并允许极短的可见性重试：并发的 `wx` 失败方看到文件已存在时，成功方可能
 * 刚 open 完还没写完内容，此刻读会得到空串。让出事件循环再读，最多三次；仍读不出
 * 才按「坏文件」处理（那时才允许删除重建）。
 */
async function readTokenRetrying(file: string, attempts: number): Promise<string | undefined> {
  const token = await readPersistedToken(file);
  if (token !== undefined || attempts <= 1) {
    return token;
  }
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setImmediate(() => {
    resolve(undefined);
  });
  await promise;
  return readTokenRetrying(file, attempts - 1);
}

/**
 * 认领持久化 token：第一位写者原子创建文件，后来者读回同一枚。
 *
 * 为什么不能沿用「先读、没有就写」：多个 dsh 宿主进程同时冷启动时，两边都会读到
 * 「没有」，各自生成一枚再以 `zg --server on` 拉起同一个 daemon。上游对重复启动退 0
 * 并交回同一个 PID，并不校验调用方 env 里的 token；于是后写者的 token 覆盖文件、
 * 却认证不了先启动的 daemon——两边都只看到「拉起退 0 但探测 401」。把创建改成 O_EXCL
 * 后，所有进程拿到同一枚 token，重复启动退 0 后的探测也能通过。
 *
 * 文件存在但形状不合（半截写入、旧垃圾）：删掉后重试一次，仍抢不到就按「这次写不进去」
 * 处理——调用方用内存 token 继续，恢复退化为下一次重试。
 *
 * @param file 目标路径
 * @param candidate 本进程生成的候选 token（仅在抢到创建权时落盘）
 * @returns 最终 token 与创建权
 */
export async function claimPersistedToken(file: string, candidate: string): Promise<ClaimedToken> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
  } catch {
    return { token: candidate, owned: false };
  }
  try {
    await writeFile(file, candidate, { mode: 0o600, flag: "wx" });
    return { token: candidate, owned: true };
  } catch (error) {
    if (!isAlreadyExists(error)) {
      return { token: candidate, owned: false };
    }
  }
  const existing = await readTokenRetrying(file, 3);
  if (existing !== undefined) {
    return { token: existing, owned: false };
  }
  // 文件存在但形状不合（半截写入、外部垃圾）：删掉后用原子 rename 重新写入。这里用
  // persistToken 而不是再抢一次 `wx`：清掉坏文件之后，本进程已经有权决定它的内容；
  // 并发窗口只剩「rm 与 rename 之间另一进程重建了文件」，那时后写者胜出——双方随后都
  // 用文件里最后一枚 token 探活，行为与正常认领一致。
  try {
    await rm(file, { force: true });
  } catch {
    return { token: candidate, owned: false };
  }
  const written = await persistToken(file, candidate);
  return { token: candidate, owned: written };
}

/** 成功后清理 token 文件（停 daemon 失败时保留，供下一次恢复）。 */
export async function clearPersistedToken(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch {
    // 清理失败不改变调用方结论：文件残留最多让下一次复用同一枚 token。
  }
}
