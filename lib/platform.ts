// lib/platform.ts —— 路径与 shell 方言的平台档位。
//
// 纯函数默认取 "posix"，由宿主在 apply 时按 process.platform 传入实际值。为什么不让
// lib 直接读 process.platform：单测要能在任意测试机上钉住两档语义（win32 的分支覆盖率
// 不该依赖 CI 恰好有一格 Windows），而生产调用方只有一个——host.ts 的 runtimePlatform()。
//
// 只分两档：Windows 用 pwsh 与盘符/UNC 路径；其余（darwin/linux/…）用 bash 与 POSIX
// 路径。本包不处理 cmd.exe，也不把 Git Bash 的 /c/... 映射进盘符路径——dsh 在 Windows
// 上的 shell 执行器是 dsh-pwsh-local（README「on Windows, dsh-pwsh-local …」）。

/** 路径与命令方言：posix = `/` 分隔 + bash；win32 = 盘符/UNC + pwsh。 */
export type PathPlatform = "posix" | "win32";

/** 把 Node 的 platform 收成两档：win32 单独一档，其余都按 POSIX。 */
export function runtimePlatform(value: NodeJS.Platform = process.platform): PathPlatform {
  return value === "win32" ? "win32" : "posix";
}

/**
 * 一个反斜杠字符。写成 `String.fromCodePoint` 而不是 `"\\"`：后者会被
 * prefer-string-raw 要求改成模板串，而模板串里单个反斜杠无法表达（会转义反引号）。
 */
export const BACKSLASH = String.fromCodePoint(92);
