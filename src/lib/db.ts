/**
 * Достъпът до D1 — един слой, за да не се разписва SQL из страниците.
 *
 * Всеки метод връща вече оформен обект, не ред от базата: колоните са
 * `snake_case` и nullable, а приложението не бива да ги разнася такива.
 */

import {
  cookieHeader,
  COOKIE_NAME,
  hashPassword,
  issueCookie,
  normalizeEmail,
  randomId,
  readCookie,
  readCookieValue,
  SESSION_TTL_SECONDS,
  verifyPassword,
  type SessionUser,
} from './auth';

export const PLANS = {
  free: { label: 'Free', credits: 50, domains: 1, competitors: 0, keywords: 10, crawlPages: 100 },
  pro: { label: 'Pro', credits: 3000, domains: 1, competitors: 3, keywords: 500, crawlPages: 10_000 },
  business: { label: 'Business', credits: 20_000, domains: 10, competitors: 10, keywords: 5000, crawlPages: 100_000 },
} as const;

export type PlanId = keyof typeof PLANS;

export function isPlan(value: string): value is PlanId {
  return value === 'free' || value === 'pro' || value === 'business';
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  plan: string;
  credits: number;
  credits_limit: number;
  renews_utc: number | null;
  created_utc: number;
}

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: isPlan(row.plan) ? row.plan : 'free',
    credits: row.credits,
    creditsLimit: row.credits_limit,
    renewsUtc: row.renews_utc,
  };
}

/* ---------------------------------------------------------------- */
/* Потребители и сесии                                               */
/* ---------------------------------------------------------------- */

export type RegisterResult =
  | { ok: true; user: SessionUser; setCookie: string }
  | { ok: false; error: string };

/** Първият месец е с датата на регистрация — подновяването е на същото число. */
function nextRenewal(now: number): number {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.getTime();
}

export async function registerUser(
  db: D1Database,
  secret: string,
  input: { email: string; name: string; password: string },
): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  const now = Date.now();
  const id = randomId();

  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, plan, credits, credits_limit, renews_utc, created_utc)
         VALUES (?, ?, ?, ?, 'free', ?, ?, ?, ?)`,
      )
      .bind(id, email, input.name.trim().slice(0, 120), await hashPassword(input.password),
        PLANS.free.credits, PLANS.free.credits, nextRenewal(now), now)
      .run();
  } catch (error) {
    // Уникалният индекс върху `email` е единствената защита от двоен запис —
    // проверка „зает ли е“ преди вмъкването е състезание. Затова грешката от
    // базата се превежда тук, а не се предотвратява преди нея.
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|constraint/i.test(message)) {
      return { ok: false, error: 'Вече има акаунт с този имейл. Влез вместо това.' };
    }
    throw error;
  }

  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  if (!row) return { ok: false, error: 'Акаунтът не можа да бъде създаден. Опитай отново.' };
  return { ok: true, user: toSessionUser(row), setCookie: await createSession(db, secret, id) };
}

export type LoginResult = { ok: true; user: SessionUser; setCookie: string } | { ok: false; error: string };

export async function loginUser(
  db: D1Database,
  secret: string,
  input: { email: string; password: string },
): Promise<LoginResult> {
  const row = await db
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(normalizeEmail(input.email))
    .first<UserRow>();

  /*
   * Едно и също съобщение за „няма такъв имейл“ и „грешна парола“.
   * Различните отговори превръщат формата за вход в справочник кой има акаунт.
   * Хешът се проверява и когато потребител няма — иначе бързият отказ издава
   * същото по време за отговор.
   */
  const stored = row?.password_hash ?? 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const valid = await verifyPassword(input.password, stored);
  if (!row || !valid) return { ok: false, error: 'Грешен имейл или парола.' };

  return { ok: true, user: toSessionUser(row), setCookie: await createSession(db, secret, row.id) };
}

export async function createSession(db: D1Database, secret: string, userId: string): Promise<string> {
  const id = randomId(24);
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_utc, created_utc) VALUES (?, ?, ?, ?)')
    .bind(id, userId, now + SESSION_TTL_SECONDS * 1000, now)
    .run();
  return cookieHeader(await issueCookie(id, secret));
}

/** Чете сесията от заявката. Връща `null` за всяка причина — викащият не различава. */
export async function userFromRequest(
  db: D1Database | undefined,
  secret: string | undefined,
  cookies: string | null,
): Promise<SessionUser | null> {
  if (!db || !secret) return null;
  const sessionId = await readCookieValue(readCookie(cookies, COOKIE_NAME), secret);
  if (!sessionId) return null;

  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_utc > ?`,
    )
    .bind(sessionId, Date.now())
    .first<UserRow>();
  return row ? toSessionUser(row) : null;
}

