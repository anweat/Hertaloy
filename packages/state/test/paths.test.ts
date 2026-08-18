import { describe, expect, it } from "vitest";
import {
  decodeObjectDir,
  decodeSegment,
  encodeSegment,
  objectDir,
  objectPath,
  parseVersionFile,
} from "../src/paths.js";

describe("路径编码：常见情况保持可读", () => {
  it("普通 object_id 原样展开成目录 —— 落盘后能直接 ls 出来", () => {
    expect(objectDir("job-1/coder-1/result")).toBe("job-1/coder-1/result");
    expect(objectPath("job-1/result", 3)).toBe("job-1/result/@3.json");
  });

  it("点号与连字符不转义（对象名常用）", () => {
    expect(encodeSegment("plan.v2-final")).toBe("plan.v2-final");
  });
});

describe("★ §17.3 三个坑", () => {
  it("保留名建不出文件 → 首字符转义，且解得回来", () => {
    for (const name of ["CON", "nul", "COM1", "LPT9", "aux.txt"]) {
      const enc = encodeSegment(name);
      expect(enc).not.toBe(name);
      expect(decodeSegment(enc)).toBe(name);
    }
  });

  it("相对段会逃出目录 → 必须转义（这是路径穿越，不是美观问题）", () => {
    expect(encodeSegment("..")).toBe("%2E.");
    expect(encodeSegment(".")).toBe("%2E");
    expect(decodeSegment(encodeSegment(".."))).toBe("..");
    expect(objectDir("a/../../etc/passwd")).not.toContain("/../");
  });

  it("大小写不同的 id 编码后**依然不同** —— 编码层不负责合并", () => {
    expect(encodeSegment("Result")).not.toBe(encodeSegment("result"));
  });
});

describe("可逆性", () => {
  const cases = [
    "result",
    "Result",
    "a b",
    "中文名",
    "x/y",
    "100%",
    "a:b",
    "CON",
    "..",
    "emoji-🙂",
    "with#hash?q=1",
  ];

  it.each(cases)("编码再解码回到原值：%s", (raw) => {
    expect(decodeSegment(encodeSegment(raw))).toBe(raw);
  });

  it("多段 id 整体可逆", () => {
    const id = "job-1/CON/中 文/result";
    expect(decodeObjectDir(objectDir(id))).toBe(id);
  });

  it("编码后只剩安全字符", () => {
    for (const raw of cases) {
      expect(encodeSegment(raw)).toMatch(/^[A-Za-z0-9._%-]+$/);
    }
  });
});

describe("拒绝而不是猜", () => {
  it("空段会让路径歧义 → 直接拒绝", () => {
    expect(() => objectDir("/job-1")).toThrow(/空段/);
    expect(() => objectDir("job-1//x")).toThrow(/空段/);
    expect(() => objectDir("")).toThrow(/不能为空/);
  });

  it("版本号必须是正整数", () => {
    expect(() => objectPath("x", 0)).toThrow(/正整数/);
    expect(() => objectPath("x", 1.5)).toThrow(/正整数/);
  });

  it("版本文件名解析：只认 @<n>.json，不认前导零", () => {
    expect(parseVersionFile("@12.json")).toBe(12);
    expect(parseVersionFile("@01.json")).toBeNull();
    expect(parseVersionFile("head.json")).toBeNull();
  });
});
