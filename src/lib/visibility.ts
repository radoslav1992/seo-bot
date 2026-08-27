/**
 * Проверка на видимост в AI отговори.
 *
 * Въпросът, на който отговаря целият продукт: като питаш машина за твоя
 * бранш, той ли излиза. Мерим го буквално — задаваме въпроса, четем отговора
 * и търсим в него домейна и името на бранда.
 *
 * Двигателите са РАЗЛИЧНИ МОДЕЛИ, а не един модел с няколко етикета.
 * Cloudflare хоства модели на Meta, Google, Mistral, Qwen, DeepSeek, OpenAI
 * (отворените) и други — те се извикват през `env.AI` без ключ и са гръбнакът
 * на проверката. Външните двигатели (живите ChatGPT, Perplexity, Gemini) са
 * по избор и се включват със свой ключ.
 *
 * Ключово: двигател, чийто модел не отговаря, се ОТЧИТА КАТО ГРЕШКА, а не
 * като „брандът не е споменат“. Разликата е между „питахме и не те намериха“
 * и „не сме питали“ — и само първото е измерване.
 */

import { fastModel, parseJsonFromModel, runChat, type ChatMessage } from './ai';

/** Идентификаторът е низ, а не изброен тип: списъкът идва от конфигурацията. */
export type EngineId = string;

export interface EngineInfo {
  id: EngineId;
  label: string;
  /** `workers-ai` вика модел през binding-а; останалите са външни API-та. */
  provider: 'workers-ai' | 'openai' | 'perplexity' | 'gemini';
  /** Само за `workers-ai`: точният идентификатор на модела. */
  model?: string;
  /** Само за външните: кой секрет ги включва. */
  secret?: string;
  note: string;
}

/**
 * Двигателите по подразбиране.
 *
 * Каталогът на Workers AI се мени бързо — модели идват и си отиват. Затова
 * този списък е НАЧАЛНА СТОЙНОСТ, а не истина в кода: `VISIBILITY_ENGINES` в
 * `wrangler.jsonc` го замества изцяло, а `/api/models` казва кои от
 * настроените наистина отговарят. Смяната на модел е един ред конфигурация,
 * не деплой на нов код.
 *
 * Виж docs/models.md за това как се проверява актуалният каталог.
 */
export const DEFAULT_ENGINES: EngineInfo[] = [
  {
    id: 'llama',
    label: 'Llama (Meta)',
    provider: 'workers-ai',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    note: 'Основният модел. Той отговаря и в чата.',
  },
  {
    id: 'gpt-oss',
    label: 'GPT-OSS (OpenAI)',
    provider: 'workers-ai',
    model: '@cf/openai/gpt-oss-120b',
    note: 'Отворените тегла на OpenAI, хостнати от Cloudflare.',
  },
  {
    id: 'gemma',
    label: 'Gemma (Google)',
    provider: 'workers-ai',
    model: '@cf/google/gemma-3-12b-it',
    note: 'Моделът на Google върху Workers AI.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    provider: 'workers-ai',
    model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    note: 'Европейски модел — полезен за български заявки.',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    provider: 'workers-ai',
    model: '@cf/qwen/qwen2.5-14b-instruct',
    note: 'Силен многоезичен модел.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT (живият)',
    provider: 'openai',
    secret: 'OPENAI_API_KEY',
    note: 'По избор. Изисква ключ за OpenAI API; ползва модел с уеб търсене.',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    provider: 'perplexity',
    secret: 'PERPLEXITY_API_KEY',
    note: 'По избор. Изисква ключ за Perplexity API; връща и цитираните източници.',
  },
  {
    id: 'gemini',
    label: 'Gemini (живият)',
    provider: 'gemini',
    secret: 'GEMINI_API_KEY',
    note: 'По избор. Изисква ключ за Google AI Studio с включено търсене.',
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

export function availableEngines(env: Env): EngineId[] {
  const secrets = env as unknown as EngineSecrets;
  return engines(env)
    .filter((engine) => (engine.provider === 'workers-ai' ? Boolean(env.AI) : Boolean(engine.secret && secrets[engine.secret])))
    .map((engine) => engine.id);
}

export interface EngineAnswer {
  engine: EngineId;
  text: string;
  citations: string[];
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
  'Ти си помощник за търсене на български. Отговаряй кратко и конкретно на въпроса, ' +
  'като посочваш конкретни марки, магазини или сайтове, които наистина съществуват в България. ' +
  'Ако препоръчваш сайтове, изписвай домейните им.';

async function askWorkersAi(env: Env, engine: EngineInfo, query: string): Promise<EngineAnswer> {
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: query },
  ];
  const result = await runChat(env, messages, { model: engine.model, maxTokens: 700, temperature: 0.4 });
  // Празен отговор е грешка, не „не те споменават“: така изчезнал от каталога
  // модел не се брои като нула точки видимост.
  if (!result.text.trim()) {
    return { engine: engine.id, text: '', citations: [], error: `Моделът ${engine.model} върна празен отговор.` };
  }
  return { engine: engine.id, text: result.text, citations: extractDomains(result.text) };
}

async function askOpenAi(id: EngineId, apiKey: string, query: string): Promise<EngineAnswer> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-search-preview',
      messages: [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: query },
      ],
      max_tokens: 700,
    }),
  });
  if (!res.ok) return { engine: id, text: '', citations: [], error: `OpenAI върна ${res.status}.` };

  const data = (await res.json()) as {
    choices?: { message?: { content?: string; annotations?: { url_citation?: { url?: string } }[] } }[];
  };
  const message = data.choices?.[0]?.message;
  const text = message?.content ?? '';
  const cited = (message?.annotations ?? [])
    .map((a) => a.url_citation?.url ?? '')
    .filter(Boolean)
    .map(hostOf)
    .filter(Boolean);
  return { engine: id, text, citations: cited.length ? cited : extractDomains(text) };
}

