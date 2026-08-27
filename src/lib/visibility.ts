/**
 * Проверка на видимост в AI отговори.
 *
 * Въпросът, на който отговаря целият продукт: като питаш машина за твоя
 * бранш, той ли излиза. Мерим го буквално — задаваме въпроса, четем отговора
 * и търсим в него домейна и името на бранда.
 *
 * КЛЮЧОВОТО РАЗЛИЧАВАНЕ тук е между двигател С ЖИВО ТЪРСЕНЕ и модел без него.
 *
 * Клиентът пита „появявам ли се, когато някой пита AI за моя бранш“. Отговорът
 * на този въпрос се дава само от двигател, който наистина търси в интернет в
 * момента на въпроса. Модел без търсене отговаря от паметта си — тоест от
 * данните, с които е обучен преди месеци. Това е ДРУГО измерване: не „в
 * отговора ли си днес“, а „знае ли изобщо за теб“. Полезно е, но е друго
 * число и стои на друго място в таблото.
 *
 * Живото търсене минава през Cloudflare AI Gateway, който проксира
 * собствените инструменти за търсене на доставчиците и — с Unified Billing —
 * не иска техните ключове: плаща се от сметката в Cloudflare.
 */

import { fastModel, parseJsonFromModel, runChat, type ChatMessage } from './ai';

/** Идентификаторът е низ, а не изброен тип: списъкът идва от конфигурацията. */
export type EngineId = string;

/**
 * Как се вика двигателят и как се включва търсенето при него.
 *
 * Всеки доставчик има свой начин — това не е наш избор, а тяхното API. Затова
 * доставчикът е изброен тип: добавянето на нов е нов случай в `askEngine`, а
 * не нов низ в конфигурацията, който мълчаливо не прави нищо.
 */
export type EngineProvider =
  /** AI Gateway → OpenAI Responses API, `web_search_preview`. */
  | 'gateway-openai'
  /** AI Gateway → Anthropic Messages API, `web_search_20250305`. */
  | 'gateway-anthropic'
  /** AI Gateway → xAI Responses API, `web_search`. */
  | 'gateway-xai'
  /** AI Gateway → Alibaba chat/completions, `enable_search: true`. */
  | 'gateway-alibaba'
  /** Google AI Studio направо, `google_search` grounding. Иска свой ключ. */
  | 'gemini'
  /** Perplexity направо — търсенето му е вградено. Иска свой ключ. */
  | 'perplexity'
  /** Workers AI binding. БЕЗ търсене — отговаря от паметта на модела. */
  | 'workers-ai';

/** Кои доставчици наистина търсят в интернет в момента на въпроса. */
export const GROUNDED_PROVIDERS: EngineProvider[] = [
  'gateway-openai',
  'gateway-anthropic',
  'gateway-xai',
  'gateway-alibaba',
  'gemini',
  'perplexity',
];

export interface EngineInfo {
  id: EngineId;
  label: string;
  provider: EngineProvider;
  /** Идентификаторът на модела. За gateway доставчиците е `доставчик/модел`. */
  model?: string;
  /** Само за доставчиците със свой ключ (`gemini`, `perplexity`). */
  secret?: string;
  note?: string;
}

export function isGrounded(engine: EngineInfo): boolean {
  return GROUNDED_PROVIDERS.includes(engine.provider);
}

/**
 * Двигателите по подразбиране.
 *
 * Проприетарните модели, а не отворените: клиентът иска да знае какво отговаря
 * ChatGPT, не какво би отговорил Llama. През AI Gateway с Unified Billing те
 * се викат без нито един чужд ключ — плащат се от сметката в Cloudflare.
 *
 * Каталогът се мени бързо (само за 2026: GPT-5.6, Gemini 3.7, Grok 4.x…),
 * затова този списък е НАЧАЛНА СТОЙНОСТ, а не истина в кода:
 * `VISIBILITY_ENGINES` в `wrangler.jsonc` го замества изцяло, а
 * „Провери моделите“ в таблото казва кои от настроените наистина отговарят.
 * Виж docs/models.md.
 */
