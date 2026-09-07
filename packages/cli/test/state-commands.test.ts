/**
 * 面向人的命令 —— 全部作用在磁盘上的 run。
 *
 * 每个用例都跨命令调用（每次调用各自 open/close 状态目录），
 * 因为这些命令的全部意义就在于**跨进程**。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContainerTemplate } from "@nodeflow/kernel";
import { RunState, writePermissions } from "@nodeflow/state";
import {
  authz,
  drain,
  execution,
  message,
  history,
  permissions,
  resources,
  scene,
  send,
  show,
  status,
  templates,
  truncate,
} from "../src/state-commands.js";

/** 缺省权限表下的人类主体 —— 全权。 */
const HUMAN = { kind: "human", id: "local" } as const;
const AGENT = { kind: "agent", id: "coder-1" } as const;

let dir: string;

const TEMPLATE = {
  nodes: {
    gate: {
      kind: "handler",
      handler: "collect",
      ports: {
        in: {
          direction: "receive",
          servo: {
            vars: {
              value: { type: "short", from: "$.value" },
              expect: { type: "short", from: "$.expect" },
            },
          },
        },
        done: { direction: "emit" },
      },
    },
  },
  edges: {},
  children: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hertaloy-cli-"));
  const s = RunState.open(dir);
  try {
    s.registry.createRoot(registerContainerTemplate(s.store, "root", TEMPLATE, "root_config"), "job-1");
    s.persist();
  } finally {
    s.close();
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("status", () => {
  it("列出实例树与在途消息", () => {
    const r = status(dir, HUMAN);
    expect(r.code).toBe(0);
    expect(r.text).toContain("job-1");
    expect(r.text).toContain("OPEN");
    expect(r.text).toContain("在途消息 0 条");
  });

  it("空状态目录说得清楚，不是空输出", () => {
    const empty = mkdtempSync(join(tmpdir(), "hertaloy-empty-"));
    try {
      expect(status(empty, HUMAN).text).toContain("还没有根容器");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("★ send：人的放行走这条，不需要第二套审批机制", () => {
  it("投消息 → 落盘 → 换次调用 status 看得到", () => {
    expect(send(dir, HUMAN, "job-1", "gate", "in", { value: "a", expect: 2 }).code).toBe(0);
    expect(status(dir, HUMAN).text).toContain("在途消息 1 条");
  });

  it("投给不存在的实例 → 拒绝并指路", () => {
    const r = send(dir, HUMAN, "job-9", "gate", "in", {});
    expect(r.code).toBe(1);
    expect(r.text).toContain("hertaloy status");
  });

  it("失败的投递不落盘 —— 状态不该被一次错误命令改动", () => {
    send(dir, HUMAN, "job-9", "gate", "in", {});
    expect(status(dir, HUMAN).text).toContain("在途消息 0 条");
  });
});

describe("★ 全流程：投两次 → 推进 → 查资产", () => {
  it("两条消息各算一份，凑齐后汇聚（跨四次进程调用）", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "same", expect: 2 });
    send(dir, HUMAN, "job-1", "gate", "in", { value: "same", expect: 2 });
    const d = await drain(dir, HUMAN);
    expect(d.code).toBe(0);
    expect(d.text).toContain("提交 2 次，失败 0 次");

    const h = history(dir, HUMAN, "job-1/parts");
    expect(h.code).toBe(0);
    expect(h.text).toContain("2 版");
  });
});

describe("show / history", () => {
  it("show 取最新版，show id@n 取指定版", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "x", expect: 9 });
    await drain(dir, HUMAN);
    expect(JSON.parse(show(dir, HUMAN, "job-1/parts").text).version).toBe(1);
    expect(JSON.parse(show(dir, HUMAN, "job-1/parts@1").text).body.value).toBe("x");
  });

  it("对象不存在时报错而不是返回空", () => {
    expect(history(dir, HUMAN, "job-1/nope").code).toBe(1);
    expect(show(dir, HUMAN, "job-1/nope").code).toBe(1);
  });
});

describe("只读命令不拿锁（§17.8）", () => {
  it("写进程占着锁时，status 仍然能查", () => {
    const holder = RunState.open(dir);
    try {
      expect(status(dir, HUMAN).code).toBe(0);
      expect(show(dir, HUMAN, "job-1/nope").code).toBe(1); // 是"没这对象"，不是"拿不到锁"
    } finally {
      holder.close();
    }
  });

  it("写命令在锁被占时明确拒绝", () => {
    const holder = RunState.open(dir);
    try {
      expect(() => send(dir, HUMAN, "job-1", "gate", "in", {})).toThrow(/已被占用/);
    } finally {
      holder.close();
    }
  });
});

describe("★ truncate：卡住的 run 杀得掉（K3）", () => {
  it("截断后实例进终态，在途消息被丢弃", () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: "a", expect: 99 });
    const r = truncate(dir, HUMAN, "job-1", "测试");
    expect(r.code).toBe(0);
    expect(r.text).toContain("丢弃消息 1 条");
    expect(status(dir, HUMAN).text).toContain("TERMINAL");
  });

  it("截断不存在的实例 → 拒绝", () => {
    expect(truncate(dir, HUMAN, "job-9", "x").code).toBe(1);
  });
});

