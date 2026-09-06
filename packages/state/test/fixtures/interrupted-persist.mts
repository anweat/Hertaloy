// 子进程专用故障点，生产代码不加入测试开关。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { RunState } from "../../src/run-state.js";

const state = RunState.open(process.argv[2]!);
const stage = process.argv[3]!;
state.store.put("job/memo", "note", { text: "interrupted" });
state.store.put("abandoned", "note", { text: "orphan" });
function stop(): never {
  process.send?.({ stage });
  // 阻塞在同步持久化内部，等待父进程强制结束；没有 close/finally 的机会。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unexpected wakeup");
}
const write = fs.writeFileSync;
const rename = fs.renameSync;
fs.writeFileSync = (...args) => {
  if (stage === "object" && String(args[0]).endsWith("@2.json.tmp")) {
    write(args[0], '{"body":');
    stop();
  }
  return write(...args);
};
fs.renameSync = (...args) => {
  if (stage === "head" && String(args[1]).endsWith("head.json")) stop();
  return rename(...args);
};
syncBuiltinESMExports();
state.persist();
throw new Error("fault boundary was not reached");
