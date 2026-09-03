import type { APIRoute } from 'astro';
import { isMissingSchema, loginUser, MISSING_SCHEMA_MESSAGE } from '../../../lib/db';
import { missingConfig, notConfigured, readJson, serverError } from '../../../lib/guard';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  const missing = missingConfig(env);
  if (missing.length > 0 || !env?.DB || !env.SESSION_SECRET) {
    return Response.json({ ok: false, error: notConfigured(missing) }, { status: 503 });
  }

  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') {
    return Response.json({ ok: false, error: 'Невалидно запитване.' }, { status: 400 });
  }

  let result;
  try {
    result = await loginUser(env.DB, env.SESSION_SECRET, { email: body.email, password: body.password });
  } catch (error) {
    if (isMissingSchema(error)) {
      return Response.json({ ok: false, error: MISSING_SCHEMA_MESSAGE }, { status: 503 });
    }
    return serverError(error, env);
  }
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 401 });

  return Response.json({ ok: true, redirect: '/tablo/' }, { headers: { 'Set-Cookie': result.setCookie } });
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
