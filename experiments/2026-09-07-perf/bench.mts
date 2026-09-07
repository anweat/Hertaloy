/**
 * 两个维度分开量：消息数 M（drain）与实例数 N（settleAll）。
 * 混在一起量会互相掩盖 —— 上一版就是 drain 的 O(M²) 把 settleAll 拖到测不完。
 */
import { InstanceRegistry, registerContainerTemplate, Runtime } from "../../packages/kernel/src/index.js";
import { ObjectStore } from "../../packages/kernel/src/store.js";

function build(kids: number, msgs: number, keep = -1) {
  const store = new ObjectStore();
  const leaf = registerContainerTemplate(store, "leaf", {
    nodes: { w: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
  });
  const root = registerContainerTemplate(store, "root", {
    nodes: { n: { kind: "handler", handler: "noop", ports: { in: { direction: "receive" } } } },
    children: { k: { template: leaf } },
  }, "root_config");
  const reg = new InstanceRegistry(store);
  reg.createRoot(root, "job");
  const rt = new Runtime(store, reg, { keepConsumedMessages: keep });
  rt.registerHandler("noop", () => ({}));
  for (let i = 0; i < kids; i += 1) rt.spawn("job", "k", `c${String(i)}`);
  for (let i = 0; i < msgs; i += 1) rt.send({ traceid: "job", node: "n", port: "in" }, {});
  return rt;
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const time = (n: number, fn: () => void): number => {
  const xs: number[] = [];
  for (let i = 0; i < n; i += 1) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
  return med(xs);
};

const mode = process.argv[2] ?? "drain-nokeep";
if (mode === "drain-nokeep" || mode === "drain-keep") {
  const keep = mode === "drain-keep" ? 200 : -1;
  console.log(`— drain（keepConsumedMessages=${String(keep)}）—`);
  for (const m of [200, 400, 800, 1600]) {
    const t = time(3, () => { build(10, m, keep).drain(); });
    console.log(`  M=${String(m).padStart(4)}  drain ${t.toFixed(1)}ms  （每条 ${(t / m).toFixed(3)}ms）`);
  }
} else {
  console.log("— settleAll / checkInvariants：实例数 N（消息固定 100）—");
  for (const n of [100, 200, 400, 800]) {
    let inv = 0, one = 0, st = 0;
    time(3, () => {
      const rt = build(n, 100); rt.drain();
      inv = time(3, () => { rt.checkInvariants(); });
      one = time(20, () => { rt.canTerminate("job"); });
      const t0 = performance.now(); rt.settleAll(); st = performance.now() - t0;
    });
    console.log(
      `  N=${String(n + 1).padStart(4)}  settleAll ${st.toFixed(0)}ms  ` +
      `canTerminate ${one.toFixed(3)}ms  checkInvariants ${inv.toFixed(1)}ms`,
    );
  }
}
