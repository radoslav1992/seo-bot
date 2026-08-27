/**
 * Генераторите: schema.org разметка, llms.txt и задания за съдържание.
 *
 * Разделението тук е нарочно: структурата се пресмята с код, а текстът се
 * пише от модел. JSON-LD, което понякога е валидно, е по-лошо от липсващо —
 * търсачката го отхвърля цялото. Затова скелетът се сглобява детерминистично
 * и се проверява, а моделът попълва само полетата с думи.
 */

import { fastModel, parseJsonFromModel, runChat, type ChatMessage } from './ai';

/* ---------------------------------------------------------------- */
/* schema.org / JSON-LD                                              */
/* ---------------------------------------------------------------- */

export type SchemaKind =
  | 'Organization'
  | 'LocalBusiness'
  | 'Product'
  | 'Article'
  | 'FAQPage'
  | 'BreadcrumbList'
  | 'HowTo'
  | 'WebSite';

export const SCHEMA_KINDS: { id: SchemaKind; label: string; use: string }[] = [
  { id: 'Organization', label: 'Organization', use: 'За началната страница и „За нас“. Свързва бранда със същност, която моделите разпознават.' },
  { id: 'LocalBusiness', label: 'LocalBusiness', use: 'За физически обект с адрес и работно време.' },
  { id: 'Product', label: 'Product', use: 'За продуктова страница: цена, наличност, оценки.' },
  { id: 'Article', label: 'Article', use: 'За статия в блога: автор, дати, тема.' },
  { id: 'FAQPage', label: 'FAQPage', use: 'Най-цитираният тип. Двойките въпрос/отговор влизат директно в AI отговорите.' },
  { id: 'BreadcrumbList', label: 'BreadcrumbList', use: 'Показва мястото на страницата в структурата на сайта.' },
  { id: 'HowTo', label: 'HowTo', use: 'За стъпкови ръководства.' },
  { id: 'WebSite', label: 'WebSite', use: 'Име на сайта и вътрешно търсене.' },
];

export interface SchemaInput {
  kind: SchemaKind;
  url: string;
  name?: string;
  description?: string;
  /** Свободни данни: цена, автор, адрес, въпроси… Каквото знаем за страницата. */
  facts?: Record<string, unknown>;
  faq?: { question: string; answer: string }[];
}

