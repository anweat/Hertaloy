/**
 * `Message.source` —— 渲染层要的那一件从现有数据推不出来的事。
 *
 * 补它之前：隧道消息带 `tunnel` 和 `target`，**不带来源**。于是
 * "这次命中是从哪个实例来的"完全算不出，而那正是"让浮动的节点也能观察到命中"
 * 这件事本身（RENDERING.md §5）。扇入边也有同样的歧义。
 *
 * 三种情形靠字段有无区分，不需要标签 —— 这几条测试就是那个区分的判据。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InstanceRegistry, registerContainerTemplate } from "../src/instances.js";
import { ObjectStore } from "../src/store.js";
import { Runtime } from "../src/runtime.js";

let store: ObjectStore;
beforeEach(() => {
  store = new ObjectStore();
});

function boot(spec: unknown): { rt: Runtime; reg: InstanceRegistry } {
  const ref = registerContainerTemplate(store, "root", spec, "root_config");
  const reg = new InstanceRegistry(store);
  reg.createRoot(ref, "job-1");
  return { rt: new Runtime(store, reg), reg };
}

describe("★ 内网边：来源是发出它的那个 emit 端口", () => {
  const FLOW = {
    nodes: {
      a: {
        kind: "handler",
        handler: "emit",
        ports: {
          in: { direction: "receive", servo: { vars: {} } },
          out: { direction: "emit" },
        },
      },
      b: {
        kind: "handler",
        handler: "noop",
        ports: { got: { direction: "receive", servo: { vars: {} } } },
      },
    },
    edges: { e: { from: { node: "a", port: "out" }, to: { node: "b", port: "got" } } },
    children: {},
    subscriptions: {},
  };

  it("下游消息带 {traceid, node, port}", () => {
    const { rt } = boot(FLOW);
    rt.registerHandler("emit", () => ({ out: { v: 1 } }));
    rt.registerHandler("noop", () => ({}));
    rt.send({ traceid: "job-1", node: "a", port: "in" }, {});
    rt.drain();

    const downstream = rt.messages().find((m) => m.target.node === "b");
    expect(downstream?.source).toEqual({ traceid: "job-1", node: "a", port: "out" });
  });

  it("★ 外部注入的那条**没有** source —— 图外来的本来就没有图内来源", () => {
    const { rt } = boot(FLOW);
    const id = rt.send({ traceid: "job-1", node: "a", port: "in" }, {});
    expect(rt.message(id).source).toBeUndefined();
  });

  it("★ 扇入：两条边汇到同一端口，各自的来源可区分", () => {
    const { rt } = boot({
      nodes: {
        left: {
          kind: "handler",
          handler: "emit",
          ports: {
            in: { direction: "receive", servo: { vars: {} } },
            out: { direction: "emit" },
          },
        },
        right: {
          kind: "handler",
          handler: "emit",
          ports: {
            in: { direction: "receive", servo: { vars: {} } },
            out: { direction: "emit" },
          },
        },
        sink: {
          kind: "handler",
          handler: "noop",
          ports: { got: { direction: "receive", servo: { vars: {} } } },
        },
      },
      edges: {
        l: { from: { node: "left", port: "out" }, to: { node: "sink", port: "got" } },
        r: { from: { node: "right", port: "out" }, to: { node: "sink", port: "got" } },
      },
      children: {},
      subscriptions: {},
    });
    rt.registerHandler("emit", () => ({ out: {} }));
    rt.registerHandler("noop", () => ({}));
    rt.send({ traceid: "job-1", node: "left", port: "in" }, {});
    rt.send({ traceid: "job-1", node: "right", port: "in" }, {});
    rt.drain();

    const sources = rt
      .messages()
      .filter((m) => m.target.node === "sink" && m.source !== undefined)
      .map((m) => m.source?.node)
      .sort();
    // 此前两条长得一模一样，分不出是谁送的
    expect(sources).toEqual(["left", "right"]);
  });
});

describe("★ 隧道：命中从哪儿来，现在算得出", () => {
  it("PUBLISH 出去的消息同时带 tunnel 和 source", () => {
    const child = registerContainerTemplate(store, "child", {
      nodes: {
        pub: {
          kind: "handler",
          handler: "emit",
          ports: {
            in: { direction: "receive", servo: { vars: {} } },
            out: { direction: "emit", tunnel: "findings" },
          },
        },
      },
      edges: {},
      children: {},
      subscriptions: {},
    });
    const ref = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {
          watcher: {
            kind: "handler",
            handler: "noop",
            ports: { heard: { direction: "receive", servo: { vars: {} } } },
          },
        },
        edges: {},
        children: { kid: { template: child, entry: { node: "pub", port: "in" } } },
        subscriptions: {
          s: { tunnel: "findings", to: { node: "watcher", port: "heard" } },
        },
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(ref, "job-1");
    const rt = new Runtime(store, reg);
    rt.registerHandler("emit", () => ({ out: { finding: "看这儿" } }));
    rt.registerHandler("noop", () => ({}));

    const kid = reg.spawn("job-1", "kid", "k1");
    rt.send({ traceid: kid.traceid, node: "pub", port: "in" }, {});
    rt.drain();

    const heard = rt.messages().find((m) => m.target.node === "watcher");
    expect(heard?.tunnel).toBe("findings");
    // ★ 这一行是整件事的重点：染色能染出那根来路了
    expect(heard?.source?.traceid).toBe(kid.traceid);
    expect(heard?.source?.port).toBe("out");
  });
});

describe("★ 子实例终止通知：只有 traceid，没有 node/port", () => {
  it("来源是子**实例**本身，不是某个节点的 emit", () => {
    const child = registerContainerTemplate(store, "child", {
      nodes: {
        only: {
          kind: "handler",
          handler: "noop",
          ports: { in: { direction: "receive", servo: { vars: {} } } },
        },
      },
      edges: {},
      children: {},
      subscriptions: {},
    });
    const ref = registerContainerTemplate(
      store,
      "root",
      {
        nodes: {
          done: {
            kind: "handler",
            handler: "noop",
            ports: { exit: { direction: "receive", servo: { vars: {} } } },
          },
        },
        edges: {},
        children: {
          kid: {
            template: child,
            entry: { node: "only", port: "in" },
            exit: { node: "done", port: "exit" },
          },
        },
        subscriptions: {},
      },
      "root_config",
    );
    const reg = new InstanceRegistry(store);
    reg.createRoot(ref, "job-1");
    const rt = new Runtime(store, reg);
    rt.registerHandler("noop", () => ({}));

    const kid = reg.spawn("job-1", "kid", "k1");
    rt.send({ traceid: kid.traceid, node: "only", port: "in" }, {});
    rt.drain();
    rt.settleAll();

    const notice = rt.messages().find((m) => m.target.node === "done");
    expect(notice?.source).toEqual({ traceid: kid.traceid });
    expect(notice?.source?.node).toBeUndefined();
  });
});
