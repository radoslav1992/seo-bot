/**
 * Google Search Console и Google Analytics 4.
 *
 * Това е другата половина на измерването: анализаторът вижда сайта отвън,
 * а GSC и GA4 показват какво реално се е случило — по кои заявки идват хора,
 * на коя позиция, и какво правят после. Ботът ползва и двете, защото съвет
 * върху предположение не струва нищо.
 *
 * Потокът е OAuth 2.0 с `access_type=offline`: пазим само refresh токена
 * (шифрован) и вадим кратък access токен при всяка заявка.
 */

import { decryptSecret, encryptSecret, randomId } from './auth';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * Обхватите. Само за четене — приложението няма причина да пише нищо в чужд имот.
 *
 * Analytics НЕ е включен по подразбиране и това не е пестеливост, а условие за
 * пускане: `analytics.readonly` е „чувствителен“ обхват и до одобрение от Google
 * приложението може да свърже най-много 100 изрично изброени тестови акаунта.
 * `webmasters.readonly` не е чувствителен, тоест със Search Console клиентите са
 * неограничени от първия ден.
 *
 * Analytics се включва с `GOOGLE_ENABLE_ANALYTICS=1`, след като проверката мине.
 * Виж docs/deploy.md → „Кой може да свърже акаунта си“.
 */
const SCOPE_SEARCH_CONSOLE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SCOPE_ANALYTICS = 'https://www.googleapis.com/auth/analytics.readonly';

export function analyticsEnabled(env: Env): boolean {
  return env.GOOGLE_ENABLE_ANALYTICS === '1' || env.GOOGLE_ENABLE_ANALYTICS === 'true';
}

