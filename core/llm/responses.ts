import { LlmError, postJson, type LlmTransport } from "./http.js";
import { isTruncated, openAiUsage, tokenCount, parseToolArgs, reportUsage, type UsageSink, type ChatMessage, type ChatRequest, type ChatTurn, type LlmProvider, type LlmRequest, type LlmResult } from "./provider.js";

/** Responses API input items for a tool conversation (stateless: the full history is re-sent). */
export function toResponsesInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.callId, output: m.content });
    else {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    }
  }
  return out;
}

type RespOut = { type?: string; call_id?: string; id?: string; name?: string; arguments?: unknown; content?: { type?: string; text?: string }[] };

type RespUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
type RespStatus = { status?: unknown; incomplete_details?: { reason?: unknown } | null };
const respCut = (d: RespStatus) => d.status === "incomplete" && (d.incomplete_details?.reason ?? "max_output_tokens") === "max_output_tokens";
const respUsage = (u: RespUsage | undefined) => (u && typeof u === "object" ? openAiUsage(u.input_tokens, u.output_tokens, u.input_tokens_details?.cached_tokens) : null);

/** OpenAI Responses API (`/v1/responses`). API keys only. */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly label: string;
  readonly providerId: string;
  readonly supportsTools = true;
  constructor(private baseUrl: string, private model: string, private apiKey: string, private onUsage?: UsageSink, private transport: Partial<LlmTransport> = {}) {
    this.label = model;
    this.providerId = transport.providerId ?? "openai";
  }
  private url() { return `${this.baseUrl.replace(/\/+$/, "")}/responses`; }
  private http(): Partial<LlmTransport> { return { ...this.transport, providerId: this.providerId }; }
  private empty(): never { throw new LlmError("parse", { provider: this.providerId }); }
  async complete(req: LlmRequest): Promise<string> {
    const r = await this.completeEx(req);
    if (!r.text) this.empty();
    return r.text;
  }
  async completeEx(req: LlmRequest): Promise<LlmResult> {
    const data = (await postJson(
      this.url(),
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        instructions: req.system,
        input: req.user,
        max_output_tokens: req.maxOutputTokens,
        ...(req.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
      },
      this.http(),
    )) as { output_text?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[]; usage?: RespUsage } & RespStatus;
    reportUsage(this.onUsage, respUsage(data.usage));
    const text = typeof data.output_text === "string" && data.output_text
      ? data.output_text
      : (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    const outputTokens = tokenCount(data.usage?.output_tokens);
    return { text, truncated: isTruncated(respCut(data), outputTokens, req.maxOutputTokens), outputTokens };
  }
  async chat(req: ChatRequest): Promise<ChatTurn> {
    const tools = req.tools?.length ? req.tools : undefined;
    const data = (await postJson(
      this.url(),
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        instructions: req.system,
        input: toResponsesInput(req.messages),
        max_output_tokens: req.maxOutputTokens,
        store: false,
        ...(tools ? { tools: tools.map((t) => ({ type: "function", ...t })) } : {}),
        ...(req.jsonMode && !tools ? { text: { format: { type: "json_object" } } } : {}),
      },
      this.http(),
    )) as { output_text?: string; output?: RespOut[]; usage?: RespUsage } & RespStatus;
    reportUsage(this.onUsage, respUsage(data.usage));
    const items = data.output ?? [];
    const text = typeof data.output_text === "string" && data.output_text
      ? data.output_text
      : items.flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    const toolCalls = items.flatMap((o, i) => o.type === "function_call" && o.name
      ? [{ id: o.call_id || o.id || `call_${i}`, name: o.name, args: parseToolArgs(o.arguments) }] : []);
    const truncated = isTruncated(respCut(data), tokenCount(data.usage?.output_tokens), req.maxOutputTokens);
    if (!text && !toolCalls.length && !truncated) this.empty();
    return {
      text, toolCalls, ...(truncated ? { truncated } : {}),
      ...(data.usage ? { usage: { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 } } : {}),
    };
  }
}
