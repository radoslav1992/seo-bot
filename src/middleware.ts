import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { userFromRequest } from './lib/db';

/**
 * Четенето на сесията става веднъж, тук.
 *
 * Иначе всяка страница и всеки маршрут го правят сами и рано или късно един
 * от тях забравя — а забравената проверка на страница с данни не изглежда
 * като грешка, изглежда като работеща страница.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  /*
   * Пререндерираните страници минават през middleware-а И ПРИ БИЛДА, където
   * заглавките на заявката не съществуват. Четенето им там е предупреждение
   * и празен резултат, така че статичните страници просто се пропускат —
   * те и без това не показват нищо лично.
   */
  if (context.isPrerendered) return next();

  // SameSite=Lax protects the session cookie in most browser flows, but an
  // explicit origin check also covers JSON writes and form posts. Requests
  // without Origin remain valid for non-browser API clients and local tools.
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method.toUpperCase());
  if (unsafe) {
    const origin = context.request.headers.get('origin');
    const fetchSite = context.request.headers.get('sec-fetch-site');
    let foreignOrigin = false;
    if (origin) {
      try {
        foreignOrigin = new URL(origin).origin !== context.url.origin;
      } catch {
        foreignOrigin = true;
      }
    }
    if (fetchSite === 'cross-site' || foreignOrigin) {
      return Response.json({ ok: false, error: 'Заявката е отказана от защитата на сайта.' }, { status: 403 });
    }
  }

  context.locals.user = await userFromRequest(
    env.DB,
    env.SESSION_SECRET,
    context.request.headers.get('cookie'),
  ).catch(() => null);

  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'self'; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; upgrade-insecure-requests",
  );
  if (context.url.pathname.startsWith('/api/') || context.url.pathname === '/tablo/' || context.url.pathname === '/chat/') {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
});
