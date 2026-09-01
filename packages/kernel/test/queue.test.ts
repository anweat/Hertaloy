/**
 * 消息队列 —— 从 `runtime.ts` 抽出来那一块的自有用例。
 *
 * 抽之前这些行为只被**间接**覆盖（跑一遍编排，顺带把队列也走了）。间接覆盖的
 * 毛病是：改坏了不一定在这里红，而是在三层之外某条断言上莫名其妙地红。
 * 抽出来就该有自己的钉子，尤其是下面三条 —— 每条都对应一次真踩过的坑。
 */

import { describe, expect, it } from "vitest";
import { MessageQueue, isLive, type Message } from "../src/queue.js";
import { InvariantError } from "../src/errors.js";

function q(keep = -1): MessageQueue {
  return new MessageQueue(keep);
}

const to = (traceid: string, node = "n", port = "in") => ({ traceid, node, port });

describe("投递与取值", () => {
  it("id 单调发放，`all()` 按投递顺序", () => {
    const queue = q();
    const a = queue.enqueue({ target: to("job-1"), payload: { v: 1 } });
    const b = queue.enqueue({ target: to("job-1"), payload: { v: 2 } });
    expect([a, b]).toEqual(["msg-1", "msg-2"]);
    expect(queue.all().map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(queue.all()[0]?.state).toBe("QUEUED");
    expect(queue.all()[0]?.attempts).toBe(0);
  });

  it("取不到是编程错误，不是空值 —— id 只由本类发放", () => {
    const queue = q();
    expect(queue.has("msg-9")).toBe(false);
    expect(() => queue.get("msg-9")).toThrow(InvariantError);
    expect(() => queue.get("msg-9")).toThrow(/未知消息/);
  });

  it("`queued()` 只给还在排队的；`liveFor` 按实例 + 还会动的状态过滤", () => {
    const queue = q();
    const a = queue.enqueue({ target: to("job-1"), payload: {} });
    const b = queue.enqueue({ target: to("job-1"), payload: {} });
    const c = queue.enqueue({ target: to("job-2"), payload: {} });
    queue.setState(a, "CLAIMED");
    queue.setState(b, "CONSUMED");

    expect(queue.queued().map((m) => m.id)).toEqual([c]);
    // CLAIMED 仍然算"还会动的" —— 它正被某个执行占着
    expect(queue.liveFor("job-1").map((m) => m.id)).toEqual([a]);
    expect(queue.liveFor("job-2").map((m) => m.id)).toEqual([c]);
    expect(isLive(queue.get(b))).toBe(false);
  });
});

describe("★ 消息是冻结对象，改状态换新对象", () => {
  /**
   * 共享可变消息会让"提交是事务"在回滚时失真 —— 快照拷的是引用，
   * 原地改就绕过了回滚。这条不靠自觉，靠 `Object.freeze`。
   */
  it("原地改会抛，`replace` 产生新对象", () => {
    const queue = q();
    const id = queue.enqueue({ target: to("job-1"), payload: {} });
    const before = queue.get(id);
    expect(Object.isFrozen(before)).toBe(true);
    expect(() => {
      (before as { state: string }).state = "CONSUMED";
    }).toThrow(TypeError);

    queue.setState(id, "CONSUMED");
    expect(queue.get(id)).not.toBe(before);
    expect(before.state).toBe("QUEUED"); // 旧引用不受影响 —— 快照因此可回滚
    expect(queue.get(id).state).toBe("CONSUMED");
  });

  it("`replace` 只打补丁，其余字段原样带过去", () => {
    const queue = q();
    const id = queue.enqueue({
      target: to("job-1"),
      payload: { v: 1 },
      alias: "progress",
      requestId: "req-1",
    });
    queue.replace(id, { state: "FAILED", attempts: 2, failure: "炸了" });
    expect(queue.get(id)).toMatchObject({
      state: "FAILED",
      attempts: 2,
      failure: "炸了",
      alias: "progress",
      requestId: "req-1",
      payload: { v: 1 },
    });
  });
});

describe("★ 回收：只丢 CONSUMED", () => {
  /**
   * 头**每次提交全量重写**，所以已消费消息无界增长会让累计写入变成平方级
   * （实测 2000 条 → head.json 1.1 MB，而其中在队列里的是 0 条）。
   *
   * 但不能见旧就丢：`DISCARDED` 是截断留下的，迟到的结果还要靠它走冲突域
   * 复核（L3）；`FAILED` 是排查现场。
   */
  it("留最近 N 条已消费，更老的丢掉", () => {
    const queue = q(2);
    const ids = Array.from({ length: 6 }, () =>
      queue.enqueue({ target: to("job-1"), payload: {} }),
    );
    for (const id of ids) queue.setState(id, "CONSUMED");
    queue.prune();
    // `#order` 是投递顺序，所以留下的是最后两条
    expect(queue.all().map((m) => m.id)).toEqual(ids.slice(-2));
  });

  it("★ DISCARDED 与 FAILED 一条都不丢", () => {
    const queue = q(0);
    const discarded = queue.enqueue({ target: to("job-1"), payload: {} });
    const failed = queue.enqueue({ target: to("job-1"), payload: {} });
    const consumed = queue.enqueue({ target: to("job-1"), payload: {} });
    queue.setState(discarded, "DISCARDED", "被截断");
    queue.setState(failed, "FAILED", "炸了");
    queue.setState(consumed, "CONSUMED");
    // 撑过阈值，逼 prune 真的动手
    for (let i = 0; i < 4; i += 1) {
      queue.setState(queue.enqueue({ target: to("job-1"), payload: {} }), "CONSUMED");
    }
    queue.prune();

    const left = new Set(queue.all().map((m) => m.id));
    expect(left.has(discarded)).toBe(true);
    expect(left.has(failed)).toBe(true);
    expect(left.has(consumed)).toBe(false);
  });

  it("负数 = 不清理", () => {
    const queue = q(-1);
    for (let i = 0; i < 50; i += 1) {
      queue.setState(queue.enqueue({ target: to("job-1"), payload: {} }), "CONSUMED");
    }
    queue.prune();
    expect(queue.all()).toHaveLength(50);
  });

  it("QUEUED 的永远不丢 —— 它们还没跑", () => {
    const queue = q(0);
    for (let i = 0; i < 10; i += 1) queue.enqueue({ target: to("job-1"), payload: {} });
    queue.prune();
    expect(queue.all()).toHaveLength(10);
  });
});

describe("★ 快照往返", () => {
  /**
   * 队列同时是**事务的可回滚部件**和**落盘内容的一部分**。两个用途共用一份
   * `snapshot()`，所以 `seq` 必须一起带走 —— 漏了它，恢复之后新消息会拿到
   * 已经用过的 id，覆盖掉旧消息且不留痕迹。
   */
  it("恢复之后顺序、状态、seq 都对得上", () => {
    const queue = q(-1);
    const a = queue.enqueue({ target: to("job-1"), payload: { v: 1 } });
    const b = queue.enqueue({ target: to("job-2"), payload: { v: 2 }, alias: "x" });
    queue.setState(a, "CONSUMED");
    const snap = queue.snapshot();

    const restored = q(-1);
    restored.restore(snap);
    expect(restored.all().map((m) => m.id)).toEqual([a, b]);
    expect(restored.get(a).state).toBe("CONSUMED");
    expect(restored.get(b).alias).toBe("x");

    // ★ seq 带走了：下一条不会跟已有的撞号
    const next = restored.enqueue({ target: to("job-1"), payload: {} });
    expect(next).toBe("msg-3");
  });

  it("回滚语义：拿旧快照恢复，中间的改动整体消失", () => {
    const queue = q(-1);
    const a = queue.enqueue({ target: to("job-1"), payload: {} });
    const before = queue.snapshot();

    queue.setState(a, "CONSUMED");
    queue.enqueue({ target: to("job-1"), payload: {} });
    expect(queue.all()).toHaveLength(2);

    queue.restore(before);
    expect(queue.all().map((m) => m.id)).toEqual([a]);
    expect(queue.get(a).state).toBe("QUEUED");
  });

  it("快照是拷贝，不是引用 —— 之后的改动不会渗回去", () => {
    const queue = q(-1);
    const a = queue.enqueue({ target: to("job-1"), payload: {} });
    const snap = queue.snapshot() as { messages: Map<string, Message> };
    queue.setState(a, "CONSUMED");
    expect(snap.messages.get(a)?.state).toBe("QUEUED");
  });
});