export async function destroySession(db: D1Database, secret: string, cookies: string | null): Promise<void> {
  const sessionId = await readCookieValue(readCookie(cookies, COOKIE_NAME), secret);
  if (sessionId) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

/* ---------------------------------------------------------------- */
/* Кредити                                                           */
/* ---------------------------------------------------------------- */

/**
 * Тегли кредити атомично.
 *
 * `WHERE credits >= ?` в самото UPDATE е разликата между лимит и пожелание:
 * при две едновременни заявки проверка-после-запис пропуска и двете, а това
 * условие пропуска само първата.
 */
export async function refundCredits(db: D1Database, userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  // Таванът пази от връщане над лимита, ако междувременно планът е сменен.
  await db
    .prepare('UPDATE users SET credits = MIN(credits + ?, credits_limit) WHERE id = ?')
    .bind(amount, userId)
    .run();
}

export async function spendCredits(db: D1Database, userId: string, amount: number): Promise<boolean> {
  if (amount <= 0) return true;
  const result = await db
    .prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
    .bind(amount, userId, amount)
    .run();
  const row = await db.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first<{ credits: number }>();
  return result.success && row !== null && row.credits >= 0;
}

/* ---------------------------------------------------------------- */
/* Домейни                                                           */
/* ---------------------------------------------------------------- */

export interface DomainRow {
  id: string;
  user_id: string;
  domain: string;
  is_primary: number;
  gsc_site: string | null;
  ga4_property: string | null;
  created_utc: number;
}

/** `https://www.Пример.bg/път` → `пример.bg`. Празен низ, ако нищо не остане. */
export function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split('/')[0]?.split('?')[0]?.split('#')[0] ?? '';
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value : '';
}

export async function listDomains(db: D1Database, userId: string): Promise<DomainRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM domains WHERE user_id = ? ORDER BY is_primary DESC, created_utc ASC')
    .bind(userId)
    .all<DomainRow>();
  return results;
}

export async function addDomain(
  db: D1Database,
  userId: string,
  domain: string,
  makePrimary = false,
): Promise<DomainRow | null> {
  const clean = normalizeDomain(domain);
  if (!clean) return null;
  const existing = await db
    .prepare('SELECT * FROM domains WHERE user_id = ? AND domain = ?')
    .bind(userId, clean)
    .first<DomainRow>();
  if (existing) return existing;

  const id = randomId();
  const isFirst = (await listDomains(db, userId)).length === 0;
  await db
    .prepare('INSERT INTO domains (id, user_id, domain, is_primary, created_utc) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, clean, makePrimary || isFirst ? 1 : 0, Date.now())
    .run();
  return db.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first<DomainRow>();
}

export async function primaryDomain(db: D1Database, userId: string): Promise<DomainRow | null> {
  const domains = await listDomains(db, userId);
  return domains[0] ?? null;
}

export async function listCompetitors(db: D1Database, domainId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT domain FROM competitors WHERE domain_id = ? ORDER BY created_utc ASC')
    .bind(domainId)
    .all<{ domain: string }>();
  return results.map((row) => row.domain);
}

export async function addCompetitor(db: D1Database, domainId: string, domain: string): Promise<boolean> {
  const clean = normalizeDomain(domain);
  if (!clean) return false;
  const existing = await listCompetitors(db, domainId);
  if (existing.includes(clean)) return true;
  await db
    .prepare('INSERT INTO competitors (id, domain_id, domain, created_utc) VALUES (?, ?, ?, ?)')
    .bind(randomId(), domainId, clean, Date.now())
    .run();
  return true;
}

/* ---------------------------------------------------------------- */
/* Чатове и съобщения                                                */
/* ---------------------------------------------------------------- */

export interface ChatRow {
  id: string;
  user_id: string;
  domain_id: string | null;
  title: string;
  created_utc: number;
  updated_utc: number;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tools_json: string | null;
  created_utc: number;
}

export async function listChats(db: D1Database, userId: string, limit = 40): Promise<(ChatRow & { messages: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages
       FROM chats c WHERE c.user_id = ? ORDER BY c.updated_utc DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ChatRow & { messages: number }>();
  return results;
}

export async function createChat(db: D1Database, userId: string, domainId: string | null): Promise<ChatRow> {
  const id = randomId();
  const now = Date.now();
  await db
    .prepare('INSERT INTO chats (id, user_id, domain_id, title, created_utc, updated_utc) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, domainId, 'Нов чат', now, now)
    .run();
  return { id, user_id: userId, domain_id: domainId, title: 'Нов чат', created_utc: now, updated_utc: now };
}

/** Чатът се взема заедно с потребителя — иначе чужд идентификатор отваря чужд разговор. */
export async function getChat(db: D1Database, userId: string, chatId: string): Promise<ChatRow | null> {
  return db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').bind(chatId, userId).first<ChatRow>();
}

export async function listMessages(db: D1Database, chatId: string, limit = 100): Promise<MessageRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_utc ASC LIMIT ?')
    .bind(chatId, limit)
    .all<MessageRow>();
  return results;
}

export async function addMessage(
  db: D1Database,
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  tools?: unknown,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare('INSERT INTO messages (id, chat_id, role, content, tools_json, created_utc) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomId(), chatId, role, content, tools ? JSON.stringify(tools) : null, now),
    db.prepare('UPDATE chats SET updated_utc = ? WHERE id = ?').bind(now, chatId),
  ]);
}

export async function renameChat(db: D1Database, chatId: string, title: string): Promise<void> {
  await db.prepare('UPDATE chats SET title = ? WHERE id = ?').bind(title.slice(0, 80), chatId).run();
}

export async function deleteChat(db: D1Database, userId: string, chatId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM messages WHERE chat_id = (SELECT id FROM chats WHERE id = ? AND user_id = ?)').bind(chatId, userId),
    db.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').bind(chatId, userId),
  ]);
}