/** Празните полета се махат: `"author": null` е по-лошо от липсващ автор. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(prune).filter((item) => item !== undefined && item !== null && item !== '') as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = prune(raw);
      if (cleaned === undefined || cleaned === null || cleaned === '') continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) continue;
      out[key] = cleaned;
    }
    return out as unknown as T;
  }
  return value;
}

export function buildSchema(input: SchemaInput): Record<string, unknown> {
  const facts = input.facts ?? {};
  const base = { '@context': 'https://schema.org', '@type': input.kind };

  switch (input.kind) {
    case 'FAQPage':
      return prune({
        ...base,
        mainEntity: (input.faq ?? []).map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: { '@type': 'Answer', text: item.answer },
        })),
      });

    case 'Product':
      return prune({
        ...base,
        name: input.name,
        description: input.description,
        url: input.url,
        brand: facts.brand ? { '@type': 'Brand', name: facts.brand } : undefined,
        sku: facts.sku,
        image: facts.image,
        offers: facts.price
          ? {
              '@type': 'Offer',
              url: input.url,
              // Валутата има значение: `лв.` в цената и липсваща валута е
              // типичната причина Google да отхвърли иначе валиден Product.
              priceCurrency: facts.currency ?? 'BGN',
              price: String(facts.price),
              availability: `https://schema.org/${facts.availability ?? 'InStock'}`,
            }
          : undefined,
        aggregateRating:
          facts.ratingValue && facts.reviewCount
            ? {
                '@type': 'AggregateRating',
                ratingValue: String(facts.ratingValue),
                reviewCount: String(facts.reviewCount),
              }
            : undefined,
      });

    case 'Article':
      return prune({
        ...base,
        headline: input.name,
        description: input.description,
        mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
        author: facts.author ? { '@type': 'Person', name: facts.author } : undefined,
        publisher: facts.publisher
          ? { '@type': 'Organization', name: facts.publisher, logo: facts.logo ? { '@type': 'ImageObject', url: facts.logo } : undefined }
          : undefined,
        datePublished: facts.datePublished,
        dateModified: facts.dateModified ?? facts.datePublished,
        inLanguage: facts.inLanguage ?? 'bg-BG',
        image: facts.image,
      });

    case 'LocalBusiness':
      return prune({
        ...base,
        name: input.name,
        description: input.description,
        url: input.url,
        telephone: facts.telephone,
        priceRange: facts.priceRange,
        address: facts.streetAddress
          ? {
              '@type': 'PostalAddress',
              streetAddress: facts.streetAddress,
              addressLocality: facts.addressLocality ?? 'София',
              postalCode: facts.postalCode,
              addressCountry: facts.addressCountry ?? 'BG',
            }
          : undefined,
        openingHours: facts.openingHours,
        geo: facts.latitude && facts.longitude
          ? { '@type': 'GeoCoordinates', latitude: facts.latitude, longitude: facts.longitude }
          : undefined,
      });

    case 'BreadcrumbList':
      return prune({
        ...base,
        itemListElement: (Array.isArray(facts.items) ? facts.items : []).map((item, index) => {
          const entry = item as { name?: string; url?: string };
          return { '@type': 'ListItem', position: index + 1, name: entry.name, item: entry.url };
        }),
      });

    case 'HowTo':
      return prune({
        ...base,
        name: input.name,
        description: input.description,
        totalTime: facts.totalTime,
        step: (Array.isArray(facts.steps) ? facts.steps : []).map((step, index) => {
          const entry = step as { name?: string; text?: string };
          return { '@type': 'HowToStep', position: index + 1, name: entry.name, text: entry.text };
        }),
      });

    case 'WebSite':
      return prune({
        ...base,
        name: input.name,
        url: input.url,
        inLanguage: facts.inLanguage ?? 'bg-BG',
        potentialAction: facts.searchUrl
          ? {
              '@type': 'SearchAction',
              target: { '@type': 'EntryPoint', urlTemplate: `${facts.searchUrl}{search_term_string}` },
              'query-input': 'required name=search_term_string',
            }
          : undefined,
      });

    case 'Organization':
    default:
      return prune({
        ...base,
        name: input.name,
        description: input.description,
        url: input.url,
        logo: facts.logo,
        sameAs: Array.isArray(facts.sameAs) ? facts.sameAs : undefined,
        contactPoint: facts.telephone
          ? { '@type': 'ContactPoint', telephone: facts.telephone, contactType: 'customer support', areaServed: 'BG', availableLanguage: ['Bulgarian'] }
          : undefined,
        address: facts.streetAddress
          ? {
              '@type': 'PostalAddress',
              streetAddress: facts.streetAddress,
              addressLocality: facts.addressLocality,
              addressCountry: facts.addressCountry ?? 'BG',
            }
          : undefined,
      });
  }
}

/** Проверката, която прави разликата между „валидно“ и „приема се“. */
export function validateSchemaObject(schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const type = schema['@type'];
  if (!schema['@context']) problems.push('Липсва @context.');
  if (!type) problems.push('Липсва @type.');

  if (type === 'FAQPage') {
    const entities = schema.mainEntity;
    if (!Array.isArray(entities) || entities.length === 0) problems.push('FAQPage без въпроси не се приема.');
    else if (entities.length < 2) problems.push('Само един въпрос — добави поне два, за да има смисъл.');
  }
  if (type === 'Product') {
    if (!schema.name) problems.push('Product без name.');
    const offers = schema.offers as Record<string, unknown> | undefined;
    if (offers && !offers.priceCurrency) problems.push('Offer без priceCurrency — Google отхвърля цената.');
  }
  if (type === 'Article') {
    if (!schema.headline) problems.push('Article без headline.');
    if (!schema.datePublished) problems.push('Article без datePublished — AI моделите предпочитат датирани източници.');
    if (!schema.author) problems.push('Article без author — липсва сигнал за авторитет.');
  }
  return problems;
}

