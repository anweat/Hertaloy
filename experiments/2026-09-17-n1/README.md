# N1 探针：命名空间的根从容器下沉到执行位点，代价有多大

2026-09-17。基线 `7134b98`（工作树干净）。**探针已回退，仓库未改。**

## 为什么做这次测量

`V6_REDESIGN.md` 提案里最关键的一条论证是：MODEL §7.4「聚合判定只能在同步 handler 里做」
可以整条删掉，因为它的真实成因不是 agent 的异步性，而是**命名空间的根取成了容器**——
`#handlerContext` 的 `put`/`history` 用 `containerOf(input.target)`，于是同一容器里
两个节点写同一个对象，才需要"新鲜读"这条无强制点的规矩来兜。

把根下沉到执行位点（N1 写者唯一），同容器两个位点就再也写不到同一个对象。
但这是**行为破坏**：对象 id 里含着这个前缀，而对象是内容寻址、不会自动迁移。
所以先量：多少条用例变红、分别是哪一类。

## 探针（7 行，4 处读点）

```diff
- id: namespacedId(containerOf(record), artifact.object_id),     # agent 产物
+ id: namespacedId(record.instance, artifact.object_id),

  #handlerContext(traceid, input) {
+   const root = input.target.instance;      // 根下沉到位点；spawn 仍挂容器
-   withinNamespace(traceid, …)  history(namespacedId(traceid, …))
-   withinNamespace(traceid, prefix, …)      store.put(namespacedId(traceid, …))
+   withinNamespace(root, …)     history(namespacedId(root, …))
+   withinNamespace(root, prefix, …)         store.put(namespacedId(root, …))
```

`spawn` 与 `provenance` 刻意不动，好让这次测量只反映"命名空间"这一件事。

## 结果：964 条里 29 条变红

| 包 | 红 | 总 |
|---|---|---|
| kernel | 13 | 331 |
| cli | 12 | 198 |
| state | 3 | 87 |
| mcp | 1 | 19 |
| **scene** | **0** | 66 |
| **contracts** | **0** | 71 |
| **sandbox** | **0** | 199 |

**scene / contracts / sandbox 三个包一条不红**，是这次测量最值得记的一条：
渲染层与执行面**不依赖对象命名空间的根**。所以这次破坏面是内核 + 落盘 + 命令行，
不外扩到观测与沙箱。

## 分类：26 条机械更新，3 条真语义断裂

### 机械更新（26 条）—— 断言里写死了对象 id，路径深了一层

全部形如 `job-1/results` → `job-1/gather/results`：

- `store.resolve("job-1/coder-1/plan@1")`（checkpoint-b）→ 实际是 `job-1/coder-1/writer/plan@1`
- `expect(emitted).toMatch(/^job-1\/plan@\d+$/)`（ref-and-frame14）→ 实际是 `job-1/writer/plan@1`
- `未知对象 job-1/parts`（cli 的 builtins / state-commands / json-contract / workflow，mcp 全链）
  —— `collect` 这个内置写到位点根了，而断言读的是容器根
- `未知对象 job-1/done` / `job-1/memo`（state 跨进程恢复）
- `expect(r.data).toHaveProperty("artifacts", [{ ref: "job/reports/result.md@1" }])`（cli live-journal）

这一类不需要判断，只需要改断言里的前缀。**其中 `ref-and-frame14` 那条尤其值得注意：
运行期是自洽的**（`ctx.put` 返回的 ref 经 emit 传给下游、下游 servo `type:"ref"` 解引用成功），
红的只是"断言写死了旧前缀"。也就是说**引用在跨位点传递这条链路本身没有断**。

### 真语义断裂（3 条）—— 全部同一个根因

| 用例 | 报错 |
|---|---|
| kernel/patterns `★ 跨实例汇聚靠 ctx.collect（剧本帧 12 的真实形状）` | `collect("job-1") 跨命名空间："job-1" 不在 job-1/merge 的子树内` |
| kernel/fanout-merge `三个 coder 干完 → 各自 settle → 父被通知三次 → 第三次才汇聚` | 同上 |
| kernel/patterns `自己的命名空间及其子树照常可读、可汇聚` | `read job-1/coder-1/results@1 跨命名空间："job-1/coder-1/results" 不在 job-1/collect 的子树内` |

**根因只有一个**：`merge` 是容器 `job-1` 里的一个**位点**，`coder-1` 是 `job-1` 的**子容器**。
在容器根的时代，两者同在 `job-1` 名下，所以 merge 读 coder-1 的产物属于"读自己的子树"；
根下沉到位点之后，从 `job-1/merge` 看，`job-1/coder-1` 是**兄弟**，不在自己的子树内。

这正是帧 12。所以 N1 的代价是**精确的一条**：父容器名下的跨位点汇聚失去了落点。

## 结论

1. **N1 的破坏面比预期小，而且集中**：29/964，其中 26 条是改前缀，3 条是同一个设计缺口。
2. **那个设计缺口的替代品提案里已经有了**：把跨位点汇聚从运行期的 `ctx.collect(任意前缀)`
   改成**声明期的 `gather`**（端口变量的一种来源，注入期由内核代取）。理由在这次测量之后更硬：
   合法的跨位点读只剩**一种形状** —— 父容器名下、指名某个子槽的汇聚。
   这个形状在声明期完全表达得出来，不需要运行期接受任意前缀。
   而"授权来自容器、执行由内核代取"正好解释了它为什么该是注入，不该是执行体自己调的工具。
3. **`ctx.collect` 因此不是被裁剪，是被替换**：PA1 那次给 `read`/`collect` 加的裁剪，
   在 N1 之后会把帧 12 一起挡住 —— 与其放宽裁剪，不如让跨位点汇聚根本不走运行期读。
4. **破坏性可以一次付清**：26 条机械更新 + 3 条改写法，与 head 格式升级放同一批。
   已落库对象不迁移（内容寻址），按"重建不热恢复"处理。

## 复现

```bash
# 施加探针（4 处读点，见上方 diff），然后：
pnpm -r --no-bail test
```

探针补丁未进仓库。基线 `7134b98` 下的全绿数字是 964 passed / 7 skipped（Docker daemon 未运行）。