async function askPerplexity(id: EngineId, apiKey: string, query: string): Promise<EngineAnswer> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: query },
      ],
      max_tokens: 700,
    }),
  });
  if (!res.ok) return { engine: id, text: '', citations: [], error: `Perplexity върна ${res.status}.` };

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; citations?: string[] };
  const text = data.choices?.[0]?.message?.content ?? '';
  const cited = (data.citations ?? []).map(hostOf).filter(Boolean);
  return { engine: id, text, citations: cited.length ? cited : extractDomains(text) };
}

async function askGemini(id: EngineId, apiKey: string, query: string): Promise<EngineAnswer> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ASK_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 700 },
      }),
    },
  );
  if (!res.ok) return { engine: id, text: '', citations: [], error: `Gemini върна ${res.status}.` };

  const data = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
    }[];
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const cited = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk.web?.uri ?? chunk.web?.title ?? '')
    .filter(Boolean)
    .map(hostOf)
    .filter(Boolean);
  return { engine: id, text, citations: cited.length ? cited : extractDomains(text) };
}

export async function askEngine(env: Env, engineId: EngineId, query: string): Promise<EngineAnswer> {
  const engine = engineById(env, engineId);
  if (!engine) {
    return { engine: engineId, text: '', citations: [], error: `Няма настроен двигател „${engineId}“.` };
  }

  const secrets = env as unknown as EngineSecrets;
  const key = engine.secret ? secrets[engine.secret] : undefined;

  try {
    switch (engine.provider) {
      case 'workers-ai':
        return env.AI
          ? await askWorkersAi(env, engine, query)
          : { engine: engine.id, text: '', citations: [], error: 'Workers AI не е свързан.' };
      case 'openai':
        return key
          ? await askOpenAi(engine.id, key, query)
          : { engine: engine.id, text: '', citations: [], error: `Няма ключ ${engine.secret}.` };
      case 'perplexity':
        return key
          ? await askPerplexity(engine.id, key, query)
          : { engine: engine.id, text: '', citations: [], error: `Няма ключ ${engine.secret}.` };
      case 'gemini':
        return key
          ? await askGemini(engine.id, key, query)
          : { engine: engine.id, text: '', citations: [], error: `Няма ключ ${engine.secret}.` };
      default:
        return { engine: engine.id, text: '', citations: [], error: `Непознат доставчик „${String(engine.provider)}“.` };
    }
  } catch (error) {
    return {
      engine: engine.id,
      text: '',
      citations: [],
      error: error instanceof Error ? error.message : 'Двигателят не отговори.',
    };
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

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

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
  error?: string;
}

export interface VisibilityRun {
  domain: string;
  checks: VisibilityCheck[];
  /** 0–100: дял на заявките, в които брандът е споменат. */
  score: number;
  byEngine: { engine: EngineId; label: string; score: number; asked: number }[];
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
          competitors: [], excerpt: '', error: answer.error,
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
      });
    });
  }

  const answered = checks.filter((check) => !check.error);
  const score = answered.length
    ? Math.round((answered.filter((check) => check.mentioned).length / answered.length) * 100)
    : 0;

  const byEngine = input.engines.map((engine) => {
    const forEngine = answered.filter((check) => check.engine === engine);
    return {
      engine,
      label: engineLabel(env, engine),
      score: forEngine.length
        ? Math.round((forEngine.filter((check) => check.mentioned).length / forEngine.length) * 100)
        : 0,
      asked: forEngine.length,
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
    byEngine,
    topCompetitors: [...counts.entries()]
      .map(([domain, mentions]) => ({ domain, mentions }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 10),
  };
}
