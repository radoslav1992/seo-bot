/**
 * Workers AI — единственият доставчик на модели в приложението.
 *
 * Няма ключ и няма външна услуга: моделите се извикват през `env.AI`
 * binding-а и се плащат на акаунта в Cloudflare. Кой модел точно — стои в
 * `wrangler.jsonc` → `vars`, а не тук, за да е смяната променлива, а не
 * разписване на код.
 */

export const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DEFAULT_FAST_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Само за `role: 'tool'` — кой инструмент е върнал това. */
  name?: string;
}

/** Описание на инструмент във формата, който Workers AI очаква. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

export class AiUnavailableError extends Error {
  constructor() {
    super('Моделите не са налични в момента.');
    this.name = 'AiUnavailableError';
  }
}

function chatModel(env: Env): string {
  return env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

export function fastModel(env: Env): string {
  return env.FAST_MODEL || DEFAULT_FAST_MODEL;
}

/**
 * Извиквания на инструменти идват в няколко форми според модела: понякога
 * `tool_calls: [{ name, arguments }]`, понякога във формата на OpenAI с
 * `function: { name, arguments: "<json низ>" }`. Нормализираме ги тук, за да
 * не се разлива вариацията в логиката на агента.
 */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const fn = (record.function ?? record) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : null;
    if (!name) continue;

    let args: Record<string, unknown> = {};
    const rawArgs = fn.arguments ?? fn.parameters;
    if (typeof rawArgs === 'string') {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        /* моделът е върнал нещо, което не е JSON — инструментът ще получи празни аргументи */
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs as Record<string, unknown>;
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

export interface RunOptions {
  model?: string;
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

/** Едно извикване на модела. Без стрийм — за стъпките с инструменти. */
export async function runChat(env: Env, messages: ChatMessage[], options: RunOptions = {}): Promise<ChatResult> {
  if (!env.AI) throw new AiUnavailableError();

  const input: Record<string, unknown> = {
    messages,
    max_tokens: options.maxTokens ?? 2048,
    temperature: options.temperature ?? 0.3,
  };
  if (options.tools?.length) input.tools = options.tools;

  const raw = (await env.AI.run(options.model ?? chatModel(env), input)) as Record<string, unknown>;
  const text = typeof raw?.response === 'string' ? raw.response : '';
  return { text, toolCalls: normalizeToolCalls(raw?.tool_calls) };
}

/**
 * Стриймът на Workers AI е SSE с `data: {"response":"…"}` и `data: [DONE]`.
 * Тук се превежда на чист поток от текстови парчета, за да не знае нищо
 * останалото за формата на транспорта.
 */
export async function streamChat(
  env: Env,
  messages: ChatMessage[],
  options: RunOptions = {},
): Promise<ReadableStream<string>> {
  if (!env.AI) throw new AiUnavailableError();

  const raw = (await env.AI.run(options.model ?? chatModel(env), {
    messages,
    max_tokens: options.maxTokens ?? 2048,
    temperature: options.temperature ?? 0.3,
    stream: true,
  })) as ReadableStream<Uint8Array>;

  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream<string>({
    async start(controller) {
      const reader = raw.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE рамката свършва на празен ред; всичко след последния е
          // непълно и остава в буфера за следващото четене.
          const frames = buffer.split('\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as { response?: string };
              if (typeof parsed.response === 'string' && parsed.response) controller.enqueue(parsed.response);
            } catch {
              /* парче, което не е JSON — пропускаме го, вместо да съборим потока */
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/**
 * Кара модела да върне JSON и го чете.
 *
 * Моделите обичат да обгръщат JSON в ```-блокове и в обяснения. Вместо да
 * се вярва на инструкцията „само JSON“, тук се изрязва първият пълен обект
 * или масив — това е разликата между „обикновено работи“ и „работи“.
 */
export function parseJsonFromModel<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;

  const opener = cleaned[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
