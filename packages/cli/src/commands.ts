/**
 * 命令实现。每个命令返回**文本 + 退出码**，不直接打印 ——
 * 这样它们能被测试直接断言，而不必去捕获 stdout。
 */

import {
  ContainerTemplate,
  isOverlay,
  validateContainerTemplate,
} from "@nodeflow/contracts";
import {
  InstanceRegistry,
  ObjectStore,
  Runtime,
  registerContainerTemplate,
  type StepFailure,
  type StepResult,
} from "@nodeflow/kernel";
import { BUILTIN_HANDLERS, BUILTIN_NAMES } from "./builtins.js";
import { Scenario } from "./scenario.js";

export interface CommandResult {
  readonly text: string;
  readonly code: number;
}

const ok = (text: string): CommandResult => ({ text, code: 0 });
const fail = (text: string): CommandResult => ({ text, code: 1 });

/**
 * 干跑校验：**不落库**。
 *
 * 这是 G1 自我修正内循环的命令行出口 —— 助手 AI 生成模板后自己跑一遍拿
 * LLM 可读错误，改完再提交，不需要先污染对象库。修的正是 V4 那条实质缺陷
 * （`propose` 不校验 ⇒ 人成了 AI 的语法检查器）。
 */
export function validate(raw: unknown): CommandResult {
  if (isOverlay(raw)) {
    return ok("覆盖层：结构合法。合并结果需要基定义才能校验，请用 `run` 或 `define`。");
  }
  const parsed = ContainerTemplate.safeParse(raw);
  if (!parsed.success) {
    return fail(
      ["结构非法：", ...parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}：${i.message}`)].join(
        "\n  ",
      ),
    );
  }
  const issues = validateContainerTemplate(parsed.data);
  if (issues.length > 0) {
    return fail(
      ["连接期校验失败：", ...issues.map((i: { where: string; message: string }) => `${i.where}：${i.message}`)].join("\n  "),
    );
  }
  const nodes = Object.keys(parsed.data.nodes).length;
  const edges = Object.keys(parsed.data.edges).length;
  return ok(`合法：${nodes} 个节点，${edges} 条边，${Object.keys(parsed.data.children).length} 个子槽。`);
}

/** 一次性跑完一个场景，返回可读报告。 */
export function run(rawScenario: unknown): CommandResult {
  const parsed = Scenario.safeParse(rawScenario);
  if (!parsed.success) {
    return fail(
      ["场景文件非法：", ...parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`)].join(
        "\n  ",
      ),
    );
  }
  const scenario = parsed.data;
  const store = new ObjectStore();
  const refs = new Map<string, string>();

  try {
    for (const t of scenario.templates) {
      // 覆盖层的 extends 可以写成前面模板的 id，这里解析成精确 ref
      const spec =
        isOverlay(t.spec) && typeof (t.spec as { extends: string }).extends === "string"
          ? { ...(t.spec as object), extends: refs.get((t.spec as { extends: string }).extends) ??
              (t.spec as { extends: string }).extends }
          : t.spec;
      refs.set(t.id, registerContainerTemplate(store, t.id, spec, t.kind));
    }
  } catch (error) {
    return fail(`注册失败：${(error as Error).message}`);
  }

  const rootRef = refs.get(scenario.root.template);
  if (rootRef === undefined) {
    return fail(
      `根容器引用了未定义的模板 \`${scenario.root.template}\`。已定义：${[...refs.keys()].join(", ")}`,
    );
  }

  const registry = new InstanceRegistry(store);
  const runtime = new Runtime(store, registry);
  for (const [name, fn] of Object.entries(BUILTIN_HANDLERS)) runtime.registerHandler(name, fn);

  let results: readonly (StepResult | StepFailure)[];
  try {
    registry.createRoot(rootRef, scenario.root.id);
    for (const s of scenario.send) {
      runtime.send({ traceid: s.traceid, node: s.node, port: s.port }, s.payload);
    }
    results = runtime.drain();
    runtime.settleAll();
    runtime.checkInvariants();
  } catch (error) {
    return fail(`运行失败：${(error as Error).message}`);
  }

  return ok(report(runtime, registry, store, results, scenario.root.id));
}

function report(
  runtime: Runtime,
  registry: InstanceRegistry,
  store: ObjectStore,
  results: readonly (StepResult | StepFailure)[],
  root: string,
): string {
  const lines: string[] = [];
  const failures = results.filter((r): r is StepFailure => "reason" in r);

  lines.push(`提交 ${results.length} 次，失败 ${failures.length} 次。`);
  lines.push("");
  lines.push("实例树：");
  for (const inst of registry.subtree(root)) {
    const depth = inst.traceid.split("/").length - root.split("/").length;
    const blockers = runtime.terminationBlockers(inst.traceid);
    lines.push(
      `${"  ".repeat(depth + 1)}${inst.traceid}  ${inst.status}  seq=${inst.seq}` +
        (blockers.length > 0 ? `  阻塞：${blockers.join("；")}` : ""),
    );
  }

  const objects = store.collect(root, "").length;
  lines.push("");
  lines.push("提交快照（consumed → produced 即因果边）：");
  for (const inst of registry.subtree(root)) {
    for (const snap of runtime.snapshots(inst.traceid)) {
      const b = snap.body as Record<string, unknown>;
      lines.push(
        `  ${inst.traceid}#${String(b.seq)}  ${String(b.node)}  ` +
          `${JSON.stringify(b.consumed)} → ${JSON.stringify(b.produced)}`,
      );
    }
  }

  if (failures.length > 0) {
    lines.push("");
    lines.push("失败：");
    for (const f of failures) lines.push(`  ${f.traceid}/${f.nodeId}：${f.reason}`);
  }

  lines.push("");
  lines.push(`可用内置 handler：${BUILTIN_NAMES.join(", ")}`);
  void objects;
  return lines.join("\n");
}