export function googleScopes(env: Env): string {
  return [
    SCOPE_SEARCH_CONSOLE,
    ...(analyticsEnabled(env) ? [SCOPE_ANALYTICS] : []),
    'openid',
    'email',
  ].join(' ');
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(env: Env, requestUrl: string): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const base = env.PUBLIC_SITE_URL || new URL(requestUrl).origin;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${base.replace(/\/$/, '')}/api/google/callback`,
  };
}

export function authorizeUrl(config: GoogleConfig, state: string, scopes: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes,
    // Без `offline` Google не дава refresh токен и връзката умира след час.
    access_type: 'offline',
    // Без `consent` Google връща refresh токен САМО първия път — при повторно
    // свързване (нов домейн, изтрит токен) идва отговор без него и връзката
    // мълчаливо не се възстановява.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(config: GoogleConfig, code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(config: GoogleConfig, refreshToken: string): Promise<string | null> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as TokenResponse;
  return data.access_token ?? null;
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return '';
    const data = (await res.json()) as { email?: string };
    return data.email ?? '';
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------- */
/* Съхранение на връзката                                            */
/* ---------------------------------------------------------------- */

interface GoogleAccountRow {
  id: string;
  user_id: string;
  email: string;
  refresh_token_enc: string;
  scopes: string;
  created_utc: number;
}

export async function saveGoogleAccount(
  db: D1Database,
  encKey: string,
  userId: string,
  refreshToken: string,
  email: string,
  scopes: string,
): Promise<void> {
  const encrypted = await encryptSecret(refreshToken, encKey);
  const now = Date.now();
  // Един акаунт на потребител: повторното свързване подменя, а не добавя.
  await db
    .prepare(
      `INSERT INTO google_accounts (id, user_id, email, refresh_token_enc, scopes, created_utc)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email = excluded.email,
         refresh_token_enc = excluded.refresh_token_enc,
         scopes = excluded.scopes,
         created_utc = excluded.created_utc`,
    )
    .bind(randomId(), userId, email, encrypted, scopes, now)
    .run();
}

export async function googleAccountEmail(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT email FROM google_accounts WHERE user_id = ?')
    .bind(userId)
    .first<{ email: string }>();
  return row?.email ?? null;
}

export async function disconnectGoogle(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM google_accounts WHERE user_id = ?').bind(userId).run();
}

/** Access токен за текущия потребител, или `null` ако няма връзка. */
export async function accessTokenFor(
  db: D1Database,
  env: Env,
  requestUrl: string,
  userId: string,
): Promise<string | null> {
  const config = googleConfig(env, requestUrl);
  if (!config || !env.TOKEN_ENC_KEY) return null;

  const row = await db
    .prepare('SELECT * FROM google_accounts WHERE user_id = ?')
    .bind(userId)
    .first<GoogleAccountRow>();
  if (!row) return null;

  const refreshToken = await decryptSecret(row.refresh_token_enc, env.TOKEN_ENC_KEY);
  if (!refreshToken) return null;
  return refreshAccessToken(config, refreshToken);
}

/* ---------------------------------------------------------------- */
/* Search Console                                                    */
/* ---------------------------------------------------------------- */

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function gscListSites(accessToken: string): Promise<GscSite[]> {
  const res = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { siteEntry?: GscSite[] };
  return data.siteEntry ?? [];
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryOptions {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: ('query' | 'page' | 'country' | 'device' | 'date')[];
  rowLimit?: number;
  /** Филтър по съдържание на заявката — за „как се движи този клъстер“. */
  queryContains?: string;
}

export async function gscSearchAnalytics(accessToken: string, options: GscQueryOptions): Promise<GscRow[]> {
  const body: Record<string, unknown> = {
    startDate: options.startDate,
    endDate: options.endDate,
    dimensions: options.dimensions ?? ['query'],
    rowLimit: Math.min(options.rowLimit ?? 25, 500),
  };
  if (options.queryContains) {
    body.dimensionFilterGroups = [
      { filters: [{ dimension: 'query', operator: 'contains', expression: options.queryContains }] },
    ];
  }

  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(options.siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`Search Console върна ${res.status}.`);
  const data = (await res.json()) as { rows?: GscRow[] };
  return data.rows ?? [];
}

/**
 * Кой имот в Search Console отговаря на следения домейн.
 *
 * Прави разликата между „свързах Google“ и „работи“: без това потребителят
 * трябва да избере имот от падащо меню, а повечето хора не знаят разликата
 * между `sc-domain:` и адрес с префикс, нито че `https://` и `https://www.`
 * са два различни имота.
 *
 * Редът е по надеждност: имотът за целия домейн покрива и поддомейни, и двата
 * протокола, затова се предпочита пред префиксните.
 */
export function matchSiteForDomain(sites: GscSite[], domain: string): string | null {
  const bare = domain.toLowerCase().replace(/^www\./, '');
  const candidates = [
    `sc-domain:${bare}`,
    `https://${bare}/`,
    `https://www.${bare}/`,
    `http://${bare}/`,
    `http://www.${bare}/`,
  ];

  const owned = sites.filter((site) => site.permissionLevel !== 'siteUnverifiedUser');
  for (const candidate of candidates) {
    const hit = owned.find((site) => site.siteUrl.toLowerCase() === candidate);
    if (hit) return hit.siteUrl;
  }

  // Последен опит: имот, чийто хост съвпада, дори форматът да е различен.
  const loose = owned.find((site) => {
    const raw = site.siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return raw.toLowerCase().replace(/^www\./, '') === bare;
  });
  return loose?.siteUrl ?? null;
}

/* ---------------------------------------------------------------- */
/* Сравнение на два периода                                          */
/* ---------------------------------------------------------------- */

export interface GscDelta {
  key: string;
  clicks: number;
  clicksPrev: number;
  clicksDelta: number;
  impressions: number;
  impressionsPrev: number;
  ctr: number;
  position: number;
  positionPrev: number;
  /** Положително = изкачване (по-малък номер на позиция). */
  positionDelta: number;
  /** Появила се, изчезнала или присъстваща и в двата периода. */
  state: 'new' | 'lost' | 'both';
}

/**
 * Search Console изостава с 2–3 дни. Заявка „до вчера“ връща празни редове и
 * това изглежда като срив, какъвто няма.
 */
const GSC_LAG_DAYS = 3;

/**
 * Двата периода един до друг — това, което отговаря на „какво се промени“.
 *
 * Прави се тук, а не в модела: разликата между две числа е аритметика и
 * трябва да дава един и същ отговор при всяко питане. Моделът получава готови
 * разлики и обяснява защо, вместо да ги смята.
 */
export async function gscCompare(
  accessToken: string,
  options: { siteUrl: string; dimension: 'query' | 'page' | 'country' | 'device'; days: number; rowLimit?: number },
): Promise<{ current: GscRow[]; previous: GscRow[]; deltas: GscDelta[]; period: { from: string; to: string; prevFrom: string; prevTo: string } }> {
  const days = Math.max(1, Math.min(options.days, 240));
  const period = {
    to: daysAgo(GSC_LAG_DAYS),
    from: daysAgo(GSC_LAG_DAYS + days - 1),
    prevTo: daysAgo(GSC_LAG_DAYS + days),
    prevFrom: daysAgo(GSC_LAG_DAYS + 2 * days - 1),
  };
  const rowLimit = Math.min(options.rowLimit ?? 200, 500);

  const [current, previous] = await Promise.all([
    gscSearchAnalytics(accessToken, {
      siteUrl: options.siteUrl, startDate: period.from, endDate: period.to,
      dimensions: [options.dimension], rowLimit,
    }),
    gscSearchAnalytics(accessToken, {
      siteUrl: options.siteUrl, startDate: period.prevFrom, endDate: period.prevTo,
      dimensions: [options.dimension], rowLimit,
    }),
  ]);

  const before = new Map(previous.map((row) => [row.keys.join(' / '), row]));
  const deltas: GscDelta[] = [];

  for (const row of current) {
    const key = row.keys.join(' / ');
    const old = before.get(key);
    before.delete(key);
    deltas.push({
      key,
      clicks: row.clicks,
      clicksPrev: old?.clicks ?? 0,
      clicksDelta: row.clicks - (old?.clicks ?? 0),
      impressions: row.impressions,
      impressionsPrev: old?.impressions ?? 0,
      ctr: row.ctr,
      position: row.position,
      positionPrev: old?.position ?? 0,
      // Позицията е „колкото по-малка, толкова по-добре“, затова знакът се обръща.
      positionDelta: old ? old.position - row.position : 0,
      state: old ? 'both' : 'new',
    });
  }

  // Каквото е останало в `before`, го е имало преди, а сега го няма — това е
  // най-важната половина на въпроса „какво паднахме“ и лесно се изпуска.
  for (const [key, old] of before) {
    deltas.push({
      key,
      clicks: 0, clicksPrev: old.clicks, clicksDelta: -old.clicks,
      impressions: 0, impressionsPrev: old.impressions,
      ctr: 0, position: 0, positionPrev: old.position, positionDelta: 0,
      state: 'lost',
    });
  }

  return { current, previous, deltas, period };
}

export interface UrlInspection {
  verdict: string;
  coverageState: string;
  indexingState: string;
  lastCrawlTime: string | null;
  robotsTxtState: string;
  pageFetchState: string;
  richResults: string[];
  mobileVerdict: string | null;
}

export async function gscInspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<UrlInspection | null> {
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'bg' }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    inspectionResult?: {
      indexStatusResult?: Record<string, unknown>;
      richResultsResult?: { detectedItems?: { richResultType?: string }[] };
      mobileUsabilityResult?: { verdict?: string };
    };
  };
  const status = data.inspectionResult?.indexStatusResult;
  if (!status) return null;

  return {
    verdict: String(status.verdict ?? 'VERDICT_UNSPECIFIED'),
    coverageState: String(status.coverageState ?? ''),
    indexingState: String(status.indexingState ?? ''),
    lastCrawlTime: typeof status.lastCrawlTime === 'string' ? status.lastCrawlTime : null,
    robotsTxtState: String(status.robotsTxtState ?? ''),
    pageFetchState: String(status.pageFetchState ?? ''),
    richResults: (data.inspectionResult?.richResultsResult?.detectedItems ?? [])
      .map((item) => item.richResultType ?? '')
      .filter(Boolean),
    mobileVerdict: data.inspectionResult?.mobileUsabilityResult?.verdict ?? null,
  };
}

