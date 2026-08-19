/**
 * 资源注册表落盘 —— **动态上载**的那一半。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addResource,
  loadResources,
  removeResource,
  resourcesPath,
  writeResources,
} from "../src/resources.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-res-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("★ 缺省是空表，不是「什么都行」", () => {
  it("没有文件 → 空表", () => {
    const { registry, source } = loadResources(dir);
    expect(registry).toEqual({});
    expect(source).toBe("default");
  });

  it("空表下引用任何别名都会失败 —— 能用的必须是显式给的", () => {
    expect(Object.keys(loadResources(dir).registry)).toHaveLength(0);
  });
});

describe("★ 动态上载", () => {
  it("加一条之后读得到，且落成了文件", () => {
    addResource(dir, "primary", { kind: "git", path: "/repos/app", defaultBase: "main" });
    const { registry, source } = loadResources(dir);
    expect(source).toBe("file");
    expect(registry.primary).toEqual({ kind: "git", path: "/repos/app", defaultBase: "main" });
    expect(readFileSync(resourcesPath(dir), "utf8")).toContain("primary");
  });

  it("加多条互不影响", () => {
    addResource(dir, "a", { kind: "dir", path: "/x" });
    addResource(dir, "b", { kind: "skill", path: "/y" });
    expect(Object.keys(loadResources(dir).registry).sort()).toEqual(["a", "b"]);
  });

  it("★ 同名已存在就拒绝 —— 悄悄换掉别名会让所有引用它的模板跟着变", () => {
    addResource(dir, "primary", { kind: "git", path: "/repos/app" });
    expect(() => addResource(dir, "primary", { kind: "git", path: "/repos/other" })).toThrow(
      /已存在/,
    );
    // 原来的没被动
    expect(loadResources(dir).registry.primary?.path).toBe("/repos/app");
  });

  it("先 remove 再 add 才能改指向 —— 改动是显式的", () => {
    addResource(dir, "primary", { kind: "git", path: "/repos/app" });
    removeResource(dir, "primary");
    addResource(dir, "primary", { kind: "git", path: "/repos/other" });
    expect(loadResources(dir).registry.primary?.path).toBe("/repos/other");
  });

  it("删不存在的会说清楚", () => {
    expect(() => removeResource(dir, "nope")).toThrow(/没有资源/);
  });
});

describe("★ 一条写坏就整表拒绝", () => {
  it("种类不认识 → 拒绝，不是跳过坏的用好的", () => {
    writeFileSync(
      resourcesPath(dir),
      JSON.stringify({ format: 1, resources: { a: { kind: "ftp", path: "/x" } } }),
      "utf8",
    );
    expect(() => loadResources(dir)).toThrow(/非法/);
  });

  it("格式版本对不上 → 拒绝，不猜着读", () => {
    writeFileSync(resourcesPath(dir), JSON.stringify({ format: 99, resources: {} }), "utf8");
    expect(() => loadResources(dir)).toThrow(/非法/);
  });

  it("多余字段也拒绝 —— strict 是有意的", () => {
    expect(() =>
      addResource(dir, "a", { kind: "dir", path: "/x", oops: 1 } as never),
    ).toThrow(/非法/);
  });
});

describe("说明字段会传给 agent", () => {
  it("note 存得下", () => {
    addResource(dir, "docs", { kind: "dir", path: "/d", note: "内部接口手册" });
    expect(loadResources(dir).registry.docs?.note).toBe("内部接口手册");
  });

  it("writeResources 可以整表覆盖", () => {
    writeResources(dir, { x: { kind: "dir", path: "/x" } });
    expect(Object.keys(loadResources(dir).registry)).toEqual(["x"]);
  });
});

describe("★ 目录还不存在时也能登记", () => {
  it("先 resources add 再 init —— 这是最自然的顺序，不该 ENOENT", () => {
    const fresh = join(dir, "还没建的目录");
    addResource(fresh, "primary", { kind: "git", path: "/repos/app" });
    expect(loadResources(fresh).registry.primary?.path).toBe("/repos/app");
  });
});
