/**
 * ControlPlane 工具 schema —— MCP tools/list 与 REST /control/dispatch 同源。
 * 形状 = MCP Tool.inputSchema（JSON Schema）。
 * actor 由可信边界注入，工具参数里的 actor/proposer 一律无效。
 */
import type { ControlTool } from "./zod.js";

export const CONTROL_TOOLS: Record<string, ControlTool> = {
  register_card: {
    description: "注册一张装配面卡片（skill/mcp/rules/prompt），返回精确引用 kind/card@version。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["skill", "mcp", "rules", "prompt"] },
        card_id: { type: "string" },
        version: { type: "integer" },
        body: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "card_id", "version", "body"],
    },
  },
  search_cards: {
    description: "卡片库检索：kind 过滤 + tags 全命中 + query 模糊匹配，返回精确版本引用列表。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["skill", "mcp", "rules", "prompt"] },
        tags: { type: "array", items: { type: "string" } },
        query: { type: "string" },
      },
    },
  },
  compile_agent_spec: {
    description: "把卡片组合编译成 AgentSpec（编译期定型工具全集与五段 prompt，产出 prefix_hash）。",
    inputSchema: {
      type: "object",
      properties: {
        spec_id: { type: "string" },
        model: { type: "string" },
        cards: { type: "array", items: { type: "array" } },
        tools: { type: "array", items: { type: "object" } },
      },
      required: ["spec_id", "model"],
    },
  },
  register_contract: {
    description: "注册不可变 MessageContract（id@version）。",
    inputSchema: {
      type: "object",
      properties: {
        contract_id: { type: "string" },
        version: { type: "integer" },
        schema: { type: "object" },
      },
      required: ["contract_id", "version", "schema"],
    },
  },
  register_topic: {
    description: "注册 TopicDefinition（request/reply contract 可选）。",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string" },
        request_contract: { type: "object" },
        reply_contract: { type: "object" },
      },
      required: ["topic_id"],
    },
  },
  register_policy: {
    description: "注册 StrategyPolicy。",
    inputSchema: {
      type: "object",
      properties: { policy_id: { type: "string" }, spec: { type: "object" } },
      required: ["policy_id", "spec"],
    },
  },
  register_transform: {
    description: "注册 JsonTransformDefinition（role=EDGE_SERVO，body 只允许 set/map/drop）。",
    inputSchema: {
      type: "object",
      properties: {
        transform_id: { type: "string" },
        role: { type: "string", enum: ["EDGE_SERVO"] },
        body: { type: "object" },
      },
      required: ["transform_id", "role", "body"],
    },
  },
  register_graph_template: {
    description: "发布 GraphTemplate @1（重复 id 拒绝；演进走 publish_graph_template）。",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string" },
        spec: { type: "object" },
      },
      required: ["template_id", "spec"],
    },
  },
  publish_graph_template: {
    description: "版本化发布 GraphTemplate（@2、@3…，旧 ref 保持可用；内容寻址幂等）。",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string" },
        spec: { type: "object" },
        derived_from: { type: "array", items: { type: "string" } },
      },
      required: ["template_id", "spec"],
    },
  },
  propose_graph_template: {
    description: "提出图模板定义提案（只落 ObjectVersion，不注册；proposer 取可信 actor）。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        template_id: { type: "string" },
        spec: { type: "object" },
        required_approvers: { type: "array", items: { type: "string" } },
        derived_from: { type: "array", items: { type: "string" } },
      },
      required: ["proposal_id", "template_id", "spec"],
    },
  },
  approve_graph_template: {
    description: "审批图模板提案（校验 + 版本化发布 + 落 approved 事实，全留痕）。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        modifications: { type: "object" },
      },
      required: ["proposal_id"],
    },
  },
  create_draft: {
    description: "创建画布草稿（spec + layout 分离存储）。",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        spec: { type: "object" },
        layout: { type: "object" },
      },
      required: ["draft_id", "spec"],
    },
  },
  save_draft: {
    description: "保存画布草稿（spec 或 layout）。",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        spec: { type: "object" },
        layout: { type: "object" },
      },
      required: ["draft_id"],
    },
  },
  publish_draft: {
    description: "发布草稿为模板版本（校验 + register/publish_graph_template），返回 template_ref。",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        template_id: { type: "string" },
      },
      required: ["draft_id", "template_id"],
    },
  },
  import_draft: {
    description: "画布导入：把助手 AI 生成的 GraphTemplate JSON 变成草稿，画布可见。",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        spec: { type: "object" },
      },
      required: ["draft_id", "spec"],
    },
  },
  instantiate: {
    description: "由精确模板 ref 创建 GraphInstance，返回 gid。",
    inputSchema: {
      type: "object",
      properties: {
        template_ref: { type: "string" },
        owner: { type: "string" },
        params: { type: "object" },
        controllers: { type: "array", items: { type: "string" } },
      },
      required: ["template_ref", "owner"],
    },
  },
  send: {
    description: "向实例端点发送一条数据消息（目标必须已声明端点）。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
        payload: {},
      },
      required: ["target", "payload"],
    },
  },
  publish: {
    description: "向主题发布消息（发给所有 OPEN 订阅者；payload 不得携带 edgeId）。",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string" },
        payload: {},
        callback: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      },
      required: ["topic_id", "payload"],
    },
  },
  subscribe: {
    description: "订阅主题（target = [gid, node_id, endpoint]）。",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string" },
        target: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      },
      required: ["topic_id", "target"],
    },
  },
  unsubscribe: {
    description: "取消订阅（持久化删除，重启不得复活）。",
    inputSchema: {
      type: "object",
      properties: { subscription_id: { type: "string" } },
      required: ["subscription_id"],
    },
  },
  drain: {
    description: "排空指定实例（不传 gids 排空全部）。",
    inputSchema: {
      type: "object",
      properties: { gids: { type: "array", items: { type: "string" } } },
    },
  },
  control: {
    description: "控制面动作（pause/resume/close），需实例 controllers 授权。",
    inputSchema: {
      type: "object",
      properties: {
        gid: { type: "string" },
        action: { type: "string", enum: ["pause", "resume", "close"] },
      },
      required: ["gid", "action"],
    },
  },
  approve_node: {
    description: "审批节点动作（allow/deny），需节点 authorized_actors 授权。",
    inputSchema: {
      type: "object",
      properties: {
        gid: { type: "string" },
        node_id: { type: "string" },
        decision: { type: "string", enum: ["allow", "deny"] },
        payload: {},
      },
      required: ["gid", "node_id", "decision"],
    },
  },
  query_graph: {
    description: "查询实例状态、seq 与节点持久状态。",
    inputSchema: {
      type: "object",
      properties: { gid: { type: "string" } },
      required: ["gid"],
    },
  },
  query_template_versions: {
    description: "查询 GraphTemplate 定义版本历史。",
    inputSchema: {
      type: "object",
      properties: { template_id: { type: "string" } },
      required: ["template_id"],
    },
  },
  read_object: {
    description: "按精确版本引用读取 ObjectVersion（object_id@version；拒绝 latest）。",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
};

export const CONTROL_TOOL_NAMES = Object.keys(CONTROL_TOOLS);
