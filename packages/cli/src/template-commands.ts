/** 模板反馈独立于运行场景：只读查询不改变实例固定的版本。 */
import type { Principal } from "@nodeflow/contracts";
import { AuthorizationError, TemplateValidationError, OPERATION_CLASS, type Operation } from "@nodeflow/kernel";
import { checkAgentSpec } from "@nodeflow/sandbox";
import { RunState, lockHolders } from "@nodeflow/state";
import type { CommandResult } from "./state-commands.js";

export function definitions(dir: string, actor: Principal, scope?: string): CommandResult {
  const state = RunState.open(dir, { readOnly: true });
  try {
    const data = state.control.definitions(actor, scope);
    return { code: 0, text: JSON.stringify(data, null, 2), data };
  } catch (error) {
    if (error instanceof AuthorizationError) return { code: 1, text: `拒绝：${error.message}` };
    throw error;
  } finally {
    state.close();
  }
}

/** 带对象库上下文的完整校验；define 复用同一准备阶段。 */
export function validateDefinition(
  dir: string, actor: Principal, id: string, spec: unknown, kind?: string,
): CommandResult {
  const state = RunState.open(dir, { readOnly: true, validateExecutionSpec: checkAgentSpec });
  try {
    const prepared = state.control.validateDefinition(actor, id, spec, kind);
    return { code: 0, text: "完整校验通过（未注册）", data: {
      valid: true, level: "registration", registered: false, issues: [],
      definition: prepared,
    } };
  } catch (error) { return feedbackError(error); }
  finally { state.close(); }
}

/** 正式注册返回实际精确 ref；既有运行继续持有自己的 pin。 */
export function define(
  dir: string, actor: Principal, id: string, spec: unknown, kind?: string,
): CommandResult {
  const state = RunState.open(dir, { validateExecutionSpec: checkAgentSpec });
  try {
    const ref = state.control.define(actor, id, spec, kind);
    state.persist();
    return { code: 0, text: `已注册 ${ref}`, data: { ref, registered: true } };
  } catch (error) { return feedbackError(error); }
  finally { state.close(); }
}

function feedbackError(error: unknown): CommandResult {
  if (error instanceof AuthorizationError) return {
    code: 1, text: `拒绝：${error.message}`, data: { error: { code: "forbidden", message: error.message } },
  };
  if (error instanceof TemplateValidationError) return {
    code: 1, text: error.message,
    data: { valid: false, level: "registration", registered: false,
      issues: error.issues.map((i) => ({ ...i, severity: "error" })) },
  };
  throw error;
}

/** 当前条件与通道能力预览。参数仍须提交时校验，不预留权限或执行权。 */
export function operations(
  dir: string, actor: Principal, scope?: string, channel: "cli" | "http" | "mcp" = "cli",
): CommandResult {
  const state = RunState.open(dir, { readOnly: true });
  try {
    const trace = scope ?? state.registry.rootTrace;
    if (trace === null) {
      state.control.check(actor, "DQL", "*");
      return { code: 0, text: "没有根实例", data: { scope: null, channel, actions: [] } };
    }
    state.control.subtree(actor, trace);
    const inst = state.registry.get(trace);
    const tpl = state.registry.template(trace);
    const receives = Object.entries(tpl.nodes).flatMap(([node, spec]) =>
      Object.entries(spec.ports).filter(([, p]) => p.direction === "receive").map(([port]) => ({ node, port })));
    const slots = Object.keys(tpl.children);
    const actions = (["define", "send", "spawn", "run", "truncate"] as const).map((operation: Operation) => {
      const target = operation === "define" ? inst.templateRef.slice(0, inst.templateRef.lastIndexOf("@"))
        : operation === "run" ? state.registry.rootTrace! : trace;
      const reasons: { code: string; message: string }[] = [];
      let permission = { allowed: true, reason: "当前授权允许" };
      try { state.control.check(actor, OPERATION_CLASS[operation], target); }
      catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        permission = { allowed: false, reason: error.message };
        reasons.push({ code: "forbidden", message: error.message });
      }
      if (channel === "http") reasons.push({ code: "read_only_transport", message: "HTTP 只提供读取和干跑校验，写操作使用 CLI/MCP" });
      if (channel === "cli" && operation === "spawn") reasons.push({ code: "unsupported_channel", message: "CLI 尚无 spawn 命令，使用 MCP spawn_child" });
      if ((operation === "send" || operation === "spawn") && inst.status !== "OPEN") {
        reasons.push({ code: "terminal_instance", message: `实例已 ${inst.status}` });
      }
      if (operation === "send" && receives.length === 0) reasons.push({ code: "no_receive_port", message: "模板没有 receive 端口" });
      if (operation === "spawn" && slots.length === 0) reasons.push({ code: "no_child_slot", message: "模板没有子槽" });
      if (operation === "run" && trace !== state.registry.rootTrace) reasons.push({ code: "root_only", message: "推进仅支持根实例，不支持子树推进" });
      if (operation === "run" && channel === "cli" && lockHolders(dir).some((l) => l.name === "driver.lock")) {
        reasons.push({ code: "driver_locked", message: "已有驱动持有 driver.lock；本结果不判断该进程是否仍存活" });
      }
      return {
        operation, target, permission, available: reasons.length === 0, reasons,
        requires: operation === "define" ? ["spec"] : operation === "send" ? ["node", "port"]
          : operation === "spawn" ? ["slot", "segment"] : [],
        ...(operation === "send" ? { endpoints: receives } : {}),
        ...(operation === "spawn" ? { slots } : {}),
        ...(operation === "run" ? { note: channel === "mcp"
          ? "MCP advance 仅推进同步 handler；agent 执行使用 CLI drain --runner"
          : "agent 执行需要 --runner；提交时重新检查驱动权" } : {}),
        ...(operation === "truncate" ? { note: "截断提供逻辑栅栏；不承诺跨进程物理取消" } : {}),
      };
    });
    const data = { scope: trace, channel, status: inst.status, actions };
    return { code: 0, text: JSON.stringify(data, null, 2), data };
  } catch (error) { return feedbackError(error); }
  finally { state.close(); }
}
