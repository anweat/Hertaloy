#!/usr/bin/env node
/**
 * hertaloy —— 命令行入口。
 *
 * 现有两条命令，都**不需要跨进程状态**（还没有持久化，见 `scenario.ts` 的说明）：
 *
 *   hertaloy validate <template.json>   干跑校验，不落库  ← G1 自我修正的出口
 *   hertaloy run <scenario.json>        一次性跑完并报告
 */

import { readFileSync } from "node:fs";
import { run, validate } from "./commands.js";

const USAGE = `hertaloy —— Nodeflow V5 命令行

用法：
  hertaloy validate <template.json>   校验容器模板，不落库
  hertaloy run <scenario.json>        跑一个一次性场景并打印报告

场景文件形如：
  { "templates": [{"id": "root", "kind": "root_config", "spec": {…}}],
    "root": {"template": "root", "id": "job-1"},
    "send": [{"traceid": "job-1", "node": "n", "port": "in", "payload": {}}] }
`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function main(argv: readonly string[]): number {
  const [command, file] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (file === undefined) {
    process.stderr.write(`缺少文件参数。\n\n${USAGE}`);
    return 2;
  }

  let payload: unknown;
  try {
    payload = readJson(file);
  } catch (error) {
    process.stderr.write(`读不了 ${file}：${(error as Error).message}\n`);
    return 2;
  }

  const result =
    command === "validate" ? validate(payload) : command === "run" ? run(payload) : null;

  if (result === null) {
    process.stderr.write(`未知命令 \`${command}\`。\n\n${USAGE}`);
    return 2;
  }
  (result.code === 0 ? process.stdout : process.stderr).write(`${result.text}\n`);
  return result.code;
}

process.exitCode = main(process.argv.slice(2));