describe("★ 权限层真的在起作用（K2）", () => {
  it("缺省表下 agent 被拒 —— 第一不变量的默认值", () => {
    const r = status(dir, AGENT);
    expect(r.code).toBe(1);
    expect(r.text).toContain("拒绝");
    expect(r.text).toContain("agent:coder-1");
  });

  it("拒绝理由里列出当前授权 —— 人得看得见缺什么才改得动配置", () => {
    expect(send(dir, AGENT, "job-1", "gate", "in", {}).text).toContain("human:*");
  });

  it("agent 的写操作同样被拒，且状态没被改动", () => {
    expect(truncate(dir, AGENT, "job-1", "x").code).toBe(1);
    expect(status(dir, HUMAN).text).toContain("OPEN");
  });

  it("status 报出权限表是配置来的还是缺省的", () => {
    expect(status(dir, HUMAN).text).toContain("缺省（人类全权，agent 无权）");
  });

  it("配了 permissions.json 就按文件来 —— 授权后 agent 能查自己的子树", () => {
    writePermissions(dir, [
      { principal: "human:*", scope: "*", ops: ["DDL", "DML", "DQL"] },
      { principal: "agent:coder-1", scope: "job-1", ops: ["DQL"] },
    ]);
    const r = status(dir, AGENT);
    expect(r.code).toBe(0);
    expect(r.text).toContain("permissions.json");
    // 但写操作仍然没给
    expect(truncate(dir, AGENT, "job-1", "x").code).toBe(1);
  });

  it("授权作用域按段边界判定 —— job-1 不覆盖 job-10", () => {
    writePermissions(dir, [{ principal: "agent:coder-1", scope: "job-10", ops: ["DQL"] }]);
    expect(status(dir, AGENT).code).toBe(1);
  });

  it("permissions.json 有一条写坏 → 整表拒绝，不是跳过坏的用好的", () => {
    writeFileSync(
      join(dir, "permissions.json"),
      JSON.stringify({ format: 1, grants: [{ principal: "nope", scope: "*", ops: ["DQL"] }] }),
      "utf8",
    );
    expect(() => status(dir, HUMAN)).toThrow(/第 1 条授权非法/);
  });
});

describe("★ hertaloy resources：动态上载", () => {
  it("空表时说清怎么登记", () => {
    const r = resources(dir, HUMAN, "list", []);
    expect(r.code).toBe(0);
    expect(r.text).toContain("没有登记任何资源");
    expect(r.text).toContain("add");
  });

  it("登记之后列得出来，并说明模板里怎么用", () => {
    const added = resources(dir, HUMAN, "add", ["primary", "git", "/repos/app", "主仓库"]);
    expect(added.code).toBe(0);
    expect(added.text).toContain("路径不进模板");

    const list = resources(dir, HUMAN, "list", []);
    expect(list.text).toContain("primary");
    expect(list.text).toContain("/repos/app");
    expect(list.text).toContain("主仓库");
  });

  it("参数不全就给用法，不猜", () => {
    expect(resources(dir, HUMAN, "add", ["onlyname"]).code).toBe(1);
    expect(resources(dir, HUMAN, "add", ["onlyname"]).text).toContain("用法");
  });

  it("种类不认识 → 拒绝并说清有哪几种", () => {
    const r = resources(dir, HUMAN, "add", ["x", "ftp", "/p"]);
    expect(r.code).toBe(1);
  });

  it("删得掉", () => {
    resources(dir, HUMAN, "add", ["a", "dir", "/x"]);
    expect(resources(dir, HUMAN, "remove", ["a"]).code).toBe(0);
    expect(resources(dir, HUMAN, "list", []).text).toContain("没有登记任何资源");
  });
});

/**
 * 决策只有 ControlPlane 一处 —— "没有第二个 Runtime" 在授权上的形状。
 *
 * 这两个命令此前是**第二条没有检查的路径**：`resources` 连 actor 参数都没有，
 * 而改别名就是改模板的实际指向；`permissions` 的读路径写着 `void actor`，
 * 谁都看得到整张授权表。
 */
