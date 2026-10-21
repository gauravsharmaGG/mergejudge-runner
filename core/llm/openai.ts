import { LlmError, postJson, type LlmTransport } from "./http.js";
import { isTruncated, openAiUsage, tokenCount, parseToolArgs, reportUsage, type UsageSink, type ChatMessage, type ChatRequest, type ChatTurn, type LlmProvider, type LlmRequest, type LlmResult } from "./provider.js";

type OaMessage = Record<string, unknown>;

/** Chat Completions messages (also z.ai GLM and other OpenAI-compatible endpoints). */
export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
    else {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    }
  }
  return out;
}

type OaUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
const oaUsage = (u: OaUsage | undefined) => (u && typeof u === "object" ? openAiUsage(u.prompt_tokens, u.completion_tokens, u.prompt_tokens_details?.cached_tokens) : null);

export class OpenAiProvider implements LlmProvider {
  readonly label: string;
  readonly providerId: string;
  readonly supportsTools = true;
  constructor(private baseUrl: string, private model: string, private apiKey: string, private onUsage?: UsageSink, private transport: Partial<LlmTransport> = {}) {
    this.label = model;
    this.providerId = transport.providerId ?? "openai";
  }
  private url() { return `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`; }
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
        max_tokens: req.maxOutputTokens,
        temperature: 0,
        ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
      this.http(),
    )) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: OaUsage };
    reportUsage(this.onUsage, oaUsage(data.usage));
    const content = data.choices?.[0]?.message?.content;
    const outputTokens = tokenCount(data.usage?.completion_tokens);
    const truncated = isTruncated(data.choices?.[0]?.finish_reason === "length", outputTokens, req.maxOutputTokens);
    // A reasoning model that spends the whole limit thinking returns empty content with finish_reason "length".
    if (typeof content !== "string" && !truncated) this.empty();
    return { text: typeof content === "string" ? content : "", truncated, outputTokens };
  }
  async chat(req: ChatRequest): Promise<ChatTurn> {
    const tools = req.tools?.length ? req.tools : undefined;
    const data = (await postJson(
      this.url(),
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: req.maxOutputTokens,
        temperature: 0,
        messages: toOpenAiMessages(req.system, req.messages),
        ...(tools ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
        // JSON mode and tools do not mix on every endpoint; it is only requested on the tool-less final turn.
        ...(req.jsonMode && !tools ? { response_format: { type: "json_object" } } : {}),
      },
      this.http(),
    )) as {
      choices?: { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
      usage?: OaUsage;
    };
    reportUsage(this.onUsage, oaUsage(data.usage));
    const msg = data.choices?.[0]?.message;
    if (!msg) this.empty();
    const toolCalls = (msg.tool_calls ?? []).flatMap((c, i) =>
      c.function?.name ? [{ id: c.id || `call_${i}`, name: c.function.name, args: parseToolArgs(c.function.arguments) }] : []);
    const text = typeof msg.content === "string" ? msg.content : "";
    const truncated = isTruncated(data.choices?.[0]?.finish_reason === "length", tokenCount(data.usage?.completion_tokens), req.maxOutputTokens);
    if (!text && !toolCalls.length && !truncated) this.empty();
    return {
      text, toolCalls, ...(truncated ? { truncated } : {}),
      ...(data.usage ? { usage: { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 } } : {}),
    };
  }
}
