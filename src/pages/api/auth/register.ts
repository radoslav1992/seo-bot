import type { APIRoute } from 'astro';
import { addDomain, isMissingSchema, MISSING_SCHEMA_MESSAGE, registerUser } from '../../../lib/db';
import { isEmail, normalizeEmail, passwordProblem } from '../../../lib/auth';
import { missingConfig, notConfigured, readJson } from '../../../lib/guard';

export const prerender = false;

interface Body {
  name?: unknown;
  email?: unknown;
  password?: unknown;
  domain?: unknown;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  const missing = missingConfig(env);
  if (missing.length > 0 || !env?.DB || !env.SESSION_SECRET) {
    return Response.json({ ok: false, error: notConfigured(missing) }, { status: 503 });
  }

  const body = await readJson<Body>(request);
  if (!body) return Response.json({ ok: false, error: 'Невалидно запитване.' }, { status: 400 });

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (name.length < 2) return Response.json({ ok: false, error: 'Въведи име и фамилия.' }, { status: 422 });
  if (!isEmail(email)) return Response.json({ ok: false, error: 'Въведи валиден имейл адрес.' }, { status: 422 });
  const problem = passwordProblem(password);
  if (problem) return Response.json({ ok: false, error: problem }, { status: 422 });

  let result;
  try {
    result = await registerUser(env.DB, env.SESSION_SECRET, { name, email, password });
  } catch (error) {
    // Първата регистрация е и първото докосване до базата — тук се вижда
    // пропуснатата миграция и тук трябва да се каже какво да се направи.
    if (isMissingSchema(error)) {
      return Response.json({ ok: false, error: MISSING_SCHEMA_MESSAGE }, { status: 503 });
    }
    throw error;
  }
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 409 });

  // Домейнът е по избор — акаунт без него си е акаунт, просто таблото ще
  // поиска един, преди да покаже числа.
  if (typeof body.domain === 'string' && body.domain.trim()) {
    await addDomain(env.DB, result.user.id, body.domain, true).catch(() => null);
  }

  return Response.json({ ok: true, redirect: '/tablo/' }, { headers: { 'Set-Cookie': result.setCookie } });
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
