import { expect, it } from "vitest";
import { ensureInternalNetwork } from "../src/network.js";

it.each([
  [{ Name: "net-x", Internal: false }],
  [{ Name: "net-x" }],
  [{ Name: "net-x", Internal: "true" }],
  [{ Name: "other", Internal: true }],
  [],
].map((data) => ({ data })))("同名网络必须被确认是内网，拒绝不匹配的 inspect：$data", ({ data }) => {
  const calls: string[][] = [];
  expect(() => ensureInternalNetwork("net-x", (argv) => {
    calls.push([...argv]);
    return JSON.stringify(data);
  })).toThrow(/内网/);
  expect(calls).toEqual([["network", "inspect", "net-x"]]);
});

it("inspect 返回坏 JSON 时不尝试覆盖或重建已有网络", () => {
  const calls: string[][] = [];
  expect(() => ensureInternalNetwork("net-x", (argv) => {
    calls.push([...argv]);
    return "not JSON";
  })).toThrow(/内网/);
  expect(calls).toHaveLength(1);
});

it("create 竞争失败后，也必须验证抢先创建的是内网", () => {
  let created = false;
  expect(() => ensureInternalNetwork("net-x", (argv) => {
    if (argv[1] === "create") { created = true; throw new Error("already exists"); }
    if (!created) throw new Error("not found");
    return JSON.stringify([{ Name: "net-x", Internal: false }]);
  })).toThrow(/内网/);
});

it("create 返回成功后仍检查实际网络属性", () => {
  const calls: string[][] = [];
  expect(() => ensureInternalNetwork("net-x", (argv) => {
    calls.push([...argv]);
    if (calls.length === 1) throw new Error("not found");
    return argv[1] === "create" ? "network-id" : JSON.stringify([{ Name: "net-x", Internal: false }]);
  })).toThrow(/内网/);
  expect(calls.map((args) => args[1])).toEqual(["inspect", "create", "inspect"]);
});
