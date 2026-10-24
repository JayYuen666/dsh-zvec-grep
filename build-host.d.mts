/** build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。 */
export function buildHost(): Promise<string>;
/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。 */
export function singleEntryChunk(
  output: readonly {
    type: string;
    fileName: string;
    code?: string;
    isEntry?: boolean;
    moduleIds?: string[];
  }[],
  source: string,
): { type: "chunk"; code: string; moduleIds?: string[] };
