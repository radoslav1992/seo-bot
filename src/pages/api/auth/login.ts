import type { APIRoute } from 'astro';
import { loginUser } from '../../../lib/db';
import { readJson } from '../../../lib/guard';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  if (!env?.DB || !env.SESSION_SECRET) {
    return Response.json({ ok: false, error: 'Входът не е настроен на този сървър.' }, { status: 503 });
  }

  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') {
    return Response.json({ ok: false, error: 'Невалидно запитване.' }, { status: 400 });
  }

  const result = await loginUser(env.DB, env.SESSION_SECRET, { email: body.email, password: body.password });
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 401 });

  return Response.json({ ok: true, redirect: '/tablo/' }, { headers: { 'Set-Cookie': result.setCookie } });
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
