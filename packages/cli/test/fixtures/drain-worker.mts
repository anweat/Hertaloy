import { drain } from "../../src/state-commands.js";

const result = await drain(process.argv[2]!, { kind: "human", id: "local" }, {
  async run(request) {
    const released = new Promise<void>((resolve) => process.once("message", () => resolve()));
    process.send?.({ started: request.executionId });
    await released;
    return { executionId: request.executionId, termination: "DONE", emissions: {} };
  },
  async cancel() {},
});
process.send?.({ result });
process.disconnect?.();