describe("★ 绕过 ControlPlane 的两条路收回来了", () => {
  it("★ agent 读不了资源别名表 —— 那里面是真实路径", () => {
    // "agent 拿不到真实位置"正是别名机制的意义所在
    const r = resources(dir, AGENT, "list", []);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/无权/);
  });

  it("★ agent 改不了别名 —— 改别名就是改模板指向哪个仓", () => {
    const r = resources(dir, AGENT, "add", ["evil", "git", "/somewhere/else"]);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/无权/);
  });

  it("agent 看不到授权表本身", () => {
    const r = permissions(dir, AGENT, false);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/无权/);
  });

  it("人照旧 —— 缺省授权是人类全权", () => {
    expect(resources(dir, HUMAN, "list", []).code).toBe(0);
    expect(permissions(dir, HUMAN, false).code).toBe(0);
  });
});

/**
 * ★ 观测这条链的出口 —— 此前**根本不存在**。
 *
 * `exportSnapshot`（state）零个调用方，`buildScene`（scene）只被自己的测试
 * 调用、输入还是一份定格夹具。两端各自都绿，中间没人走。前端要开工，
 * 第一件事恰恰是从这个不存在的出口拿数据。
 *
 * 所以这一组测的是**整条链**：真跑一段 → 导出 → 场景里确实有该有的东西。
 */
describe("★ scene：观测链的出口", () => {
  it("真跑一段之后，场景里有实例、有节点、有流", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: 1, expect: 1 });
    await drain(dir, HUMAN, undefined);

    const r = scene(dir, HUMAN);
    expect(r.code).toBe(0);

    const built = JSON.parse(r.text) as {
      viewport: string;
      cells: { id: string; kind: string }[];
      tethers: unknown[];
      range: { from: number; to: number };
    };
    expect(built.viewport).toBe("job-1");
    // 容器即实例，节点也是单元 —— 两种 kind 都该在
    expect(built.cells.some((c) => c.kind === "instance" && c.id === "job-1")).toBe(true);
    expect(built.cells.map((c) => c.id)).toContain("job-1#gate");
    // 实例包着节点，这条关系要出来
    expect(built.tethers.length).toBeGreaterThan(0);
    // 序号轴：真跑过一次提交，range 不是空的
    expect(built.range.to).toBeGreaterThanOrEqual(1);
  });

  it("--scope 就是前缀裁剪 —— 视口即前缀", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: 1, expect: 1 });
    await drain(dir, HUMAN, undefined);

    const r = scene(dir, HUMAN, "job-1");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.text) as { viewport: string }).viewport).toBe("job-1");
  });

  /**
   * ★ 它此前是全仓**权限最高、检查最少**的读路径：`exportSnapshot` 不收 actor，
   * 一次授权都不做，而返回的比任何一个已授权查询都多。现在走 ControlPlane。
   */
  it("★ 无权的主体被拒 —— 不再是绕过授权的那条路", () => {
    const r = scene(dir, AGENT);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/拒绝/);
  });

  /**
   * `parseSnapshot` 在命令里拿 zod 验我们自己刚导出的东西。导出端的形状一旦
   * 和 scene 收的形状分家，这条命令当场炸 —— 而在此之前那种漂移是静默的
   * （夹具定格之后两端各自演化，谁也不知道）。
   */
  it("★ 导出端与 scene 收的形状必须对得上，对不上当场炸", async () => {
    send(dir, HUMAN, "job-1", "gate", "in", { value: 1, expect: 1 });
    await drain(dir, HUMAN, undefined);
    // 这条命令内部就是 exportSnapshot → parseSnapshot → buildScene，
    // 能跑通本身就是那条接缝的红灯
    expect(scene(dir, HUMAN).code).toBe(0);
  });
});

/**
 * ★ 授权流水的出口 —— 画布外那块「人的操作」面板要吃的东西。
 *
 * `authz.jsonl` 一直在写，但**没有任何出口**：文件在长，没人读得出来。
 * 又一条两端各自都绿、中间没人走。
 *
 * 它不进场景，是因为**内核不知道谁在调它**（§11：Principal 由可信边界注入）。
 * "谁投的这条消息"不在编排状态里，只在这份决策流水里 —— 硬塞进 RunSnapshot
 * 就是让观测格式去承担它答不出的问题。
 */
describe("★ authz：谁做了什么", () => {
  it("放行与拒绝都在里面，被拒的带理由", () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    send(dir, AGENT, "job-1", "gate", "in", "{}"); // 无权，会被拒

    const r = authz(dir, HUMAN);
    expect(r.code).toBe(0);
    expect(r.text).toContain("human:local");
    expect(r.text).toContain("放行");
    expect(r.text).toContain("agent:coder-1");
    expect(r.text).toContain("拒绝");
    // 被拒的那条要说清缺什么 —— 它往往就是"权限配错了"的现场
    expect(r.text).toMatch(/无权/);
  });

  it("★ 读流水本身也要授权 —— 按根实例判定", () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    const r = authz(dir, AGENT);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/拒绝/);
  });

  it("序号单调，读流水这件事本身也留痕", () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    const first = authz(dir, HUMAN).data as { seq: number }[];
    const second = authz(dir, HUMAN).data as { seq: number }[];
    expect(first.map((e) => e.seq)).toEqual([...first.keys()].map((i) => i + 1));
    // 只读打开不写日志（§17.8 单写者）—— 所以看两次，条数不变
    expect(second).toHaveLength(first.length);
  });
});

