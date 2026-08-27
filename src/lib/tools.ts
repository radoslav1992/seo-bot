/**
 * Инструментите на бота.
 *
 * Чатът без тях е модел, който говори за SEO. С тях е асистент, който гледа
 * твоя сайт, твоя Search Console и твоя Analytics и отговаря с числа оттам.
 * Всеки инструмент връща две неща: кратко резюме за модела и (по избор)
 * структурирани данни, които интерфейсът показва като карта под отговора.
 *
 * Правилата, които държат това честно:
 *  · Инструмент никога не си измисля данни. Няма ли достъп — казва го.
 *  · Всеки инструмент има цена в кредити и тя се удържа ПРЕДИ изпълнението.
 *  · Домейнът идва от акаунта, не от подканата — иначе ботът може да бъде
 *    придуман да обхожда чужд сайт от името на потребителя.
 */

import { analyzeSite, assertSafeRemoteUrl, configureSelfFetch, crawlSite, sanitizeUrl } from './analyzer';
import type { ToolSchema } from './ai';
import {
  addCompetitor, addTask, listCompetitors, listTasks, saveAudit, saveVisibility, spendCredits,
  type DomainRow,
} from './db';
import {
  buildContentBrief, buildLlmsTxt, buildRobotsAllowBlock, buildSchema, extractFaqPairs,
  keywordIdeas, schemaScriptTag, SCHEMA_KINDS, validateSchemaObject, type SchemaKind,
} from './generators';
import {
  accessTokenFor, daysAgo, ga4AiTraffic, ga4ListProperties, ga4RunReport,
  gscInspectUrl, gscListSites, gscSearchAnalytics,
} from './google';
import type { SessionUser } from './auth';
import { availableEngines, runVisibilityCheck, suggestQueries } from './visibility';

export interface ToolContext {
  env: Env;
  db: D1Database;
  user: SessionUser;
  /** Проследяваният домейн. Може да липсва при съвсем нов акаунт. */
  domain: DomainRow | null;
  requestUrl: string;
}

export interface ToolResult {
  /** Това вижда моделът. Кратко, с числа, без украса. */
  summary: string;
  /** Това вижда потребителят като карта под отговора. */
  data?: unknown;
  /** Как се казва картата в интерфейса. */
  kind?: string;
}

