/**
 * Проверка на видимост в AI отговори.
 *
 * Въпросът, на който отговаря целият продукт: като питаш машина за твоя
 * бранш, той ли излиза. Мерим го буквално — задаваме въпроса, четем отговора
 * и търсим в него домейна и името на бранда.
 *
 * ВСИЧКО минава през `env.AI.run` — binding-а на Workers AI, с две аргумента и
 * нищо повече. Партньорските модели (`openai/*`, `google/*`) се викат по същия
 * начин като собствените `@cf/*`: без AI Gateway, без токен за Cloudflare API
 * и без ключове на доставчиците. Сметката е на акаунта.
 *
 * ВТОРОТО важно нещо: разликата между двигател, който наистина е ТЪРСИЛ, и
 * модел, който е отговорил от паметта си. Първото отговаря на въпроса „в
 * отговора ли си днес“, второто — на „знае ли изобщо за теб“. И понеже дали
 * търсенето е минало не се знае предварително, то се ЧЕТЕ ОТ ОТГОВОРА, а не се
 * обявява в конфигурацията: продуктът, който казва на клиента да мери вместо
 * да предполага, не бива да предполага за себе си.
 */

import { fastModel, parseJsonFromModel, runChat, type ChatMessage } from './ai';

/** Идентификаторът е низ, а не изброен тип: списъкът идва от конфигурацията. */
export type EngineId = string;

export interface EngineInfo {
  id: EngineId;
  label: string;
  /**
   * Идентификаторът на модела. Той избира и доставчика, и формата на тялото —
   * няма отделно поле за това, защото имената не се застъпват:
   * `openai/*`, `google/*`, `@cf/*`.
   */
  model: string;
  /** Да се поиска ли живо търсене. Дали е минало — казва отговорът. */
  search?: boolean;
  note?: string;
}

/**
 * Формата на тялото за `env.AI.run`. Три са, не една.
 *
 * Разликата не е козметична: подадени грешни полета, моделът не гърми, а тихо
 * пренебрегва тавана, температурата и инструментите — тоест търсенето мълчаливо
 * не се случва, а отговорът изглежда наред.
 */
export type BodyShape = 'gemini' | 'responses' | 'messages';

export function bodyShapeFor(model: string): BodyShape {
  if (model.startsWith('google/')) return 'gemini';
  if (model.startsWith('openai/')) return 'responses';
  return 'messages';
}

/**
 * Може ли този модел изобщо да търси.
 *
 * Собствените модели на Cloudflare (`@cf/*`) нямат инструмент за търсене —
 * те отговарят от теглата си. При партньорските се ИСКА търсене, но дали е
 * минало се проверява после, в отговора.
 */
export function canSearch(model: string): boolean {
  return bodyShapeFor(model) !== 'messages';
}

/**
 * Двигателите по подразбиране.
 *
 * Проприетарните модели, защото клиентът пита какво отговаря ChatGPT, а не
 * какво би отговорил Llama. През binding-а те не искат нито един чужд ключ.
 *
 * Списъкът е НАЧАЛНА СТОЙНОСТ, а не истина в кода: `VISIBILITY_ENGINES` в
 * настройките на worker-а го замества изцяло — стойност, която се сменя от
 * dashboard-а без деплой. Каталогът се мени бързо; „Провери моделите“ в
 * таблото казва кои от настроените работят днес. Виж docs/models.md.
 */
export const DEFAULT_ENGINES: EngineInfo[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    model: 'openai/gpt-5.6-luna',
    search: true,
    note: 'Иска живо търсене през Responses API.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    model: 'google/gemini-3.7-flash',
    search: true,
    note: 'Иска живо търсене през google_search.',
  },
  {
    id: 'llama-memory',
    label: 'Llama (без търсене)',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    note: 'Не мери видимост, а познатост: какво моделът знае за бранда наизуст.',
  },
];

