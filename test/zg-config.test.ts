// lib/zg-config.ts 的环境变量投影：端点与 HF 镜像走同一套规范化。

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { zgEnv } from "../lib/zg-config.ts";
import type { ZgDeployConfig } from "../lib/zg-config.ts";

const API_URL = "https://api.example.com";

function configOf(overrides: Partial<ZgDeployConfig>): ZgDeployConfig {
  return {
    defaultEmbedding: { get: () => "" },
    clientMode: "auto",
    stdoutMaxBytes: 1,
    indexTimeoutMs: 1,
    hfEndpoint: { get: () => "" },
    allowRemoteEmbedding: true,
    remoteEmbeddingEndpoint: "",
    remoteEmbeddingApiKeyFrom: "",
    ...overrides,
  };
}

describe("zgEnv 的端点规范化", () => {
  it("远程端点与 HF 镜像都剥尾斜杠并保留 host", () => {
    const env = zgEnv(
      configOf({
        hfEndpoint: { get: () => " https://mirror.example.com/ " },
        remoteEmbeddingEndpoint: " https://api.example.com/// ",
      }),
    );
    assert.ok(env !== undefined);
    assert.equal(env["HF_ENDPOINT"], "https://mirror.example.com");
    assert.equal(env["ZVEC_GREP_ENDPOINT"], API_URL);
  });

  it("没有 host 的伪 URL 不下发，避免把失败推迟到 zg 发请求", () => {
    const env = zgEnv(
      configOf({
        remoteEmbeddingEndpoint: "https://",
        hfEndpoint: { get: () => "///" },
      }),
    );
    assert.equal(env, undefined);
  });

  it("凭据名被塞成非字符串时按未配置处理", () => {
    const env = zgEnv(
      configOf({
        remoteEmbeddingEndpoint: API_URL,
        remoteEmbeddingApiKeyFrom: 42 as never,
      }),
    );
    assert.ok(env !== undefined);
    assert.equal(env["ZVEC_GREP_ENDPOINT"], API_URL);
    assert.equal(env["ZVEC_GREP_API_KEY"], undefined);
  });

  it("未开放远程 embedding 时不读端点与凭据名", () => {
    const env = zgEnv(
      configOf({
        allowRemoteEmbedding: false,
        remoteEmbeddingEndpoint: API_URL,
      }),
    );
    assert.equal(env, undefined);
  });
});
