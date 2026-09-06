import { drain } from "../../src/state-commands.js";

const result = await drain(process.argv[2]!, { kind: "human", id: "local" }, {
  async run(request) {
    /**
     * 收到 `interrupt` 就自己发一次 SIGINT。
     *
     * 为什么不由父进程真发信号：Windows 上 `subprocess.kill()` 会忽略信号名
     * 直接终止进程，处理器根本不会跑 —— 那样这条用例在本机就成了假通过。
     * 自发信号验的是**处理器有没有被装上、装上之后放不放锁**，
     * 也就是"两端各自都绿、中间没人走"那一段；OS 递送不归它管。
     */
    const released = new Promise<void>((resolve) =>
      process.once("message", (m) => {
        if (m === "interrupt") {
          process.emit("SIGINT");
          return;
        }
        resolve();
      }),
    );
    process.send?.({ started: request.executionId });
    await released;
    return { executionId: request.executionId, termination: "DONE", emissions: {} };
  },
  async cancel() {},
});
process.send?.({ result });
process.disconnect?.();
