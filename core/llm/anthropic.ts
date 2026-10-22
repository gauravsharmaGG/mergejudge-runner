import { LlmError, postJson, withCallBudget, type LlmTransport } from "./http.js";
import { isTruncated, reportUsage, tokenCount, type UsageSink, type LlmUsage, type ChatMessage, type ChatRequest, type ChatTurn, type LlmProvider, type LlmRequest, type LlmResult } from "./provider.js";

type Block = Record<string, unknown>;

/** Messages API content blocks; consecutive tool results share one user message. */
export function toAnthropicMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: string | Block[] }[] {
  const out: { role: "user" | "assistant"; content: string | Block[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks.length ? blocks : "(no text)" });
    } else {
      const block = { type: "tool_result", tool_use_id: m.callId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** Messages API usage: `input_tokens` already excludes cache reads and writes. */
export function anthropicUsage(u: AnthropicUsage | undefined): LlmUsage | null {
  if (!u || typeof u !== "object") return null;
  return { input: tokenCount(u.input_tokens), output: tokenCount(u.output_tokens), cacheRead: tokenCount(u.cache_read_input_tokens), cacheWrite: tokenCount(u.cache_creation_input_tokens) };
}

export class AnthropicProvider implements LlmProvider {
  readonly label: string;
  readonly providerId: string;
  readonly supportsTools = true;
  constructor(private baseUrl: string, private model: string, private apiKey: string, private onUsage?: UsageSink, private transport: Partial<LlmTransport> = {}) {
    this.label = model;
    this.providerId = transport.providerId ?? "anthropic";
  }
  private url() { return `${this.baseUrl.replace(/\/+$/, "")}/v1/messages`; }
  private headers() { return { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }; }
  private http(budgetMs?: number): Partial<LlmTransport> { return withCallBudget({ ...this.transport, providerId: this.providerId }, budgetMs); }
  private empty(): never { throw new LlmError("parse", { provider: this.providerId }); }
  async complete(req: LlmRequest): Promise<string> {
    const r = await this.completeEx(req);
    if (!r.text) this.empty();
    return r.text;
  }
  async completeEx(req: LlmRequest): Promise<LlmResult> {
    const data = (await postJson(
      this.url(),
      this.headers(),
      {
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      },
      this.http(),
    )) as { content?: { type: string; text?: string }[]; usage?: AnthropicUsage; stop_reason?: unknown };
    reportUsage(this.onUsage, anthropicUsage(data.usage));
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const outputTokens = tokenCount(data.usage?.output_tokens);
    return { text, truncated: isTruncated(data.stop_reason === "max_tokens", outputTokens, req.maxOutputTokens), outputTokens };
  }
  async chat(req: ChatRequest): Promise<ChatTurn> {
    const data = (await postJson(
      this.url(),
      this.headers(),
      {
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
          : {}),
      },
      this.http(req.budgetMs),
    )) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      usage?: AnthropicUsage;
      stop_reason?: unknown;
    };
    reportUsage(this.onUsage, anthropicUsage(data.usage));
    const blocks = data.content ?? [];
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
    const toolCalls = blocks.flatMap((b, i) => b.type === "tool_use" && b.name
      ? [{ id: b.id || `toolu_${i}`, name: b.name, args: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {} }] : []);
    const truncated = isTruncated(data.stop_reason === "max_tokens", tokenCount(data.usage?.output_tokens), req.maxOutputTokens);
    if (!text && !toolCalls.length && !truncated) this.empty();
    return {
      text, toolCalls, ...(truncated ? { truncated } : {}),
      ...(data.usage ? { usage: { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 } } : {}),
    };
  }
}
