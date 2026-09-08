import { describe, expect, it } from "vitest";
import { MessageEnvelope, Endpoint, NodeId } from "../src/message.js";
import { ContainerTemplate } from "../src/template.js";
import { TraceId } from "../src/identity.js";

const envelope = {
  message_id: "msg-1",
  target: { traceid: "job-1/coder-2", node: "work", port: "in" },
  payload: { task: "export" },
};

describe("MessageEnvelope —— 信封无路由字段（不变量 M1）", () => {
  it("接受最小信封与带 in_reply_to / alias 的形式", () => {
    expect(MessageEnvelope.safeParse(envelope).success).toBe(true);
    expect(
      MessageEnvelope.safeParse({
        ...envelope,
        in_reply_to: "msg-0",
        alias: "skill.discovery",
      }).success,
    ).toBe(true);
    expect(Endpoint.safeParse(envelope.target).success).toBe(true);
  });

  it("`tunnel` 已经不是字段了 —— 隧道机制整个删掉，别名接管", () => {
    expect(MessageEnvelope.safeParse({ ...envelope, tunnel: "progress" }).success).toBe(false);
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

describe("NodeId —— 节点 id 就是实例路径的一段", () => {
  it("放宽的那部分不再收：大写与下划线都不是合法路径段", () => {
    expect(NodeId.safeParse("coder").success).toBe(true);
    expect(NodeId.safeParse("coder-2").success).toBe(true);
    // 以下三个在收紧前全部合法
    expect(NodeId.safeParse("Coder").success).toBe(false);
    expect(NodeId.safeParse("_tmp").success).toBe(false);
    expect(NodeId.safeParse("my_node").success).toBe(false);
  });

  it("★ 判据不是「像标识符」，是「拼进 traceid 之后仍然是合法 traceid」", () => {
    // 这条用例才是收紧的理由本身：节点默认实例化，段只能是它自己。
    for (const id of ["coder", "coder-2", "a", "x9"]) {
      expect(NodeId.safeParse(id).success).toBe(true);
      expect(TraceId.safeParse(`job-1/${id}`).success).toBe(true);
    }
    for (const id of ["Coder", "_tmp", "my_node", "-lead", "trail-"]) {
      expect(NodeId.safeParse(id).success).toBe(false);
      expect(TraceId.safeParse(`job-1/${id}`).success).toBe(false);
    }
  });

  it("模板当场拒收，报的是路径段的话，不是「必须是标识符」", () => {
    const node = { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } };
    // 先钉住对照组：同一份节点定义，只有 id 不同 —— 否则拒收可能拒的是别的东西
    expect(ContainerTemplate.safeParse({ nodes: { coder: node } }).success).toBe(true);

    const bad = ContainerTemplate.safeParse({ nodes: { Coder: node } });
    expect(bad.success).toBe(false);
    const message = bad.success ? "" : JSON.stringify(bad.error.issues);
    expect(message).toContain("实例路径段");
  });
});
