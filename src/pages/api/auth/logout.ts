import type { APIRoute } from 'astro';
import { clearCookieHeader } from '../../../lib/auth';
import { destroySession } from '../../../lib/db';

export const prerender = false;

/**
 * Излизането трие сесията В БАЗАТА, не само бисквитката.
 *
 * Изчистена бисквитка при жива сесия значи, че копие на стойността ѝ —
 * от лог, от разширение, от чужд браузър — още работи.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const env = locals.runtime?.env;
  if (env?.DB && env.SESSION_SECRET) {
    await destroySession(env.DB, env.SESSION_SECRET, request.headers.get('cookie')).catch(() => undefined);
  }

  const response = redirect('/vhod/', 303);
  response.headers.set('Set-Cookie', clearCookieHeader);
  return response;
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
