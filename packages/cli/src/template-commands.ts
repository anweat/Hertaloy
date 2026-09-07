/** 模板反馈独立于运行场景：只读查询不改变实例固定的版本。 */
import type { Principal } from "@nodeflow/contracts";
import { AuthorizationError } from "@nodeflow/kernel";
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
