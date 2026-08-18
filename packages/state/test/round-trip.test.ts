/**
 * §17 持久化：真正的验收是**换一个进程能不能接着跑**。
 *
 * 同进程里存了再读证明不了什么 —— 内存里的对象引用可能还在。
 * 所以每个用例都 close 掉再 open，模拟"进程退出、重新起来"。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState } from "../src/run-state.js";
import { versionsOnDisk } from "../src/objects.js";
import { isLocked } from "../src/lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = {
  nodes: {
    work: {
      kind: "handler",
      handler: "note",
      ports: {
        in: { direction: "receive", servo: { vars: { text: { type: "short", from: "$.text" } } } },
      },
    },
  },
  edges: {},
  children: {},
  subscriptions: {},
};

/** 起一个进程、干点活、落盘、退出。 */
function session(fn: (s: RunState) => void): void {
  const state = RunState.open(dir);
  try {
    fn(state);
    state.persist();
  } finally {
    state.close();
  }
}

describe("★ 跨进程恢复", () => {
  it("第一个进程建根 + 写资产，第二个进程读得到", () => {
    session((s) => {
      const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
      s.registry.createRoot(ref, "job-1");
      s.runtime.registerHandler("note", (vars, ctx) => {
        ctx.put("memo", "note", { text: String(vars.text) });
        return {};
      });
      s.runtime.send({ traceid: "job-1", node: "work", port: "in" }, { text: "hello" });
      s.runtime.drain();
    });

    const s2 = RunState.open(dir);
    try {
      expect(s2.recovered).toBe(true);
      expect(s2.registry.rootTrace).toBe("job-1");
      expect(s2.registry.get("job-1").status).toBe("OPEN");
      expect(s2.store.head("job-1/memo").body).toEqual({ text: "hello" });
    } finally {
      s2.close();
    }
  });

  it("版本号跨进程保持不变 —— Ref 才不会集体失效", () => {
    session((s) => {
      const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
      s.registry.createRoot(ref, "job-1");
      for (const text of ["a", "b", "c"]) {
        s.store.put("job-1/memo", "note", { text });
      }
    });

    expect(versionsOnDisk(dir, "job-1/memo")).toEqual([1, 2, 3]);

    const s2 = RunState.open(dir);
    try {
      expect(s2.store.history("job-1/memo").map((v) => v.version)).toEqual([1, 2, 3]);
      expect(s2.store.get("job-1/memo", 2).body).toEqual({ text: "b" });
    } finally {
      s2.close();
    }
  });

  it("在途消息与锁跨进程留存 —— 可变头的意义就在这", () => {
    session((s) => {
      const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
      s.registry.createRoot(ref, "job-1");
      // 不 drain：消息就留在队列里
      s.runtime.send({ traceid: "job-1", node: "work", port: "in" }, { text: "pending" });
    });

    const s2 = RunState.open(dir);
    try {
      expect(s2.runtime.pending()).toHaveLength(1);
      // 换个进程接着跑完
      s2.runtime.registerHandler("note", (vars, ctx) => {
        ctx.put("memo", "note", { text: String(vars.text) });
        return {};
      });
      s2.runtime.drain();
      expect(s2.store.head("job-1/memo").body).toEqual({ text: "pending" });
      s2.runtime.checkInvariants();
    } finally {
      s2.close();
    }
  });

  it("恢复出来的实例是**冻结**的 —— transact 的浅拷贝快照依赖这条", () => {
    session((s) => {
      const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
      s.registry.createRoot(ref, "job-1");
    });
    const s2 = RunState.open(dir);
    try {
      expect(Object.isFrozen(s2.registry.get("job-1"))).toBe(true);
    } finally {
      s2.close();
    }
  });

  it("空目录 = 新建，不是恢复", () => {
    const s = RunState.open(dir);
    try {
      expect(s.recovered).toBe(false);
      expect(s.registry.rootTrace).toBeNull();
    } finally {
      s.close();
    }
  });
});

describe("★ 落盘的形状：目录能直接看", () => {
  it("对象按 object_id 展开成目录树，版本号即文件名", () => {
    session((s) => {
      s.store.put("job-1/coder-1/result", "artifact", { ok: true });
    });
    const file = join(dir, "objects", "job-1", "coder-1", "result", "@1.json");
    expect(JSON.parse(readFileSync(file, "utf8")).body).toEqual({ ok: true });
  });
});

describe("★ 目录锁（§17.8）", () => {
  it("第二个进程拿不到锁，且报得出持有者", () => {
    const first = RunState.open(dir);
    try {
      expect(isLocked(dir)).toBe(true);
      expect(() => RunState.open(dir)).toThrow(/已被占用/);
      expect(() => RunState.open(dir)).toThrow(new RegExp(String(process.pid)));
    } finally {
      first.close();
    }
    expect(isLocked(dir)).toBe(false);
  });

  it("只读打开不拿锁 —— status 这类命令不该被写进程挡住", () => {
    const first = RunState.open(dir);
    try {
      const reader = RunState.open(dir, { readOnly: true });
      reader.close();
      expect(isLocked(dir)).toBe(true); // 只读关闭不会误放别人的锁
    } finally {
      first.close();
    }
  });

  it("open 失败时不留下锁", () => {
    writeFileSync(join(dir, "head.json"), JSON.stringify({ format: 99 }), "utf8");
    expect(() => RunState.open(dir)).toThrow(/格式 99/);
    expect(isLocked(dir)).toBe(false);
  });
});

describe("★ 完整性：宁可炸，不要似是而非", () => {
  it("对象文件缺一个 → 装载当场炸，而不是等某次 read(ref)", () => {
    session((s) => {
      for (const text of ["a", "b", "c"]) s.store.put("job-1/memo", "note", { text });
    });
    rmSync(join(dir, "objects", "job-1", "memo", "@2.json"));
    expect(() => RunState.open(dir)).toThrow(/版本不连续/);
  });

  it("对象库与 head 对不上 → 拒绝装载", () => {
    session((s) => {
      s.store.put("job-1/memo", "note", { text: "a" });
    });
    const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
    writeFileSync(
      join(dir, "head.json"),
      JSON.stringify({ ...head, objectCursor: 99 }),
      "utf8",
    );
    expect(() => RunState.open(dir)).toThrow(/对不上/);
  });

  it("格式版本不认识 → 拒绝，不猜着读", () => {
    writeFileSync(join(dir, "head.json"), JSON.stringify({ format: 2 }), "utf8");
    expect(() => RunState.open(dir)).toThrow(/只认 1/);
  });
});
