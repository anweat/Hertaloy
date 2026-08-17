import { describe, expect, it } from "vitest";
import {
  CONTROL_TOOL_NAMES,
  graphTemplateSchema,
  messageContractSchema,
  stableStringify,
  wsClientMessageSchema,
} from "../src/index.js";

describe("contracts", () => {
  it("GraphTemplate 接受合法模板（PUSH 边 / 七种 kind / 精确引用）", () => {
    const spec = {
      template_id: "t",
      nodes: {
        plan: {
          kind: "agent",
          spec: "planner",
          publish_topics: { progress: "io" },
          spawn_slots: ["workers"],
          on_error: "err",
          endpoints: {
            io: { receive: { PUSH: { contract: "Task@1" } } },
            out: { emit: { PUSH: { contract: "Plan@1" } } },
            err: { emit: {} },
          },
        },
        end: { kind: "end", endpoints: { io: {} } },
      },
      edges: [{ id: "e1", from: "plan.out", to: "end.io", operation: "PUSH", servo: "s@1" }],
      slots: {
        workers: { template: "worker@1", instantiation: "PER_CALL", entry: "w.io" },
      },
      subscriptions: [{ topic: "progress", endpoint: "plan.io" }],
      strict_contracts: false,
    };
    expect(() => graphTemplateSchema.parse(spec)).not.toThrow();
  });

  it("GraphTemplate 拒绝未知节点 kind 与非法端点", () => {
    expect(() =>
      graphTemplateSchema.parse({
        nodes: { a: { kind: "checkpoint", endpoints: { io: {} } } },
      })
    ).toThrow();
    expect(() =>
      graphTemplateSchema.parse({
        nodes: { a: { kind: "agent", endpoints: {} } },
      })
    ).toThrow(); // endpoints 必须非空
  });

  it("MessageContract 只接受 JSON Schema 子集字段", () => {
    expect(() => messageContractSchema.parse({ type: "object", properties: { a: {} }, required: ["a"] })).not.toThrow();
    expect(() => messageContractSchema.parse({ $schema: "http://x" })).toThrow();
    expect(() => messageContractSchema.parse({ type: "banana" })).toThrow();
  });

  it("WS 客户端消息：subscribe/unsubscribe", () => {
    expect(wsClientMessageSchema.parse({ type: "subscribe", channels: ["instance:gi-1"] })).toBeTruthy();
    expect(() => wsClientMessageSchema.parse({ type: "banana" })).toThrow();
  });

  it("ControlPlane 工具 >= 15 个", () => {
    expect(CONTROL_TOOL_NAMES.length).toBeGreaterThanOrEqual(15);
  });

  it("stableStringify 与键序无关、跨语言稳定", () => {
    const a = { b: 1, a: [1, { y: 2, x: 3 }] };
    const b = { a: [1, { x: 3, y: 2 }], b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify({}).length).toBeGreaterThan(0);
  });
});
