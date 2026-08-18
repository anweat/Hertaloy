#!/usr/bin/env node
/**
 * hertaloy —— 命令行入口。
 *
 * 两类命令：
 *
 *   无状态（进程内跑完就完）
 *     validate <template.json>   干跑校验，不落库  ← G1 自我修正的出口
 *     run <scenario.json>        一次性跑完并报告
 *
 *   有状态（作用在磁盘上的 run，见 §17）
 *     status / show / history / send / drain
 *
 *   人的放行没有专用命令：`status` 看谁在等，`send` 投消息放行（第四次归约）。
 */

import { readFileSync } from "node:fs";
import { run, validate } from "./commands.js";
import { diagnose, formatChecks } from "./doctor.js";
import { type CommandResult, drain, history, send, show, status } from "./state-commands.js";

const USAGE = `hertaloy —— Nodeflow V5 命令行

用法：
  hertaloy doctor                     环境自检（node / git / wsl / docker / profiles）
  hertaloy validate <template.json>   校验容器模板，不落库
  hertaloy run <scenario.json>        跑一个一次性场景并打印报告

作用在磁盘上的 run（<dir> 是状态目录）：
  hertaloy status  <dir>                        实例树 / 阻塞原因 / 在途消息 / 死锁
  hertaloy show    <dir> <object-id[@n]>        读一个对象版本
  hertaloy history <dir> <object-id>            某对象的版本历史
  hertaloy send    <dir> <traceid> <node> <port> [json]   投一条消息（人的放行走这条）
  hertaloy drain   <dir>                        推进到静止（只认内置 handler）

场景文件形如：
  { "templates": [{"id": "root", "kind": "root_config", "spec": {…}}],
    "root": {"template": "root", "id": "job-1"},
    "send": [{"traceid": "job-1", "node": "n", "port": "in", "payload": {}}] }
`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** 有状态命令。参数不够就返回用法错误，而不是往下掉进"读文件"那条路。 */
function statefulCommand(command: string, args: readonly string[]): CommandResult | null {
  const [dir, a, b, c, d] = args;
  const need = (n: number): CommandResult | null =>
    args.length < n ? { text: `\`${command}\` 参数不够。

${USAGE}`, code: 2 } : null;

  switch (command) {
    case "status":
      return need(1) ?? status(dir as string);
    case "show":
      return need(2) ?? show(dir as string, a as string);
    case "history":
      return need(2) ?? history(dir as string, a as string);
    case "drain":
      return need(1) ?? drain(dir as string);
    case "send": {
      const short = need(4);
      if (short !== null) return short;
      let payload: unknown = {};
      if (d !== undefined) {
        try {
          payload = JSON.parse(d);
        } catch (error) {
          return { text: `载荷不是合法 JSON：${(error as Error).message}`, code: 2 };
        }
      }
      return send(dir as string, a as string, b as string, c as string, payload as never);
    }
    default:
      return null;
  }
}

function main(argv: readonly string[]): number {
  const [command, file] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "doctor") {
    const checks = diagnose();
    const blocked = checks.some((c) => !c.ok && c.blocking);
    (blocked ? process.stderr : process.stdout).write(`${formatChecks(checks)}
`);
    return blocked ? 1 : 0;
  }
  const rest = argv.slice(1);
  const stateful = statefulCommand(command, rest);
  if (stateful !== null) {
    (stateful.code === 0 ? process.stdout : process.stderr).write(`${stateful.text}
`);
    return stateful.code;
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