/* ---------------------------------------------------------------- */
/* Задачи                                                            */
/* ---------------------------------------------------------------- */

export interface TaskRow {
  id: string;
  user_id: string;
  domain_id: string | null;
  title: string;
  detail: string;
  priority: string;
  impact: number;
  status: string;
  source: string;
  created_utc: number;
  done_utc: number | null;
}

export async function listTasks(db: D1Database, userId: string, limit = 20): Promise<TaskRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks WHERE user_id = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, impact DESC, created_utc DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<TaskRow>();
  return results;
}

export async function addTask(
  db: D1Database,
  userId: string,
  task: { domainId?: string | null; title: string; detail?: string; priority?: string; impact?: number; source?: string },
): Promise<string> {
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO tasks (id, user_id, domain_id, title, detail, priority, impact, status, source, created_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(id, userId, task.domainId ?? null, task.title.slice(0, 200), (task.detail ?? '').slice(0, 1000),
      task.priority === 'high' || task.priority === 'low' ? task.priority : 'medium',
      Math.max(0, Math.min(50, Math.round(task.impact ?? 0))), task.source ?? 'bot', Date.now())
    .run();
  return id;
}

export async function completeTask(db: D1Database, userId: string, taskId: string): Promise<void> {
  await db
    .prepare("UPDATE tasks SET status = 'done', done_utc = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), taskId, userId)
    .run();
}

/* ---------------------------------------------------------------- */
/* Одити и проверки на видимост                                      */
/* ---------------------------------------------------------------- */

export interface AuditRow {
  id: string;
  domain_id: string;
  url: string;
  geo_score: number;
  tech_score: number;
  issues: number;
  result_json: string;
  created_utc: number;
}

export async function saveAudit(
  db: D1Database,
  userId: string,
  domainId: string,
  audit: { url: string; geoScore: number; techScore: number; issues: number; result: unknown },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audits (id, user_id, domain_id, url, geo_score, tech_score, issues, result_json, created_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(randomId(), userId, domainId, audit.url, audit.geoScore, audit.techScore, audit.issues,
      JSON.stringify(audit.result), Date.now())
    .run();
}

export async function latestAudit(db: D1Database, domainId: string): Promise<AuditRow | null> {
  return db
    .prepare('SELECT * FROM audits WHERE domain_id = ? ORDER BY created_utc DESC LIMIT 1')
    .bind(domainId)
    .first<AuditRow>();
}

export interface VisibilityRow {
  id: string;
  domain_id: string;
  query: string;
  engine: string;
  mentioned: number;
  position: number | null;
  competitors: string;
  excerpt: string;
  grounded: number;
  created_utc: number;
}

export async function saveVisibility(
  db: D1Database,
  userId: string,
  domainId: string,
  checks: {
    query: string;
    engine: string;
    mentioned: boolean;
    position: number | null;
    competitors: string[];
    excerpt: string;
    grounded: boolean;
  }[],
): Promise<void> {
  if (checks.length === 0) return;
  const now = Date.now();
  await db.batch(
    checks.map((check) =>
      db
        .prepare(
          `INSERT INTO visibility_checks
             (id, user_id, domain_id, query, engine, mentioned, position, competitors, excerpt, grounded, created_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(randomId(), userId, domainId, check.query.slice(0, 300), check.engine,
          check.mentioned ? 1 : 0, check.position, check.competitors.join(','), check.excerpt.slice(0, 800),
          check.grounded ? 1 : 0, now),
    ),
  );
}

export async function visibilitySince(db: D1Database, domainId: string, sinceUtc: number): Promise<VisibilityRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM visibility_checks WHERE domain_id = ? AND created_utc >= ? ORDER BY created_utc DESC LIMIT 2000')
    .bind(domainId, sinceUtc)
    .all<VisibilityRow>();
  return results;
}
