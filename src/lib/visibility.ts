/**
 * Проверка на видимост в AI отговори.
 *
 * Въпросът, на който отговаря целият продукт: като питаш машина за твоя
 * бранш, той ли излиза. Мерим го буквално — задаваме въпроса, четем отговора
 * и търсим в него домейна и името на бранда.
 *
 * Двигателите са НАИСТИНА различни доставчици, а не един модел с четири
 * етикета. Cloudflare Workers AI работи винаги (сметката е на акаунта);
 * ChatGPT, Perplexity и Gemini се включват, когато операторът сложи
 * съответния ключ. Двигател без ключ се показва като „не е свързан“, а не се
 * подменя мълчаливо с друг модел — иначе таблото показва число, което не
 * значи това, което пише над него.
 */

import { fastModel, parseJsonFromModel, runChat, type ChatMessage } from './ai';

export type EngineId = 'workers-ai' | 'chatgpt' | 'perplexity' | 'gemini';

export interface EngineInfo {
  id: EngineId;
  label: string;
  /** Кой секрет включва двигателя. `null` за вградения. */
  secret: string | null;
  note: string;
}

export const ENGINES: EngineInfo[] = [
  {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    secret: null,
    note: 'Вграден. Работи без външен ключ и е базовата ти мярка.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    secret: 'OPENAI_API_KEY',
    note: 'Изисква ключ за OpenAI API. Ползва модел с достъп до уеб търсене.',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    secret: 'PERPLEXITY_API_KEY',
    note: 'Изисква ключ за Perplexity API. Връща и списък с цитирани източници.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    secret: 'GEMINI_API_KEY',
    note: 'Изисква ключ за Google AI Studio (Gemini API) с включено търсене.',
  },
];

/** Секретите за външните двигатели не са в `Env`, защото са по избор. */
type EngineSecrets = Record<string, string | undefined>;

export function availableEngines(env: Env): EngineId[] {
  const secrets = env as unknown as EngineSecrets;
  return ENGINES.filter((engine) => engine.secret === null || Boolean(secrets[engine.secret])).map((e) => e.id);
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

async function askWorkersAi(env: Env, query: string): Promise<EngineAnswer> {
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: query },
  ];
  const result = await runChat(env, messages, { maxTokens: 700, temperature: 0.4 });
  return { engine: 'workers-ai', text: result.text, citations: extractDomains(result.text) };
}

async function askOpenAi(apiKey: string, query: string): Promise<EngineAnswer> {
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
  if (!res.ok) return { engine: 'chatgpt', text: '', citations: [], error: `OpenAI върна ${res.status}.` };

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
  return { engine: 'chatgpt', text, citations: cited.length ? cited : extractDomains(text) };
}

async function askPerplexity(apiKey: string, query: string): Promise<EngineAnswer> {
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
  if (!res.ok) return { engine: 'perplexity', text: '', citations: [], error: `Perplexity върна ${res.status}.` };

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; citations?: string[] };
  const text = data.choices?.[0]?.message?.content ?? '';
  const cited = (data.citations ?? []).map(hostOf).filter(Boolean);
  return { engine: 'perplexity', text, citations: cited.length ? cited : extractDomains(text) };
}

async function askGemini(apiKey: string, query: string): Promise<EngineAnswer> {
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
  if (!res.ok) return { engine: 'gemini', text: '', citations: [], error: `Gemini върна ${res.status}.` };

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
  return { engine: 'gemini', text, citations: cited.length ? cited : extractDomains(text) };
}

export async function askEngine(env: Env, engine: EngineId, query: string): Promise<EngineAnswer> {
  const secrets = env as unknown as EngineSecrets;
  try {
    switch (engine) {
      case 'workers-ai':
        return await askWorkersAi(env, query);
      case 'chatgpt':
        return secrets.OPENAI_API_KEY
          ? await askOpenAi(secrets.OPENAI_API_KEY, query)
          : { engine, text: '', citations: [], error: 'Няма ключ за OpenAI.' };
      case 'perplexity':
        return secrets.PERPLEXITY_API_KEY
          ? await askPerplexity(secrets.PERPLEXITY_API_KEY, query)
          : { engine, text: '', citations: [], error: 'Няма ключ за Perplexity.' };
      case 'gemini':
        return secrets.GEMINI_API_KEY
          ? await askGemini(secrets.GEMINI_API_KEY, query)
          : { engine, text: '', citations: [], error: 'Няма ключ за Gemini.' };
    }
  } catch (error) {
    return { engine, text: '', citations: [], error: error instanceof Error ? error.message : 'Двигателят не отговори.' };
  }
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
      label: ENGINES.find((e) => e.id === engine)?.label ?? engine,
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
