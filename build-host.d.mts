/** build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
 *
 *  buildHost() 交回**生成出来的 host.js 完整文本**（不是落盘路径——落盘由
 *  `writeArtifact` 在脚本内完成）；rolldown 构建失败或产物清单缺 host.js 时
 *  `Promise` reject（实现抛 `Error`）。
 *
 *  singleEntryChunk 直接转出 shared 的签名——手抄一份会在源包演进时静默漂移。 */
export function buildHost(): Promise<string>;
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