/** Готов за поставяне блок. */
export function schemaScriptTag(schema: Record<string, unknown>): string {
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

/**
 * Извлича FAQ двойките от текста на страница с модел.
 *
 * Тук моделът е на място: „кои са въпросите и отговорите в този текст“ е
 * четене, не изчисление.
 */
export async function extractFaqPairs(
  env: Env,
  input: { text: string; topic?: string; count?: number },
): Promise<{ question: string; answer: string }[]> {
  const count = Math.max(2, Math.min(input.count ?? 6, 12));
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'Ти си редактор на български. Връщаш само JSON, без обяснения и без код блокове.',
    },
    {
      role: 'user',
      content:
        `Тема: ${input.topic ?? 'страницата по-долу'}.\n\n` +
        `Текст:\n"""${input.text.slice(0, 6000)}"""\n\n` +
        `Извлечи или формулирай ${count} двойки въпрос/отговор на български, които реален клиент би задал. ` +
        'Отговорите да са пълни изречения от 2 до 4 реда, самостоятелно разбираеми (AI моделите ги цитират извадени от контекст).\n' +
        'Формат: [{"question": "...", "answer": "..."}]',
    },
  ];

  const result = await runChat(env, messages, { maxTokens: 1600, temperature: 0.4 });
  const parsed = parseJsonFromModel<{ question?: string; answer?: string }[]>(result.text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => typeof item?.question === 'string' && typeof item?.answer === 'string')
    .map((item) => ({ question: item.question!.trim(), answer: item.answer!.trim() }))
    .filter((item) => item.question.length > 5 && item.answer.length > 15)
    .slice(0, count);
}

/* ---------------------------------------------------------------- */
/* llms.txt                                                          */
/* ---------------------------------------------------------------- */

export interface LlmsTxtInput {
  domain: string;
  siteName: string;
  summary: string;
  sections: { title: string; links: { title: string; url: string; note?: string }[] }[];
  contact?: string;
}

/**
 * `/llms.txt` по конвенцията на llmstxt.org: заглавие, кратко резюме в блок
 * цитат, после раздели със списъци от връзки. Форматът е markdown нарочно —
 * четлив е и за човек, и за модел, и не иска парсер.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const lines: string[] = [`# ${input.siteName}`, ''];
  if (input.summary) lines.push(`> ${input.summary.replace(/\n+/g, ' ').trim()}`, '');

  for (const section of input.sections) {
    if (section.links.length === 0) continue;
    lines.push(`## ${section.title}`, '');
    for (const link of section.links) {
      lines.push(`- [${link.title}](${link.url})${link.note ? `: ${link.note}` : ''}`);
    }
    lines.push('');
  }

  if (input.contact) lines.push('## Контакт', '', input.contact, '');
  lines.push(`<!-- Генерирано от SEO Bot за ${input.domain} -->`);
  return lines.join('\n');
}

/**
 * `robots.txt` блок, който пуска AI ботовете.
 *
 * Изписваме ги поименно с `Allow: /`, вместо да разчитаме на липсата на
 * забрана: масовият шаблон в WordPress приставките е `User-agent: *` с
 * `Disallow: /wp-`, а някои сайтове наследяват `Disallow: /` от staging и
 * никой не забелязва, докато не спре трафикът.
 */
export const AI_CRAWLER_ALLOWLIST = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'Bingbot',
  'CCBot',
  'meta-externalagent',
];

export function buildRobotsAllowBlock(sitemapUrl?: string): string {
  const blocks = AI_CRAWLER_ALLOWLIST.map((agent) => `User-agent: ${agent}\nAllow: /`);
  const lines = ['# Достъп за AI ботовете — добавено от SEO Bot', '', ...blocks];
  if (sitemapUrl) lines.push('', `Sitemap: ${sitemapUrl}`);
  return lines.join('\n\n');
}

/* ---------------------------------------------------------------- */
/* Задание за съдържание                                             */
/* ---------------------------------------------------------------- */

export interface ContentBrief {
  title: string;
  /** Първите 60 думи — частта, която моделите цитират дословно. */
  answerFirst: string;
  outline: { heading: string; points: string[] }[];
  faq: { question: string; answer: string }[];
  entities: string[];
  wordCount: number;
  schemaTypes: string[];
  notes: string[];
}

