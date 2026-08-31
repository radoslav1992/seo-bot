/**
 * Числата на таблото.
 *
 * Всичко тук се пресмята при четене от суровите редове в `visibility_checks`
 * и `audits`. Пазенето на готов резултат би било по-бързо, но прави
 * невъзможен въпроса „кои точно заявки паднаха“ — а той е целият продукт.
 */

import { availableEngines, engineLabel, engines, mayGround, type EngineId } from './visibility';
import {
  latestAudit, listChats, listCompetitors, listTasks, primaryDomain, visibilitySince,
  type ChatRow, type DomainRow, type TaskRow,
} from './db';
import type { CrawlResult } from './analyzer';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EngineScore {
  id: EngineId;
  label: string;
  score: number;
  asked: number;
  grounded: boolean;
}

export interface QueryRow {
  query: string;
  mentioned: boolean;
  engines: string[];
  position: number | null;
  change: number | null;
}

export interface SeriesPoint {
  day: number;
  score: number;
}

export interface DashboardData {
  domain: DomainRow | null;
  competitors: string[];
  periodDays: number;
  /**
   * Видимостта: 0–100 по двигателите С ЖИВО ТЪРСЕНЕ. `null`, ако такъв
   * двигател още не е питан — тогава няма измерена видимост и таблото го
   * казва вместо да покаже число, което значи друго.
   */
  score: number | null;
  /** Отделно число: какво знаят моделите наизуст, без търсене. */
  memoryScore: number | null;
  /**
   * Има ли двигател с търсене, който МОЖЕ да се пусне сега.
   *
   * Нарочно не е „настроен ли е“: настроен двигател без токен за Gateway е
   * същото като липсващ, а разликата се вижда само в „Провери моделите“.
   * Таблото трябва да предупреди в двата случая.
   */
  hasGroundedEngine: boolean;
  /** Разлика спрямо първата половина на периода. `null` при малко данни. */
  change: number | null;
  engines: EngineScore[];
  series: SeriesPoint[];
  queries: QueryRow[];
  totalQueries: number;
  /** Кой излиза вместо теб — от самите отговори, не от предположение. */
  rivals: { domain: string; mentions: number; share: number }[];
  audit: {
    techScore: number;
    pagesCrawled: number;
    criticalIssues: number;
    schemaCoverage: number;
    geoScore: number;
    at: number;
    truncated: boolean;
  } | null;
  tasks: TaskRow[];
  chats: (ChatRow & { messages: number })[];
  /** Колко двигателя са настроени — за да каже таблото по колко се мери. */
  configuredEngines: number;
}

/**
 * Настроен ли е изобщо двигател, от който да се очаква измерена видимост.
 *
 * „Може да се пусне“, не „е минал“: дали търсенето наистина се е случило се
 * знае едва от отговора. Тук се лови само по-грубият случай — че такъв
 * двигател не е и поискан.
 */
function usableGrounded(env: Env): boolean {
  const ready = new Set(availableEngines(env));
  return engines(env).some((engine) => mayGround(engine) && ready.has(engine.id));
}

/** Броят дни е избор на потребителя, но не произволен — таблото има три копчета. */
export function normalizePeriod(raw: string | null): number {
  const value = Number(raw);
  return value === 7 || value === 90 ? value : 30;
}

