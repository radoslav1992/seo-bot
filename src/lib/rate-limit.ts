/** Small D1-backed limiter for public authentication endpoints. */

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestKey(request: Request, secret: string, scope: string): Promise<string> {
  const forwarded = request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
  const agent = request.headers.get('user-agent')?.slice(0, 160) ?? 'unknown';
  const material = new TextEncoder().encode(`${scope}\n${forwarded}\n${agent}\n${secret}`);
  return `${scope}:${hex(await crypto.subtle.digest('SHA-256', material))}`;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export async function consumeRateLimit(
  db: D1Database,
  request: Request,
  secret: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const key = await requestKey(request, secret, scope);
  const now = Date.now();
  const resetBefore = now - windowMs;
  const expires = now + windowMs;

  await db.prepare(
    `INSERT INTO rate_limits (key, window_start_utc, hits, expires_utc)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       hits = CASE WHEN window_start_utc < ? THEN 1 ELSE hits + 1 END,
       window_start_utc = CASE WHEN window_start_utc < ? THEN excluded.window_start_utc ELSE window_start_utc END,
       expires_utc = CASE WHEN window_start_utc < ? THEN excluded.expires_utc ELSE expires_utc END`,
  ).bind(key, now, expires, resetBefore, resetBefore, resetBefore).run();

  const row = await db.prepare('SELECT hits, window_start_utc FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ hits: number; window_start_utc: number }>();
  const retryAfter = Math.max(1, Math.ceil(((row?.window_start_utc ?? now) + windowMs - now) / 1000));
  return { allowed: Boolean(row && row.hits <= limit), retryAfter };
}

export function rateLimitResponse(retryAfter: number): Response {
  return Response.json(
    { ok: false, error: 'Твърде много опити. Изчакай малко и опитай отново.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}
