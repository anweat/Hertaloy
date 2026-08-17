/**
 * 提交事务。
 *
 * 对应 FOUNDATION_V5.md §10.1：一次提交要同时改消息状态、锁账本、pending 请求表、
 * 下游消息、产物版本、RunSnapshot —— **这些必须原子**。
 *
 * 在此之前"零部分提交"只做到了"零部分**排期**"：排期算好了才提交，
 * 但提交本身是一串顺序 mutation，第 4 步抛异常会留下前 3 步的half state。
 *
 * 实现之所以能这么简单，是因为内核里所有可变容器装的都是**冻结对象**：
 * Map/数组做浅拷贝就是完整快照，不需要深拷贝，也不可能被绕过去改。
 */

export interface Snapshotable {
  snapshot(): unknown;
  restore(snap: unknown): void;
}

/**
 * 在一组可回滚部件上执行一次原子变更。
 *
 * 抛异常 → 全部恢复到调用前，异常继续上抛。
 * 注意恢复顺序与快照顺序无关：各部件互不依赖，各自还原即可。
 */
export function transact<T>(parts: readonly Snapshotable[], fn: () => T): T {
  const snaps = parts.map((p) => p.snapshot());
  try {
    return fn();
  } catch (error) {
    parts.forEach((p, i) => {
      p.restore(snaps[i]);
    });
    throw error;
  }
}
