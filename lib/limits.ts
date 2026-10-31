// lib/limits.ts —— 设置卡六个字段里三个数值字段的区间与默认值（零依赖叶）。
//
// 为什么单列：这组数同时被宿主 schema（host.ts 的 .default/.min/.max）、limit 钳制
// （lib/cli.ts）、卡片显示与输入区间（lib/card-logic.ts / src/client-entry.ts）消费，
// 各处抄一份会在宿主改默认值或区间后静默漂移——卡片继续显示旧区间、文案与钳位各说各话。
// LIMIT_MIN 同时是三个数值字段共用的下限（schema 侧三条 .min(1) 同源）。
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 50;
export const DEFAULT_LIMIT = 10;
export const BUDGET_MAX = 20;
/** 解锁窗口上限（分钟）。 */
export const WINDOW_MAX = 240;
export const DEFAULT_GREP_BUDGET = 3;
/** 解锁窗口默认值（分钟）。 */
export const DEFAULT_UNLOCK_WINDOW_MIN = 10;
