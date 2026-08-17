import { describe, expect, it } from "vitest";
import { ObjectVersion, ArtifactSubmission, isKernelKind } from "../src/object.js";

const version = {
  object_id: "plan",
  version: 1,
  kind: "plan",
  content_hash: "0123456789abcdef",
  body: { tasks: [] },
  provenance: { at_seq: 0, derived_from: [] },
};

describe("ObjectVersion —— 版本层（不变量 V1–V4）", () => {
  it("接受最小版本与带 provenance 谱系的版本", () => {
    expect(ObjectVersion.safeParse(version).success).toBe(true);
    expect(
      ObjectVersion.safeParse({
        ...version,
        provenance: {
          traceid: "job-1/coder-2",
          node_id: "work",
          at_seq: 7,
          derived_from: ["plan@2", "spec@1"],
        },
      }).success,
    ).toBe(true);
  });

  it("拒绝 version < 1 与 object_id 含 `@`", () => {
    expect(ObjectVersion.safeParse({ ...version, version: 0 }).success).toBe(false);
    expect(ObjectVersion.safeParse({ ...version, object_id: "plan@1" }).success).toBe(false);
  });

  it("derived_from 只接受精确引用", () => {
    expect(
      ObjectVersion.safeParse({
        ...version,
        provenance: { at_seq: 0, derived_from: ["plan"] },
      }).success,
    ).toBe(false);
  });

  it("拒绝非法哈希、kind、body、序号与顶层字段", () => {
    expect(
      ObjectVersion.safeParse({ ...version, content_hash: "0123456789abcde" }).success,
    ).toBe(false);
    expect(
      ObjectVersion.safeParse({ ...version, content_hash: "0123456789abcdeF" }).success,
    ).toBe(false);
    expect(ObjectVersion.safeParse({ ...version, kind: "Plan" }).success).toBe(false);
    expect(ObjectVersion.safeParse({ ...version, body: [] }).success).toBe(false);
    expect(
      ObjectVersion.safeParse({
        ...version,
        provenance: { at_seq: -1, derived_from: [] },
      }).success,
    ).toBe(false);
    expect(ObjectVersion.safeParse({ ...version, extra: true }).success).toBe(false);
  });

  it("接受带 execution_id 的 provenance", () => {
    expect(
      ObjectVersion.safeParse({
        ...version,
        provenance: { at_seq: 0, derived_from: [], execution_id: "exec-1" },
      }).success,
    ).toBe(true);
  });
});

describe("内核保留 kind", () => {
  it("识别保留 kind，用户 kind 不在其中", () => {
    expect(isKernelKind("run")).toBe(true);
    expect(isKernelKind("annotation")).toBe(true);
    expect(isKernelKind("plan")).toBe(false);
  });
});

describe("ArtifactSubmission —— backend 只提交内容（不变量 V1）", () => {
  it("提交里没有 version 字段：版本号只由 store 分配", () => {
    expect(
      ArtifactSubmission.safeParse({ object_id: "plan", kind: "plan", body: {} }).success,
    ).toBe(true);
    expect(
      ArtifactSubmission.safeParse({ object_id: "plan", kind: "plan", body: {}, version: 1 })
        .success,
    ).toBe(false);
  });
});
