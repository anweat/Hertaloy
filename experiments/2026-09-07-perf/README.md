# drain 的二次成本从哪来

2026-09-07。基线 `3faa172`（本轮改动之前），改动后为本目录所在提交。

## 结论

`InstanceRegistry.#template(ref)` 每次调用都对整份模板做一次 zod `safeParse`，
而 `#pickWork` 对**每一步的每一条排队消息**都调它 —— 于是 `drain` 是 M²/2
次全量模板解析。**1600 条消息要 27 秒。**

按版本对象记一份解析结果之后：

| 队列消息数 M | 基线 | 现在 | 倍数 |
|---|---|---|---|
| 200 | 198.0ms | 21.5ms | 9.2× |
| 400 | 735.4ms | 50.7ms | 14.5× |
| 800 | 7715.8ms | 181.9ms | **42×** |
| 1600 | 26836.1ms | 755.4ms | **36×** |

仍是二次（每条 0.108ms → 0.472ms），但常数小了一个量级。剩下的二次来自
`#pickWork` 每步扫一遍 `queued()`；要压掉它得建一张 QUEUED 索引，
那是要维护的第二份状态，本轮没做。

`settleAll` 基本没变（N=801 时 195ms → 196ms）—— 它不怎么调 `template()`。
`canTerminate` 的常数小了一半（不再为了判一个布尔值渲染中文字符串）。

## 一个被推翻的中间结论

同进程里先后跑两组会互相污染。我一度据此断言"生产默认 `keepConsumedMessages=200`
比不清理还慢一倍多"，并照着改了 `prune()` 的门槛。分进程重测后：

```
keepConsumedMessages=-1    M=200  21.5ms   M=1600  755.4ms
keepConsumedMessages=200   M=200  20.5ms   M=1600  758.5ms
```

**没有差别。**那条改动因此撤回了 —— 而且它本身是错的：它按 `#messages.size`
的增长判断何时再扫，而 drain 期间 size 只减不增，等于把清理关掉。

## 怎么复现

```powershell
corepack pnpm exec tsx experiments/2026-09-07-perf/bench.mts drain-nokeep
corepack pnpm exec tsx experiments/2026-09-07-perf/bench.mts drain-keep
corepack pnpm exec tsx experiments/2026-09-07-perf/bench.mts settle
```

**分开跑，别合并** —— 同进程连跑会让后一组慢一到两倍，那是 GC 不是产品行为。
每档取 3 次中位数。数字与机器相关，看的是**倍数与增长趋势**，不是绝对值。
