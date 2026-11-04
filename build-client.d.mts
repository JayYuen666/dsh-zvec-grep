/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。
 *
 *  singleEntryChunk 直接转出 shared 的签名——手抄一份会在源包加参数、改可选性或
 *  调整返回结构时静默漂移，而这里的运行期本来就是 re-export 同一个实现。
 *  失败语义（非 entry 的单个 chunk、code 缺失、多余 chunk/asset）由 shared 的
 *  `singleEntryChunk` 抛 `Error` 承载，见其 `@throws` 面。 */
export function buildClient(): Promise<string>;
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
