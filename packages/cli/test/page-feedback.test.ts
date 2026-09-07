import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";

// 执行页面本身的数据/异步逻辑；轻量 DOM 替身不冒充浏览器布局测试。
function page() {
  const element = () => ({
    textContent: "", children: [] as unknown[],
    listeners: {} as Record<string, () => Promise<void>>,
    append(...items: unknown[]) { this.children.push(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    addEventListener(name: string, fn: () => Promise<void>) { this.listeners[name] = fn; },
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

it("现场凭据失效后停止轮询，保留可操作的刷新提示", async () => {
  const { ctx, elements } = page();
  await runInContext(`
    api = async () => { throw new Expired('凭据失效，请刷新'); };
    liveFor = 'exec-1';
    renderLive();
  `, ctx);
  expect(runInContext("liveFor", ctx)).toBeNull();
  expect(JSON.stringify(elements.get("live-body"))).toContain("请刷新");
});

it("执行结束后可以从引用读对象正文，快速切换引用不接收迟到结果", async () => {
  const { ctx, elements } = page();
  await runInContext(`
    const detail = { execution:{status:'SETTLED',termination:'DONE'}, observation:{available:true,ref:'job/$exec@1'}, artifacts:[{ref:'job/result.md@1'}] };
    api = async () => detail;
    liveFor = 'exec-1';
    renderLive();
  `, ctx);
  const children = elements.get("live-body")!.children as { textContent: string; listeners: Record<string, () => Promise<void>> }[];
  expect(JSON.stringify(children)).toContain("DONE");
  runInContext(`let finishObject; api = () => new Promise(resolve => { finishObject = resolve; });`, ctx);
  const first = children.find((c) => c.textContent === "job/$exec@1")!.listeners.click!();
  runInContext(`api = async () => ({body:{text:'FINAL CONTENT'}});`, ctx);
  await children.find((c) => c.textContent === "job/result.md@1")!.listeners.click!();
  runInContext(`finishObject({body:{text:'STALE'}});`, ctx);
  await first;
  expect(children.at(-1)!.textContent).toContain("FINAL CONTENT");
  expect(children.at(-1)!.textContent).not.toContain("STALE");
});

it("终态到达时旧现场请求仍在途，返回后会主动补查结算详情", async () => {
  const { ctx, elements } = page();
  await runInContext(`
    let finishLive;
    api = () => new Promise(resolve => { finishLive = resolve; });
    liveFor = 'exec-1'; liveRunning = true;
    const oldLive = renderLive();
    liveRunning = false;
    api = async () => ({execution:{status:'SETTLED',termination:'DONE'},observation:{available:false},artifacts:[]});
    finishLive({live:{available:true,entries:[]}});
    oldLive;
  `, ctx);
  expect(JSON.stringify(elements.get("live-body"))).toContain("DONE");
});

it("同步节点可读失败消息；成功消息已回收时解释缺席并读精确提交", async () => {
  const { ctx, elements } = page();
  await runInContext(`
    api = async path => path.startsWith('/message') ? {lastFailure:'缺少 value'} : {};
    scene.cells = [{id:'job#work',kind:'node',parent:'job',phase:'failed',result:{message:{id:'msg-1',available:true}}}];
    show(scene.cells[0]);
  `, ctx);
  expect(JSON.stringify(elements.get("live-body"))).toContain("缺少 value");
  await runInContext(`
    api = async path => { if (path.startsWith('/message')) throw new Error('不该查询回收消息'); return {body:{consumed:['msg-2']}}; };
    scene.cells[0] = {id:'job#work',kind:'node',parent:'job',phase:'done',result:{message:{id:'msg-2',available:false},commit:'job/$run@1'}};
    renderDetail();
  `, ctx);
  expect(JSON.stringify(elements.get("live-body"))).toContain("已回收");
  expect(JSON.stringify(elements.get("live-body"))).toContain("msg-2");
  expect(JSON.stringify(elements.get("live-body"))).not.toContain("不该查询");
  const children = elements.get("live-body")!.children as { textContent: string; listeners: Record<string, () => Promise<void>> }[];
  await children.find((c) => c.textContent === "job/$run@1")!.listeners.click!();
  expect(children.at(-1)!.textContent).toContain('"consumed"');
});

it("同步失败消息仍在读取时同节点出现新提交，旧响应不能覆盖成功结果", async () => {
  const { ctx, elements } = page();
  await runInContext(`
    let finishMessage;
    api = path => path.startsWith('/message') ? new Promise(resolve => { finishMessage = resolve; }) : Promise.resolve({});
    scene.cells = [{id:'job#work',kind:'node',parent:'job',phase:'failed',result:{message:{id:'msg-1',available:true}}}];
    show(scene.cells[0]);
    scene.cells[0] = {id:'job#work',kind:'node',parent:'job',phase:'done',result:{message:{id:'msg-2',available:false},commit:'job/$run@1'}};
    renderDetail();
    finishMessage({lastFailure:'OLD FAILURE'});
  `, ctx);
  expect(JSON.stringify(elements.get("live-body"))).toContain("job/$run@1");
  expect(JSON.stringify(elements.get("live-body"))).not.toContain("OLD FAILURE");
});