export const DEFAULT_ENGINES: EngineInfo[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    provider: 'gateway-openai',
    model: 'openai/gpt-5.6-luna',
    note: 'С живо търсене. През AI Gateway, без ключ за OpenAI.',
  },
  {
    id: 'claude',
    label: 'Claude',
    provider: 'gateway-anthropic',
    model: 'anthropic/claude-haiku-4.5',
    note: 'С живо търсене. През AI Gateway, без ключ за Anthropic.',
  },
  {
    id: 'grok',
    label: 'Grok',
    provider: 'gateway-xai',
    model: 'xai/grok-4.20-multi-agent-0309',
    note: 'С живо търсене. Единственият модел на xAI с търсене през Gateway.',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    provider: 'gateway-alibaba',
    model: 'alibaba/qwen3-max',
    note: 'С живо търсене през `enable_search`.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    provider: 'gemini',
    model: 'gemini-3.7-flash',
    secret: 'GEMINI_API_KEY',
    note: 'С живо търсене. AI Gateway още не проксира търсенето на Google, затова иска свой ключ.',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    provider: 'perplexity',
    model: 'sonar',
    secret: 'PERPLEXITY_API_KEY',
    note: 'По избор. Търсенето му е вградено; връща и цитираните източници.',
  },
  {
    id: 'llama-memory',
    label: 'Llama (без търсене)',
    provider: 'workers-ai',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    note: 'Не мери видимост, а познатост: какво моделът знае за бранда наизуст.',
  },
];

/** Секретите за външните двигатели не са в `Env`, защото са по избор. */
type EngineSecrets = Record<string, string | undefined>;

/**
 * Списъкът от двигатели за тази инсталация.
 *
 * Разчита се отбранително: счупен JSON в конфигурацията не бива да оставя
 * продукта без нито един двигател, затова при грешка се връщат стандартните.
 */
export function engines(env: Env): EngineInfo[] {
  const raw = (env as unknown as EngineSecrets).VISIBILITY_ENGINES;
  if (!raw) return DEFAULT_ENGINES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ENGINES;
    const cleaned = parsed.filter(
      (item): item is EngineInfo =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as EngineInfo).id === 'string' &&
        typeof (item as EngineInfo).label === 'string',
    );
    return cleaned.length ? cleaned : DEFAULT_ENGINES;
  } catch {
    return DEFAULT_ENGINES;
  }
}

export function engineById(env: Env, id: string): EngineInfo | null {
  return engines(env).find((engine) => engine.id === id) ?? null;
}

/** Етикетът за таблото. Двигател, махнат от конфигурацията, пак има име в историята. */
export function engineLabel(env: Env, id: string): string {
  return engineById(env, id)?.label ?? id;
}

/** Какво трябва да е налично, за да работи двигателят изобщо. */
export function engineBlocker(env: Env, engine: EngineInfo): string | null {
  const secrets = env as unknown as EngineSecrets;
  if (engine.provider === 'workers-ai') return env.AI ? null : 'Workers AI не е свързан.';
  if (engine.provider.startsWith('gateway-')) {
    // Един токен отваря всички gateway двигатели наведнъж — затова липсата му
    // не е проблем на един двигател, а изключена видимост изобщо.
    if (!env.CLOUDFLARE_ACCOUNT_ID) return 'Липсва CLOUDFLARE_ACCOUNT_ID.';
    if (!env.CLOUDFLARE_API_TOKEN) return 'Липсва секретът CLOUDFLARE_API_TOKEN.';
    return null;
  }
  return engine.secret && secrets[engine.secret] ? null : `Липсва ключът ${engine.secret ?? '—'}.`;
}

export function availableEngines(env: Env): EngineId[] {
  return engines(env)
    .filter((engine) => engineBlocker(env, engine) === null)
    .map((engine) => engine.id);
}

export interface EngineAnswer {
  engine: EngineId;
  text: string;
  citations: string[];
  /** Търсил ли е двигателят в интернет за този отговор. */
  grounded: boolean;
  error?: string;
}

/**
 * Въпросът се задава на български и без подсказка за търсения бранд.
 *
 * Ако в подканата се спомене „tehnobaza.bg“, моделът ще го повтори в отговора
 * и проверката ще мери собствената си подсказка. Точно затова домейнът НЕ
 * влиза тук — той се търси едва в готовия отговор.
 */
const ASK_SYSTEM =
  'Ти си помощник за търсене на български. Потърси в интернет и отговори кратко и конкретно, ' +
  'като посочваш конкретни марки, магазини или сайтове, които наистина съществуват в България. ' +
  'Ако препоръчваш сайтове, изписвай домейните им.';

/**
 * Същият въпрос, но за модел без търсене.
 *
 * Не му се казва „потърси“ — той не може. Казва му се да отговори от това,
 * което знае, и да си мълчи, ако не знае. Иначе моделът съчинява домейни,
 * които не съществуват, и проверката брои измислици за конкуренти.
 */
