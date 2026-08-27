/**
 * Анализатор на сайтове — събира всичко за един URL от страната на сървъра.
 *
 * Пренесен от анализатора на Kova (repo `agency`, `src/lib/analyzer.ts`) и
 * доразвит тук с обхождане на няколко страници (`crawlSite`), защото таблото
 * иска числа за целия сайт, а не за една страница.
 *
 * Използва само Web API (fetch, URL, TextEncoder) и публичния DNS-over-HTTPS
 * на Cloudflare — без Node вградени модули и без външни платени услуги, така
 * че работи еднакво на Cloudflare Worker-а и в `astro dev`.
 */

const FETCH_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 4_000;
const DNS_TIMEOUT_MS = 4_000;
/* Worker-ът има бюджет от 50 подзаявки на безплатния план — пестим ги. */
const MAX_REDIRECT_HOPS = 5;
/** Груба защита на CPU времето — regex анализът спира дотук. */
const MAX_HTML_CHARS = 1_500_000;
const MAX_SITEMAP_URLS = 20;
const MAX_HEADINGS = 40;
const MAX_OUTBOUND_DOMAINS = 30;
const MAX_KEYWORDS = 12;

const USER_AGENT =
  'Mozilla/5.0 (compatible; SeoBotAnalyzer/1.0; +https://seobot.bg/)';

const COMMON_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap-0.xml',
  '/sitemap1.xml',
  '/wp-sitemap.xml',
];

/* ------------------------------------------------------------------ */
/* Fetch, който умее да заявява и собствения хост на Worker-а           */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare блокира `fetch()` от Worker към собствения му хост (заявката би
 * влязла рекурсивно в същия Worker). Затова API маршрутът регистрира тук
 * ASSETS binding-а: заявките към хоста на самия сайт се обслужват директно от
 * статичния билд, а всичко останало минава през обикновен `fetch`.
 * Конфигурацията е еднаква за всички заявки в един Worker, така че
 * module-level състоянието е безопасно при паралелни анализи.
 */
interface SelfAssets {
  fetch(request: Request): Promise<Response>;
}

let selfHosts = new Set<string>();
let selfAssets: SelfAssets | null = null;

export function configureSelfFetch(hosts: string[], assets: SelfAssets | null | undefined): void {
  selfHosts = new Set(hosts.map((host) => host.toLowerCase()));
  selfAssets = assets ?? null;
}

/** За всички HTTP заявки към анализирания сайт — вместо директен `fetch`. */
function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (selfAssets) {
    try {
      if (selfHosts.has(new URL(url).hostname.toLowerCase())) {
        return selfAssets.fetch(new Request(url, init));
      }
    } catch {
      /* невалиден URL — оставяме обикновения fetch да върне грешката */
    }
  }
  return fetch(url, init);
}

/* ------------------------------------------------------------------ */
/* Безопасност на адреса (защита от SSRF)                              */
/* ------------------------------------------------------------------ */

const VALID_HOSTNAME_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.[a-zA-Z0-9-]{1,63})*\.[a-zA-Z]{2,}$/;
const HOSTNAME_BLOCKLIST = new Set(['localhost', 'localhost.localdomain', 'broadcasthost']);

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => acc * 256 + Number(oct), 0);
}