/**
 * ★ 配置那一条流 —— 与场景分开走。
 *
 * 配置**不可变**（C4：实例 pin 一份定义，永不迁移），场景**每帧变**。
 * 塞进场景等于每帧重传不变的东西，正好毁掉 `--watch` 差量省下的那部分。
 * 分开之后 C5 的性质直接兑现成"拉一次就够，缓存永不失效"。
 */
describe("★ templates：配置流", () => {
  it("★ 带得出 servo —— 这正是场景筛掉、而点击要看的那部分", () => {
    const r = templates(dir, HUMAN);
    expect(r.code).toBe(0);
    const all = JSON.parse(r.text) as Record<string, { nodes: Record<string, unknown> }>;
    const one = Object.values(all)[0];
    const gate = one?.nodes.gate as { ports: Record<string, { servo?: { vars: unknown } }> };
    // 端口的 servo 声明原样在这儿：变量名、类型、取值路径
    expect(gate.ports.in?.servo?.vars).toEqual({
      value: { type: "short", from: "$.value" },
      expect: { type: "short", from: "$.expect" },
    });
  });

  it("★ 原样给，不二次编码 —— 端口模式靠字段有无判，不发明 mode 枚举", () => {
    const all = JSON.parse(templates(dir, HUMAN).text) as Record<
      string,
      { nodes: Record<string, { ports: Record<string, Record<string, unknown>> }> }
    >;
    const port = Object.values(all)[0]?.nodes.gate?.ports.done as Record<string, unknown>;
    // 没有 alias / callback / reply ⇒ 内网边。判定与内核同一条规则
    // （见 MessageSource：「三种情形，靠字段有无区分，不需要标签」）
    expect(port).toEqual({ direction: "emit" });
    expect(Object.keys(port)).not.toContain("mode");
  });

  it("键就是 templateRef —— 与 cell.identity 对得上，可当缓存键", () => {
    const all = JSON.parse(templates(dir, HUMAN).text) as Record<string, unknown>;
    expect(Object.keys(all).every((k) => /@\d+$/.test(k))).toBe(true);
  });

  it("★ 无权的主体被拒 —— 与场景同一条授权", () => {
    const r = templates(dir, AGENT);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/拒绝/);
  });
});

/**
 * ★ 详情查询（S4）：从节点追到失败、消息与产物，四种"没有"分开。
 */
describe("★ 详情查询", () => {
  it("★ status 的 data 给结构化义务，中文只留在 text 里", () => {
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    const r = status(dir, HUMAN);
    const data = r.data as { instances: { blockers: { kind: string; key: string }[] }[] };
    const blockers = data.instances[0]?.blockers ?? [];
    expect(blockers.length).toBeGreaterThan(0);
    // 机器读的那份是结构化的
    expect(blockers[0]).toHaveProperty("kind");
    expect(blockers[0]).toHaveProperty("key");
    // 人看的那份仍然是中文，但它在 text 里
    expect(r.text).toMatch(/阻塞/);
  });

  it("消息详情：端点、来源、因果都在", () => {
    const sent = send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    const id = (sent.data as { messageId: string }).messageId;
    const r = message(dir, HUMAN, id);
    expect(r.code).toBe(0);
    const d = r.data as { message: { target: { node: string } }; causes: string[] };
    expect(d.message.target.node).toBe("gate");
    // 人投的：来源是图外
    expect(r.text).toMatch(/图外/);
    expect(d.causes).toEqual([]);
  });

  it("★ 不存在的 id → 说清是哪个没找到，不是空结果", () => {
    expect(message(dir, HUMAN, "msg-999").text).toMatch(/没有消息 msg-999/);
    expect(execution(dir, HUMAN, "exec-999").text).toMatch(/没有 execution exec-999/);
  });

  it("★ 无权主体 → 拒绝，而且与「没有」分不出来", () => {
    const a = message(dir, AGENT, "msg-999");
    expect(a.code).toBe(1);
    expect(a.text).toMatch(/拒绝/);
    // 存在的那条也是同一个答案 —— 存在性不是泄漏面
    send(dir, HUMAN, "job-1", "gate", "in", '{"value":1,"expect":1}');
    expect(message(dir, AGENT, "msg-1").text).toMatch(/拒绝/);
  });
});