const BRIEF_SYSTEM =
  'Ти си редактор, който пише за български пазар и оптимизира едновременно за Google и за ' +
  'генеративните двигатели (GEO). Правилата ти:\n' +
  '1. Отговорът на въпроса стои в първите 60 думи — това е частта, която моделите цитират.\n' +
  '2. Сравнителните таблици и списъците се цитират по-често от параграфите.\n' +
  '3. Всяка секция трябва да е разбираема сама по себе си, извадена от контекст.\n' +
  '4. Конкретни числа, дати и имена бият общите приказки.\n' +
  'Връщаш само JSON, без обяснения и без код блокове.';

export async function buildContentBrief(
  env: Env,
  input: { topic: string; domain?: string; audience?: string; keywords?: string[] },
): Promise<ContentBrief | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: BRIEF_SYSTEM },
    {
      role: 'user',
      content:
        `Тема: ${input.topic}\n` +
        `Сайт: ${input.domain ?? 'не е посочен'}\n` +
        `Аудитория: ${input.audience ?? 'български клиенти, които избират доставчик'}\n` +
        `Ключови думи: ${(input.keywords ?? []).join(', ') || 'изведи ги сам от темата'}\n\n` +
        'Върни задание за статия на български в този формат:\n' +
        '{"title":"...","answerFirst":"...(60 думи)","outline":[{"heading":"H2","points":["..."]}],' +
        '"faq":[{"question":"...","answer":"..."}],"entities":["марки, стандарти, места"],' +
        '"wordCount":1400,"schemaTypes":["Article","FAQPage"],"notes":["какво да не се пропуска"]}',
    },
  ];

  const result = await runChat(env, messages, { maxTokens: 2500, temperature: 0.5 });
  const parsed = parseJsonFromModel<ContentBrief>(result.text);
  if (!parsed || typeof parsed.title !== 'string') return null;

  return {
    title: parsed.title,
    answerFirst: typeof parsed.answerFirst === 'string' ? parsed.answerFirst : '',
    outline: Array.isArray(parsed.outline)
      ? parsed.outline
          .filter((section) => typeof section?.heading === 'string')
          .map((section) => ({
            heading: section.heading,
            points: Array.isArray(section.points) ? section.points.filter((p): p is string => typeof p === 'string') : [],
          }))
      : [],
    faq: Array.isArray(parsed.faq)
      ? parsed.faq.filter((item) => typeof item?.question === 'string' && typeof item?.answer === 'string')
      : [],
    entities: Array.isArray(parsed.entities) ? parsed.entities.filter((e): e is string => typeof e === 'string') : [],
    wordCount: Number.isFinite(parsed.wordCount) ? Number(parsed.wordCount) : 1200,
    schemaTypes: Array.isArray(parsed.schemaTypes)
      ? parsed.schemaTypes.filter((s): s is string => typeof s === 'string')
      : ['Article'],
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

/** Идеи за ключови думи/въпроси около една тема, групирани по намерение. */
export async function keywordIdeas(
  env: Env,
  input: { seed: string; count?: number },
): Promise<{ intent: string; keywords: string[] }[]> {
  const count = Math.max(10, Math.min(input.count ?? 30, 60));
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Ти си SEO стратег за български пазар. Връщаш само JSON.' },
    {
      role: 'user',
      content:
        `Основна тема: „${input.seed}“.\n` +
        `Върни около ${count} български ключови думи и въпроса, групирани по намерение.\n` +
        'Формат: [{"intent":"информационно|сравнително|транзакционно|локално","keywords":["...","..."]}]',
    },
  ];

  const result = await runChat(env, messages, { model: fastModel(env), maxTokens: 1400, temperature: 0.6 });
  const parsed = parseJsonFromModel<{ intent?: string; keywords?: unknown }[]>(result.text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((group) => typeof group?.intent === 'string' && Array.isArray(group.keywords))
    .map((group) => ({
      intent: group.intent!,
      keywords: (group.keywords as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 30),
    }));
}
