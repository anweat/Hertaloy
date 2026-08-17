import { describe, expect, it } from "vitest";
import { MessageEnvelope, SubscriptionAddress, Endpoint } from "../src/message.js";

const envelope = {
  message_id: "msg-1",
  target: { traceid: "job-1/coder-2", node: "work", port: "in" },
  payload: { task: "export" },
};

describe("MessageEnvelope —— 信封无路由字段（不变量 M1）", () => {
  it("接受最小信封与带 in_reply_to / tunnel 的形式", () => {
    expect(MessageEnvelope.safeParse(envelope).success).toBe(true);
    expect(
      MessageEnvelope.safeParse({
        ...envelope,
        in_reply_to: "msg-0",
        tunnel: "skill.discovery",
      }).success,
    ).toBe(true);
    expect(Endpoint.safeParse(envelope.target).success).toBe(true);
  });

  it("拒绝任何路由字段 —— 消息不选边、不创建边", () => {
    expect(MessageEnvelope.safeParse({ ...envelope, edge_id: "e1" }).success).toBe(false);
  });

  it("拒绝 causation_ids —— 因果由 RunSnapshot 承担，不进信封", () => {
    expect(
      MessageEnvelope.safeParse({ ...envelope, causation_ids: ["msg-0"] }).success,
    ).toBe(false);
  });
});

describe("SubscriptionAddress —— 隧道标签 ∩ traceid 前缀（不变量 M2）", () => {
  it("接受带作用域与不带作用域两种", () => {
    expect(
      SubscriptionAddress.safeParse({ tunnel: "progress", scope: "job-1" }).success,
    ).toBe(true);
    expect(SubscriptionAddress.safeParse({ tunnel: "progress" }).success).toBe(true);
  });

  it("拒绝非法隧道标签", () => {
    expect(SubscriptionAddress.safeParse({ tunnel: "Progress" }).success).toBe(false);
  });
});
