/**
 * Nodeflow V5 —— 控制面工具层（对 Python nodeflow_control.py 的 TS 移植）
 *
 * 把装配/编排/控制 API 封装成声明式工具 schema + 单一 dispatch 入口，
 * 供助手 AI / MCP server / REST /control/dispatch 调用：
 *
 * - actor 由可信边界注入（dispatch(..., actor)），payload 里的 proposer/actor 一律不可信
 * - 所有写操作都落到既有提交/版本事实里，本层不发明新的旁路
 * - 返回值只含 JSON 可序列化数据
 */
import { CONTROL_TOOLS } from "@nodeflow/contracts";
import { InvariantError, Principal, principalParse, principalStr } from "./core.js";
import type { RuntimeLike } from "./runtime-like.js";
import * as definitions from "./definitions.js";
import { searchCards } from "./projections.js";

export class ControlPlane {
  constructor(public rt: RuntimeLike) {}

  toolSchemas(): Record<string, { description: string; inputSchema: Record<string, unknown> }> {
    return CONTROL_TOOLS;
  }

  async dispatch(tool: string, arguments_: Record<string, unknown>, opts: { actor: Principal | string }): Promise<unknown> {
    if (!(tool in CONTROL_TOOLS)) throw new InvariantError(`unknown control tool: ${tool}`);
    const args = { ...(arguments_ ?? {}) };
    const principal = principalParse(opts.actor);
    const actorStr = principalStr(principal);
    const rt = this.rt;

    switch (tool) {
      case "register_card":
        return definitions.registerCard(rt, {
          kind: String(args.kind),
          cardId: String(args.card_id),
          version: Number(args.version),
          body: (args.body ?? {}) as Record<string, unknown>,
          tags: (args.tags ?? []) as string[],
        });
      case "search_cards":
        return searchCards(rt, {
          kind: args.kind != null ? String(args.kind) : undefined,
          tags: (args.tags ?? []) as string[],
          query: args.query != null ? String(args.query) : undefined,
        });
      case "compile_agent_spec":
        return definitions.compileAgentSpec(rt, {
          specId: String(args.spec_id),
          model: String(args.model),
          cards: ((args.cards ?? []) as unknown[]).map(normalizeCardEntry),
          tools: (args.tools ?? []) as unknown[],
        });
      case "register_contract":
        return definitions.registerContract(rt, String(args.contract_id), Number(args.version), (args.schema ?? {}) as Record<string, unknown>);
      case "register_topic":
        return definitions.registerTopic(rt, String(args.topic_id), {
          requestContract: (args.request_contract ?? null) as Record<string, unknown> | null,
          replyContract: (args.reply_contract ?? null) as Record<string, unknown> | null,
        });
      case "register_policy":
        return definitions.registerPolicy(rt, String(args.policy_id), (args.spec ?? {}) as Record<string, unknown>);
      case "register_transform":
        return definitions.registerTransform(rt, String(args.transform_id), {
          role: String(args.role),
          body: (args.body ?? {}) as Record<string, unknown>,
        });
      case "register_graph_template":
        return definitions.registerGraphTemplate(rt, String(args.template_id), (args.spec ?? {}) as Record<string, unknown>);
      case "publish_graph_template":
        return definitions.publishGraphTemplate(rt, String(args.template_id), (args.spec ?? {}) as Record<string, unknown>, (args.derived_from ?? []) as string[]);
      case "propose_graph_template":
        // proposer 只信注入的 actor，payload 无法自封身份（#10）
        return definitions.proposeGraphTemplate(rt, {
          proposalId: String(args.proposal_id),
          templateId: String(args.template_id),
          spec: (args.spec ?? {}) as Record<string, unknown>,
          proposer: principal,
          requiredApprovers: (args.required_approvers ?? []) as string[],
          derivedFrom: (args.derived_from ?? []) as string[],
        });
      case "approve_graph_template":
        return definitions.approveGraphTemplate(rt, String(args.proposal_id), {
          actor: principal,
          modifications: (args.modifications ?? null) as Record<string, unknown> | null,
        });
      case "create_draft":
        return rt.createDraft(String(args.draft_id), (args.spec ?? {}) as Record<string, unknown>, (args.layout ?? {}) as Record<string, unknown>);
      case "save_draft":
        return rt.saveDraft(String(args.draft_id), (args.spec ?? null) as Record<string, unknown> | null, (args.layout ?? null) as Record<string, unknown> | null);
      case "publish_draft":
        return rt.publishDraft(String(args.draft_id), String(args.template_id));
      case "import_draft":
        return rt.createDraft(String(args.draft_id), (args.spec ?? {}) as Record<string, unknown>, {});
      case "instantiate":
        return rt.instantiateLocked(String(args.template_ref), String(args.owner), (args.params ?? {}) as Record<string, unknown>, (args.controllers ?? []) as string[]);
      case "send":
        return rt.send((args.target as string[]).slice(0, 3) as [string, string, string], args.payload);
      case "publish": {
        const callback = args.callback ? (args.callback as string[]).slice(0, 3) as [string, string, string] : null;
        return rt.publishLocked(String(args.topic_id), args.payload, { callback });
      }
      case "subscribe":
        return rt.subscribe(String(args.topic_id), (args.target as string[]).slice(0, 3) as [string, string, string]);
      case "unsubscribe":
        return rt.unsubscribe(String(args.subscription_id));
      case "drain":
        await rt.drain(...((args.gids ?? []) as string[]));
        return { drained: true };
      case "control":
        await rt.control(String(args.gid), String(args.action), { actor: principal });
        return { status: rt.graphStatus(String(args.gid)) };
      case "approve_node":
        await rt.approve(String(args.gid), String(args.node_id), { actor: principal, decision: String(args.decision), payload: args.payload });
        return { approved: true };
      case "query_graph": {
        const gid = String(args.gid);
        const inst = rt.st.instances.get(gid)!;
        const nodes: Record<string, unknown> = {};
        for (const [nid, st] of inst.nodes) nodes[nid] = { ...st.persistent };
        return { status: inst.status, seq: inst.seq, nodes };
      }
      case "query_template_versions":
        return rt.graphTemplateVersions(String(args.template_id)).map((ov) => ({
          ref: String((ov.body.template_ref as string) ?? `@${ov.version}`),
          version: ov.version,
          content_hash: ov.content_hash,
          derived_from: ov.provenance.derived_from,
        }));
      case "read_object": {
        const ov = rt.store.resolve(String(args.ref));
        return { object_id: ov.object_id, version: ov.version, kind: ov.kind, body: structuredClone(ov.body) };
      }
      default:
        throw new InvariantError(`control tool not implemented: ${tool}`);
    }
  }
}

function normalizeCardEntry(entry: unknown): [string, string] | [string, string, number] {
  const e = entry as unknown[];
  if (e.length === 2) return [String(e[0]), String(e[1])];
  return [String(e[0]), String(e[1]), Number(e[2])];
}
