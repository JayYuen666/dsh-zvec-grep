import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步 API —— node/no-sync 的例外，按文件声明（基线只放只读那一组，
  // D13：其余谁用谁点名文件；名单不外溢，别处再写同一个 API 照样报）。
  // 写盘那几条（含 chmodSync 改文件元数据、symlinkSync 造软链）是门禁/集成用例要在临时目录
  // 里造出「索引库 + workspace manifest」那对文件、以及造一个 mode 000 的不可读忽略文件
  // 来钉预检的判据。
  syncIoScopes: [
    {
      files: ["test/**"],
      apis: [
        "mkdirSync",
        "mkdtempSync",
        "rmSync",
        "writeFileSync",
        "chmodSync",
        "accessSync",
        "symlinkSync",
      ],
    },
    // lib/index-preflight.ts 用 accessSync 判「存在但当前进程读不了」那一档（mode 000 / 他人
    // 属主 ⇒ statSync().isFile() 照样为真，而真 zg open 会 EACCES 并把坏路径写进工作区索引
    // 状态、永久弄坏这棵树）。它是只读的**权限探针**，不是写盘，与 statSync 同属一次 O(1)
    // 探测，没有 readFileSync 那种「把大文件整段读进内存」的代价；共享基线的只读豁免表
    // 恰好没收录它，所以要在这里点名。
    { files: ["lib/index-preflight.ts"], apis: ["accessSync"] },
  ],
  titlePrefixes: [
    "BigInt",
    "GET",
    "HEAD",
    "JSON",
    "LRU",
    "NUL",
    "POST",
    "ROUTING",
    "TTL",
    "ZgCard",
  ],
});
