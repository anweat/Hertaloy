/**
 * 状态不变量 —— 抽成纯函数之后才写得出的那些用例。
 *
 * 挂在 `Runtime` 上时，这些检查只能"跑一遍正常流程，然后期待它不报"。
 * 而**正确的运行时摆不出违规状态** —— 于是最该被钉住的那几条
 * （claim 被偷走、半状态）从来没有正面用例，只有 `patterns.test.ts` 里
 * 一条靠 `registry.setStatus` 绕后门造出来的。
 *
 * 纯函数可以直接把事实喂进去，所以这里逐条正反都钉。
 */

import { describe, expect, it } from "vitest";
import { formatProblems, stateProblems, type InvariantFacts } from "../src/invariants.js";
import type { Message } from "../src/queue.js";

function msg(id: string, state: Message["state"], traceid = "job-1"): Message {
  return {
    id,
    target: { instance: `${traceid}/n`, port: "in" },
    payload: {},
    state,
    attempts: 0,
  };
}

const facts = (f: Partial<InvariantFacts>): InvariantFacts => ({
  messages: [],
  executions: [],
  instances: [],
  obligations: [],
  ...f,
});

describe("消息 CLAIMED ⟺ 存在引用它的 RUNNING 记录", () => {
  it("配对上就没问题", () => {
    expect(
      stateProblems(
        facts({
          messages: [msg("msg-1", "CLAIMED")],
          executions: [
            { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("CLAIMED 却没有 RUNNING 记录 → 报", () => {
    const out = stateProblems(facts({ messages: [msg("msg-1", "CLAIMED")] }));
    expect(out).toEqual(["消息 msg-1 是 CLAIMED，但没有 RUNNING 记录引用它"]);
  });

  it("RUNNING 记录引用了一条已 CONSUMED 的消息 → 报", () => {
    const out = stateProblems(
      facts({
        messages: [msg("msg-1", "CONSUMED")],
        executions: [
          { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
        ],
      }),
    );
    expect(out).toEqual(["RUNNING 记录引用了 msg-1，但它是 CONSUMED"]);
  });

  it("记录引用了一条不存在的消息 → 不报（那是 GC 掉的历史，不是半状态）", () => {
    expect(
      stateProblems(
        facts({
          executions: [
            { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-9"] },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("★ 一条消息至多被一条 RUNNING 记录 claim", () => {
  /**
   * 这条就是"claim 被偷走"的样子。**以前没有正面用例** —— 要构造它，
   * 得让运行时同时开出两条 RUNNING 记录指向同一条消息，而 `#busy` 正好挡着。
   */
  it("两条 RUNNING 记录抢同一条消息 → 报", () => {
    const out = stateProblems(
      facts({
        messages: [msg("msg-1", "CLAIMED")],
        executions: [
          { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
          { executionId: "exec-2", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
        ],
      }),
    );
    expect(out).toEqual(["消息 msg-1 同时被 exec-1 与 exec-2 claim"]);
  });

  it("★ 重试留下的旧记录不算违规 —— 只看 RUNNING", () => {
    /**
     * 重试后旧记录仍列着那条消息，但那是**历史**不是活跃 claim。
     * 把 SETTLED 也算进来会把正常重试判成违规（第一版就是这么写的，测试当场炸了）。
     */
    expect(
      stateProblems(
        facts({
          messages: [msg("msg-1", "CLAIMED")],
          executions: [
            { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "SETTLED", claimed: ["msg-1"] },
            { executionId: "exec-2", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("VOIDED 的也不算 —— 结果被栅栏丢掉了", () => {
    expect(
      stateProblems(
        facts({
          messages: [msg("msg-1", "CLAIMED")],
          executions: [
            { executionId: "exec-1", traceid: "job-1", nodeId: "n", status: "VOIDED", claimed: ["msg-1"] },
            { executionId: "exec-2", traceid: "job-1", nodeId: "n", status: "RUNNING", claimed: ["msg-1"] },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("TERMINAL 的实例不该还背着东西", () => {
  const dead = { traceid: "job-1/c1", status: "TERMINAL" };

  it("还有在途消息 → 报（QUEUED 与 CLAIMED 都算）", () => {
    const out = stateProblems(
      facts({
        instances: [dead],
        messages: [msg("msg-1", "QUEUED", "job-1/c1"), msg("msg-2", "CLAIMED", "job-1/c1")],
        executions: [
          { executionId: "exec-1", traceid: "job-1/c1", nodeId: "n", status: "RUNNING", claimed: ["msg-2"] },
        ],
      }),
    );
    expect(out).toContain("实例 job-1/c1 已 TERMINAL，却仍有 2 条在途消息");
    expect(out).toContain("实例 job-1/c1 已 TERMINAL，却仍有 RUNNING 执行 exec-1");
  });

  it("已了结的消息不算 —— CONSUMED / FAILED / DISCARDED 都是历史", () => {
    expect(
      stateProblems(
        facts({
          instances: [dead],
          messages: [
            msg("msg-1", "CONSUMED", "job-1/c1"),
            msg("msg-2", "FAILED", "job-1/c1"),
            msg("msg-3", "DISCARDED", "job-1/c1"),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("还在等东西 → 报（只看 request / child；自己在跑不算在等）", () => {
    const out = stateProblems(
      facts({
        instances: [dead],
        obligations: [
          { kind: "child", holder: "job-1/c1", key: "job-1/c1/x", waitingOn: "job-1/c1/x" },
          { kind: "request", holder: "job-1/c1", key: "req-1", waitingOn: "job-1/svc" },
          // message / execution 是"自己还在跑"，上面两条已经分别检查过了
          { kind: "message", holder: "job-1/c1", key: "msg-1" },
        ],
      }),
    );
    expect(out).toEqual(["实例 job-1/c1 已 TERMINAL，却仍在等 2 件事"]);
  });

  it("别人名下的义务不算到它头上", () => {
    expect(
      stateProblems(
        facts({
          instances: [dead],
          obligations: [
            { kind: "child", holder: "job-1", key: "job-1/c1", waitingOn: "job-1/c1" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("OPEN 的实例背着东西是正常的", () => {
    expect(
      stateProblems(
        facts({
          instances: [{ traceid: "job-1/c1", status: "OPEN" }],
          messages: [msg("msg-1", "QUEUED", "job-1/c1")],
          obligations: [
            { kind: "child", holder: "job-1/c1", key: "job-1/c1/x", waitingOn: "job-1/c1/x" },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("渲染", () => {
  it("没问题就是 null —— 调用方据此决定抛不抛", () => {
    expect(formatProblems([])).toBeNull();
  });

  it("多条违规一次列全，不是抛第一条就停", () => {
    const text = formatProblems(["甲", "乙"]) as string;
    expect(text).toContain("状态不变量被破坏：");
    expect(text).toContain("甲");
    expect(text).toContain("乙");
  });
});