const ASK_SYSTEM_MEMORY =
  'Ти си помощник на български. Отговори на въпроса САМО от това, което вече знаеш — нямаш достъп ' +
  'до интернет. Посочвай само марки и сайтове, за които наистина си сигурен, че съществуват в ' +
  'България, и изписвай домейните им. Ако не знаеш конкретни имена, кажи го направо вместо да гадаеш.';

/* ---------------------------------------------------------------- */
/* Транспортът към двигателите                                       */
/* ---------------------------------------------------------------- */

const ASK_TIMEOUT_MS = 30_000;

/** Адресът на AI Gateway. Едно място, за да не се разпилява по функциите. */
function gatewayUrl(env: Env, path: 'responses' | 'messages' | 'chat/completions'): string | null {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/${path}`;
}

interface GatewayCall {
  env: Env;
  engine: EngineInfo;
  path: 'responses' | 'messages' | 'chat/completions';
  body: Record<string, unknown>;
}

/**
 * Едно извикване през AI Gateway.
 *
 * С Unified Billing тук НЕ пътува ключ на доставчика — само токенът за
 * Cloudflare. Затова един секрет отваря ChatGPT, Claude, Grok и Qwen наведнъж
 * и няма четири ключа за въртене.
 */
async function callGateway({ env, engine, path, body }: GatewayCall): Promise<
  { ok: true; data: unknown } | { ok: false; error: string }
> {
  const url = gatewayUrl(env, path);
  if (!url) return { ok: false, error: 'Липсва CLOUDFLARE_ACCOUNT_ID.' };
  if (!env.CLOUDFLARE_API_TOKEN) return { ok: false, error: 'Липсва секретът CLOUDFLARE_API_TOKEN.' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      // Кой gateway да брои заявката. Без него Cloudflare ползва подразбиращия се.
      ...(env.AI_GATEWAY_ID ? { 'cf-aig-metadata': JSON.stringify({ gateway: env.AI_GATEWAY_ID }) } : {}),
    },
    body: JSON.stringify({ model: engine.model, ...body }),
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `${engine.model} върна ${res.status}. ${detail}` };
  }
  return { ok: true, data: await res.json() };
}

/**
 * Извлича текст и цитирани адреси от произволен отговор на Gateway.
 *
 * Четирите доставчика връщат четири различни форми и всяка от тях се мени.
 * Вместо четири крехки парсера тук се обхожда цялото дърво: взимат се всички
 * низове под ключове за текст и всички `http(s)` адреси под ключове за адрес.
 * По-грубо е, но не се чупи при добавено ниво в отговора — а точно това се
 * случва най-често.
 */
function harvest(data: unknown): { text: string; urls: string[] } {
  const texts: string[] = [];
  const urls: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, key: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (key === 'text' || key === 'output_text' || key === 'content' || key === 'reasoning') {
        if (node.trim()) texts.push(node);
      } else if ((key === 'url' || key === 'uri' || key === 'source') && /^https?:\/\//i.test(node)) {
        urls.push(node);
      }
      return;
    }
    if (typeof node !== 'object') return;
    // Пръстени в JSON не се очакват, но обхождането не бива да зависи от това.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, childKey);
    }
  };

  walk(data, '');
  return { text: texts.join('\n').trim(), urls };
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Общото завършване на всеки доставчик: текст → отговор с домейни. */
function finish(engine: EngineInfo, text: string, urls: string[]): EngineAnswer {
  const cited = urls.map(hostOf).filter(Boolean);
  if (!text.trim()) {
    return {
      engine: engine.id,
      text: '',
      citations: [],
      grounded: isGrounded(engine),
      error: `${engine.model ?? engine.id} върна празен отговор.`,
    };
  }
  return {
    engine: engine.id,
    text,
    // Цитираните източници и домейните, изписани в текста, са две различни
    // неща и двете значат „конкурент, който излиза вместо теб“.
    citations: [...new Set([...cited, ...extractDomains(text)])],
    grounded: isGrounded(engine),
  };
}

function fail(engine: EngineInfo, error: string): EngineAnswer {
  return { engine: engine.id, text: '', citations: [], grounded: isGrounded(engine), error };
}

/* — OpenAI през Gateway: Responses API + `web_search_preview` — */
async function askGatewayOpenAi(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const result = await callGateway({
    env,
    engine,
    path: 'responses',
    body: {
      instructions: ASK_SYSTEM,
      input: query,
      max_output_tokens: 900,
      tools: [{ type: 'web_search_preview' }],
    },
  });
  if (!result.ok) return fail(engine, result.error);
  const { text, urls } = harvest(result.data);
  return finish(engine, text, urls);
}

/* — Anthropic през Gateway: Messages API + `web_search_20250305` — */
async function askGatewayAnthropic(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const result = await callGateway({
    env,
    engine,
    path: 'messages',
    body: {
      system: ASK_SYSTEM,
      max_tokens: 1200,
      messages: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    },
  });
  if (!result.ok) return fail(engine, result.error);
  const { text, urls } = harvest(result.data);
  return finish(engine, text, urls);
}

/* — xAI през Gateway: Responses API + `web_search` — */
async function askGatewayXai(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const result = await callGateway({
    env,
    engine,
    path: 'responses',
    body: {
      instructions: ASK_SYSTEM,
      input: query,
      max_turns: 4,
      tools: [{ type: 'web_search' }],
    },
  });
  if (!result.ok) return fail(engine, result.error);
  const { text, urls } = harvest(result.data);
  return finish(engine, text, urls);
}

/* — Alibaba през Gateway: chat/completions + `enable_search` — */
async function askGatewayAlibaba(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const result = await callGateway({
    env,
    engine,
    path: 'chat/completions',
    body: {
      enable_search: true,
      max_tokens: 900,
      messages: [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: query },
      ],
    },
  });
  if (!result.ok) return fail(engine, result.error);
  // Qwen не връща източниците отделно — вплита ги в подканата. Затова
  // конкурентите тук идват само от текста на отговора.
  const { text, urls } = harvest(result.data);
  return finish(engine, text, urls);
}

/* — Gemini направо: `google_search` grounding — */
async function askGemini(engine: EngineInfo, apiKey: string, query: string): Promise<EngineAnswer> {
  const model = engine.model ?? 'gemini-3.7-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ASK_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 900 },
      }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    },
  );
  if (!res.ok) return fail(engine, `Gemini върна ${res.status}.`);

  const data = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
    }[];
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  const urls = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk.web?.uri ?? '')
    .filter(Boolean);
  return finish(engine, text, urls);
}

/* — Perplexity направо: търсенето е вградено — */
async function askPerplexity(engine: EngineInfo, apiKey: string, query: string): Promise<EngineAnswer> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: engine.model ?? 'sonar',
      messages: [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: query },
      ],
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });
  if (!res.ok) return fail(engine, `Perplexity върна ${res.status}.`);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    citations?: string[];
  };
  return finish(engine, data.choices?.[0]?.message?.content ?? '', data.citations ?? []);
}

/* — Workers AI: БЕЗ търсене, от паметта на модела — */
async function askWorkersAi(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM_MEMORY },
    { role: 'user', content: query },
  ];
  const result = await runChat(env, messages, { model: engine.model, maxTokens: 700, temperature: 0.4 });
  return finish(engine, result.text, []);
}

export async function askEngine(env: Env, engineId: EngineId, query: string): Promise<EngineAnswer> {
  const engine = engineById(env, engineId);
  if (!engine) {
    return {
      engine: engineId,
      text: '',
      citations: [],
      grounded: false,
      error: `Няма настроен двигател „${engineId}“.`,
    };
  }

  const secrets = env as unknown as EngineSecrets;
  const key = engine.secret ? secrets[engine.secret] : undefined;

  try {
    switch (engine.provider) {
      case 'gateway-openai':
        return await askGatewayOpenAi(env, engine, query);
      case 'gateway-anthropic':
        return await askGatewayAnthropic(env, engine, query);
      case 'gateway-xai':
        return await askGatewayXai(env, engine, query);
      case 'gateway-alibaba':
        return await askGatewayAlibaba(env, engine, query);
      case 'gemini':
        return key ? await askGemini(engine, key, query) : fail(engine, `Няма ключ ${engine.secret}.`);
      case 'perplexity':
        return key ? await askPerplexity(engine, key, query) : fail(engine, `Няма ключ ${engine.secret}.`);
      case 'workers-ai':
        return env.AI ? await askWorkersAi(env, engine, query) : fail(engine, 'Workers AI не е свързан.');
      default:
        return fail(engine, `Непознат доставчик „${String(engine.provider)}“.`);
    }
  } catch (error) {
    return fail(engine, error instanceof Error ? error.message : 'Двигателят не отговори.');
  }
}

/**
 * Проверява кои настроени двигатели наистина отговарят.
 *
 * Каталогът на Workers AI се мени и вчерашният идентификатор може да е
 * изчезнал. Тази проверка го хваща с един кратък въпрос вместо със спаднал
 * до нула резултат на таблото — грешката в конфигурацията трябва да изглежда
 * като грешка, а не като лоша новина за бизнеса.
 */
export interface EngineHealth {
  id: EngineId;
  label: string;
  provider: string;
  model?: string;
  /** Търси ли този двигател в интернет — по-важно от това дали изобщо отговаря. */
  grounded: boolean;
  ok: boolean;
  ms: number;
  error?: string;
}

export async function checkEngines(env: Env): Promise<EngineHealth[]> {
  const list = engines(env);
  return Promise.all(
    list.map(async (engine) => {
      const started = Date.now();
      const answer = await askEngine(env, engine.id, 'Кажи само думата „готово“.');
      return {
        id: engine.id,
        label: engine.label,
        provider: engine.provider,
        model: engine.model,
        grounded: isGrounded(engine),
        ok: !answer.error && answer.text.trim().length > 0,
        ms: Date.now() - started,
        error: answer.error,
      };
    }),
  );
}

/* ---------------------------------------------------------------- */
/* Разчитане на отговора                                             */
/* ---------------------------------------------------------------- */

/** Домейните, изписани в текста на отговора (моделите често пишат `пример.bg` без схема). */
export function extractDomains(text: string): string[] {
  const found = new Set<string>();
  const regex = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:bg|com|net|org|eu|io|co|shop|store|info))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const domain = match[1]?.toLowerCase().replace(/^www\./, '');
    if (domain) found.add(domain);
  }
  return [...found];
}

export interface MentionVerdict {
  mentioned: boolean;
  /** Кой по ред е споменат брандът спрямо другите домейни. `null`, ако липсва. */
  position: number | null;
  competitors: string[];
  excerpt: string;
}

/**
 * Търси бранда в отговора — по домейн и по име.
 *
 * Нарочно е чист текстов разбор, а не втори модел: „споменат ли е“ е факт, а
 * не преценка, и трябва да дава един и същ резултат при две минавания през
 * същия текст. Втори модел върху този въпрос вкарва шум точно в числото,
 * върху което стъпва всичко останало.
 */
export function findMention(answer: string, domain: string, brandName?: string): MentionVerdict {
  const bare = domain.toLowerCase().replace(/^www\./, '');
  const label = bare.split('.')[0] ?? bare;
  const names = [bare, brandName?.toLowerCase(), label.length >= 4 ? label : undefined].filter(
    (value): value is string => Boolean(value),
  );

  const lower = answer.toLowerCase();
  const index = names
    .map((name) => lower.indexOf(name))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0];

  const mentioned = index !== undefined;
  const domains = extractDomains(answer).filter((d) => d !== bare);

  // Поредността е по позиция в текста: първият споменат е първият отговор,
  // който човек ще прочете.
  let position: number | null = null;
  if (mentioned) {
    const ordered = extractDomains(answer)
      .map((d) => ({ domain: d, at: lower.indexOf(d) }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => a.at - b.at);
    const rank = ordered.findIndex((entry) => entry.domain === bare);
    position = rank >= 0 ? rank + 1 : 1;
  }

  let excerpt = '';
  if (index !== undefined) {
    const start = Math.max(0, index - 120);
    excerpt = answer.slice(start, index + 200).trim();
  } else {
    excerpt = answer.slice(0, 240).trim();
  }

  return { mentioned, position, competitors: domains.slice(0, 8), excerpt };
}

/* ---------------------------------------------------------------- */
/* Заявки за проверка                                                */
/* ---------------------------------------------------------------- */

/**
 * Съставя списък от въпроси, които реален човек би задал за този бранш.
 *
 * Не са ключови думи, а въпроси: машините се питат с изречения, а
 * „винтоверт цена“ е заявка за търсачка, не за разговор.
 */
export async function suggestQueries(
  env: Env,
  input: { domain: string; industry?: string; count?: number },
): Promise<string[]> {
  const count = Math.max(3, Math.min(input.count ?? 8, 20));
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Ти си SEO/GEO стратег за български пазар. Връщаш само JSON масив от низове, без обяснения.',
    },
    {
      role: 'user',
      content:
        `Домейн: ${input.domain}. Бранш: ${input.industry ?? 'неизвестен — съди по домейна'}.\n` +
        `Върни точно ${count} въпроса на български, които реален български клиент би задал на AI асистент, ` +
        `преди да купи или избере доставчик в този бранш. Въпросите да са естествени изречения, ` +
        `да НЕ съдържат името на домейна и да са подходящи да проверим дали брандът се появява в отговора.\n` +
        'Формат: ["въпрос 1", "въпрос 2", ...]',
    },
  ];

  const result = await runChat(env, messages, { model: fastModel(env), maxTokens: 700, temperature: 0.7 });
  const parsed = parseJsonFromModel<unknown[]>(result.text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 5 && item.length < 300)
    .slice(0, count);
}

export interface VisibilityCheck {
  query: string;
  engine: EngineId;
  mentioned: boolean;
  position: number | null;
  competitors: string[];
  excerpt: string;
  /** Търсил ли е двигателят в интернет. Решава в кое число влиза проверката. */
  grounded: boolean;
  error?: string;
}

export interface VisibilityRun {
  domain: string;
  checks: VisibilityCheck[];
  /**
   * 0–100: дял на отговорите С ЖИВО ТЪРСЕНЕ, в които брандът е споменат.
   * `null`, ако не е питан нито един такъв двигател — тогава просто НЯМА
   * измерена видимост и таблото трябва да го каже, а не да покаже число.
   */
  score: number | null;
  /** Отделно: какво знаят моделите наизуст. Друго измерване, друго число. */
  memoryScore: number | null;
  byEngine: { engine: EngineId; label: string; score: number; asked: number; grounded: boolean }[];
  /** Кой излиза вместо теб, подреден по брой споменавания. */
  topCompetitors: { domain: string; mentions: number }[];
}

export async function runVisibilityCheck(
  env: Env,
  input: { domain: string; brandName?: string; queries: string[]; engines: EngineId[] },
): Promise<VisibilityRun> {
  const pairs = input.engines.flatMap((engine) => input.queries.map((query) => ({ engine, query })));

  // Заявките вървят паралелно, но на партиди: Worker-ът има таван на
  // едновременните подзаявки, а и външните API-та отвръщат с 429 при залп.
  const checks: VisibilityCheck[] = [];
  const BATCH = 4;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const answers = await Promise.all(batch.map((pair) => askEngine(env, pair.engine, pair.query)));
    answers.forEach((answer, index) => {
      const pair = batch[index];
      if (!pair) return;
      if (answer.error) {
        checks.push({
          query: pair.query, engine: pair.engine, mentioned: false, position: null,
          competitors: [], excerpt: '', grounded: answer.grounded, error: answer.error,
        });
        return;
      }
      const verdict = findMention(answer.text, input.domain, input.brandName);
      checks.push({
        query: pair.query,
        engine: pair.engine,
        mentioned: verdict.mentioned,
        position: verdict.position,
        competitors: [...new Set([...verdict.competitors, ...answer.citations])].slice(0, 8),
        excerpt: verdict.excerpt,
        grounded: answer.grounded,
      });
    });
  }

  const answered = checks.filter((check) => !check.error);

  /*
   * Двете числа се смятат ОТДЕЛНО и никога не се смесват.
   *
   * Видимостта е за двигателите с живо търсене — те отговарят на въпроса
   * „в отговора ли си днес“. Моделите без търсене отговарят на друг въпрос
   * („знаят ли изобщо за теб“) и събирането им в едно средно би дало число,
   * което не значи нито едното, нито другото.
   */
  const share = (rows: VisibilityCheck[]): number | null =>
    rows.length ? Math.round((rows.filter((check) => check.mentioned).length / rows.length) * 100) : null;

  const score = share(answered.filter((check) => check.grounded));
  const memoryScore = share(answered.filter((check) => !check.grounded));

  const byEngine = input.engines.map((engine) => {
    const forEngine = answered.filter((check) => check.engine === engine);
    return {
      engine,
      label: engineLabel(env, engine),
      score: share(forEngine) ?? 0,
      asked: forEngine.length,
      grounded: forEngine[0]?.grounded ?? false,
    };
  });

  const counts = new Map<string, number>();
  for (const check of answered) {
    for (const competitor of check.competitors) {
      counts.set(competitor, (counts.get(competitor) ?? 0) + 1);
    }
  }

  return {
    domain: input.domain,
    checks,
    score,
    memoryScore,
    byEngine,
    topCompetitors: [...counts.entries()]
      .map(([domain, mentions]) => ({ domain, mentions }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 10),
  };
}
