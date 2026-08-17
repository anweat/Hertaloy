/**
 * servo 求值 —— 纯提取，无控制流（不变量 S1 / S2）。
 *
 * servo 拿到本次消息的 payload，按声明的路径提出变量。它**不能**：
 *   改信封（信封根本没传进来）、构造端口（端口是模板声明的）、执行分支（路径语言里没有）。
 * 这三条不是运行时检查，是这个函数的签名和路径文法共同保证的。
 */

import {
  type Json,
  type PathSegment,
  type Port,
  type PortVar,
  parsePath,
} from "@nodeflow/contracts";

export type VarBag = Readonly<Record<string, Json>>;

function walk(value: Json | undefined, segments: readonly PathSegment[]): Json | undefined {
  if (value === undefined) return undefined;
  const head = segments[0];
  if (head === undefined) return value;
  const rest = segments.slice(1);

  switch (head.kind) {
    case "key": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
      return walk((value as Record<string, Json>)[head.name], rest);
    }
    case "index": {
      if (!Array.isArray(value)) return undefined;
      return walk(value[head.index], rest);
    }
    case "each": {
      if (!Array.isArray(value)) return undefined;
      const out: Json[] = [];
      for (const item of value) {
        const got = walk(item, rest);
        if (got !== undefined) out.push(got);
      }
      return out;
    }
  }
}

export function evaluatePath(root: Json, path: string): Json | undefined {
  return walk(root, parsePath(path));
}

export interface ExtractionFailure {
  readonly variable: string;
  readonly path: string;
  readonly message: string;
}

export type ExtractionResult =
  | { readonly ok: true; readonly vars: VarBag }
  | { readonly ok: false; readonly failures: readonly ExtractionFailure[] };

/**
 * 按端口 servo 提取全部声明的变量。
 *
 * **全有或全无**：任一变量取不到就整体失败，调用方据此做零部分提交。
 * 缺省不补值 —— 契约校验器"只接受或拒绝，不暗中补字段"的同款规则。
 */
export function extractPortVars(port: Port, payload: Json): ExtractionResult {
  if (port.direction !== "receive" || port.servo === undefined) {
    return { ok: true, vars: Object.freeze({}) };
  }

  const vars: Record<string, Json> = {};
  const failures: ExtractionFailure[] = [];

  for (const [name, decl] of Object.entries(port.servo.vars) as [string, PortVar][]) {
    const value = evaluatePath(payload, decl.from);
    if (value === undefined) {
      failures.push({
        variable: name,
        path: decl.from,
        message: `路径 ${decl.from} 在本次 payload 中取不到值`,
      });
      continue;
    }
    vars[name] = value;
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, vars: Object.freeze(vars) };
}

export function formatExtractionFailures(failures: readonly ExtractionFailure[]): string {
  return failures.map((f) => `变量 \`${f.variable}\`：${f.message}`).join("；");
}
