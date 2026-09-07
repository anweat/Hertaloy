/**
 * 内核错误分类。
 *
 * `InvariantError` = 编程错误（调用方违反了契约），立即抛出，不进失败通道。
 * 错误信息面向 LLM 与画布：说清违反了什么、可用的是什么（FOUNDATION §7"错误可读"）。
 */

export class InvariantError extends Error {
  override readonly name: string = "InvariantError";
}

export class AuthorizationError extends InvariantError {
  override readonly name: string = "AuthorizationError";
}

/** 模板校验失败保留字段位置，调用方无需反解析中文错误。 */
export class TemplateValidationError extends InvariantError {
  override readonly name: string = "TemplateValidationError";
  constructor(message: string, readonly issues: readonly {
    where: string; code: string; message: string;
  }[]) {
    super(message);
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