const PRIVATE_IPV4_RANGES: [number, number][] = [
  [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
  [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
  [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
  [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
  [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
  [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
  [ipv4ToInt('192.0.0.0'), ipv4ToInt('192.0.0.255')],
  [ipv4ToInt('192.0.2.0'), ipv4ToInt('192.0.2.255')],
  [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
  [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')],
  [ipv4ToInt('198.51.100.0'), ipv4ToInt('198.51.100.255')],
  [ipv4ToInt('203.0.113.0'), ipv4ToInt('203.0.113.255')],
  [ipv4ToInt('224.0.0.0'), ipv4ToInt('255.255.255.255')],
];

const PRIVATE_IPV6_PREFIXES = ['::', '::1', 'fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'ff'];

export function isPrivateIp(ip: string): boolean {
  const cleaned = ip.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (HOSTNAME_BLOCKLIST.has(cleaned)) return true;

  if (isIpv4(cleaned)) {
    const value = ipv4ToInt(cleaned);
    return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
  }

  if (cleaned.includes(':')) {
    if (cleaned.startsWith('::ffff:')) {
      const mapped = cleaned.slice('::ffff:'.length);
      if (isIpv4(mapped)) return isPrivateIp(mapped);
    }
    return PRIVATE_IPV6_PREFIXES.some((prefix) => cleaned.startsWith(prefix));
  }

  return false;
}

/** Връща каноничния адрес или null, ако е невалиден/вътрешен. */
export function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    if (isIpv4(host) || host.includes(':')) {
      if (isPrivateIp(host)) return null;
    } else if (host.length > 253 || !VALID_HOSTNAME_RE.test(host) || HOSTNAME_BLOCKLIST.has(host)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Проверява и DNS записите на хоста, за да не сочат към вътрешната мрежа
 * (защита срещу DNS rebinding). Връща каноничния адрес или null.
 */
export async function assertSafeRemoteUrl(url: string): Promise<string | null> {
  const safe = sanitizeUrl(url);
  if (!safe) return null;

  const host = new URL(safe).hostname.toLowerCase();
  if (isIpv4(host) || host.includes(':')) return safe;

  const [a, aaaa] = await Promise.all([resolveDns(host, 'A'), resolveDns(host, 'AAAA')]);
  const addresses = [...a, ...aaaa].map((r) => r.data);
  if (addresses.some((addr) => isPrivateIp(addr))) return null;
  return safe;
}

/* ------------------------------------------------------------------ */
/* DNS-over-HTTPS                                                      */
/* ------------------------------------------------------------------ */

export interface DnsRecord {
  name: string;
  data: string;
  ttl?: number;
}

export async function resolveDns(
  name: string,
  type: 'A' | 'AAAA' | 'MX' | 'TXT' | 'NS' | 'CNAME',
): Promise<DnsRecord[]> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { Answer?: { name: string; data: string; TTL?: number }[] };
    return (data.Answer ?? []).map((a) => ({
      name: a.name,
      data: typeof a.data === 'string' ? a.data.replace(/^"|"$/g, '') : String(a.data),
      ttl: a.TTL,
    }));
  } catch {
    return [];
  }
}

export interface DnsInfo {
  a: string[];
  aaaa: string[];
  mx: string[];
  ns: string[];
  txt: string[];
  spf: string | null;
  dmarc: string | null;
}

export async function collectDns(domain: string): Promise<DnsInfo> {
  const [a, aaaa, mx, ns, txt, dmarcTxt] = await Promise.all([
    resolveDns(domain, 'A'),
    resolveDns(domain, 'AAAA'),
    resolveDns(domain, 'MX'),
    resolveDns(domain, 'NS'),
    resolveDns(domain, 'TXT'),
    resolveDns(`_dmarc.${domain}`, 'TXT'),
  ]);

  const txtValues = txt.map((r) => r.data);
  return {
    a: a.map((r) => r.data),
    aaaa: aaaa.map((r) => r.data),
    mx: mx.map((r) => r.data),
    ns: ns.map((r) => r.data),
    txt: txtValues,
    spf: txtValues.find((v) => v.toLowerCase().startsWith('v=spf1')) ?? null,
    dmarc: dmarcTxt.map((r) => r.data).find((v) => v.toLowerCase().startsWith('v=dmarc1')) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Изтегляне на страницата и верига от редиректи                       */
/* ------------------------------------------------------------------ */

export interface PageFetch {
  finalUrl: string;
  status: number;
  ok: boolean;
  responseTimeMs: number;
  htmlBytes: number;
  htmlTruncated: boolean;
  contentType: string | null;
  headers: Record<string, string>;
  setCookies: string[];
  html: string;
}

export async function fetchPage(url: string): Promise<PageFetch> {
  const started = Date.now();
  const res = await httpFetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'bg,en;q=0.8',
    },
  });
  const raw = await res.text();
  const responseTimeMs = Date.now() - started;

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

  return {
    finalUrl: res.url || url,
    status: res.status,
    ok: res.ok,
    responseTimeMs,
    htmlBytes: new TextEncoder().encode(raw).length,
    htmlTruncated: raw.length > MAX_HTML_CHARS,
    contentType: res.headers.get('content-type'),
    headers,
    setCookies,
    html: raw.slice(0, MAX_HTML_CHARS),
  };
}

export interface RedirectHop {
  url: string;
  status: number;
}

export async function followRedirects(url: string): Promise<RedirectHop[]> {
  const chain: RedirectHop[] = [];
  let current: string | null = sanitizeUrl(url);

  for (let i = 0; current && i < MAX_REDIRECT_HOPS; i++) {
    const hopUrl: string = current;
    try {
      const res = await httpFetch(hopUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
      chain.push({ url: hopUrl, status: res.status });
      if (res.status < 300 || res.status >= 400) break;

      const location = res.headers.get('location');
      if (!location) break;
      current = sanitizeUrl(new URL(location, hopUrl).href);
    } catch {
      chain.push({ url: hopUrl, status: 0 });
      break;
    }
  }

  return chain;
}

/* ------------------------------------------------------------------ */
/* SEO одит върху HTML                                                 */
/* ------------------------------------------------------------------ */

export interface SeoAudit {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  lang: string | null;
  charset: string | null;
  viewport: boolean;
  favicon: boolean;
  metaRobots: string | null;
  noindex: boolean;
  nofollow: boolean;
  generator: string | null;
  hreflangCount: number;
  headings: { tag: string; text: string }[];
  headingCounts: Record<string, number>;
  imagesTotal: number;
  imagesMissingAlt: number;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
}

export function auditSeo(html: string): SeoAudit {
  const headings: SeoAudit['headings'] = [];
  const headingCounts: Record<string, number> = { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 };
  const headingRegex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html)) !== null) {
    const tag = match[1].toUpperCase();
    headingCounts[tag] += 1;
    if (headings.length < MAX_HEADINGS) {
      headings.push({ tag, text: match[2].replace(/<[^>]*>/g, '').trim().slice(0, 120) });
    }
  }

  const imgs = html.match(/<img[^>]*>/gi) ?? [];
  const imagesMissingAlt = imgs.filter((i) => !/alt=/i.test(i) || /alt=["']\s*["']/i.test(i)).length;

  const ogTags: Record<string, string> = {};
  const ogRegex = /<meta[^>]+property=["']og:([^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  while ((match = ogRegex.exec(html)) !== null) ogTags[match[1]] = match[2];

  const twitterTags: Record<string, string> = {};
  const twRegex = /<meta[^>]+name=["']twitter:([^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  while ((match = twRegex.exec(html)) !== null) twitterTags[match[1]] = match[2];

  const first = (re: RegExp): string | null => html.match(re)?.[1]?.trim() ?? null;

  const title = first(/<title[^>]*>([\s\S]*?)<\/title>/i)?.replace(/\s+/g, ' ') ?? null;
  const metaDescription = first(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const metaRobots = first(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);

  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    canonical: first(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
    lang: first(/<html[^>]+lang=["']([^"']*)["']/i),
    charset: first(/<meta[^>]+charset=["']?([^"'\s/>]+)/i),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    favicon: /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html),
    metaRobots,
    noindex: !!metaRobots && /\bnoindex\b/i.test(metaRobots),
    nofollow: !!metaRobots && /\bnofollow\b/i.test(metaRobots),
    generator: first(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']*)["']/i),
    hreflangCount: (html.match(/<link[^>]+hreflang=["'][^"']+["']/gi) ?? []).length,
    headings,
    headingCounts,
    imagesTotal: imgs.length,
    imagesMissingAlt,
    ogTags,
    twitterTags,
  };
}

/* ------------------------------------------------------------------ */
/* Съдържание и ключови думи (кирилица + латиница)                     */
/* ------------------------------------------------------------------ */

const STOP_WORDS = new Set([
  // английски
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'our', 'all', 'can', 'has', 'have',
  'this', 'that', 'with', 'from', 'was', 'were', 'will', 'more', 'how', 'what', 'when', 'who',
  'about', 'into', 'out', 'get', 'their', 'they', 'them', 'its', 'also', 'than', 'then', 'may',
  // български
  'като', 'това', 'тази', 'този', 'тези', 'той', 'нея', 'него', 'ние', 'вие', 'или', 'ако',
  'при', 'към', 'след', 'пред', 'над', 'под', 'през', 'със', 'във', 'който', 'която', 'което',
  'които', 'какво', 'защо', 'как', 'къде', 'кога', 'един', 'една', 'едно', 'едни', 'още',
  'само', 'вече', 'може', 'могат', 'трябва', 'има', 'няма', 'бъде', 'било', 'била', 'бил',
  'били', 'сме', 'сте', 'съм', 'беше', 'бяха', 'всички', 'всяка', 'всеки', 'всичко', 'нещо',
  'някои', 'много', 'малко', 'повече', 'най', 'тук', 'там', 'сега', 'без', 'да', 'не', 'на',
  'за', 'от', 'по', 'се', 'си',
]);

export interface ContentStats {
  wordCount: number;
  sentenceCount: number;
  avgWordsPerSentence: number;
  keywords: { word: string; count: number }[];
}

export function analyzeContent(html: string): ContentStats {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = text.toLowerCase().match(/[a-zа-я][a-zа-я'-]{2,}/g) ?? [];
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 1);

  const counts = new Map<string, number>();
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const keywords = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_KEYWORDS);

  return {
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgWordsPerSentence:
      sentences.length > 0 ? Math.round((words.length / sentences.length) * 10) / 10 : 0,
    keywords,
  };
}

/* ------------------------------------------------------------------ */
/* Връзки                                                              */
/* ------------------------------------------------------------------ */

export interface LinkStats {
  internal: number;
  external: number;
  outboundDomains: { domain: string; href: string }[];
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

export function analyzeLinks(html: string, baseUrl: string): LinkStats {
  const base = new URL(baseUrl);
  const baseHost = normalizeHost(base.hostname);
  let internal = 0;
  let external = 0;
  const outbound = new Map<string, string>();

  const linkRegex = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      const host = normalizeHost(resolved.hostname);
      if (host === baseHost) {
        internal += 1;
      } else {
        external += 1;
        if (!outbound.has(host) && outbound.size < MAX_OUTBOUND_DOMAINS) {
          outbound.set(host, resolved.href);
        }
      }
    } catch {
      // невалиден href — пропускаме
    }
  }

  return {
    internal,
    external,
    outboundDomains: [...outbound.entries()].map(([domain, href]) => ({ domain, href })),
  };
}

/* ------------------------------------------------------------------ */
/* Структурирани данни и социални профили                              */
/* ------------------------------------------------------------------ */

export interface StructuredData {
  jsonLdTypes: string[];
  microdataTypes: string[];
}

export function extractStructuredData(html: string): StructuredData {
  const types = new Set<string>();
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const collect = (node: unknown): void => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (typeof node === 'object') {
          const record = node as Record<string, unknown>;
          const t = record['@type'];
          if (typeof t === 'string') types.add(t);
          if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
          if (record['@graph']) collect(record['@graph']);
        }
      };
      collect(JSON.parse(match[1].trim()));
    } catch {
      // невалиден JSON-LD — пропускаме
    }
  }

  const microdata = new Set<string>();
  const microRegex = /itemtype=["']https?:\/\/schema\.org\/([^"']+)["']/gi;
  while ((match = microRegex.exec(html)) !== null) microdata.add(match[1]);

  return { jsonLdTypes: [...types], microdataTypes: [...microdata] };
}

export interface SocialProfile {
  platform: string;
  url: string;
}

export function extractSocialProfiles(html: string): SocialProfile[] {
  const platforms: { name: string; pattern: RegExp }[] = [
    { name: 'Facebook', pattern: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9.]+/ },
    { name: 'Instagram', pattern: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.]+/ },
    { name: 'LinkedIn', pattern: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9_-]+/ },
    { name: 'X (Twitter)', pattern: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_]+/ },
    { name: 'YouTube', pattern: /https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|@)[a-zA-Z0-9_-]+/ },
    { name: 'GitHub', pattern: /https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/ },
    { name: 'TikTok', pattern: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/ },
    { name: 'Viber', pattern: /https?:\/\/invite\.viber\.com\/[^"'\s]+/ },
  ];

  const profiles: SocialProfile[] = [];
  for (const { name, pattern } of platforms) {
    const found = html.match(pattern);
    if (found) profiles.push({ platform: name, url: found[0] });
  }
  return profiles;
}

/* ------------------------------------------------------------------ */
/* Контакти на страницата                                              */
/* ------------------------------------------------------------------ */

export interface PageContacts {
  emails: string[];
  phones: string[];
}

export function extractContacts(html: string): PageContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();

  let match: RegExpExecArray | null;
  const mailtoRegex = /href=["']mailto:([^"'?]+)/gi;
  while ((match = mailtoRegex.exec(html)) !== null) emails.add(match[1].trim().toLowerCase());

  const telRegex = /href=["']tel:([^"']+)["']/gi;
  while ((match = telRegex.exec(html)) !== null) phones.add(match[1].trim());

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ');
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  for (const email of text.match(emailRegex) ?? []) {
    const clean = email.toLowerCase();
    if (!/\.(png|jpe?g|gif|webp|svg|avif|css|js)$/.test(clean)) emails.add(clean);
  }

  return { emails: [...emails].slice(0, 10), phones: [...phones].slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Технологии и тракери                                                */
/* ------------------------------------------------------------------ */

export interface Technology {
  name: string;
  category: string;
}

interface TechSignature {
  name: string;
  category: string;
  html?: RegExp;
  header?: { name: string; value?: RegExp };
}

const TECH_SIGNATURES: TechSignature[] = [
  // CMS и платформи
  { name: 'WordPress', category: 'CMS', html: /wp-content\/|wp-includes\/|\/wp-json\// },
  { name: 'WooCommerce', category: 'Онлайн магазин', html: /woocommerce/i },
  { name: 'Joomla', category: 'CMS', html: /\/media\/jui\/|content=["']Joomla/i },
  { name: 'Drupal', category: 'CMS', html: /Drupal\.settings|\/sites\/default\/files/ },
  { name: 'Shopify', category: 'Онлайн магазин', html: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: 'Wix', category: 'Уебсайт билдър', html: /wixstatic\.com|wix\.com\/velo/ },
  { name: 'Squarespace', category: 'Уебсайт билдър', html: /static1\.squarespace\.com|squarespace\.com/ },
  { name: 'Webflow', category: 'Уебсайт билдър', html: /assets(?:-global)?\.website-files\.com|data-wf-page/ },
  { name: 'OpenCart', category: 'Онлайн магазин', html: /catalog\/view\/theme|index\.php\?route=/ },
  { name: 'PrestaShop', category: 'Онлайн магазин', html: /prestashop/i },
  { name: 'Magento', category: 'Онлайн магазин', html: /static\/version\d+\/frontend|Magento_/ },
  { name: 'Ghost', category: 'CMS', html: /content=["']Ghost/i },

  // JavaScript фреймуъркове и библиотеки
  { name: 'Next.js', category: 'JS фреймуърк', html: /__NEXT_DATA__|\/_next\// },
  { name: 'Nuxt', category: 'JS фреймуърк', html: /__NUXT__|\/_nuxt\// },
  { name: 'React', category: 'JS библиотека', html: /data-reactroot|data-reactid|react-dom(?:\.production)?(?:\.min)?\.js/ },
  { name: 'Vue.js', category: 'JS библиотека', html: /data-v-app|vue(?:\.runtime)?(?:\.global)?(?:\.prod)?(?:\.min)?\.js/ },
  { name: 'Angular', category: 'JS фреймуърк', html: /\bng-version=/ },
  { name: 'Svelte', category: 'JS фреймуърк', html: /class=["'][^"']*svelte-[a-z0-9]+/ },
  { name: 'Astro', category: 'JS фреймуърк', html: /<astro-island|astro-route|content=["']Astro/ },
  { name: 'Gatsby', category: 'JS фреймуърк', html: /___gatsby/ },
  { name: 'jQuery', category: 'JS библиотека', html: /jquery[.-][\d.]*(?:min\.)?js/i },
  { name: 'Alpine.js', category: 'JS библиотека', html: /alpinejs|\bx-data=/ },
  { name: 'htmx', category: 'JS библиотека', html: /htmx(?:\.min)?\.js|\bhx-(?:get|post)=/ },

  // CSS и шрифтове
  { name: 'Bootstrap', category: 'CSS фреймуърк', html: /bootstrap(?:\.min)?\.(?:css|js)/i },
  { name: 'Tailwind CSS', category: 'CSS фреймуърк', html: /tailwindcss|class=["'][^"']*\b(?:sm|md|lg|xl|2xl):[a-z-]+/ },
  { name: 'Font Awesome', category: 'Икони и шрифтове', html: /font-?awesome/i },
  { name: 'Google Fonts', category: 'Икони и шрифтове', html: /fonts\.googleapis\.com|fonts\.gstatic\.com/ },

  // Аналитика, маркетинг и чат
  { name: 'Hotjar', category: 'Аналитика', html: /static\.hotjar\.com|\bhjid\b/ },
  { name: 'Microsoft Clarity', category: 'Аналитика', html: /clarity\.ms/ },
  { name: 'Plausible', category: 'Аналитика', html: /plausible\.io\/js/ },
  { name: 'Matomo', category: 'Аналитика', html: /matomo\.js|piwik\.js/ },
  { name: 'Fathom', category: 'Аналитика', html: /usefathom\.com/ },
  { name: 'HubSpot', category: 'Маркетинг', html: /js\.hs-scripts\.com|hubspot/i },
  { name: 'Mailchimp', category: 'Маркетинг', html: /list-manage\.com|chimpstatic\.com/ },
  { name: 'Intercom', category: 'Чат', html: /widget\.intercom\.io/ },
  { name: 'Crisp', category: 'Чат', html: /client\.crisp\.chat/ },
  { name: 'Tawk.to', category: 'Чат', html: /embed\.tawk\.to/ },

  // Плащания и видео
  { name: 'Stripe', category: 'Плащания', html: /js\.stripe\.com/ },
  { name: 'PayPal', category: 'Плащания', html: /paypal\.com\/sdk\/js/ },
  { name: 'YouTube (вграждане)', category: 'Видео', html: /youtube(?:-nocookie)?\.com\/embed/ },
  { name: 'Vimeo (вграждане)', category: 'Видео', html: /player\.vimeo\.com/ },

  // Хостинг, CDN и сървъри — по хедъри
  { name: 'Cloudflare', category: 'Хостинг / CDN', header: { name: 'cf-ray' } },
  { name: 'Cloudflare', category: 'Хостинг / CDN', header: { name: 'server', value: /cloudflare/i } },
  { name: 'Netlify', category: 'Хостинг / CDN', header: { name: 'x-nf-request-id' } },
  { name: 'Vercel', category: 'Хостинг / CDN', header: { name: 'x-vercel-id' } },
  { name: 'GitHub Pages', category: 'Хостинг / CDN', header: { name: 'server', value: /github\.com/i } },
  { name: 'Amazon CloudFront', category: 'Хостинг / CDN', header: { name: 'x-amz-cf-id' } },
  { name: 'nginx', category: 'Уеб сървър', header: { name: 'server', value: /nginx/i } },
  { name: 'Apache', category: 'Уеб сървър', header: { name: 'server', value: /apache/i } },
  { name: 'LiteSpeed', category: 'Уеб сървър', header: { name: 'server', value: /litespeed/i } },
  { name: 'Microsoft IIS', category: 'Уеб сървър', header: { name: 'server', value: /microsoft-iis/i } },
  { name: 'PHP', category: 'Език / Runtime', header: { name: 'x-powered-by', value: /php/i } },
  { name: 'Express', category: 'Език / Runtime', header: { name: 'x-powered-by', value: /express/i } },
  { name: 'ASP.NET', category: 'Език / Runtime', header: { name: 'x-powered-by', value: /asp\.net/i } },
];

/** Библиотеки, за които улавяме версия от HTML — нужно за проверката за уязвимости. */
// Търсим „<библиотека><разделител><версия>“ в URL-и на скриптове (cdnjs, jsDelivr,
// unpkg, локални файлове). Разделителят може да е `-`, `.`, `/`, `@` или `v`.
const VERSIONED_LIBRARIES: { name: string; regex: RegExp }[] = [
  { name: 'jQuery', regex: /jquery(?:\.min)?[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)|jquery[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'Bootstrap', regex: /bootstrap[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'Angular', regex: /ng-version=["']([0-9.]+)["']|angular[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'React', regex: /react(?:-dom)?[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'Vue.js', regex: /vue[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'Lodash', regex: /lodash[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
  { name: 'Moment.js', regex: /moment[.\-@/]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i },
];

/** Улавя версиите на познати библиотеки — за кръстосване с базата от уязвимости. */
export function detectLibraryVersions(html: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const { name, regex } of VERSIONED_LIBRARIES) {
    const match = regex.exec(html);
    const version = match?.[1] ?? match?.[2];
    if (version && !out.some((v) => v.name === name)) out.push({ name, version });
  }
  return out;
}

export function detectTechnologies(html: string, headers: Record<string, string>): Technology[] {
  const found = new Map<string, Technology>();

  for (const sig of TECH_SIGNATURES) {
    let matches = false;
    if (sig.html) matches = sig.html.test(html);
    if (!matches && sig.header) {
      const value = headers[sig.header.name];
      matches = value !== undefined && (!sig.header.value || sig.header.value.test(value));
    }
    if (matches && !found.has(sig.name)) found.set(sig.name, { name: sig.name, category: sig.category });
  }

  return [...found.values()];
}

export interface Tracker {
  name: string;
  id: string;
}

export function detectTrackers(html: string): Tracker[] {
  const trackers: Tracker[] = [];
  const push = (name: string, id: string | undefined) => {
    if (id && !trackers.some((t) => t.name === name)) trackers.push({ name, id });
  };

  push('Google Tag Manager', html.match(/GTM-[A-Z0-9]+/)?.[0]);
  push('Google Analytics', html.match(/G-[A-Z0-9]{6,}|UA-\d+-\d+/)?.[0]);
  push('Facebook Pixel', html.match(/fbq\(\s*['"]init['"],\s*['"](\d+)['"]/)?.[1]);
  push('TikTok Pixel', html.match(/ttq\.load\(\s*['"]([a-zA-Z0-9]+)['"]\s*\)/)?.[1]);
  push('LinkedIn Insight Tag', html.match(/_linkedin_data_partner_ids\s*=\s*\[\s*['"]?(\d+)/)?.[1]);
  push('Twitter Pixel', html.match(/twq\(\s*['"]config['"],\s*['"]([a-zA-Z0-9]+)['"]/)?.[1]);

  return trackers;
}

/* ------------------------------------------------------------------ */
/* Сигурност                                                           */
/* ------------------------------------------------------------------ */

export interface SecurityInfo {
  https: boolean;
  headers: { key: string; label: string; value: string | null }[];
  grade: string;
  score: number;
  recommendations: string[];
}

const SECURITY_HEADERS: { key: string; label: string; points: number; recommendation: string }[] = [
  {
    key: 'strict-transport-security',
    label: 'Strict-Transport-Security (HSTS)',
    points: 20,
    recommendation: 'Добави Strict-Transport-Security, за да наложиш HTTPS връзки.',
  },
  {
    key: 'content-security-policy',
    label: 'Content-Security-Policy',
    points: 25,
    recommendation: 'Добави Content-Security-Policy срещу XSS и инжектиране на скриптове.',
  },
  {
    key: 'x-frame-options',
    label: 'X-Frame-Options',
    points: 15,
    recommendation: 'Добави X-Frame-Options срещу clickjacking атаки.',
  },
  {
    key: 'x-content-type-options',
    label: 'X-Content-Type-Options',
    points: 15,
    recommendation: 'Добави X-Content-Type-Options: nosniff срещу подмяна на MIME типове.',
  },
  {
    key: 'referrer-policy',
    label: 'Referrer-Policy',
    points: 10,
    recommendation: 'Добави Referrer-Policy, за да ограничиш изтичането на информация.',
  },
  {
    key: 'permissions-policy',
    label: 'Permissions-Policy',
    points: 15,
    recommendation: 'Добави Permissions-Policy, за да ограничиш достъпа до браузърни функции.',
  },
];

export function analyzeSecurity(finalUrl: string, headers: Record<string, string>): SecurityInfo {
  let score = 0;
  const recommendations: string[] = [];
  const rows: SecurityInfo['headers'] = [];

  for (const { key, label, points, recommendation } of SECURITY_HEADERS) {
    const value = headers[key] ?? null;
    rows.push({ key, label, value });
    if (value !== null) score += points;
    else recommendations.push(recommendation);
  }

  const https = finalUrl.startsWith('https://');
  if (!https) recommendations.unshift('Сайтът не използва HTTPS — това е критичен проблем.');

  let grade: string;
  if (!https) grade = 'F';
  else if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';

  return { https, headers: rows, grade, score, recommendations };
}

/* ------------------------------------------------------------------ */
/* robots.txt и sitemap                                                */
/* ------------------------------------------------------------------ */

export interface RobotsInfo {
  found: boolean;
  sitemaps: string[];
  rules: { userAgent: string; directives: string[] }[];
  raw: string;
}

export async function fetchRobotsTxt(origin: string): Promise<RobotsInfo> {
  try {
    const res = await httpFetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return { found: false, sitemaps: [], rules: [], raw: '' };
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    // Някои сайтове връщат 200 с HTML страница вместо истински robots.txt.
    if (contentType.includes('text/html') || /^\s*</.test(text)) {
      return { found: false, sitemaps: [], rules: [], raw: '' };
    }

    const rules: RobotsInfo['rules'] = [];
    const sitemaps: string[] = [];
    let currentAgent = '*';
    let directives: string[] = [];

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^user-agent:/i.test(trimmed)) {
        if (directives.length > 0) {
          rules.push({ userAgent: currentAgent, directives });
          directives = [];
        }
        currentAgent = trimmed.split(':').slice(1).join(':').trim();
      } else if (/^sitemap:/i.test(trimmed)) {
        sitemaps.push(trimmed.split(':').slice(1).join(':').trim());
      } else {
        directives.push(trimmed);
      }
    }
    if (directives.length > 0) rules.push({ userAgent: currentAgent, directives });

    return { found: true, sitemaps, rules, raw: text.slice(0, 2000) };
  } catch {
    return { found: false, sitemaps: [], rules: [], raw: '' };
  }
}

export interface SitemapInfo {
  found: boolean;
  url: string | null;
  urlCount: number;
  sampleUrls: string[];
}

function extractLocs(xml: string): string[] {
  return (xml.match(/<loc>([\s\S]*?)<\/loc>/gi) ?? [])
    .map((m) => m.replace(/<\/?loc>/gi, '').trim())
    .filter(Boolean);
}

async function tryFetchSitemapText(url: string): Promise<string | null> {
  try {
    const res = await httpFetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!/<urlset[\s>]|<sitemapindex[\s>]/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export async function fetchSitemap(origin: string, declared: string[]): Promise<SitemapInfo> {
  // Най-много 5 кандидата + 2 вложени — иначе подзаявките изяждат бюджета.
  const candidates = [...declared, ...COMMON_SITEMAP_PATHS.map((p) => `${origin}${p}`)].slice(0, 5);

  for (const candidate of candidates) {
    const text = await tryFetchSitemapText(candidate);
    if (!text) continue;

    let urls: string[];
    if (/<sitemapindex[\s>]/i.test(text)) {
      const nested = extractLocs(text).slice(0, 2);
      const nestedTexts = await Promise.all(nested.map(tryFetchSitemapText));
      urls = nestedTexts.filter((t): t is string => t !== null).flatMap(extractLocs);
    } else {
      urls = extractLocs(text);
    }

    if (urls.length > 0) {
      return { found: true, url: candidate, urlCount: urls.length, sampleUrls: urls.slice(0, MAX_SITEMAP_URLS) };
    }
  }

  return { found: false, url: null, urlCount: 0, sampleUrls: [] };
}

/* ------------------------------------------------------------------ */
/* Архитектура на страницата                                           */
/* ------------------------------------------------------------------ */

export interface ArchitectureInfo {
  htmlBytes: number;
  domElements: number;
  scriptsExternal: number;
  scriptsInline: number;
  stylesheets: number;
  inlineStyles: number;
  images: number;
  modernImages: number;
  compression: string | null;
}

export function analyzeArchitecture(page: PageFetch): ArchitectureInfo {
  const html = page.html;
  const scriptsTotal = (html.match(/<script[\s>]/gi) ?? []).length;
  const scriptsExternal = (html.match(/<script[^>]+src=/gi) ?? []).length;

  return {
    htmlBytes: page.htmlBytes,
    domElements: (html.match(/<[a-z][a-z0-9-]*/gi) ?? []).length,
    scriptsExternal,
    scriptsInline: scriptsTotal - scriptsExternal,
    stylesheets: (html.match(/<link[^>]+rel=["']stylesheet["']/gi) ?? []).length,
    inlineStyles: (html.match(/<style[\s>]/gi) ?? []).length,
    images: (html.match(/<img[\s>]/gi) ?? []).length,
    modernImages: (html.match(/\.(?:webp|avif)|image\/(?:webp|avif)/gi) ?? []).length,
    compression: page.headers['content-encoding'] ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Хостинг и геолокация (IP → ASN → доставчик)                         */
/* ------------------------------------------------------------------ */

const HOSTING_PROVIDERS: { keyword: string; name: string; tier: string }[] = [
  { keyword: 'cloudflare', name: 'Cloudflare', tier: 'CDN / Edge' },
  { keyword: 'amazon', name: 'Amazon Web Services', tier: 'Enterprise Cloud' },
  { keyword: 'aws', name: 'Amazon Web Services', tier: 'Enterprise Cloud' },
  { keyword: 'google', name: 'Google Cloud', tier: 'Enterprise Cloud' },
  { keyword: 'microsoft', name: 'Microsoft Azure', tier: 'Enterprise Cloud' },
  { keyword: 'azure', name: 'Microsoft Azure', tier: 'Enterprise Cloud' },
  { keyword: 'fastly', name: 'Fastly', tier: 'CDN / Edge' },
  { keyword: 'akamai', name: 'Akamai', tier: 'Корпоративен CDN' },
  { keyword: 'digitalocean', name: 'DigitalOcean', tier: 'Облачен VPS' },
  { keyword: 'linode', name: 'Linode (Akamai)', tier: 'Облачен VPS' },
  { keyword: 'vultr', name: 'Vultr', tier: 'Облачен VPS' },
  { keyword: 'hetzner', name: 'Hetzner', tier: 'Бюджетен облак' },
  { keyword: 'ovh', name: 'OVHcloud', tier: 'Бюджетен облак' },
  { keyword: 'vercel', name: 'Vercel', tier: 'Serverless' },
  { keyword: 'netlify', name: 'Netlify', tier: 'Serverless' },
  { keyword: 'heroku', name: 'Heroku', tier: 'PaaS' },
  { keyword: 'godaddy', name: 'GoDaddy', tier: 'Споделен хостинг' },
  { keyword: 'siteground', name: 'SiteGround', tier: 'Споделен хостинг' },
  { keyword: 'superhosting', name: 'SuperHosting.BG', tier: 'Български хостинг' },
  { keyword: 'icn.bg', name: 'ICN.Bg', tier: 'Български хостинг' },
  { keyword: 'neterra', name: 'Neterra', tier: 'Български дейта център' },
  { keyword: 'wpengine', name: 'WP Engine', tier: 'Managed WordPress' },
  { keyword: 'shopify', name: 'Shopify', tier: 'Платформа за магазини' },
  { keyword: 'squarespace', name: 'Squarespace', tier: 'Уебсайт билдър' },
  { keyword: 'wix', name: 'Wix', tier: 'Уебсайт билдър' },
  { keyword: 'oracle', name: 'Oracle Cloud', tier: 'Enterprise Cloud' },
  { keyword: 'alibaba', name: 'Alibaba Cloud', tier: 'Enterprise Cloud' },
];

export interface HostingInfo {
  ip: string;
  isp: string | null;
  org: string | null;
  asn: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  provider: { name: string; tier: string } | null;
}

/** Геолокация и доставчик на хостинг чрез безплатния ip-api.com. Връща null при неуспех. */
export async function fetchHostingInfo(ip: string): Promise<HostingInfo | null> {
  if (!ip || ip.includes(':')) {
    // ip-api безплатният план не поддържа IPv6 добре; пропускаме.
    if (!ip) return null;
  }
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,isp,org,as,asname,country,countryCode,regionName,city&lang=en`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, string>;
    if (data.status !== 'success') return null;

    const haystack = `${data.isp} ${data.org} ${data.asname} ${data.as}`.toLowerCase();
    const match = HOSTING_PROVIDERS.find((p) => haystack.includes(p.keyword));

    return {
      ip,
      isp: data.isp || null,
      org: data.org || null,
      asn: data.as || null,
      country: data.country || null,
      countryCode: data.countryCode || null,
      region: data.regionName || null,
      city: data.city || null,
      provider: match ? { name: match.name, tier: match.tier } : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Домейн (регистрация чрез RDAP — публичен WHOIS)                      */
/* ------------------------------------------------------------------ */

export interface DomainInfo {
  registrar: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  ageYears: number | null;
  nameservers: string[];
  statuses: string[];
}

export async function fetchDomainInfo(domain: string): Promise<DomainInfo | null> {
  const parts = domain.replace(/^www\./, '').split('.');
  const root = parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');

  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(root)}`, {
      headers: { Accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;

    const eventDate = (action: string): string | null =>
      (data.events ?? []).find((e: any) => e.eventAction === action)?.eventDate ?? null;

    const registrarEntity = (data.entities ?? []).find(
      (e: any) => Array.isArray(e.roles) && e.roles.includes('registrar'),
    );
    let registrar: string | null = null;
    const vcard = registrarEntity?.vcardArray?.[1];
    if (Array.isArray(vcard)) {
      registrar = vcard.find((entry: any[]) => entry[0] === 'fn')?.[3] ?? null;
    }

    const createdAt = eventDate('registration');
    let ageYears: number | null = null;
    if (createdAt) {
      const created = new Date(createdAt).getTime();
      if (!Number.isNaN(created)) {
        ageYears = Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24 * 365.25));
      }
    }

    const nameservers = (data.nameservers ?? [])
      .map((ns: any) => (typeof ns.ldhName === 'string' ? ns.ldhName.toLowerCase() : null))
      .filter((n: string | null): n is string => !!n);

    const statuses = Array.isArray(data.status) ? data.status.slice(0, 8) : [];

    if (!createdAt && !registrar && nameservers.length === 0) return null;
    return {
      registrar,
      createdAt,
      updatedAt: eventDate('last changed') ?? eventDate('last update of RDAP database'),
      expiresAt: eventDate('expiration'),
      ageYears,
      nameservers,
      statuses,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Поддомейни (по речник, чрез DNS-over-HTTPS)                          */
/* ------------------------------------------------------------------ */

/**
 * 18 имена × 1 DNS заявка — списъкът е подрязан заради бюджета от 50
 * подзаявки на Worker заявка (безплатния план на Cloudflare).
 */
const COMMON_SUBDOMAINS = [
  'www', 'mail', 'blog', 'shop', 'store', 'api', 'app', 'admin', 'portal',
  'dev', 'staging', 'test', 'cdn', 'docs', 'support', 'status', 'news', 'account',
];

export async function enumerateSubdomains(domain: string): Promise<string[]> {
  const base = domain.replace(/^www\./, '');
  const found: string[] = [];
  const chunkSize = 9;

  for (let i = 0; i < COMMON_SUBDOMAINS.length; i += chunkSize) {
    const chunk = COMMON_SUBDOMAINS.slice(i, i + chunkSize);
    const checks = await Promise.allSettled(
      chunk.map(async (sub) => {
        const target = `${sub}.${base}`;
        // Една A заявка стига: DNS-over-HTTPS следва CNAME веригата и връща
        // и двата типа записи в отговора.
        const a = await resolveDns(target, 'A');
        return a.length > 0 ? target : null;
      }),
    );
    for (const result of checks) {
      if (result.status === 'fulfilled' && result.value) found.push(result.value);
    }
  }

  return found;
}

/* ------------------------------------------------------------------ */
/* Достъпност (WCAG евристики)                                          */
/* ------------------------------------------------------------------ */

export interface AccessibilityIssue {
  severity: 'критично' | 'сериозно' | 'средно' | 'леко';
  message: string;
  count: number;
}

export interface AccessibilityAudit {
  score: number;
  grade: string;
  issues: AccessibilityIssue[];
  passed: string[];
}

export function auditAccessibility(html: string): AccessibilityAudit {
  const issues: AccessibilityIssue[] = [];
  const passed: string[] = [];

  const imgs = html.match(/<img[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((i) => !/alt=/i.test(i) || /alt=["']\s*["']/i.test(i)).length;
  if (missingAlt > 0) issues.push({ severity: 'сериозно', message: `${missingAlt} изображения без alt текст`, count: missingAlt });
  else if (imgs.length > 0) passed.push(`Всички ${imgs.length} изображения имат alt текст`);

  const inputs = html.match(/<input[^>]*>/gi) ?? [];
  const formInputs = inputs.filter((i) => !/type=["'](hidden|submit|button|reset|image)["']/i.test(i));
  const unlabeled = formInputs.filter((i) => {
    const idMatch = i.match(/id=["']([^"']+)["']/i);
    if (/aria-label/i.test(i)) return false;
    if (!idMatch) return true;
    return !new RegExp(`for=["']${idMatch[1]}["']`, 'i').test(html);
  }).length;
  if (unlabeled > 0) issues.push({ severity: 'сериозно', message: `${unlabeled} полета във форма без свързан етикет (label)`, count: unlabeled });
  else if (formInputs.length > 0) passed.push('Всички полета във формите имат етикети');

  if (!/<html[^>]+lang=["'][^"']+["']/i.test(html)) issues.push({ severity: 'сериозно', message: 'Липсва lang атрибут на <html> — екранните четци не знаят езика', count: 1 });
  else passed.push('Езикът на документа е зададен');

  if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) issues.push({ severity: 'сериозно', message: 'Липсва <title> на страницата', count: 1 });
  else passed.push('Страницата има заглавие');

  const hasMain = /<main[\s>]/i.test(html) || /role=["']main["']/i.test(html);
  if (!hasMain) issues.push({ severity: 'средно', message: 'Няма <main> ориентир за основното съдържание', count: 1 });
  else passed.push('Има <main> ориентир');

  if (!(/<nav[\s>]/i.test(html) || /role=["']navigation["']/i.test(html))) issues.push({ severity: 'леко', message: 'Няма <nav> ориентир за навигацията', count: 1 });
  else passed.push('Има <nav> ориентир');

  const headingLevels = (html.match(/<h([1-6])[^>]*>/gi) ?? []).map((h) => parseInt(h.match(/<h([1-6])/i)?.[1] ?? '0', 10));
  if (headingLevels.length > 0 && headingLevels[0] !== 1) issues.push({ severity: 'средно', message: 'Първото заглавие не е H1 — нарушена йерархия', count: 1 });
  else if (headingLevels.length > 0) passed.push('Йерархията на заглавията започва с H1');
  let skipped = 0;
  for (let i = 1; i < headingLevels.length; i++) if (headingLevels[i] > headingLevels[i - 1] + 1) skipped++;
  if (skipped > 0) issues.push({ severity: 'средно', message: `Йерархията на заглавията прескача ${skipped} ниво(а)`, count: skipped });

  const emptyButtons = (html.match(/<button[^>]*>\s*<\/button>/gi) ?? []).filter((b) => !/aria-label|title=/i.test(b)).length;
  if (emptyButtons > 0) issues.push({ severity: 'сериозно', message: `${emptyButtons} празни бутона без достъпно име`, count: emptyButtons });

  const genericLinks = (html.match(/<a[^>]*>\s*(?:натисни тук|виж повече|прочети повече|тук|повече|click here|read more|more)\s*<\/a>/gi) ?? []).length;
  if (genericLinks > 0) issues.push({ severity: 'леко', message: `${genericLinks} връзки с общ текст като „виж повече“`, count: genericLinks });

  const viewportMeta = html.match(/<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']+)["']/i);
  if (viewportMeta && /user-scalable\s*=\s*(no|0)/i.test(viewportMeta[1])) issues.push({ severity: 'критично', message: 'Мащабирането е забранено (user-scalable=no)', count: 1 });
  else passed.push('Мащабирането от потребителя е разрешено');

  const positiveTabindex = (html.match(/tabindex=["'][1-9]/gi) ?? []).length;
  if (positiveTabindex > 0) issues.push({ severity: 'леко', message: `${positiveTabindex} елемента с положителен tabindex (нарушава реда на фокуса)`, count: positiveTabindex });

  const total = issues.length + passed.length;
  const score = total > 0 ? Math.round((passed.length / total) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

  const severityOrder = { критично: 0, сериозно: 1, средно: 2, леко: 3 } as const;
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return { score, grade, issues, passed };
}

/* ------------------------------------------------------------------ */
/* Разширен SEO (schema валидиране, тегло, дублирано съдържание)        */
/* ------------------------------------------------------------------ */

export interface SchemaValidation {
  schemas: { type: string; isValid: boolean; issues: string[] }[];
  richResultsEligible: string[];
}

const RICH_RESULT_TYPES = ['Article', 'Product', 'FAQPage', 'HowTo', 'Recipe', 'Event', 'LocalBusiness', 'Organization', 'BreadcrumbList', 'Review', 'JobPosting', 'Course', 'VideoObject'];
const SCHEMA_REQUIRED_FIELDS: Record<string, string[]> = {
  Article: ['headline', 'author', 'datePublished'],
  Product: ['name', 'image', 'offers'],
  FAQPage: ['mainEntity'],
  Event: ['name', 'startDate', 'location'],
  LocalBusiness: ['name', 'address', 'telephone'],
  Organization: ['name', 'url'],
  BreadcrumbList: ['itemListElement'],
  JobPosting: ['title', 'description', 'datePosted', 'hiringOrganization'],
};

export function validateSchemas(html: string): SchemaValidation {
  const schemas: SchemaValidation['schemas'] = [];
  const richResultsEligible: string[] = [];
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] ?? [parsed];
      for (const item of Array.isArray(items) ? items : [items]) {
        if (!item || typeof item !== 'object') continue;
        const type = typeof item['@type'] === 'string' ? item['@type'] : Array.isArray(item['@type']) ? item['@type'][0] : 'Unknown';
        const issues: string[] = [];
        for (const field of SCHEMA_REQUIRED_FIELDS[type] ?? []) {
          if (!item[field]) issues.push(`Липсва задължително поле: ${field}`);
        }
        const isValid = issues.length === 0;
        schemas.push({ type, isValid, issues });
        if (isValid && RICH_RESULT_TYPES.includes(type) && !richResultsEligible.includes(type)) {
          richResultsEligible.push(type);
        }
      }
    } catch {
      schemas.push({ type: 'Невалиден JSON-LD', isValid: false, issues: ['Грешка при разчитане на JSON'] });
    }
  }

  return { schemas, richResultsEligible };
}

export interface PageWeight {
  totalKB: number;
  grade: string;
  breakdown: { type: string; kb: number; count: number }[];
  recommendations: string[];
}

export function analyzePageWeight(html: string, htmlBytes: number): PageWeight {
  const breakdown: { type: string; kb: number; count: number }[] = [];
  const recommendations: string[] = [];

  breakdown.push({ type: 'HTML документ', kb: Math.round(htmlBytes / 1024), count: 1 });

  const extScripts = (html.match(/<script[^>]+src=["'][^"']+["']/gi) ?? []).length;
  const inlineScripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  breakdown.push({ type: 'Външни скриптове (оценка)', kb: extScripts * 45, count: extScripts });
  breakdown.push({ type: 'Вградени скриптове', kb: Math.round(inlineScripts.reduce((t, s) => t + s.length, 0) / 1024), count: inlineScripts.length });

  const stylesheets = (html.match(/<link[^>]+rel=["']stylesheet["']/gi) ?? []).length;
  breakdown.push({ type: 'Външни стилове (оценка)', kb: stylesheets * 25, count: stylesheets });

  const images = (html.match(/<img[^>]+src=["'][^"']+["']/gi) ?? []).length;
  breakdown.push({ type: 'Изображения (оценка)', kb: images * 80, count: images });

  const fonts = (html.match(/url\([^)]*\.(?:woff2?|ttf|otf|eot)/gi) ?? []).length;
  if (fonts > 0) breakdown.push({ type: 'Шрифтове (оценка)', kb: fonts * 35, count: fonts });

  const iframes = (html.match(/<iframe/gi) ?? []).length;
  if (iframes > 0) breakdown.push({ type: 'Iframe рамки (оценка)', kb: iframes * 200, count: iframes });

  const totalKB = breakdown.reduce((sum, b) => sum + b.kb, 0);
  const grade = totalKB < 500 ? 'A' : totalKB < 1000 ? 'B' : totalKB < 2000 ? 'C' : totalKB < 4000 ? 'D' : 'F';

  if (extScripts > 15) recommendations.push(`Много външни скриптове (${extScripts}) — обедини или премахни неизползваните.`);
  if (images > 20) recommendations.push(`Много изображения (${images}) — ползвай lazy loading и WebP/AVIF формат.`);
  if (fonts > 4) recommendations.push(`Много шрифтове (${fonts}) — ограничи до 2–3 файла.`);
  if (iframes > 3) recommendations.push(`Много iframe рамки (${iframes}) — всяка зарежда цял отделен документ.`);

  return { totalKB, grade, breakdown: breakdown.filter((b) => b.count > 0), recommendations };
}

export interface SeoIssues {
  issues: string[];
}

export function checkSeoIssues(seo: SeoAudit): SeoIssues {
  const issues: string[] = [];
  if (!seo.title) issues.push('Липсва <title> — критично за SEO.');
  else if (seo.titleLength > 60) issues.push(`Заглавието е ${seo.titleLength} знака (препоръчително ≤60).`);
  else if (seo.titleLength < 10) issues.push('Заглавието е твърде кратко — направи го описателно.');

  if (!seo.metaDescription) issues.push('Липсва мета описание — влияе на кликовете от търсачките.');
  else if (seo.metaDescriptionLength > 160) issues.push(`Мета описанието е ${seo.metaDescriptionLength} знака (препоръчително ≤160).`);
  else if (seo.metaDescriptionLength < 50) issues.push('Мета описанието е твърде кратко — цели 120–160 знака.');

  if (!seo.canonical) issues.push('Липсва canonical адрес — риск от дублирано съдържание.');
  if (seo.headingCounts.H1 === 0) issues.push('Липсва H1 заглавие — важно за SEO.');
  else if (seo.headingCounts.H1 > 1) issues.push(`Повече от едно H1 (${seo.headingCounts.H1}) — трябва да е точно едно.`);
  if (!seo.viewport) issues.push('Липсва viewport meta — сайтът няма да е удобен на мобилни.');
  if (Object.keys(seo.ogTags).length === 0) issues.push('Липсват Open Graph тагове — лошо изглежда при споделяне.');

  return { issues };
}

/* ------------------------------------------------------------------ */
/* Дълбока сигурност (CSP, mixed content, SRI, рискове, уязвимости)     */
/* ------------------------------------------------------------------ */

const KNOWN_VULNERABILITIES: Record<string, { severity: string; cve: string; description: string; fixedIn: string }[]> = {
  jQuery: [
    { severity: 'средно', cve: 'CVE-2020-11022', description: 'XSS при HTML, подаден към DOM методи', fixedIn: '3.5.0' },
    { severity: 'ниско', cve: 'CVE-2019-11358', description: 'Prototype pollution в extend()', fixedIn: '3.4.0' },
  ],
  Bootstrap: [
    { severity: 'средно', cve: 'CVE-2019-8331', description: 'XSS в tooltip/popover data-template', fixedIn: '4.3.1' },
    { severity: 'средно', cve: 'CVE-2024-6531', description: 'XSS в carousel компонента', fixedIn: '5.3.3' },
  ],
  Angular: [{ severity: 'високо', cve: 'CVE-2022-25869', description: 'XSS през angular.copy в стари версии', fixedIn: '1.8.3' }],
  Lodash: [{ severity: 'високо', cve: 'CVE-2021-23337', description: 'Command injection през template()', fixedIn: '4.17.21' }],
  'Moment.js': [{ severity: 'високо', cve: 'CVE-2022-31129', description: 'ReDoS при разчитане на дати', fixedIn: '2.29.4' }],
  React: [{ severity: 'средно', cve: 'CVE-2018-6341', description: 'XSS при SSR с потребителски вход в атрибути', fixedIn: '16.4.2' }],
  'Vue.js': [{ severity: 'средно', cve: 'CVE-2024-6783', description: 'XSS през v-bind с определени атрибути', fixedIn: '3.4.6' }],
};

function versionLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

const HIGH_RISK_THIRD_PARTIES: Record<string, { risk: string; category: string; concern: string }> = {
  'doubleclick.net': { risk: 'висок', category: 'Реклами', concern: 'Рекламна мрежа на Google — тежко проследяване' },
  'google-analytics.com': { risk: 'среден', category: 'Аналитика', concern: 'Проследяване на поведение — изисква GDPR съгласие' },
  'googletagmanager.com': { risk: 'среден', category: 'Тагове', concern: 'Може да зарежда произволни скриптове' },
  'hotjar.com': { risk: 'висок', category: 'Записи на сесии', concern: 'Записва сесии, включително въведеното във формите' },
  'clarity.ms': { risk: 'висок', category: 'Записи на сесии', concern: 'Microsoft Clarity записва потребителски сесии' },
  'facebook.net': { risk: 'среден', category: 'Проследяване', concern: 'Крос-сайт проследяване, GDPR последици' },
  'tiktok.com': { risk: 'висок', category: 'Проследяване', concern: 'TikTok пиксел — данни към ByteDance' },
  'snap.licdn.com': { risk: 'среден', category: 'Проследяване', concern: 'LinkedIn проследяващ пиксел' },
  'unpkg.com': { risk: 'среден', category: 'CDN', concern: 'npm CDN — риск във веригата на доставки' },
  'cdn.jsdelivr.net': { risk: 'нисък', category: 'CDN', concern: 'Публичен CDN — риск при компрометиране' },
};

export interface DeepSecurity {
  vulnerabilities: { technology: string; version: string; severity: string; cve: string; description: string; fixedIn: string }[];
  csp: { present: boolean; issues: { severity: string; message: string }[] };
  mixedContent: { count: number; resources: { type: string; url: string }[] };
  sri: { totalExternal: number; withIntegrity: number; coveragePercent: number };
  thirdParties: { domain: string; risk: string; category: string; concern: string }[];
  riskLevel: string;
}

export function runDeepSecurity(
  html: string,
  pageUrl: string,
  domain: string,
  cspHeader: string | null,
  libraries: { name: string; version: string }[],
): DeepSecurity {
  // Уязвимости по версия
  const vulnerabilities: DeepSecurity['vulnerabilities'] = [];
  for (const lib of libraries) {
    for (const v of KNOWN_VULNERABILITIES[lib.name] ?? []) {
      if (versionLessThan(lib.version, v.fixedIn)) {
        vulnerabilities.push({ technology: lib.name, version: lib.version, ...v });
      }
    }
  }
  const sevOrder = { критично: 0, високо: 1, средно: 2, ниско: 3 } as Record<string, number>;
  vulnerabilities.sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4));

  // CSP
  const cspIssues: { severity: string; message: string }[] = [];
  if (!cspHeader) {
    cspIssues.push({ severity: 'високо', message: 'Няма Content-Security-Policy — сайтът е уязвим на XSS и инжектиране.' });
  } else {
    const directives = new Map<string, string[]>();
    for (const part of cspHeader.split(';')) {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name) directives.set(name.toLowerCase(), values);
    }
    const scriptSrc = directives.get('script-src') ?? directives.get('default-src') ?? [];
    if (scriptSrc.includes("'unsafe-inline'")) cspIssues.push({ severity: 'високо', message: "'unsafe-inline' в script-src позволява вградени скриптове — основен XSS вектор." });
    if (scriptSrc.includes("'unsafe-eval'")) cspIssues.push({ severity: 'високо', message: "'unsafe-eval' в script-src позволява eval() — риск от инжектиране на код." });
    if (scriptSrc.includes('*')) cspIssues.push({ severity: 'високо', message: "Заместващ знак '*' позволява скриптове от всякакъв източник." });
    if (!directives.has('frame-ancestors')) cspIssues.push({ severity: 'средно', message: "Липсва 'frame-ancestors' — риск от clickjacking." });
    if (!directives.has('base-uri')) cspIssues.push({ severity: 'средно', message: "Липсва 'base-uri' — възможна е инжекция на <base>." });
  }

  // Mixed content
  const mixedResources: { type: string; url: string }[] = [];
  if (pageUrl.startsWith('https://')) {
    const patterns: { type: string; regex: RegExp }[] = [
      { type: 'скрипт', regex: /<script[^>]+src=["'](http:\/\/[^"']+)["']/gi },
      { type: 'стил', regex: /<link[^>]+href=["'](http:\/\/[^"']+)["'][^>]*rel=["']stylesheet["']/gi },
      { type: 'изображение', regex: /<img[^>]+src=["'](http:\/\/[^"']+)["']/gi },
      { type: 'iframe', regex: /<iframe[^>]+src=["'](http:\/\/[^"']+)["']/gi },
    ];
    const seen = new Set<string>();
    for (const { type, regex } of patterns) {
      let m: RegExpExecArray | null;
      while ((m = regex.exec(html)) !== null) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          if (mixedResources.length < 20) mixedResources.push({ type, url: m[1].slice(0, 160) });
        }
      }
    }
  }

  // SRI покритие
  let totalExternal = 0;
  let withIntegrity = 0;
  const sriPatterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi,
  ];
  for (const regex of sriPatterns) {
    let m: RegExpExecArray | null;
    const fresh = new RegExp(regex.source, regex.flags);
    while ((m = fresh.exec(html)) !== null) {
      const src = m[1];
      const isExternal = /^https?:\/\//i.test(src) || src.startsWith('//');
      if (!isExternal) continue;
      try {
        const host = new URL(src.startsWith('//') ? `https:${src}` : src).hostname.toLowerCase();
        if (host.endsWith(domain.toLowerCase())) continue;
      } catch {
        continue;
      }
      totalExternal++;
      if (/\bintegrity\s*=\s*["'][^"']+["']/i.test(m[0])) withIntegrity++;
    }
  }
  const coveragePercent = totalExternal > 0 ? Math.round((withIntegrity / totalExternal) * 100) : 100;

  // Трети страни
  const externalDomains = new Set<string>();
  const urlRegex = /(?:src|href|action)=["']https?:\/\/([^/"']+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(html)) !== null) {
    const host = match[1].toLowerCase();
    if (!host.endsWith(domain.toLowerCase())) externalDomains.add(host);
  }
  const thirdParties: DeepSecurity['thirdParties'] = [];
  for (const host of externalDomains) {
    const known = Object.entries(HIGH_RISK_THIRD_PARTIES).find(([key]) => host.includes(key));
    if (known) thirdParties.push({ domain: host, ...known[1] });
  }
  const riskRank = { висок: 0, среден: 1, нисък: 2 } as Record<string, number>;
  thirdParties.sort((a, b) => (riskRank[a.risk] ?? 3) - (riskRank[b.risk] ?? 3));

  // Обща оценка на риска
  let riskScore = 0;
  riskScore += vulnerabilities.filter((v) => v.severity === 'критично').length * 20;
  riskScore += vulnerabilities.filter((v) => v.severity === 'високо').length * 12;
  riskScore += vulnerabilities.filter((v) => v.severity === 'средно').length * 5;
  riskScore += cspIssues.filter((i) => i.severity === 'високо').length * 10;
  riskScore += mixedResources.length * 8;
  riskScore += thirdParties.filter((t) => t.risk === 'висок').length * 6;
  if (totalExternal > 0) riskScore += Math.round((100 - coveragePercent) * 0.05);
  riskScore = Math.min(100, riskScore);
  const riskLevel = riskScore >= 70 ? 'Критичен' : riskScore >= 45 ? 'Висок' : riskScore >= 25 ? 'Среден' : riskScore >= 10 ? 'Нисък' : 'Минимален';

  return {
    vulnerabilities,
    csp: { present: !!cspHeader, issues: cspIssues },
    mixedContent: { count: mixedResources.length, resources: mixedResources },
    sri: { totalExternal, withIntegrity, coveragePercent },
    thirdParties: thirdParties.slice(0, 30),
    riskLevel,
  };
}

/* ------------------------------------------------------------------ */
/* Бисквитки и GDPR                                                    */
/* ------------------------------------------------------------------ */

const CONSENT_PROVIDERS: { name: string; pattern: RegExp }[] = [
  { name: 'OneTrust', pattern: /onetrust|optanon/i },
  { name: 'CookieBot', pattern: /cookiebot|CookieDeclaration/i },
  { name: 'CookieYes', pattern: /cookie-law-info|cookieyes/i },
  { name: 'Osano', pattern: /osano\.com/i },
  { name: 'iubenda', pattern: /iubenda/i },
  { name: 'Didomi', pattern: /didomi/i },
  { name: 'Quantcast', pattern: /quantcast.*choice|__cmpapi/i },
  { name: 'Cookie Notice', pattern: /cookie-notice|cookie-consent|gdpr-cookie/i },
];

export interface CookieInfo {
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string }[];
  consentProvider: string | null;
  issues: string[];
}

export function analyzeCookies(html: string, setCookies: string[]): CookieInfo {
  const cookies: CookieInfo['cookies'] = [];
  const issues: string[] = [];

  for (const header of setCookies) {
    const parts = header.split(';').map((p) => p.trim());
    const name = parts[0]?.split('=')[0]?.trim() ?? '';
    if (!name) continue;
    const secure = parts.some((p) => p.toLowerCase() === 'secure');
    const httpOnly = parts.some((p) => p.toLowerCase() === 'httponly');
    const sameSite = parts.find((p) => p.toLowerCase().startsWith('samesite='))?.split('=')[1] ?? 'Не е зададено';
    cookies.push({ name, secure, httpOnly, sameSite });
    if (!secure) issues.push(`Бисквитката „${name}“ е без флаг Secure.`);
  }

  let consentProvider: string | null = null;
  for (const provider of CONSENT_PROVIDERS) {
    if (provider.pattern.test(html)) {
      consentProvider = provider.name;
      break;
    }
  }
  if (!consentProvider) issues.push('Не е открит банер за съгласие за бисквитки — възможно нарушение на GDPR.');

  return { cookies, consentProvider, issues };
}

/* ------------------------------------------------------------------ */
/* GEO — оптимизация за генеративни (AI) търсачки                       */
/* ------------------------------------------------------------------ */

/**
 * GEO (Generative Engine Optimisation) е спътникът на SEO: вместо класиране в
 * десетте сини връзки, целта е сайтът да бъде *намерен, разчетен и цитиран* от
 * AI отговарящите машини (ChatGPT, Perplexity, Google AI Overviews, Gemini,
 * Claude). Оценяваме сигналите, на които тези машини разчитат. Функциите са
 * чисто евристични — не се вика никакъв AI модел.
 */

const KEY_AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];
const ALL_AI_CRAWLERS = [
  ...KEY_AI_CRAWLERS,
  'anthropic-ai', 'Claude-Web', 'CCBot', 'Applebot-Extended', 'Amazonbot', 'Bytespider', 'cohere-ai', 'Meta-ExternalAgent',
];
const AI_FRIENDLY_SCHEMA_TYPES = [
  'Organization', 'WebSite', 'FAQPage', 'QAPage', 'Article', 'NewsArticle', 'BlogPosting', 'Product', 'BreadcrumbList', 'HowTo', 'Person',
];

export type GeoSignalStatus = 'pass' | 'warn' | 'fail';

export interface GeoSignal {
  label: string;
  status: GeoSignalStatus;
  points: number;
  max: number;
  detail: string;
  recommendation?: string;
}

export interface GeoAuditResult {
  score: number;
  grade: string;
  signals: GeoSignal[];
  aiCrawlers: { name: string; allowed: boolean }[];
  llmsTxt: boolean;
}

/** Проверява дали robots.txt изцяло забранява (`Disallow: /`) даден бот. */
function isAgentBlocked(robots: RobotsInfo, agent: string): boolean {
  if (!robots.found || robots.rules.length === 0) return false;
  const fullyDisallows = (rule: RobotsInfo['rules'][number]) =>
    rule.directives.some((d) => /^disallow:\s*\/\s*$/i.test(d.trim()));
  const specific = robots.rules.find((r) => r.userAgent.toLowerCase() === agent.toLowerCase());
  if (specific) return fullyDisallows(specific);
  const wildcard = robots.rules.find((r) => r.userAgent === '*');
  return wildcard ? fullyDisallows(wildcard) : false;
}

/** Проверява за `/llms.txt` манифест. Връща false при грешка или HTML страница. */
export async function fetchLlmsTxt(origin: string): Promise<boolean> {
  try {
    const res = await httpFetch(`${origin}/llms.txt`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const text = await res.text();
    if (text.trim().length === 0) return false;
    if (/<!doctype html|<html[\s>]/i.test(text.slice(0, 400))) return false;
    return true;
  } catch {
    return false;
  }
}

const geoGrade = (score: number): string =>
  score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

export function runGeoAudit(
  html: string,
  seo: SeoAudit,
  structuredData: StructuredData,
  robots: RobotsInfo,
  llmsTxt: boolean,
): GeoAuditResult {
  const signals: GeoSignal[] = [];
  const lower = html.toLowerCase();
  const schemaTypes = [...structuredData.jsonLdTypes, ...structuredData.microdataTypes];

  // 1. Достъп за AI ботове (30 т.)
  const aiCrawlers = ALL_AI_CRAWLERS.map((name) => ({ name, allowed: !isAgentBlocked(robots, name) }));
  const blockedKey = KEY_AI_CRAWLERS.filter((name) => isAgentBlocked(robots, name));
  const crawlerPoints = Math.round(((KEY_AI_CRAWLERS.length - blockedKey.length) / KEY_AI_CRAWLERS.length) * 30);
  signals.push({
    label: 'Достъп за AI ботове',
    status: crawlerPoints === 30 ? 'pass' : crawlerPoints === 0 ? 'fail' : 'warn',
    points: crawlerPoints,
    max: 30,
    detail:
      blockedKey.length === 0
        ? 'Всички основни AI ботове (GPTBot, ClaudeBot, PerplexityBot, Google-Extended…) са допуснати.'
        : `Забранени в robots.txt: ${blockedKey.join(', ')}.`,
    recommendation:
      blockedKey.length > 0
        ? `Разреши AI ботовете в robots.txt, за да могат отговарящите машини да те индексират и цитират: ${blockedKey.join(', ')}.`
        : undefined,
  });

  // 2. llms.txt манифест (10 т.)
  signals.push({
    label: 'llms.txt манифест',
    status: llmsTxt ? 'pass' : 'fail',
    points: llmsTxt ? 10 : 0,
    max: 10,
    detail: llmsTxt ? 'Открит е /llms.txt, който насочва AI моделите към ключовото съдържание.' : 'Няма /llms.txt.',
    recommendation: llmsTxt ? undefined : 'Публикувай /llms.txt със списък на най-важните страници, за да ги намират лесно AI моделите.',
  });

  // 3. Структурирани данни (20 т.)
  const hasAiFriendly = schemaTypes.some((t) => AI_FRIENDLY_SCHEMA_TYPES.includes(t));
  const schemaPoints = schemaTypes.length > 0 ? (hasAiFriendly ? 20 : 12) : 0;
  signals.push({
    label: 'Структурирани данни (schema.org)',
    status: schemaPoints === 20 ? 'pass' : schemaPoints > 0 ? 'warn' : 'fail',
    points: schemaPoints,
    max: 20,
    detail: schemaTypes.length > 0 ? `Открити схеми: ${schemaTypes.slice(0, 8).join(', ')}.` : 'Няма schema.org структурирани данни.',
    recommendation:
      schemaPoints === 20
        ? undefined
        : schemaTypes.length === 0
          ? 'Добави schema.org JSON-LD (Organization, Article, FAQPage…), за да извличат AI машините факти и същности.'
          : 'Добави богати на същности схеми (Organization, FAQPage, Article) — сегашните нямат AI-приятелски типове.',
  });

  // 4. Семантично основно съдържание (10 т.)
  const hasMain = /<main[\s>]/.test(lower) || /<article[\s>]/.test(lower) || /role=["']main["']/.test(lower);
  signals.push({
    label: 'Семантично основно съдържание',
    status: hasMain ? 'pass' : 'fail',
    points: hasMain ? 10 : 0,
    max: 10,
    detail: hasMain ? 'Използва <main>/<article> ориентири за извличане на съдържанието.' : 'Няма <main> или <article> ориентир.',
    recommendation: hasMain ? undefined : 'Обгради основното съдържание в <main> или <article>, за да го отделят AI парсерите от менюта и реклами.',
  });

  // 5. Йерархия на заглавията (10 т.)
  const h1 = seo.headingCounts.H1;
  const h2 = seo.headingCounts.H2;
  let headingPoints = 0;
  if (h1 === 1) headingPoints += 7;
  if (h2 >= 1) headingPoints += 3;
  signals.push({
    label: 'Йерархия на заглавията',
    status: headingPoints === 10 ? 'pass' : headingPoints > 0 ? 'warn' : 'fail',
    points: headingPoints,
    max: 10,
    detail: `${h1} × H1, ${h2} × H2.`,
    recommendation:
      headingPoints === 10
        ? undefined
        : h1 !== 1
          ? 'Използвай точно едно H1 и описателни H2 — AI машините свързват отговорите с плана от заглавия.'
          : 'Добави H2 подзаглавия, за да разделиш страницата на цитируеми секции.',
  });

  // 6. Въпроси и отговори / FAQ (8 т.)
  const hasFaqSchema = schemaTypes.includes('FAQPage') || schemaTypes.includes('QAPage');
  const questionHeadings = (html.match(/<h[2-4][^>]*>[^<]*\?\s*<\/h[2-4]>/gi) ?? []).length;
  const faqPoints = hasFaqSchema ? 8 : questionHeadings >= 2 ? 4 : 0;
  signals.push({
    label: 'Съдържание тип въпрос/отговор (FAQ)',
    status: faqPoints === 8 ? 'pass' : faqPoints > 0 ? 'warn' : 'fail',
    points: faqPoints,
    max: 8,
    detail: hasFaqSchema
      ? 'Има FAQ/QA схема — идеална за отговарящите машини.'
      : questionHeadings >= 2
        ? `${questionHeadings} заглавия във формата на въпрос.`
        : 'Няма FAQ схема или съдържание тип въпрос.',
    recommendation: faqPoints === 8 ? undefined : 'Добави FAQ секция със схема FAQPage — отговарящите машини цитират директно двойките въпрос/отговор.',
  });

  // 7. Сигнали за авторитет: автор и дати (7 т.)
  const hasAuthor = /<meta[^>]+name=["']author["']/i.test(html) || /rel=["']author["']/i.test(html) || /"author"\s*:/.test(html);
  const hasDate = /<meta[^>]+property=["']article:published_time["']/i.test(html) || /"datepublished"\s*:/i.test(html) || /<time[\s>]/i.test(lower);
  let authorityPoints = 0;
  if (hasAuthor) authorityPoints += 4;
  if (hasDate) authorityPoints += 3;
  signals.push({
    label: 'Сигнали за авторитет (автор и дати)',
    status: authorityPoints === 7 ? 'pass' : authorityPoints > 0 ? 'warn' : 'fail',
    points: authorityPoints,
    max: 7,
    detail: `${hasAuthor ? 'Има информация за автор' : 'Няма автор'}; ${hasDate ? 'има дати на публикуване/обновяване' : 'няма дати'}.`,
    recommendation: authorityPoints === 7 ? undefined : 'Покажи автор и дати на публикуване/промяна (meta тагове или схема) — AI машините предпочитат датирани и приписуеми източници.',
  });

  // 8. Готово за отговор мета описание (5 т.)
  const descLen = seo.metaDescriptionLength;
  const metaPoints = descLen >= 50 && descLen <= 160 ? 5 : descLen > 0 ? 3 : 0;
  signals.push({
    label: 'Готово за отговор мета описание',
    status: metaPoints === 5 ? 'pass' : metaPoints > 0 ? 'warn' : 'fail',
    points: metaPoints,
    max: 5,
    detail: descLen > 0 ? `Мета описанието е ${descLen} знака.` : 'Няма мета описание.',
    recommendation:
      metaPoints === 5
        ? undefined
        : descLen === 0
          ? 'Добави мета описание 50–160 знака — машините го ползват като готов кратък отговор.'
          : 'Настрой мета описанието към 50–160 знака за чист откъс-отговор.',
  });

  const score = Math.max(0, Math.min(100, signals.reduce((sum, s) => sum + s.points, 0)));
  return { score, grade: geoGrade(score), signals, aiCrawlers, llmsTxt };
}

/* ------------------------------------------------------------------ */
/* Пълен анализ                                                        */
/* ------------------------------------------------------------------ */

export interface AnalysisResult {
  url: string;
  domain: string;
  analyzedAtMs: number;
  page: {
    finalUrl: string;
    status: number;
    ok: boolean;
    responseTimeMs: number;
    contentType: string | null;
    server: string | null;
    poweredBy: string | null;
    htmlTruncated: boolean;
  };
  redirects: RedirectHop[];
  hosting: HostingInfo | null;
  domainInfo: DomainInfo | null;
  subdomains: string[];
  seo: SeoAudit;
  seoIssues: SeoIssues;
  geo: GeoAuditResult;
  content: ContentStats;
  links: LinkStats;
  structuredData: StructuredData;
  schemaValidation: SchemaValidation;
  socialProfiles: SocialProfile[];
  contacts: PageContacts;
  technologies: Technology[];
  trackers: Tracker[];
  security: SecurityInfo;
  deepSecurity: DeepSecurity;
  accessibility: AccessibilityAudit;
  cookies: CookieInfo;
  dns: DnsInfo;
  robots: RobotsInfo;
  sitemap: SitemapInfo;
  architecture: ArchitectureInfo;
  pageWeight: PageWeight;
}

const EMPTY_DNS: DnsInfo = { a: [], aaaa: [], mx: [], ns: [], txt: [], spf: null, dmarc: null };

/** Изпълнява пълния анализ. Хвърля грешка само ако страницата не може да се изтегли. */
export async function analyzeSite(safeUrl: string): Promise<AnalysisResult> {
  const urlObj = new URL(safeUrl);
  const domain = urlObj.hostname;
  const origin = urlObj.origin;

  // Партида 1: страницата и леките проверки. Тежките изброявания са нарочно
  // във втората партида — иначе се надпреварват с fetch-а на страницата за
  // бюджета от подзаявки и той може да пропадне по средата на redirect.
  const [pageResult, redirectsResult, robotsResult, dnsResult, llmsResult] =
    await Promise.allSettled([
      fetchPage(safeUrl),
      followRedirects(safeUrl),
      fetchRobotsTxt(origin),
      collectDns(domain),
      fetchLlmsTxt(origin),
    ]);

  if (pageResult.status === 'rejected') {
    throw new Error('fetch-failed');
  }
  const page = pageResult.value;
  const html = page.html;

  const robots =
    robotsResult.status === 'fulfilled'
      ? robotsResult.value
      : { found: false, sitemaps: [], rules: [], raw: '' };
  const dns = dnsResult.status === 'fulfilled' ? dnsResult.value : EMPTY_DNS;

  // Партида 2: sitemap (от robots), геолокация (от DNS) и обемните проверки.
  const firstIp = dns.a[0] ?? null;
  const [sitemapResult, hostingResult, domainInfoResult, subdomainsResult] =
    await Promise.allSettled([
      fetchSitemap(origin, robots.sitemaps),
      firstIp ? fetchHostingInfo(firstIp) : Promise.resolve(null),
      fetchDomainInfo(domain),
      enumerateSubdomains(domain),
    ]);

  const sitemap =
    sitemapResult.status === 'fulfilled'
      ? sitemapResult.value
      : { found: false, url: null, urlCount: 0, sampleUrls: [] };
  const hosting = hostingResult.status === 'fulfilled' ? hostingResult.value : null;

  const seo = auditSeo(html);
  const structuredData = extractStructuredData(html);
  const libraries = detectLibraryVersions(html);
  const cspHeader = page.headers['content-security-policy'] ?? null;
  const llmsTxt = llmsResult.status === 'fulfilled' ? llmsResult.value : false;

  return {
    url: safeUrl,
    domain,
    analyzedAtMs: Date.now(),
    page: {
      finalUrl: page.finalUrl,
      status: page.status,
      ok: page.ok,
      responseTimeMs: page.responseTimeMs,
      contentType: page.contentType,
      server: page.headers['server'] ?? null,
      poweredBy: page.headers['x-powered-by'] ?? null,
      htmlTruncated: page.htmlTruncated,
    },
    redirects: redirectsResult.status === 'fulfilled' ? redirectsResult.value : [],
    hosting,
    domainInfo: domainInfoResult.status === 'fulfilled' ? domainInfoResult.value : null,
    subdomains: subdomainsResult.status === 'fulfilled' ? subdomainsResult.value : [],
    seo,
    seoIssues: checkSeoIssues(seo),
    geo: runGeoAudit(html, seo, structuredData, robots, llmsTxt),
    content: analyzeContent(html),
    links: analyzeLinks(html, page.finalUrl),
    structuredData,
    schemaValidation: validateSchemas(html),
    socialProfiles: extractSocialProfiles(html),
    contacts: extractContacts(html),
    technologies: detectTechnologies(html, page.headers),
    trackers: detectTrackers(html),
    security: analyzeSecurity(page.finalUrl, page.headers),
    deepSecurity: runDeepSecurity(html, page.finalUrl, domain, cspHeader, libraries),
    accessibility: auditAccessibility(html),
    cookies: analyzeCookies(html, page.setCookies),
    dns,
    robots,
    sitemap,
    architecture: analyzeArchitecture(page),
    pageWeight: analyzePageWeight(html, page.htmlBytes),
  };
}

/* ------------------------------------------------------------------ */
/* Обхождане на сайта (много страници)                                 */
/* ------------------------------------------------------------------ */

/**
 * Числата на таблото — „обходени адреса“, „критични проблема“, „страници със
 * schema“ — са за целия сайт, а `analyzeSite` гледа една страница. Затова
 * тук стои второ, по-плитко минаване: много адреси, само проверките, които
 * се събират в средна стойност.
 *
 * Границата е броят подзаявки на Worker-а (50 на безплатния план, 1000 на
 * платения), затова `maxPages` е таван, а не цел: спираме на него дори когато
 * има още какво да се обходи, и казваме колко сме видели.
 */

const CRAWL_CONCURRENCY = 5;
const CRAWL_TIMEOUT_MS = 6_000;

export interface CrawledPage {
  url: string;
  status: number;
  ok: boolean;
  responseTimeMs: number;
  title: string | null;
  titleLength: number;
  metaDescriptionLength: number;
  h1Count: number;
  wordCount: number;
  imagesMissingAlt: number;
  hasSchema: boolean;
  schemaTypes: string[];
  hasCanonical: boolean;
  noindex: boolean;
  htmlKB: number;
  issues: string[];
}

export interface CrawlResult {
  origin: string;
  /** Колко адреса реално са изтеглени. */
  pagesCrawled: number;
  /** Колко адреса е имало в опашката, когато сме спрели. Разликата е недогледаното. */
  pagesDiscovered: number;
  /** Стигнали ли сме тавана — таблото го показва, за да не се чете „4 812“ като „всичко“. */
  truncated: boolean;
  /** 0–100. Среден технически резултат по обходените страници. */
  techScore: number;
  criticalIssues: number;
  /** Дял на страниците със schema.org разметка, 0–100. */
  schemaCoverage: number;
  avgResponseMs: number;
  brokenPages: { url: string; status: number }[];
  duplicateTitles: { title: string; urls: string[] }[];
  missingTitles: string[];
  missingDescriptions: string[];
  pages: CrawledPage[];
  source: 'sitemap' | 'links' | 'mixed';
}

/** Вътрешните адреси на страницата, вече канонизирани (без хеш и без `?`-шум). */
function internalLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const baseHost = normalizeHost(base.hostname);
  const out = new Set<string>();
  const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href || /^(mailto:|tel:|javascript:|data:|#)/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (normalizeHost(url.hostname) !== baseHost) continue;
      // Файловете за изтегляне не са страници и само изяждат бюджета.
      if (/\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|css|js|xml|json|ico|woff2?)$/i.test(url.pathname)) continue;
      url.hash = '';
      out.add(url.href);
    } catch {
      /* счупен href — пропускаме го */
    }
  }
  return [...out];
}

/** Леката проверка на една страница. Не хвърля: счупената страница е резултат. */
async function crawlOne(url: string): Promise<{ page: CrawledPage; links: string[] } | null> {
  const started = Date.now();
  try {
    const res = await httpFetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'bg,en;q=0.8' },
    });
    const responseTimeMs = Date.now() - started;
    const contentType = res.headers.get('content-type') ?? '';

    if (!res.ok || !contentType.includes('html')) {
      return {
        page: {
          url, status: res.status, ok: res.ok, responseTimeMs,
          title: null, titleLength: 0, metaDescriptionLength: 0, h1Count: 0, wordCount: 0,
          imagesMissingAlt: 0, hasSchema: false, schemaTypes: [], hasCanonical: false,
          noindex: false, htmlKB: 0,
          issues: res.ok ? [] : [`Адресът връща ${res.status}.`],
        },
        links: [],
      };
    }

    const raw = (await res.text()).slice(0, MAX_HTML_CHARS);
    const seo = auditSeo(raw);
    const structured = extractStructuredData(raw);
    const content = analyzeContent(raw);
    const schemaTypes = [...structured.jsonLdTypes, ...structured.microdataTypes];

    const issues: string[] = [];
    if (!seo.title) issues.push('Липсва <title>.');
    if (!seo.metaDescription) issues.push('Липсва мета описание.');
    if (seo.headingCounts.H1 !== 1) issues.push(`${seo.headingCounts.H1} × H1 (трябва да е точно едно).`);
    if (!seo.canonical) issues.push('Липсва canonical.');
    if (schemaTypes.length === 0) issues.push('Няма schema.org разметка.');
    if (content.wordCount < 150) issues.push(`Само ${content.wordCount} думи — няма какво да цитира AI модел.`);
    if (seo.imagesMissingAlt > 0) issues.push(`${seo.imagesMissingAlt} изображения без alt.`);

    return {
      page: {
        url: res.url || url,
        status: res.status,
        ok: true,
        responseTimeMs,
        title: seo.title,
        titleLength: seo.titleLength,
        metaDescriptionLength: seo.metaDescriptionLength,
        h1Count: seo.headingCounts.H1,
        wordCount: content.wordCount,
        imagesMissingAlt: seo.imagesMissingAlt,
        hasSchema: schemaTypes.length > 0,
        schemaTypes,
        hasCanonical: Boolean(seo.canonical),
        noindex: seo.noindex,
        htmlKB: Math.round(new TextEncoder().encode(raw).length / 1024),
        issues,
      },
      links: internalLinks(raw, res.url || url),
    };
  } catch {
    return {
      page: {
        url, status: 0, ok: false, responseTimeMs: Date.now() - started,
        title: null, titleLength: 0, metaDescriptionLength: 0, h1Count: 0, wordCount: 0,
        imagesMissingAlt: 0, hasSchema: false, schemaTypes: [], hasCanonical: false,
        noindex: false, htmlKB: 0,
        issues: ['Страницата не отговори навреме.'],
      },
      links: [],
    };
  }
}

/**
 * Обхожда сайта до `maxPages` адреса, като предпочита sitemap-а пред връзките.
 *
 * Sitemap-ът е списъкът, който сайтът сам обявява за важен; обхождането по
 * връзки намира това, което наистина е достъпно. При наличен sitemap ползваме
 * него като начало и допълваме с връзки — двете заедно показват и разминаването.
 */
export async function crawlSite(safeUrl: string, maxPages = 25): Promise<CrawlResult> {
  const start = new URL(safeUrl);
  const origin = start.origin;

  const robots = await fetchRobotsTxt(origin).catch(() => ({ found: false, sitemaps: [] as string[], rules: [], raw: '' }));
  const sitemap = await fetchSitemap(origin, robots.sitemaps).catch(() => null);

  const seeded = sitemap?.sampleUrls?.length ? sitemap.sampleUrls : [];
  const queue: string[] = [start.href, ...seeded.filter((u) => u !== start.href)];
  const seen = new Set<string>(queue);
  const pages: CrawledPage[] = [];

  let usedLinks = false;
  while (pages.length < maxPages && queue.length > 0) {
    const batch = queue.splice(0, Math.min(CRAWL_CONCURRENCY, maxPages - pages.length));
    const results = await Promise.all(batch.map((url) => crawlOne(url)));
    for (const result of results) {
      if (!result) continue;
      pages.push(result.page);
      for (const link of result.links) {
        if (seen.size >= maxPages * 4) break; // опашката също има таван
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push(link);
        usedLinks = true;
      }
    }
  }

  const okPages = pages.filter((p) => p.ok);
  const withSchema = okPages.filter((p) => p.hasSchema).length;
  const criticalIssues = pages.reduce((sum, p) => sum + p.issues.length, 0);

  // Техническият резултат е средно по страница: всяка тръгва от 100 и губи
  // точки по тежест на проблема. Пресмята се тук, а не в модел — оценка,
  // която се мени между две еднакви обхождания, не е оценка.
  const perPageScore = (p: CrawledPage): number => {
    if (!p.ok) return 0;
    let score = 100;
    if (!p.title) score -= 18;
    else if (p.titleLength > 60 || p.titleLength < 10) score -= 6;
    if (p.metaDescriptionLength === 0) score -= 12;
    else if (p.metaDescriptionLength > 160 || p.metaDescriptionLength < 50) score -= 4;
    if (p.h1Count !== 1) score -= 12;
    if (!p.hasCanonical) score -= 8;
    if (!p.hasSchema) score -= 14;
    if (p.wordCount < 150) score -= 12;
    if (p.imagesMissingAlt > 0) score -= Math.min(8, p.imagesMissingAlt);
    if (p.responseTimeMs > 2000) score -= 8;
    else if (p.responseTimeMs > 1000) score -= 4;
    if (p.htmlKB > 500) score -= 6;
    return Math.max(0, score);
  };

  const techScore = okPages.length
    ? Math.round(okPages.reduce((sum, p) => sum + perPageScore(p), 0) / okPages.length)
    : 0;

  const titleGroups = new Map<string, string[]>();
  for (const page of okPages) {
    if (!page.title) continue;
    const key = page.title.trim().toLowerCase();
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), page.url]);
  }

  return {
    origin,
    pagesCrawled: pages.length,
    pagesDiscovered: seen.size,
    truncated: queue.length > 0 || pages.length >= maxPages,
    techScore,
    criticalIssues,
    schemaCoverage: okPages.length ? Math.round((withSchema / okPages.length) * 100) : 0,
    avgResponseMs: okPages.length
      ? Math.round(okPages.reduce((sum, p) => sum + p.responseTimeMs, 0) / okPages.length)
      : 0,
    brokenPages: pages.filter((p) => !p.ok).map((p) => ({ url: p.url, status: p.status })).slice(0, 20),
    duplicateTitles: [...titleGroups.entries()]
      .filter(([, urls]) => urls.length > 1)
      .map(([title, urls]) => ({ title, urls: urls.slice(0, 5) }))
      .slice(0, 10),
    missingTitles: okPages.filter((p) => !p.title).map((p) => p.url).slice(0, 10),
    missingDescriptions: okPages.filter((p) => p.metaDescriptionLength === 0).map((p) => p.url).slice(0, 10),
    pages,
    source: seeded.length && usedLinks ? 'mixed' : seeded.length ? 'sitemap' : 'links',
  };
}
