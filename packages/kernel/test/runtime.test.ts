import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime, type StepFailure, type StepResult } from "../src/runtime.js";
import { InvariantError } from "../src/errors.js";

/** `producer.out --e1--> consumer.in`，consumer 的 servo 提一个变量。 */
const chainSpec = {
  nodes: {
    producer: {
      kind: "handler",
      handler: "wrap",
      ports: {
        start: { direction: "receive", servo: { vars: { seed: { type: "short", from: "$.seed" } } } },
        out: { direction: "emit" },
        unused: { direction: "emit" },
      },
    },
    consumer: {
      kind: "handler",
      handler: "collect",
      ports: {
        in: {
          direction: "receive",
          servo: { vars: { got: { type: "short", from: "$.wrapped" } } },
        },
      },
    },
  },
  edges: { e1: { from: { node: "producer", port: "out" }, to: { node: "consumer", port: "in" } } },
  children: {},
};

let store: ObjectStore;
let reg: InstanceRegistry;
let rt: Runtime;
let collected: unknown[];

function isFailure(r: StepResult | StepFailure | null): r is StepFailure {
  return r !== null && "reason" in r;
}

beforeEach(() => {
  store = new ObjectStore();
  const ref = registerContainerTemplate(store, "chain", chainSpec, "root_config");
  reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  rt = new Runtime(store, reg);
  collected = [];
  rt.registerHandler("wrap", (vars) => ({ out: { wrapped: vars.seed ?? null } }));
  rt.registerHandler("collect", (vars) => {
    collected.push(vars.got);
    return {};
  });
});

describe("单提交转发链路", () => {
  it("emit → 边 → receive，两步跑完，变量按 servo 提取", () => {
    rt.send({ traceid: "job-1", node: "producer", port: "start" }, { seed: 7 });
    const results = rt.drain();

    expect(results).toHaveLength(2);
    const first = results[0] as StepResult;
    expect(first.nodeId).toBe("producer");
    expect(first.vars).toEqual({ seed: 7 });
    expect(first.delivered).toHaveLength(1);

    const second = results[1] as StepResult;
    expect(second.nodeId).toBe("consumer");
    expect(second.vars).toEqual({ got: 7 });
    expect(collected).toEqual([7]);
    expect(rt.pending()).toEqual([]);
    expect(rt.messages().every((m) => m.state === "CONSUMED")).toBe(true);
  });

  it("有输出但无出边的端口计入 dangling，不产生消息也不报错", () => {
    const alt = new Runtime(store, reg);
    alt.registerHandler("wrap", (vars) => ({
      out: { wrapped: vars.seed ?? null },
      unused: { ignored: true },
    }));
    alt.registerHandler("collect", () => ({}));
    alt.send({ traceid: "job-1", node: "producer", port: "start" }, { seed: 1 });

    const first = alt.step() as StepResult;
    expect(first.dangling).toEqual(["unused"]);
    expect(first.delivered).toHaveLength(1);
  });
});

describe("消息不能自选路由（不变量 M1）", () => {
  it("handler 返回的是端口名，不是地址 —— payload 里写 target 也不影响投递", () => {
    rt.registerHandler("sneaky", () => ({}));
    rt.send(
      { traceid: "job-1", node: "producer", port: "start" },
      { seed: 1, target: { traceid: "job-1", node: "producer", port: "start" } },
    );
    const results = rt.drain();
    // 只走模板声明的 e1，没有因为 payload 里的 target 多投一条
    expect((results[0] as StepResult).delivered).toHaveLength(1);
    expect(rt.messages().filter((m) => m.target.node === "consumer")).toHaveLength(1);
  });

  it("输出到未声明的 emit 端口 → InvariantError（编程错误，不进失败通道）", () => {
    const bad = new Runtime(store, reg);
    bad.registerHandler("wrap", () => ({ ghost: {} }));
    bad.registerHandler("collect", () => ({}));
    bad.send({ traceid: "job-1", node: "producer", port: "start" }, { seed: 1 });
    expect(() => bad.drain()).toThrow(/未声明的 emit 端口 `ghost`/);
  });
});

describe("零部分提交", () => {
  it("变量提取失败 → 输入 FAILED，一条下游都不创建", () => {
    const id = rt.send({ traceid: "job-1", node: "producer", port: "start" }, { wrong: 1 });
    const result = rt.step();

    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/变量 `seed`/);
    expect(rt.message(id).state).toBe("FAILED");
    expect(rt.messages()).toHaveLength(1);
    expect(collected).toEqual([]);
  });

  it("入站契约不符 → 输入 FAILED，一条下游都不创建", () => {
    const contractRef = registerContract(store);
    const ref = registerContainerTemplate(store, "guarded", {
      nodes: {
        producer: {
          kind: "handler",
          handler: "wrap",
          ports: {
            start: {
              direction: "receive",
              contract: contractRef,
              servo: { vars: { seed: { type: "short", from: "$.seed" } } },
            },
            out: { direction: "emit" },
          },
        },
      },
      edges: {},
      children: {},
    });
    const reg2 = new InstanceRegistry(store);
    reg2.createRoot(ref, "job-2");
    const rt2 = new Runtime(store, reg2);
    rt2.registerHandler("wrap", (vars) => ({ out: { wrapped: vars.seed ?? null } }));

    const id = rt2.send({ traceid: "job-2", node: "producer", port: "start" }, { seed: "字符串" });
    const result = rt2.step();

    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.reason).toMatch(/入站契约不符/);
    expect(rt2.message(id).state).toBe("FAILED");
    expect(rt2.messages()).toHaveLength(1);
  });
});

describe("入口校验", () => {
  it("未知节点 / 端口 / emit 端口作目标 → 入口即拒，不拖到调度时", () => {
    expect(() => rt.send({ traceid: "job-1", node: "ghost", port: "in" }, {})).toThrow(
      /可用节点：consumer, producer/,
    );
    expect(() => rt.send({ traceid: "job-1", node: "producer", port: "ghost" }, {})).toThrow(
      /未声明端口/,
    );
    expect(() => rt.send({ traceid: "job-1", node: "producer", port: "out" }, {})).toThrow(
      /方向是 emit/,
    );
  });

  it("handler 重复注册被拒", () => {
    expect(() => rt.registerHandler("wrap", () => ({}))).toThrow(InvariantError);
  });
});

function registerContract(s: ObjectStore): string {
  const v = s.put("SeedTask", "contract", {
    type: "object",
    required: ["seed"],
    properties: { seed: { type: "integer" } },
  });
  return `${v.object_id}@${v.version}`;
}