/**
 * Списъкът от двигатели за тази инсталация.
 *
 * Разчита се отбранително: счупен JSON в настройките не бива да оставя
 * продукта без нито един двигател, затова при грешка се връщат стандартните.
 */
export function engines(env: Env): EngineInfo[] {
  const raw = env.VISIBILITY_ENGINES;
  if (!raw) return DEFAULT_ENGINES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_ENGINES;
    const cleaned = parsed.filter(
      (item): item is EngineInfo =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as EngineInfo).id === 'string' &&
        typeof (item as EngineInfo).label === 'string' &&
        typeof (item as EngineInfo).model === 'string',
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

/**
 * Двигателите, които могат да се пуснат сега.
 *
 * Единственото условие е binding-ът: всичко минава през него, включително
 * партньорските модели. Няма ключове за проверка, защото няма ключове.
 */
export function availableEngines(env: Env): EngineId[] {
  return env.AI ? engines(env).map((engine) => engine.id) : [];
}

/** Двигател, от който изобщо може да се очаква измерена видимост. */
export function mayGround(engine: EngineInfo): boolean {
  return Boolean(engine.search) && canSearch(engine.model);
}

export interface EngineAnswer {
  engine: EngineId;
  text: string;
  citations: string[];
  /**
   * Търсил ли е двигателят наистина за ТОЗИ отговор — прочетено от самия
   * отговор, не обявено в конфигурацията.
   */
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
/* Тялото на заявката                                                */
/* ---------------------------------------------------------------- */

const ASK_TIMEOUT_MS = 45_000;
const MAX_ANSWER_TOKENS = 900;

/**
 * Сглобява тялото за `env.AI.run` според формата на модела.
 *
 * При `responses` `input` е НИЗ, не масив от съобщения — масив дава
 * „User Input Error“, код, който изглежда като сгрешен адрес, а сочи тялото.
 */
function askBody(engine: EngineInfo, query: string): Record<string, unknown> {
  const shape = bodyShapeFor(engine.model);
  const wantsSearch = mayGround(engine);
  const system = wantsSearch ? ASK_SYSTEM : ASK_SYSTEM_MEMORY;

  if (shape === 'responses') {
    return {
      input: query,
      instructions: system,
      max_output_tokens: MAX_ANSWER_TOKENS,
      ...(wantsSearch ? { tools: [{ type: 'web_search_preview' }] } : {}),
    };
  }

  if (shape === 'gemini') {
    return {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: MAX_ANSWER_TOKENS },
      ...(wantsSearch ? { tools: [{ google_search: {} }] } : {}),
    };
  }

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: query },
    ],
    max_tokens: MAX_ANSWER_TOKENS,
  };
}

/* ---------------------------------------------------------------- */
/* Разчитане на суровия отговор                                      */
/* ---------------------------------------------------------------- */

/** Ключове, под които доставчиците слагат четим текст. */
const TEXT_KEYS = new Set(['text', 'output_text', 'response', 'content', 'reasoning']);
/** Ключове, под които слагат адрес на източник. */
const URL_KEYS = new Set(['url', 'uri', 'source']);
/**
 * Следи ли този ключ/стойност, че наистина е ТЪРСЕНО.
 *
 * Всеки доставчик го бележи по своему: OpenAI слага елемент `web_search_call`
 * в `output` и анотации `url_citation`; Gemini връща `groundingMetadata` с
 * `groundingChunks`; Anthropic — блокове `server_tool_use` и
 * `web_search_tool_result`. Затова се търсят следите на трите, а не една.
 */
const SEARCH_MARKERS = [
  'web_search',
  'url_citation',
  'groundingmetadata',
  'groundingchunks',
  'server_tool_use',
];

interface Harvest {
  text: string;
  urls: string[];
  searched: boolean;
}

/**
 * Обхожда цялото дърво на отговора.
 *
 * По-грубо от четири отделни парсера, но не се чупи при добавено ниво — а
 * точно това се случва най-често, когато доставчикът промени формата си.
 * Текстът се събира от ВСИЧКИ парчета: при моделите, които мислят, първите
 * елементи са разсъждения без текст и „вземи първия“ би върнало празно.
 */
