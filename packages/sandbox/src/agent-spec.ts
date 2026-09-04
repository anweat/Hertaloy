/**
 * agent 节点的声明 —— **一条命令行**（第五次归约，FOUNDATION §14）。
 *
 * ## 为什么它在 sandbox 而不在 contracts
 *
 * 这份 schema 原本住在 `@nodeflow/contracts` 的 `template.ts` 里。可它整个是
 * **执行面语义**：`workspace.from` 是工作区交接、`network: none|internal|open`
 * 是出网策略、`profile: claude-code|codex` 是渲染成谁认识的文件 ——
 * 全是"怎么跑"，而契约层是给画布与 LLM 用的纯结构层（`instances.ts` 那条
 * 注释说的就是这个）。
 *
 * 搬过来之后，内核对执行面只剩两条线：
 *
 *   `ExecutionBackend`  两个方法（run / cancel）
 *   `NodeExecutionSpec` 不透明 JSON，内核只坚持"不许写凭据"
 *
 * 内核源码里 `grep 'argv|workspace|capabilities|profile'` 仍然零命中 ——
 * 搬之前就是零，搬之后连**类型**上的穿透也没了。
 *
 * ## 注册期仍然校验
 *
 * 搬走不等于放到运行期才查。`registerContainerTemplate` 有一条校验缝
 * （`validateExecutionSpec`），CLI 把 `checkAgentSpec` 接进去，于是
 * "workspace 既给 source 又给 from"这类错仍然在注册期被拒 ——
 * 与 §1「注册期拒绝，不做运行期救火」一致。没接的话只剩契约层那条凭据扫描。
 *
 * ## 密钥那条留在 contracts
 *
 * `env` 这里是普通 `z.string()`。不写凭据是**对象库的规矩**（§17.7：模板不可变、
 * 内容寻址、按前缀可读），不是执行面的规矩，所以它留在 `NodeExecutionSpec` 上，
 * 而且现在递归扫所有字符串 —— 比原来只查 `env` 管得宽。
 */

import { z } from "zod";

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const Ident = z.string().regex(IDENT, "标识符必须以字母或下划线起头");
const NodeId = z.string().min(1);

export const AgentSpec = z
  .object({
    argv: z.array(z.string()).nonempty(),
    /** 卡片渲染成谁认识的文件（`claude-code` / `codex` / `hertaloy-agent`）。 */
    profile: z.string().optional(),
    /** 注入到 `.hertaloy/context/` 的文件：相对路径 → 内容。 */
    context: z.record(z.string()).optional(),
    /**
     * 环境变量。**只放取值方式，不放值本身。**
     *
     * `$NAME` 从跑它那台机器的环境里取；字面量只允许非凭据的配置值
     * （`NODE_ENV=production` 这类）。像凭据的字面量在**注册期**就被拒 ——
     * 此前这条只是注释，没有任何强制点，而模板是不可变对象：
     * 写进去就撤不回来，只能换密钥。
     */
    env: z.record(z.string()).optional(),
    /**
     * 这个节点的**能力上界** —— 声明在模板上，agent 碰不到。
     *
     * 此前它们只存在于 backend 的构造参数里：`NetworkPolicy` 是
     * `DockerRunner` 的一个字段，**一个 run 里所有 agent 节点共用一条**。
     * 两个后果：
     *
     *   1. "审计 agent 不许上网、研究 agent 可以" —— 表达不出来
     *   2. 渲染层读不到任何节点的能力，"这个节点跑在什么策略下"画不出来
     *
     * 声明与使用要分在两个面上：**能力声明在模板里**（可读、可渲染、
     * agent 碰不到），**能力使用在工具里**（可记录、有范围、agent 可调）。
     * 放进 agent 自己能调的工具面，就等于让它松开自己的笼子。
     *
     * 省略 = 用 backend 的缺省（保持既有行为，这是个纯增字段）。
     */
    capabilities: z
      .object({
        /** `none` 断网 · `internal` 只通本 run 的内网 · `open` 放行。 */
        network: z.enum(["none", "internal", "open"]).optional(),
        wallClockSeconds: z.number().positive().optional(),
        /** 跑完留不留沙箱 —— 留着是为了事后翻现场。 */
        retain: z.enum(["always", "on-failure", "never"]).optional(),
      })
      .strict()
      .optional(),
    /**
     * 工作区：把一个**具名**仓库物化成工作树。
     *
     * `source` 是别名，不是路径或 URL —— 具体指向哪个仓库由 backend 配置决定。
     * 模板因此可移植：同一份模板在不同机器上跑不同的仓库，而 agent 始终
     * 拿不到真实位置。
     */
    /**
     * 工作区来源，**二选一**：
     *
     *   `source`  从具名仓库克隆一份新的（起点可用 `base` 钉住）
     *   `from`    **接过本容器内某个上游节点的工作区** —— 子流程的关键
     *
     * `from` 只能写**本容器内的节点名**，于是交接天然被限定在自己的命名空间里：
     * 一个实例接不到兄弟实例的工作区。这不是靠额外检查实现的，
     * 是靠"节点名是模板局部的"这条本来就有的性质。
     *
     * 交接而不是共享：下游拿到的是上游工作区的**一份拷贝**，各自仍有独立沙箱、
     * 独立快照。共享目录会让并行的两个节点互相踩，而沙箱一次性正是并行安全的来源。
     */
    workspace: z
      .object({
        source: Ident.optional(),
        base: z.string().min(1).optional(),
        from: NodeId.optional(),
      })
      .strict()
      .refine(
        (w) => (w.source === undefined) !== (w.from === undefined),
        "workspace 要么给 source（从具名仓库克隆），要么给 from（接过上游节点的工作区），不能都给也不能都不给",
      )
      .refine(
        (w) => w.base === undefined || w.source !== undefined,
        "base 只在 source 模式下有意义 —— 接过上游工作区时起点由上游决定",
      )
      .optional(),
    /**
     * 参考资料：别名 → 具名资源。落在 `.hertaloy/resources/<别名>/`。
     *
     * 不落 `workspace/`：工作树是被观察的，参考资料混进去会被算成 agent 的改动。
     */
    resources: z.record(Ident, Ident).optional(),
  })
  .strict();

export type AgentSpec = z.infer<typeof AgentSpec>;

/** 注册期校验一份 agent 段。返回人读的问题清单，空数组 = 没问题。 */
export function checkAgentSpec(spec: unknown, where: string): readonly string[] {
  const parsed = AgentSpec.safeParse(spec);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (i) => `${where}${i.path.length > 0 ? `.${i.path.join(".")}` : ""}：${i.message}`,
  );
}
