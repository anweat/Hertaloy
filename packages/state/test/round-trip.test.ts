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
import type { Scheduler } from "@nodeflow/kernel";
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

describe("★ 旧盘上的对象仍读得出来（at_seq 删除之后）", () => {
  /**
   * `provenance.at_seq` 写过 5 处、**读过 0 处**，随这次清理删掉了。
   * 但已经落在盘上的对象里还带着它，而 `ObjectVersion` 是 `.strict()` 的 ——
   * 于是有一个必须当场钉死的问题：**旧文件还打得开吗？**
   *
   * 答案是能，因为装载走的是 `JSON.parse(...) as ObjectVersion`，不是 `.parse()`。
   * 但"因为现在没人校验所以没事"是个**会过期的理由**：哪天有人给装载加上校验，
   * 这批文件就会在毫无预兆的情况下被拒。
   *
   * 所以把它写成用例：这条一旦变红，就是在说"你刚给装载加了严格校验，
   * 得先给旧字段一条迁移路"。**把一个潜伏的坑换成一盏灯。**
   */
  it("已落盘的对象带着 at_seq，换个进程照样解析得到", () => {
    session((s) => {
      const ref = registerContainerTemplate(s.store, "root", TEMPLATE, "root_config");
      s.registry.createRoot(ref, "job-1");
    });

    // 把盘上已有的那份改成"旧版本写的样子"：provenance 里带上已删除的 at_seq。
    // 不新增文件 —— 新增会被完整性检查抓住（磁盘版本数与 head 游标对不上），
    // 而那条检查本身是对的。
    const file = join(dir, "objects", "root", "@1.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      provenance: Record<string, unknown>;
    };
    raw.provenance.at_seq = 7;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}
`, "utf8");

    const state = RunState.open(dir);
    try {
      const got = state.store.resolve("root@1");
      expect(got.kind).toBe("root_config");
      // 旧字段原样留着，不假装它不存在 —— 只是再没人读它
      expect((got.provenance as Record<string, unknown>).at_seq).toBe(7);
    } finally {
      state.close();
    }
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

describe("★ 调度缝真的通到 RunState", () => {
  /**
   * 内核里通了不算通。`instances.ts` 那条注释记着"K5、E1 是同一类：
   * 实现在，路不通" —— 这个项目被这个形状咬过四次，所以每加一条缝都要有
   * 一条用例**真的从外层穿过去**。
   */
  it("从 OpenOptions 换掉调度顺序，跑出来的顺序跟着变", () => {
    const seen: unknown[] = [];
    const lifo: Scheduler = (c) => c[c.length - 1] ?? null;

    const state = RunState.open(dir, { scheduler: lifo });
    try {
      const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
      state.registry.createRoot(ref, "job-1");
      state.runtime.registerHandler("note", (vars) => {
        seen.push(vars.text);
        return {};
      });
      for (const text of ["甲", "乙", "丙"]) {
        state.runtime.send({ traceid: "job-1", node: "work", port: "in" }, { text });
      }
      state.runtime.drain();
    } finally {
      state.close();
    }

    expect(seen).toEqual(["丙", "乙", "甲"]);
  });

  it("不给就是内核默认的 FIFO", () => {
    const seen: unknown[] = [];
    const state = RunState.open(dir);
    try {
      const ref = registerContainerTemplate(state.store, "root", TEMPLATE, "root_config");
      state.registry.createRoot(ref, "job-1");
      state.runtime.registerHandler("note", (vars) => {
        seen.push(vars.text);
        return {};
      });
      for (const text of ["甲", "乙", "丙"]) {
        state.runtime.send({ traceid: "job-1", node: "work", port: "in" }, { text });
      }
      state.runtime.drain();
    } finally {
      state.close();
    }
    expect(seen).toEqual(["甲", "乙", "丙"]);
  });
});
