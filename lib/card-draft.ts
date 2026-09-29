// lib/card-draft.ts —— 设置卡片**草稿层的读取原语**：草稿优先取值 + 取值 → 显示文本的回落。
//
// 为什么从 lib/card-logic.ts 拆出来：card-logic 的 draftFields 管的是「六个字段各显示什么」
// （编排），本文件这两件是它对每个字段重复调用的读判据。判据此前只被单测按这层边界直接取用，
// `fallow --production` 就把它判成「只被测试养着的导出」（同 lib/argv-guard.ts 之于
// lib/cli.ts 的口径）；拆开后 lib/card-logic.ts 是本模块唯一的非测试消费者。
//
// 缺省显示文案（"10" / "3" / "10"）留在调用侧：那是字段知识，不是读判据。
// 纯函数，无 DOM、不读设置：卡片是「先暂存、点保存才写入」的草稿模型，touched 是草稿层、
// 快照 value 是已提交层，两层的优先级只由这里决定。

/** 草稿优先取值：touched 有该键（哪怕值是 undefined=待清空）即用草稿。 */
export function draftOf(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
  field: string,
): unknown {
  return field in touched ? touched[field] : value[field];
}

/** 数值型输入的显示文本：非有限数（含 undefined）回落到默认文案。 */
export function numberText(raw: unknown, fallback: string): string {
  return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : fallback;
}
