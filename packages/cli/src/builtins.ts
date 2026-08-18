/**
 * 内置 handler 库。
 *
 * 受信 handler 是**服务端注册的代码**（§6.4），CLI 不可能让用户从 json 里
 * 递一段逻辑进来 —— 那正是"AI 只能选不能构造"这条的边界。所以 CLI 能跑的图，
 * 节点必须引用这里已注册的名字。
 *
 * 这个库也是**开发指南的落点**：汇聚 / 计数 / 择优三种标准写法各在这里有一份
 * 可直接引用的实现（`packages/kernel/test/patterns.test.ts` 是它们的可运行样例）。
 */

import type { BuiltinHandler } from "@nodeflow/kernel";

export const BUILTIN_HANDLERS: Readonly<Record<string, BuiltinHandler>> = {
  /** 什么都不做，消费掉消息。用于终点与占位。 */
  noop: () => ({}),

  /** 原样转发到 `out` 端口。 */
  echo: (vars) => ({ out: { ...vars } }),

  /**
   * 汇聚：把本次载荷写成一版资产，读到 `expect` 份才往 `done` 发。
   *
   * 变量约定：`expect`（要几份）、`name`（资产名，默认 `parts`）。
   * 这是「版本历史即状态」（C5）的标准写法 —— 不存节点状态。
   */
  collect: (vars, ctx) => {
    const name = typeof vars.name === "string" ? vars.name : "parts";
    const expect = typeof vars.expect === "number" ? vars.expect : 1;
    // `index` 不是装饰，是**必需的**：见文件末尾"计数类写法"那段。
    // 少了它，三个子容器给出相同答案时只会留下一份，汇聚永远等不齐。
    ctx.put(name, "part", { index: ctx.history(name).length + 1, value: vars.value ?? null });
    const all = ctx.history(name);
    if (all.length < expect) return {};
    return { done: { parts: all.map((o) => o.body.value ?? null) } };
  },

  /**
   * 循环计数：版本号就是 epoch，走满 `rounds` 轮从 `out` 出，否则从 `again` 出。
   */
  loop: (vars, ctx) => {
    const rounds = typeof vars.rounds === "number" ? vars.rounds : 1;
    const epoch = ctx.history("epoch").length + 1;
    ctx.put("epoch", "marker", { round: epoch });
    return epoch < rounds ? { again: { epoch } } : { out: { epoch } };
  },
};

/**
 * **计数类写法必须把序号写进 body。**
 *
 * 这是 C5（版本历史即状态）与内容寻址去重的交界处，也是这两个 handler 之前
 * 都踩塌了的地方：`put` 对**同 id 同内容**返回既有版本、不产生新版本，
 * 所以"重复发生的相同事件"在版本历史里只会留下一条。
 *
 * 后果不是数字算错，是**流程卡死**：
 *   - `loop` 原先写 `{ at: Date.now() % 1 }` —— 这一项恒等于 0（毫秒数是整数），
 *     于是每轮内容相同，版本数永远是 1，`rounds > 1` 的循环永不退出。
 *   - `collect` 原先只写 `{ value }` —— 三个子容器给出相同答案时只留一份，
 *     汇聚永远等不齐。
 *
 * 也别拿时间戳或随机数去凑唯一：那会违反 §17.5 的 handler 确定性契约，
 * 从检查点重放时对不上。正确的序号来源是 `ctx.history(name).length + 1` ——
 * 它既单调又确定。
 */

export const BUILTIN_NAMES: readonly string[] = Object.keys(BUILTIN_HANDLERS).sort();
