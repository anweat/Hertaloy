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

function q(): MessageQueue {
  return new MessageQueue();
}

const to = (traceid: string, node = "n", port = "in") => ({
  instance: `${traceid}/${node}`,
  port,
});

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

  it("`queued()` 只给还在排队的；CLAIMED 仍算「还会动的」", () => {
    const queue = q();
    const a = queue.enqueue({ target: to("job-1"), payload: {} });
    const b = queue.enqueue({ target: to("job-1"), payload: {} });
    const c = queue.enqueue({ target: to("job-2"), payload: {} });
    queue.setState(a, "CLAIMED");
    queue.setState(b, "CONSUMED");

    expect(queue.queued().map((m) => m.id)).toEqual([c]);
    // CLAIMED 正被某个执行占着，所以它是活的；CONSUMED 已了结
    expect(isLive(queue.get(a))).toBe(true);
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

describe("★ 离队：谁该走由 Runtime 定，队列只管走干净", () => {
  /**
   * 这里原来是 `prune()`：队列自己按 `keepConsumedMessages` 决定丢谁，
   * 于是它必须在"头无界增长"与"历史消失"之间选一个 —— 两边都不对。
   *
   * 现在终态消息由 Runtime 先落进 `$msg` 再离队（`#settleMessage`），
   * 队列不再有策略。剩下要钉的只有两条**机械**性质，而两条都咬过人。
   */
  it("离队要两处都清 —— `#messages` 和 `#order`", () => {
    const queue = q();
    const [a, b, c] = [1, 2, 3].map(() => queue.enqueue({ target: to("job-1"), payload: {} }));
    queue.drop(b as string);
    expect(queue.has(b as string)).toBe(false);
    // `all()` 是按 `#order` 物化的：漏清 order 会在这里抛"未知消息"
    expect(queue.all().map((m) => m.id)).toEqual([a, c]);
  });

  it("★ 离队不释放号段 —— id 全局单调", () => {
    const queue = q();
    const first = queue.enqueue({ target: to("job-1"), payload: {} });
    queue.drop(first);
    const next = queue.enqueue({ target: to("job-1"), payload: {} });
    // 回退 seq 会让新消息复用已落库的 id，两条不同的消息在历史里撞成一条
    expect(next).not.toBe(first);
    expect([first, next]).toEqual(["msg-1", "msg-2"]);
  });

  it("丢不存在的 id 不炸 —— 幂等，重复收口不该是错误", () => {
    const queue = q();
    expect(() => queue.drop("msg-99")).not.toThrow();
  });
});

describe("★ 快照往返", () => {
  /**
   * 队列同时是**事务的可回滚部件**和**落盘内容的一部分**。两个用途共用一份
   * `snapshot()`，所以 `seq` 必须一起带走 —— 漏了它，恢复之后新消息会拿到
   * 已经用过的 id，覆盖掉旧消息且不留痕迹。
   */
  it("恢复之后顺序、状态、seq 都对得上", () => {
    const queue = q();
    const a = queue.enqueue({ target: to("job-1"), payload: { v: 1 } });
    const b = queue.enqueue({ target: to("job-2"), payload: { v: 2 }, alias: "x" });
    queue.setState(a, "CONSUMED");
    const snap = queue.snapshot();

    const restored = q();
    restored.restore(snap);
    expect(restored.all().map((m) => m.id)).toEqual([a, b]);
    expect(restored.get(a).state).toBe("CONSUMED");
    expect(restored.get(b).alias).toBe("x");

    // ★ seq 带走了：下一条不会跟已有的撞号
    const next = restored.enqueue({ target: to("job-1"), payload: {} });
    expect(next).toBe("msg-3");
  });

  it("回滚语义：拿旧快照恢复，中间的改动整体消失", () => {
    const queue = q();
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
    const queue = q();
    const a = queue.enqueue({ target: to("job-1"), payload: {} });
    const snap = queue.snapshot() as { messages: Map<string, Message> };
    queue.setState(a, "CONSUMED");
    expect(snap.messages.get(a)?.state).toBe("QUEUED");
  });
});