export async function loadDashboard(
  env: Env,
  db: D1Database,
  userId: string,
  periodDays: number,
): Promise<DashboardData> {
  const domain = await primaryDomain(db, userId);
  const [tasks, chats] = await Promise.all([listTasks(db, userId, 8), listChats(db, userId, 6)]);

  if (!domain) {
    return {
      domain: null, competitors: [], periodDays, score: null, memoryScore: null, change: null, engines: [],
      series: [], queries: [], totalQueries: 0, rivals: [], audit: null, tasks, chats,
      configuredEngines: engines(env).length,
      hasGroundedEngine: usableGrounded(env),
    };
  }

  const since = Date.now() - periodDays * DAY_MS;
  const [competitors, checks, audit] = await Promise.all([
    listCompetitors(db, domain.id),
    visibilitySince(db, domain.id, since),
    latestAudit(db, domain.id),
  ]);

  const share = (rows: typeof checks): number | null =>
    rows.length ? Math.round((rows.filter((check) => check.mentioned === 1).length / rows.length) * 100) : null;

  const groundedChecks = checks.filter((check) => check.grounded === 1);
  const score = share(groundedChecks);
  const memoryScore = share(checks.filter((check) => check.grounded !== 1));

  // Промяната сравнява двете половини на периода. Изисква по 5 проверки във
  // всяка — под това число разликата е шум и „+11 точки“ би било измислица.
  // Сравнението е само между проверките с търсене — двете числа не се смесват.
  const midpoint = since + (Date.now() - since) / 2;
  const older = groundedChecks.filter((check) => check.created_utc < midpoint);
  const newer = groundedChecks.filter((check) => check.created_utc >= midpoint);
  const change =
    older.length >= 5 && newer.length >= 5
      ? Math.round((newer.filter((c) => c.mentioned === 1).length / newer.length) * 100) -
        Math.round((older.filter((c) => c.mentioned === 1).length / older.length) * 100)
      : null;

  /*
   * Редът се води от ЗАПИСАНИТЕ проверки, не от настроените двигатели.
   * Махнат от конфигурацията двигател има история и тя не бива да изчезва от
   * таблото — иначе смяна на модел изглежда като изтрити измервания.
   */
  const engineIds = [...new Set(checks.map((check) => check.engine))];
  const engineScores: EngineScore[] = engineIds
    .map((id) => {
      const forEngine = checks.filter((check) => check.engine === id);
      return {
        id,
        label: engineLabel(env, id),
        score: Math.round((forEngine.filter((check) => check.mentioned === 1).length / forEngine.length) * 100),
        asked: forEngine.length,
        grounded: forEngine.some((check) => check.grounded === 1),
      };
    })
    .sort((a, b) => b.score - a.score);

  // Редицата за графиката: по един ден, само дните с проверки. Права линия
  // през дни без данни би нарисувала измерване, което не се е случило.
  const byDay = new Map<number, { total: number; hits: number }>();
  for (const check of groundedChecks) {
    const day = Math.floor(check.created_utc / DAY_MS) * DAY_MS;
    const bucket = byDay.get(day) ?? { total: 0, hits: 0 };
    bucket.total += 1;
    if (check.mentioned === 1) bucket.hits += 1;
    byDay.set(day, bucket);
  }
  const series: SeriesPoint[] = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, bucket]) => ({ day, score: Math.round((bucket.hits / bucket.total) * 100) }));

  // Заявките: един ред на въпрос, обобщен по двигатели.
  const byQuery = new Map<string, { mentioned: number; total: number; engines: Set<string>; position: number | null }>();
  for (const check of checks) {
    const entry = byQuery.get(check.query) ?? { mentioned: 0, total: 0, engines: new Set<string>(), position: null };
    entry.total += 1;
    if (check.mentioned === 1) {
      entry.mentioned += 1;
      entry.engines.add(engineLabel(env, check.engine));
      if (check.position !== null && (entry.position === null || check.position < entry.position)) {
        entry.position = check.position;
      }
    }
    byQuery.set(check.query, entry);
  }

  const queries: QueryRow[] = [...byQuery.entries()]
    .map(([query, entry]) => ({
      query,
      mentioned: entry.mentioned > 0,
      engines: [...entry.engines],
      position: entry.position,
      change: null,
    }))
    .sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || a.query.localeCompare(b.query, 'bg'))
    .slice(0, 12);

  const rivalCounts = new Map<string, number>();
  for (const check of checks) {
    for (const rival of check.competitors.split(',').filter(Boolean)) {
      if (rival === domain.domain) continue;
      rivalCounts.set(rival, (rivalCounts.get(rival) ?? 0) + 1);
    }
  }
  const rivals = [...rivalCounts.entries()]
    .map(([name, mentions]) => ({
      domain: name,
      mentions,
      share: checks.length ? Math.round((mentions / checks.length) * 100) : 0,
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 6);

  let auditSummary: DashboardData['audit'] = null;
  if (audit) {
    // Одитът може да е от една страница или от обхождане — записът пази и
    // двете, затова се чете отбранително.
    let crawl: Partial<CrawlResult> = {};
    try {
      const parsed = JSON.parse(audit.result_json) as Record<string, unknown>;
      if (typeof parsed.pagesCrawled === 'number') crawl = parsed as Partial<CrawlResult>;
    } catch {
      /* повреден запис — показваме само колоните от таблицата */
    }
    auditSummary = {
      techScore: crawl.techScore ?? audit.tech_score,
      pagesCrawled: crawl.pagesCrawled ?? 1,
      criticalIssues: crawl.criticalIssues ?? audit.issues,
      schemaCoverage: crawl.schemaCoverage ?? 0,
      geoScore: audit.geo_score,
      at: audit.created_utc,
      truncated: crawl.truncated ?? false,
    };
  }

  return {
    domain, competitors, periodDays, score, memoryScore, change, engines: engineScores, series, queries,
    totalQueries: byQuery.size, rivals, audit: auditSummary, tasks, chats,
    configuredEngines: engines(env).length,
    hasGroundedEngine: usableGrounded(env),
  };
}

/**
 * Пътят на линията в графиката.
 *
 * Пресмята се на сървъра: същите числа дават същата картина при всяко
 * зареждане, а страницата остава разбираема и без JavaScript.
 */
export function polylinePoints(series: SeriesPoint[], width = 640, height = 230): string {
  if (series.length === 0) return '';
  if (series.length === 1) {
    const y = height - (series[0]!.score / 100) * (height - 20);
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  }
  return series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - (point.score / 100) * (height - 20);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function formatDay(day: number): string {
  return new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'short' }).format(new Date(day));
}