export interface ToolDefinition {
  schema: ToolSchema;
  /** Цена в кредити. Проверките, които вървят навън, струват повече. */
  credits: number;
  /** Показва се в интерфейса, докато инструментът работи. */
  running: string;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/* ---------------------------------------------------------------- */
/* Помощници                                                         */
/* ---------------------------------------------------------------- */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class ToolError extends Error {}

/**
 * Адресът, който инструментът ще отвори.
 *
 * `own` значи „домейнът на акаунта“ — при него подканата няма думата. Само
 * инструментите за сравнение приемат чужд адрес и той пак минава през
 * пълната проверка срещу вътрешни мрежи.
 */
async function resolveUrl(context: ToolContext, raw: unknown, mode: 'own' | 'any' = 'own'): Promise<string> {
  const requested = str(raw);
  let candidate: string;

  if (mode === 'own' || !requested) {
    if (!context.domain) throw new ToolError('Няма зададен домейн в акаунта. Добави домейн от таблото.');
    // Подканата може да уточни ПЪТ в собствения домейн, но не и друг хост.
    if (requested && /^\/[^/]/.test(requested)) candidate = `https://${context.domain.domain}${requested}`;
    else if (requested && requested.includes(context.domain.domain)) candidate = requested;
    else candidate = `https://${context.domain.domain}/`;
  } else {
    candidate = requested;
  }

  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  if (!sanitizeUrl(candidate)) throw new ToolError(`Невалиден адрес: ${candidate}`);

  const safe = await assertSafeRemoteUrl(candidate);
  if (!safe) throw new ToolError('Този адрес не е позволен — вътрешни и частни адреси не се анализират.');
  return safe;
}

/** Search Console иска имота такъв, какъвто е записан там. */
function gscSiteFor(domain: DomainRow | null): string | null {
  if (!domain) return null;
  return domain.gsc_site || `sc-domain:${domain.domain}`;
}

async function requireGoogle(context: ToolContext): Promise<string> {
  const token = await accessTokenFor(context.db, context.env, context.requestUrl, context.user.id);
  if (!token) {
    throw new ToolError(
      'Няма връзка с Google. Свържи Search Console и Analytics от таблото → „Свържи Google“, за да мога да чета реални данни.',
    );
  }
  return token;
}

/* ---------------------------------------------------------------- */
/* Инструментите                                                     */
/* ---------------------------------------------------------------- */

export const TOOLS: Record<string, ToolDefinition> = {
  analyze_page: {
    credits: 2,
    running: 'Анализирам страницата…',
    schema: {
      name: 'analyze_page',
      description:
        'Пълен технически и GEO анализ на ЕДНА страница от сайта на потребителя: заглавия, мета данни, ' +
        'schema.org, достъп за AI ботове, llms.txt, скорост, сигурност, достъпност. Ползвай го, когато ' +
        'въпросът е за състоянието на сайта или на конкретна страница.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Път в сайта, например /blog/statia. Празно = началната страница.' },
        },
      },
    },
    async run(args, context) {
      const url = await resolveUrl(context, args.path, 'own');
      const result = await analyzeSite(url);

      if (context.domain) {
        await saveAudit(context.db, context.user.id, context.domain.id, {
          url,
          geoScore: result.geo.score,
          techScore: Math.max(0, 100 - result.seoIssues.issues.length * 8),
          issues: result.seoIssues.issues.length,
          result,
        });
      }

      const blocked = result.geo.aiCrawlers.filter((crawler) => !crawler.allowed).map((c) => c.name);
      const summary = [
        `GEO резултат: ${result.geo.score}/100 (${result.geo.grade}).`,
        `Заглавие: ${result.seo.title ?? 'липсва'} (${result.seo.titleLength} знака).`,
        `Мета описание: ${result.seo.metaDescriptionLength} знака.`,
        `H1: ${result.seo.headingCounts.H1}, H2: ${result.seo.headingCounts.H2}.`,
        `Schema: ${[...result.structuredData.jsonLdTypes, ...result.structuredData.microdataTypes].join(', ') || 'няма'}.`,
        `llms.txt: ${result.geo.llmsTxt ? 'има' : 'няма'}.`,
        blocked.length ? `Блокирани AI ботове: ${blocked.join(', ')}.` : 'Всички AI ботове са допуснати.',
        `Време за отговор: ${result.page.responseTimeMs} ms, HTML ${Math.round(result.pageWeight.totalKB)} KB.`,
        `SEO проблеми: ${result.seoIssues.issues.join(' | ') || 'няма'}.`,
        `GEO сигнали под максимума: ${result.geo.signals.filter((s) => s.points < s.max).map((s) => `${s.label} (${s.points}/${s.max})`).join('; ') || 'няма'}.`,
      ].join('\n');

      return { summary, data: result, kind: 'audit' };
    },
  },

  crawl_site: {
    credits: 8,
    running: 'Обхождам сайта…',
    schema: {
      name: 'crawl_site',
      description:
        'Обхожда много страници от сайта и връща обобщение: технически резултат, дял страници със schema, ' +
        'счупени адреси, дублирани заглавия. Ползвай го за въпроси за целия сайт, а не за една страница.',
      parameters: {
        type: 'object',
        properties: {
          max_pages: { type: 'number', description: 'Колко страници най-много (по подразбиране 25, таван 50).' },
        },
      },
    },
    async run(args, context) {
      const url = await resolveUrl(context, null, 'own');
      const maxPages = Math.max(5, Math.min(num(args.max_pages, 25), 50));
      const result = await crawlSite(url, maxPages);

      const summary = [
        `Обходени: ${result.pagesCrawled} адреса (открити ${result.pagesDiscovered}${result.truncated ? ', спряно на тавана' : ''}).`,
        `Технически резултат: ${result.techScore}/100.`,
        `Страници със schema: ${result.schemaCoverage}%.`,
        `Средно време за отговор: ${result.avgResponseMs} ms.`,
        `Намерени проблеми: ${result.criticalIssues}.`,
        result.brokenPages.length ? `Счупени адреси: ${result.brokenPages.map((p) => `${p.url} (${p.status})`).slice(0, 5).join(', ')}.` : 'Няма счупени адреси.',
        result.duplicateTitles.length ? `Дублирани заглавия: ${result.duplicateTitles.length} групи.` : 'Няма дублирани заглавия.',
        result.missingDescriptions.length ? `Без мета описание: ${result.missingDescriptions.length} страници.` : '',
      ].filter(Boolean).join('\n');

      return { summary, data: result, kind: 'crawl' };
    },
  },

  check_ai_visibility: {
    credits: 10,
    running: 'Питам AI двигателите…',
    schema: {
      name: 'check_ai_visibility',
      description:
        'Задава реални въпроси на AI двигателите и проверява дали брандът на потребителя е споменат в отговора. ' +
        'Това е основната мярка за GEO видимост. Ползвай го при въпроси „как стоим“, „споменават ли ни“, ' +
        '„защо паднахме“.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            description: 'Въпросите за проверка. Празно = ботът ги съставя сам от бранша.',
            items: { type: 'string' },
          },
          count: { type: 'number', description: 'Колко въпроса да състави сам, ако не са подадени (по подразбиране 6).' },
        },
      },
    },
    async run(args, context) {
      if (!context.domain) throw new ToolError('Няма зададен домейн в акаунта. Добави домейн от таблото.');

      const provided = Array.isArray(args.queries)
        ? args.queries.filter((q): q is string => typeof q === 'string').map((q) => q.trim()).filter(Boolean)
        : [];
      const queries = provided.length
        ? provided.slice(0, 12)
        : await suggestQueries(context.env, { domain: context.domain.domain, count: Math.min(num(args.count, 6), 12) });

      if (queries.length === 0) throw new ToolError('Не успях да съставя въпроси за проверка. Дай ми 2–3 конкретни.');

      const engines = availableEngines(context.env);
      const run = await runVisibilityCheck(context.env, {
        domain: context.domain.domain,
        queries,
        engines,
      });

      await saveVisibility(
        context.db,
        context.user.id,
        context.domain.id,
        run.checks.filter((check) => !check.error),
      );

      const missed = run.checks.filter((check) => !check.error && !check.mentioned).map((check) => check.query);
      const summary = [
        `Видимост: ${run.score}% (${run.checks.filter((c) => c.mentioned).length} от ${run.checks.filter((c) => !c.error).length} отговора споменават ${context.domain.domain}).`,
        `По двигател: ${run.byEngine.map((engine) => `${engine.label} ${engine.score}% (${engine.asked} заявки)`).join(', ')}.`,
        run.topCompetitors.length
          ? `Най-често излизат вместо теб: ${run.topCompetitors.slice(0, 5).map((c) => `${c.domain} (${c.mentions})`).join(', ')}.`
          : 'Отговорите не сочат конкретни конкурентни домейни.',
        missed.length ? `Заявки без споменаване: ${missed.slice(0, 6).join(' | ')}.` : 'Брандът е споменат във всички проверени заявки.',
      ].join('\n');

      return { summary, data: run, kind: 'visibility' };
    },
  },

  compare_competitor: {
    credits: 4,
    running: 'Сравнявам с конкурента…',
    schema: {
      name: 'compare_competitor',
      description:
        'Анализира сайта на конкурент и сравнява GEO сигналите му с тези на потребителя: schema, достъп за ' +
        'AI ботове, llms.txt, структура. Ползвай го при въпроси „защо masterhaus.bg е пред нас“.',
      parameters: {
        type: 'object',
        properties: {
          competitor: { type: 'string', description: 'Домейнът на конкурента, например masterhaus.bg.' },
          remember: { type: 'boolean', description: 'Да го запиша ли като следен конкурент.' },
        },
        required: ['competitor'],
      },
    },
    async run(args, context) {
      const competitorUrl = await resolveUrl(context, args.competitor, 'any');
      const ownUrl = context.domain ? await resolveUrl(context, null, 'own') : null;

      const [competitor, own] = await Promise.all([
        analyzeSite(competitorUrl),
        ownUrl ? analyzeSite(ownUrl) : Promise.resolve(null),
      ]);

      if (args.remember === true && context.domain) {
        await addCompetitor(context.db, context.domain.id, new URL(competitorUrl).hostname);
      }

      const gap = own
        ? competitor.geo.signals
            .map((signal, index) => ({ label: signal.label, theirs: signal.points, ours: own.geo.signals[index]?.points ?? 0, max: signal.max }))
            .filter((row) => row.theirs > row.ours)
        : [];

      const summary = [
        `${competitor.domain}: GEO ${competitor.geo.score}/100 (${competitor.geo.grade}).`,
        own ? `${own.domain}: GEO ${own.geo.score}/100 (${own.geo.grade}).` : '',
        `Техните схеми: ${[...competitor.structuredData.jsonLdTypes, ...competitor.structuredData.microdataTypes].join(', ') || 'няма'}.`,
        own ? `Твоите схеми: ${[...own.structuredData.jsonLdTypes, ...own.structuredData.microdataTypes].join(', ') || 'няма'}.` : '',
        `Техен llms.txt: ${competitor.geo.llmsTxt ? 'да' : 'не'}${own ? `; твой: ${own.geo.llmsTxt ? 'да' : 'не'}` : ''}.`,
        `Думи на страницата: ${competitor.content.wordCount}${own ? ` срещу твоите ${own.content.wordCount}` : ''}.`,
        gap.length
          ? `Изпреварват те по: ${gap.map((row) => `${row.label} (${row.theirs}/${row.max} срещу ${row.ours}/${row.max})`).join('; ')}.`
          : 'Няма сигнал, по който да те изпреварват.',
      ].filter(Boolean).join('\n');

      return { summary, data: { competitor, own, gap }, kind: 'comparison' };
    },
  },

  gsc_top_queries: {
    credits: 1,
    running: 'Чета Search Console…',
    schema: {
      name: 'gsc_top_queries',
      description:
        'Реални данни от Google Search Console: по кои заявки сайтът излиза, колко кликове и импресии има и ' +
        'на каква средна позиция. Това са ИСТИНСКИ позиции, не оценка. Ползвай ги, преди да съветваш нещо ' +
        'за ключови думи.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Период назад в дни (по подразбиране 28).' },
          limit: { type: 'number', description: 'Колко реда (по подразбиране 20).' },
          contains: { type: 'string', description: 'Само заявки, съдържащи този текст.' },
          dimension: { type: 'string', description: '"query" (по подразбиране), "page", "country" или "device".' },
        },
      },
    },
    async run(args, context) {
      const token = await requireGoogle(context);
      const site = gscSiteFor(context.domain);
      if (!site) throw new ToolError('Няма зададен домейн в акаунта.');

      const dimension = ['query', 'page', 'country', 'device'].includes(str(args.dimension))
        ? (str(args.dimension) as 'query' | 'page' | 'country' | 'device')
        : 'query';
      const days = Math.max(1, Math.min(num(args.days, 28), 480));

      const rows = await gscSearchAnalytics(token, {
        siteUrl: site,
        // Search Console изостава с 2–3 дни; „до вчера“ връща празни редове и
        // изглежда като спад, какъвто няма.
        startDate: daysAgo(days + 3),
        endDate: daysAgo(3),
        dimensions: [dimension],
        rowLimit: Math.min(num(args.limit, 20), 100),
        queryContains: str(args.contains) || undefined,
      });

      if (rows.length === 0) {
        return { summary: `Search Console не върна данни за ${site} за последните ${days} дни.`, kind: 'gsc' };
      }

      const summary = [
        `Search Console (${site}), последни ${days} дни, по ${dimension}:`,
        ...rows.slice(0, 25).map(
          (row) =>
            `${row.keys.join(' / ')} — ${row.clicks} клика, ${row.impressions} импресии, ` +
            `CTR ${(row.ctr * 100).toFixed(1)}%, позиция ${row.position.toFixed(1)}`,
        ),
      ].join('\n');

      return { summary, data: { site, dimension, days, rows }, kind: 'gsc' };
    },
  },

  gsc_inspect_url: {
    credits: 1,
    running: 'Проверявам индексирането…',
    schema: {
      name: 'gsc_inspect_url',
      description:
        'Проверява в Search Console дали конкретен адрес е индексиран, кога е обходен последно, блокира ли ' +
        'го robots.txt и какви rich results са разпознати.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Път в сайта, например /blog/statia.' } },
      },
    },
    async run(args, context) {
      const token = await requireGoogle(context);
      const site = gscSiteFor(context.domain);
      if (!site) throw new ToolError('Няма зададен домейн в акаунта.');
      const url = await resolveUrl(context, args.path, 'own');

      const result = await gscInspectUrl(token, site, url);
      if (!result) return { summary: `Search Console не върна данни за ${url}.`, kind: 'gsc' };

      const summary = [
        `${url}`,
        `Присъда: ${result.verdict}; покритие: ${result.coverageState}.`,
        `Индексиране: ${result.indexingState}; robots.txt: ${result.robotsTxtState}; изтегляне: ${result.pageFetchState}.`,
        `Последно обхождане: ${result.lastCrawlTime ?? 'няма данни'}.`,
        `Rich results: ${result.richResults.join(', ') || 'няма'}.`,
      ].join('\n');

      return { summary, data: { url, ...result }, kind: 'gsc' };
    },
  },

  gsc_list_sites: {
    credits: 0,
    running: 'Търся имотите в Search Console…',
    schema: {
      name: 'gsc_list_sites',
      description: 'Изброява имотите в Search Console, до които акаунтът има достъп.',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, context) {
      const token = await requireGoogle(context);
      const sites = await gscListSites(token);
      return {
        summary: sites.length
          ? `Достъпни имоти: ${sites.map((site) => `${site.siteUrl} (${site.permissionLevel})`).join(', ')}.`
          : 'Акаунтът няма достъп до имоти в Search Console.',
        data: sites,
        kind: 'gsc',
      };
    },
  },

  ga4_overview: {
    credits: 1,
    running: 'Чета Analytics…',
    schema: {
      name: 'ga4_overview',
      description:
        'Данни от Google Analytics 4: сесии, потребители и ангажираност по канал, страница или източник. ' +
        'Ползвай ги, когато въпросът е за трафик и поведение, а не за позиции.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Период назад в дни (по подразбиране 28).' },
          dimension: {
            type: 'string',
            description: 'GA4 измерение: sessionDefaultChannelGroup (по подразбиране), landingPage, sessionSource, country, deviceCategory.',
          },
          limit: { type: 'number', description: 'Колко реда (по подразбиране 20).' },
        },
      },
    },
    async run(args, context) {
      const token = await requireGoogle(context);
      const property = context.domain?.ga4_property;
      if (!property) {
        throw new ToolError('Домейнът няма свързан GA4 имот. Избери го от таблото → „Свържи Google“.');
      }

      const days = Math.max(1, Math.min(num(args.days, 28), 480));
      const dimension = str(args.dimension) || 'sessionDefaultChannelGroup';
      const report = await ga4RunReport(token, property, {
        startDate: daysAgo(days),
        endDate: 'today',
        dimensions: [dimension],
        metrics: ['sessions', 'totalUsers', 'engagementRate'],
        limit: Math.min(num(args.limit, 20), 100),
      });
      if (!report) return { summary: 'Analytics не върна данни.', kind: 'ga4' };

      const summary = [
        `GA4 (${property}), последни ${days} дни, по ${dimension}:`,
        `Общо: ${report.totals[0] ?? 0} сесии, ${report.totals[1] ?? 0} потребители.`,
        ...report.rows.slice(0, 25).map(
          (row) =>
            `${row.dimensions.join(' / ')} — ${row.metrics[0] ?? 0} сесии, ${row.metrics[1] ?? 0} потребители, ` +
            `ангажираност ${((row.metrics[2] ?? 0) * 100).toFixed(1)}%`,
        ),
      ].join('\n');

      return { summary, data: { property, dimension, days, report }, kind: 'ga4' };
    },
  },

  ga4_ai_traffic: {
    credits: 1,
    running: 'Търся трафика от AI…',
    schema: {
      name: 'ga4_ai_traffic',
      description:
        'Колко посещения идват от AI асистенти (ChatGPT, Perplexity, Gemini, Copilot) според GA4. ' +
        'Това е другата страна на видимостта: споменаването води ли до реални хора на сайта.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Период назад в дни (по подразбиране 28).' } },
      },
    },
    async run(args, context) {
      const token = await requireGoogle(context);
      const property = context.domain?.ga4_property;
      if (!property) throw new ToolError('Домейнът няма свързан GA4 имот. Избери го от таблото.');

      const days = Math.max(1, Math.min(num(args.days, 28), 480));
      const rows = await ga4AiTraffic(token, property, daysAgo(days), 'today');
      const total = rows.reduce((sum, row) => sum + row.sessions, 0);

      const summary = rows.length
        ? [
            `Трафик от AI асистенти за последните ${days} дни: ${total} сесии.`,
            ...rows.slice(0, 12).map((row) => `${row.source} — ${row.sessions} сесии, ${row.users} потребители`),
            'Забележка: част от посещенията от AI идват без източник и не се броят тук.',
          ].join('\n')
        : `GA4 не отчита сесии от разпознати AI източници за последните ${days} дни. ` +
          'Това не значи нула споменавания — значи, че споменаванията не водят кликове или идват без източник.';

      return { summary, data: { property, days, rows, total }, kind: 'ga4' };
    },
  },

  ga4_list_properties: {
    credits: 0,
    running: 'Търся имотите в Analytics…',
    schema: {
      name: 'ga4_list_properties',
      description: 'Изброява GA4 имотите, до които акаунтът има достъп.',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, context) {
      const token = await requireGoogle(context);
      const properties = await ga4ListProperties(token);
      return {
        summary: properties.length
          ? `Достъпни GA4 имоти: ${properties.map((p) => `${p.displayName} (${p.name})`).join(', ')}.`
          : 'Акаунтът няма достъп до GA4 имоти.',
        data: properties,
        kind: 'ga4',
      };
    },
  },

  generate_schema: {
    credits: 2,
    running: 'Съставям schema разметка…',
    schema: {
      name: 'generate_schema',
      description:
        'Съставя валидна schema.org JSON-LD разметка за страница. Скелетът се сглобява от код и се проверява, ' +
        'така че резултатът е за поставяне, не за редактиране. За FAQPage може сам да извлече въпросите от страницата.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: `Тип: ${SCHEMA_KINDS.map((k) => k.id).join(', ')}.`,
          },
          path: { type: 'string', description: 'Път в сайта, за който е разметката.' },
          name: { type: 'string', description: 'Име/заглавие на същността.' },
          description: { type: 'string', description: 'Кратко описание.' },
          facts: { type: 'object', description: 'Допълнителни данни: price, currency, author, telephone, streetAddress…' },
        },
        required: ['kind'],
      },
    },
    async run(args, context) {
      const kind = (SCHEMA_KINDS.find((k) => k.id === str(args.kind))?.id ?? 'Organization') as SchemaKind;
      const url = await resolveUrl(context, args.path, 'own');

      let faq: { question: string; answer: string }[] = [];
      if (kind === 'FAQPage') {
        // Въпросите се вадят от самата страница — измислен FAQ, който не
        // отговаря на видимия текст, е нарушение на правилата на Google.
        const page = await analyzeSite(url).catch(() => null);
        const text = page
          ? page.seo.headings.map((h) => h.text).join('\n') + '\n' + (page.seo.metaDescription ?? '')
          : '';
        faq = await extractFaqPairs(context.env, {
          text: text || str(args.description) || str(args.name),
          topic: str(args.name) || url,
        });
      }

      const facts = (args.facts && typeof args.facts === 'object' ? args.facts : {}) as Record<string, unknown>;
      const schema = buildSchema({
        kind,
        url,
        name: str(args.name) || context.domain?.domain,
        description: str(args.description),
        facts,
        faq,
      });

      const problems = validateSchemaObject(schema);
      const summary = [
        `Готова ${kind} разметка за ${url}.`,
        problems.length ? `Внимание: ${problems.join(' ')}` : 'Проверката мина без забележки.',
        kind === 'FAQPage' ? `Въпроси: ${faq.length}.` : '',
        'Разметката е показана на потребителя за копиране — не я преписвай в отговора.',
      ].filter(Boolean).join('\n');

      return {
        summary,
        data: { kind, url, schema, problems, snippet: schemaScriptTag(schema) },
        kind: 'schema',
      };
    },
  },

  generate_llms_txt: {
    credits: 3,
    running: 'Съставям llms.txt…',
    schema: {
      name: 'generate_llms_txt',
      description:
        'Съставя /llms.txt за сайта — файлът, който насочва AI моделите към важното съдържание — заедно с ' +
        'блок за robots.txt, който пуска AI ботовете поименно.',
      parameters: {
        type: 'object',
        properties: {
          site_name: { type: 'string', description: 'Име на сайта/бранда.' },
          summary: { type: 'string', description: 'Едно изречение какво прави бизнесът.' },
        },
      },
    },
    async run(args, context) {
      const url = await resolveUrl(context, null, 'own');
      const domain = context.domain?.domain ?? new URL(url).hostname;

      // Връзките идват от sitemap-а и от обхождането, не от модела: llms.txt
      // с измислени адреси е по-вреден от липсващ.
      const crawl = await crawlSite(url, 20).catch(() => null);
      const page = await analyzeSite(url).catch(() => null);

      const pages = (crawl?.pages ?? [])
        .filter((entry) => entry.ok && entry.title)
        .sort((a, b) => b.wordCount - a.wordCount)
        .slice(0, 25);

      const blog = pages.filter((entry) => /\/(blog|novini|statii|articles?|news)\//i.test(entry.url));
      const rest = pages.filter((entry) => !blog.includes(entry));

      const llmsTxt = buildLlmsTxt({
        domain,
        siteName: str(args.site_name) || page?.seo.title || domain,
        summary: str(args.summary) || page?.seo.metaDescription || '',
        sections: [
          { title: 'Основни страници', links: rest.slice(0, 15).map((p) => ({ title: p.title ?? p.url, url: p.url })) },
          { title: 'Статии и ръководства', links: blog.slice(0, 15).map((p) => ({ title: p.title ?? p.url, url: p.url })) },
        ],
      });

      const robotsBlock = buildRobotsAllowBlock(`https://${domain}/sitemap.xml`);
      const summary = [
        `Готов /llms.txt за ${domain} с ${pages.length} страници (взети от sitemap/обхождане, не измислени).`,
        page?.geo.llmsTxt ? 'Сайтът вече има llms.txt — този е обновен вариант.' : 'Сайтът още няма llms.txt.',
        'Файлът и блокът за robots.txt са показани на потребителя за копиране — не ги преписвай в отговора.',
      ].join('\n');

      return { summary, data: { domain, llmsTxt, robotsBlock, pages: pages.length }, kind: 'llmstxt' };
    },
  },

  content_brief: {
    credits: 4,
    running: 'Пиша заданието…',
    schema: {
      name: 'content_brief',
      description:
        'Задание за статия, оптимизирано и за Google, и за генеративните двигатели: отговор в първите 60 думи, ' +
        'структура по H2, FAQ, същности за споменаване, препоръчана schema.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Темата на статията.' },
          audience: { type: 'string', description: 'За кого е.' },
          keywords: { type: 'array', description: 'Ключови думи, ако има.', items: { type: 'string' } },
        },
        required: ['topic'],
      },
    },
    async run(args, context) {
      const topic = str(args.topic);
      if (!topic) throw new ToolError('Трябва ми тема за статията.');

      const brief = await buildContentBrief(context.env, {
        topic,
        domain: context.domain?.domain,
        audience: str(args.audience) || undefined,
        keywords: Array.isArray(args.keywords)
          ? args.keywords.filter((k): k is string => typeof k === 'string')
          : undefined,
      });
      if (!brief) throw new ToolError('Не успях да съставя заданието. Опитай с по-конкретна тема.');

      const summary = [
        `Задание: „${brief.title}“, около ${brief.wordCount} думи.`,
        `Секции: ${brief.outline.map((section) => section.heading).join(' | ')}.`,
        `FAQ въпроси: ${brief.faq.length}. Препоръчана schema: ${brief.schemaTypes.join(', ')}.`,
        'Заданието е показано на потребителя като карта — в отговора обобщи накратко и предложи следваща стъпка.',
      ].join('\n');

      return { summary, data: brief, kind: 'brief' };
    },
  },

  keyword_ideas: {
    credits: 2,
    running: 'Търся ключови думи…',
    schema: {
      name: 'keyword_ideas',
      description:
        'Идеи за ключови думи и въпроси около тема, групирани по намерение. Това са ПРЕДЛОЖЕНИЯ без обеми — ' +
        'за реални числа ползвай gsc_top_queries.',
      parameters: {
        type: 'object',
        properties: {
          seed: { type: 'string', description: 'Основната тема.' },
          count: { type: 'number', description: 'Приблизителен брой (по подразбиране 30).' },
        },
        required: ['seed'],
      },
    },
    async run(args, context) {
      const seed = str(args.seed);
      if (!seed) throw new ToolError('Трябва ми основна тема.');
      const groups = await keywordIdeas(context.env, { seed, count: num(args.count, 30) });
      const total = groups.reduce((sum, group) => sum + group.keywords.length, 0);
      return {
        summary: `${total} идеи в ${groups.length} групи по намерение:\n` +
          groups.map((group) => `${group.intent}: ${group.keywords.slice(0, 10).join(', ')}`).join('\n') +
          '\nБез данни за обем — това са предложения, не измерени заявки.',
        data: groups,
        kind: 'keywords',
      };
    },
  },

  suggest_visibility_queries: {
    credits: 1,
    running: 'Съставям въпроси за проверка…',
    schema: {
      name: 'suggest_visibility_queries',
      description:
        'Съставя въпросите, с които да мерим видимостта — естествени изречения, каквито човек задава на AI ' +
        'асистент. Ползвай го преди check_ai_visibility, ако потребителят не е дал свои.',
      parameters: {
        type: 'object',
        properties: {
          industry: { type: 'string', description: 'Бранш, ако е известен.' },
          count: { type: 'number', description: 'Колко въпроса (по подразбиране 8).' },
        },
      },
    },
    async run(args, context) {
      if (!context.domain) throw new ToolError('Няма зададен домейн в акаунта.');
      const queries = await suggestQueries(context.env, {
        domain: context.domain.domain,
        industry: str(args.industry) || undefined,
        count: num(args.count, 8),
      });
      return {
        summary: queries.length ? `Предложени въпроси:\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : 'Не успях да съставя въпроси.',
        data: queries,
        kind: 'queries',
      };
    },
  },

  create_task: {
    credits: 0,
    running: 'Записвам задача…',
    schema: {
      name: 'create_task',
      description:
        'Записва задача в таблото на потребителя. Ползвай го, когато си установил конкретно действие с ' +
        'измеримо влияние — за да не остане съветът само в чата.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Какво да се направи, в повелително наклонение.' },
          detail: { type: 'string', description: 'Защо и как — едно-две изречения.' },
          priority: { type: 'string', description: '"high", "medium" или "low".' },
          impact: { type: 'number', description: 'Очаквани точки видимост, 0–20.' },
        },
        required: ['title'],
      },
    },
    async run(args, context) {
      const title = str(args.title);
      if (!title) throw new ToolError('Задачата трябва да има заглавие.');
      await addTask(context.db, context.user.id, {
        domainId: context.domain?.id ?? null,
        title,
        detail: str(args.detail),
        priority: str(args.priority, 'medium'),
        impact: num(args.impact, 0),
      });
      return { summary: `Задачата „${title}“ е добавена в таблото.`, kind: 'task' };
    },
  },

  list_tasks: {
    credits: 0,
    running: 'Чета задачите…',
    schema: {
      name: 'list_tasks',
      description: 'Отворените задачи на потребителя, подредени по приоритет.',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, context) {
      const tasks = await listTasks(context.db, context.user.id, 20);
      return {
        summary: tasks.length
          ? `Отворени задачи:\n${tasks.map((task) => `[${task.priority}] ${task.title} (+${task.impact} видимост)`).join('\n')}`
          : 'Няма отворени задачи.',
        data: tasks,
        kind: 'tasks',
      };
    },
  },
};

export function toolSchemas(): ToolSchema[] {
  return Object.values(TOOLS).map((tool) => tool.schema);
}

export interface ToolRunLog {
  name: string;
  ok: boolean;
  summary: string;
  data?: unknown;
  kind?: string;
  credits: number;
}

/**
 * Изпълнява един инструмент.
 *
 * Не хвърля: грешката на инструмента е резултат, който моделът трябва да
 * види и да обясни на потребителя („нямам достъп до Search Console“ е
 * отговор, а не срив).
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolRunLog> {
  const tool = TOOLS[name];
  if (!tool) {
    return { name, ok: false, summary: `Няма инструмент на име ${name}.`, credits: 0 };
  }

  // Кредитите се теглят ПРЕДИ работата. Обратното значи, че скъпа проверка,
  // прекъсната по средата, е безплатна — и че лимитът е пожелание.
  if (tool.credits > 0) {
    const paid = await spendCredits(context.db, context.user.id, tool.credits);
    if (!paid) {
      return {
        name,
        ok: false,
        summary: 'Кредитите на потребителя свършиха. Кажи му да добави кредити или да смени плана.',
        credits: 0,
      };
    }
  }

  try {
    const result = await tool.run(args, context);
    return { name, ok: true, summary: result.summary, data: result.data, kind: result.kind, credits: tool.credits };
  } catch (error) {
    const message =
      error instanceof ToolError
        ? error.message
        : error instanceof Error
          ? `Инструментът не успя: ${error.message}`
          : 'Инструментът не успя.';
    return { name, ok: false, summary: message, credits: tool.credits };
  }
}

/** Инструментите нямат достъп до собствения хост на Worker-а без този binding. */
export function prepareToolRuntime(env: Env, requestUrl: string): void {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    const bare = host.replace(/^www\./, '');
    configureSelfFetch([bare, `www.${bare}`], env.ASSETS);
  } catch {
    /* без конфигурация анализът на чужди сайтове работи както обикновено */
  }
}

export { ToolError, listCompetitors };
