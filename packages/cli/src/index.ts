/**
 * CLI 作为库导出 —— 给 MCP 层复用 handler 库与干跑校验。
 *
 * `commands.ts` 与 `state-commands.ts` 各自导出了同名的 `CommandResult`，
 * 所以这里显式挑，不用 `export *`：让重名在**这里**被解决，
 * 而不是让下游包碰到一个含糊的名字。
 */

export { BUILTIN_HANDLERS, BUILTIN_NAMES } from "./builtins.js";
export { validate, run } from "./commands.js";
export type { CommandResult } from "./state-commands.js";
export {
  drain,
  history,
  init,
  permissions,
  reclaim,
  send,
  show,
  status,
  truncate,
  why,
} from "./state-commands.js";
export {
  AgentRequest,
  AgentResponse,
  buildPrompt,
  checkAssetName,
  extractJson,
  nodeIO,
  openAiClient,
  pickExecPort,
  runAgent,
  runExec,
  spawnRunner,
  validateResponse,
  type AgentIO,
  type CommandRunner,
  type ExecOutcome,
  type ModelClient,
} from "./agent.js";
export { Scenario, SendSpec } from "./scenario.js";
export { diagnose, formatChecks, type Check } from "./doctor.js";
