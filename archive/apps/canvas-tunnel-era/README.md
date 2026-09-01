# apps/canvas —— 容器工作面

一张画布：**模板在底（定义），活实例叠在上面**。只依赖 `@nodeflow/scene`
的输出形状，不 import 任何后端包（RENDERING.md §8）。

```bash
npx serve -l 5178 apps/canvas
```

## 交互模型：DDL / DML / DQL

不是为 AI 另做一套界面。内核的授权表本来就是 `(principal, scope, opclass)`，
而 opclass 天然对应"改定义 / 改运行状态 / 只读"：

| | DDL | DML | DQL |
|---|---|---|---|
| 对象 | 模板 | 实例 | 全部 |
| MCP 工具 | `define_template` `validate_template` | `create_run` `send_message` `spawn_child` `advance` `truncate_instance` | `get_status` `read_object` `list_versions` `explain_message` |
| 缺省 | 人有、agent 无 | 人有、agent 按授权 | 按 scope |

**人和 AI 调的是同一组操作**，差别只在那张表里。所以画布上每个操作旁边
直接标着 opclass 与"谁能动它" —— 这是通用节点编辑器给不出的东西。

## 两条通道

**模板 → 实例。** 虚线框是声明，实心片是活实例。同一个子槽能扇出 N 个实例
（实测 a1/a2/a3），所以它们**叠在模板上那一个位置**，不是各自散开。
实例带着它 pin 死的模板版本 —— 改模板不影响正在跑的（C4 终身 pin），
所以实例的「改结构」按钮是**禁用**的，理由写在旁边。

**子槽 ⇄ 容器。** 折叠时是个有 entry 端口的方块，点开是完整容器。
无损 —— `ChildSlot.entry` 本来就定义了"子树如何以单个端口示人"。

## 一处约束直接变成了 UI

「实例化」按钮**只在已声明的子槽上出现**。这不是前端加的判断，是第一不变量
「只能选不能构造」的形状：handler 递不进来一个模板引用，所以能实例化的位置
只有声明过的那些。未实例化的槽也要画 —— **声明本身是信息**，
与"从没命中过的订阅仍然要画"同一条道理。

## 还没做

- 模板真编辑（拖节点、连边、保存升版）—— 现在 DDL 的按钮只占位
- `proposal`：AI 改模板 → 落成提案 → 人批准 → 生成新版本。
  那个 kind 已声明但**仍无生产者与消费者**
- 折叠的子槽上，穿过它边界的隧道还没画出来（源在里面，被折叠掉了）
- 自由摆位；这版是规整两列布局