/* ---------------------------------------------------------------- */
/* Analytics 4                                                       */
/* ---------------------------------------------------------------- */

export interface Ga4Property {
  name: string;      // `properties/123456789`
  displayName: string;
}

export async function ga4ListProperties(accessToken: string): Promise<Ga4Property[]> {
  // Admin API иска филтър — списъкът минава през сметките, до които акаунтът
  // има достъп.
  const accountsRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!accountsRes.ok) return [];
  const accounts = (await accountsRes.json()) as { accounts?: { name: string }[] };

  const properties: Ga4Property[] = [];
  for (const account of (accounts.accounts ?? []).slice(0, 10)) {
    const res = await fetch(
      `https://analyticsadmin.googleapis.com/v1beta/properties?filter=${encodeURIComponent(`parent:${account.name}`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { properties?: Ga4Property[] };
    properties.push(...(data.properties ?? []));
  }
  return properties;
}

export interface Ga4ReportRow {
  dimensions: string[];
  metrics: number[];
}

export interface Ga4Report {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Ga4ReportRow[];
  totals: number[];
}

export async function ga4RunReport(
  accessToken: string,
  property: string,
  options: {
    startDate: string;
    endDate: string;
    dimensions?: string[];
    metrics?: string[];
    limit?: number;
  },
): Promise<Ga4Report | null> {
  const propertyId = property.startsWith('properties/') ? property : `properties/${property}`;
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
      dimensions: (options.dimensions ?? ['sessionDefaultChannelGroup']).map((name) => ({ name })),
      metrics: (options.metrics ?? ['sessions', 'totalUsers', 'engagementRate']).map((name) => ({ name })),
      limit: String(Math.min(options.limit ?? 25, 250)),
      metricAggregations: ['TOTAL'],
    }),
  });
  if (!res.ok) throw new Error(`Analytics върна ${res.status}.`);

  const data = (await res.json()) as {
    dimensionHeaders?: { name: string }[];
    metricHeaders?: { name: string }[];
    rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
    totals?: { metricValues?: { value: string }[] }[];
  };

  return {
    dimensionHeaders: (data.dimensionHeaders ?? []).map((h) => h.name),
    metricHeaders: (data.metricHeaders ?? []).map((h) => h.name),
    rows: (data.rows ?? []).map((row) => ({
      dimensions: (row.dimensionValues ?? []).map((v) => v.value),
      metrics: (row.metricValues ?? []).map((v) => Number(v.value) || 0),
    })),
    totals: (data.totals?.[0]?.metricValues ?? []).map((v) => Number(v.value) || 0),
  };
}

/**
 * Кой е трафикът от AI двигателите.
 *
 * GA4 още няма собствена група за него, затова се разпознава по източника:
 * chatgpt.com, perplexity.ai, gemini.google.com и copilot. Това е груба
 * мярка — част от посещенията идват без referrer — но е единствената, която
 * не иска промяна по сайта.
 */
export const AI_REFERRER_PATTERNS = ['chatgpt', 'openai', 'perplexity', 'gemini', 'claude', 'copilot', 'bard'];

export async function ga4AiTraffic(
  accessToken: string,
  property: string,
  startDate: string,
  endDate: string,
): Promise<{ source: string; sessions: number; users: number }[]> {
  const report = await ga4RunReport(accessToken, property, {
    startDate,
    endDate,
    dimensions: ['sessionSource'],
    metrics: ['sessions', 'totalUsers'],
    limit: 250,
  });
  if (!report) return [];

  return report.rows
    .filter((row) => {
      const source = (row.dimensions[0] ?? '').toLowerCase();
      return AI_REFERRER_PATTERNS.some((pattern) => source.includes(pattern));
    })
    .map((row) => ({ source: row.dimensions[0] ?? '', sessions: row.metrics[0] ?? 0, users: row.metrics[1] ?? 0 }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** `YYYY-MM-DD` отпреди N дни — форматът, който и двете API-та искат. */
export function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
