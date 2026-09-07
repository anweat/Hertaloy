import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";

// 执行页面本身的数据/异步逻辑；轻量 DOM 替身不冒充浏览器布局测试。
function page() {
  const element = () => ({
    textContent: "", children: [] as unknown[],
    append(...items: unknown[]) { this.children.push(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    addEventListener() {},
  });
  const elements = new Map<string, ReturnType<typeof element>>();
  const ctx = createContext({
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    },
    setInterval() {}, addEventListener() {},
  });
  const html = readFileSync(new URL("../src/page.html", import.meta.url), "utf8");
  const script = html.split('<script type="module">')[1]!.split("</script>")[0]!;
  runInContext(script.replace('main().catch((e) => status("出错：" + e.message));', ""), ctx);
  return { ctx, elements };
}

it("切换节点后，迟到响应不能把上一节点的日志画到当前节点", async () => {
  const { ctx, elements } = page();
  const pending = runInContext(`
    let finish;
    api = () => new Promise(resolve => { finish = resolve; });
    liveFor = 'exec-1';
    const pending = renderLive();
    liveFor = 'exec-2';
    finish({live:{available:true,entries:[{seq:1,op:'write',path:'OLD'}]}});
    pending;
  `, ctx);
  await pending;
  expect(JSON.stringify(elements.get("live-body"))).not.toContain("OLD");
});

it("选中节点离开视口时立即清掉它的现场", () => {
  const { ctx, elements } = page();
  runInContext(`
    document.getElementById('live-body').replaceChildren('OLD');
    selected = 'gone';
    renderDetail();
  `, ctx);
  expect(JSON.stringify(elements.get("live-body"))).not.toContain("OLD");
});

it("未实例化子槽的详情消费声明闭包，拉取失败后仍能补齐", async () => {
  const { ctx } = page();
  await expect(runInContext(`
    scene.cells = [{id:'job/slot',kind:'slot',identity:'leaf@1'}];
    api = async () => { throw new Error('offline'); };
    topUpTemplates();
  `, ctx)).rejects.toThrow("offline");
  const result = await runInContext(`
    api = async () => ({'leaf@1': {body:{nodes:{work:{}}},usedBy:[],dependencies:[]}});
    topUpTemplates().then(() => detailOf(scene.cells[0]));
  `, ctx);
  expect(result.定义).toEqual({ nodes: { work: {} } });
  expect(result.使用实例).toEqual([]);
});
