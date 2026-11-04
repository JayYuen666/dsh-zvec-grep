import type { OxfmtConfig } from "oxfmt";

// 本包对共享 oxfmt 基线的唯一差异面。选项名经 OxfmtConfig 固化：拼写错会被
// tsc（tsconfig.json 的 include 含本文件）当场红，而不是被 oxfmt 静默忽略、
// 拖到 fmt:check 才以「文件未格式化」的形态暴露。
//
// 手写成完整对象而不是 extends：oxfmt 的 TS 配置没有 extends/合并语义，
// 基线演进来要人工跟（tsconfig/oxlint/vitest 走的都是 shared 的合并入口，唯此处例外）。
//
// `**/*.md`：双语文档与 CHANGELOG 是交付物，重排会打散中文长段、改写历史条目——
// 刻意不进格式校验。「格式检查全绿」不含文档面。
// `**/*.jsonc`：本仓没有 .jsonc 文件（带注释的 JSON 全是 .json，不进 oxfmt）；
// 这条留作守卫，防将来真引入 .jsonc 时被意外重排。
export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
} satisfies OxfmtConfig;
