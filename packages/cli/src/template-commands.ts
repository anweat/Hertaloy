/** 模板反馈独立于运行场景：只读查询不改变实例固定的版本。 */
import type { Principal } from "@nodeflow/contracts";
import { AuthorizationError, TemplateValidationError } from "@nodeflow/kernel";
import { checkAgentSpec } from "@nodeflow/sandbox";
import { RunState } from "@nodeflow/state";
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