function harvest(data: unknown): Harvest {
  const texts: string[] = [];
  const urls: string[] = [];
  const seen = new Set<unknown>();
  let searched = false;

  const marks = (value: string): boolean => {
    const lower = value.toLowerCase();
    return SEARCH_MARKERS.some((marker) => lower.includes(marker));
  };

  const walk = (node: unknown, key: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      // Следата за търсене може да е и в стойност (`"type": "web_search_call"`),
      // и в име на ключ (`groundingMetadata`) — проверяват се и двете.
      if (marks(node) || marks(key)) searched = true;
      if (TEXT_KEYS.has(key)) {
        if (node.trim()) texts.push(node);
      } else if (URL_KEYS.has(key) && /^https?:\/\//i.test(node)) {
        urls.push(node);
      }
      return;
    }

    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (marks(key)) searched = true;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, childKey);
    }
  };

  walk(data, '');
  return { text: texts.join('\n').trim(), urls, searched };
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fail(engine: EngineInfo, error: string): EngineAnswer {
  return { engine: engine.id, text: '', citations: [], grounded: false, error };
}

/* ---------------------------------------------------------------- */
/* Извикването                                                       */
/* ---------------------------------------------------------------- */

export async function askEngine(env: Env, engineId: EngineId, query: string): Promise<EngineAnswer> {
  const engine = engineById(env, engineId);
  if (!engine) {
    return { engine: engineId, text: '', citations: [], grounded: false, error: `Няма настроен двигател „${engineId}“.` };
  }
  if (!env.AI) return fail(engine, 'Липсва Workers AI binding. Добави "ai": { "binding": "AI" } в wrangler.jsonc.');

  let raw: unknown;
  try {
    raw = await Promise.race([
      env.AI.run(engine.model, askBody(engine, query)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${engine.model} не отговори за ${ASK_TIMEOUT_MS / 1000} s.`)), ASK_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    return fail(engine, error instanceof Error ? error.message : 'Двигателят не отговори.');
  }

  const { text, urls, searched } = harvest(raw);
  if (!text) {
    // Празен отговор е ГРЕШКА, не „не те споменават“: така изчезнал от
    // каталога модел не се брои като нула точки видимост.
    return fail(engine, `${engine.model} върна отговор без текст.`);
  }

  return {
    engine: engine.id,
    text,
    // Цитираните източници и домейните, изписани в текста, са две различни
    // неща и двете значат „конкурент, който излиза вместо теб“.
    citations: [...new Set([...urls.map(hostOf).filter(Boolean), ...extractDomains(text)])],
    grounded: searched,
  };
}

/**
 * Проверява кои настроени двигатели работят — и кои наистина търсят.
 *
 * Второто е по-важното. Модел, който отговаря, но без да е търсил, изглежда
 * изправен и мери друго; без тази проверка разликата се вижда чак когато
 * числото на таблото се окаже безсмислено.
 */
export interface EngineHealth {
  id: EngineId;
  label: string;
  model: string;
  shape: BodyShape;
  /** Поискано ли е търсене за този двигател. */
  wantsSearch: boolean;
  /** Минало ли е търсене при пробната заявка. */
  searched: boolean;
  ok: boolean;
  ms: number;
  error?: string;
}

export async function checkEngines(env: Env): Promise<EngineHealth[]> {
  const list = engines(env);
  return Promise.all(
    list.map(async (engine) => {
      const started = Date.now();
      // Въпрос, на който отговор от паметта и отговор от търсене изглеждат
      // различно — иначе проверката не може да види дали търсенето е минало.
      const answer = await askEngine(env, engine.id, 'Кой е най-големият онлайн магазин за инструменти в България?');
      return {
        id: engine.id,
        label: engine.label,
        model: engine.model,
        shape: bodyShapeFor(engine.model),
        wantsSearch: mayGround(engine),
        searched: answer.grounded,
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
