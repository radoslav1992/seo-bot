import type { APIRoute } from 'astro';
import { accessTokenFor, disconnectGoogle, ga4ListProperties, googleAccountEmail, gscListSites } from '../../../lib/google';
import { guardApi } from '../../../lib/guard';

export const prerender = false;

/** Какво вижда таблото: свързан ли е Google и кои имоти са достъпни. */
export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env, db, user } = guard.context;

  const configured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY);
  const email = await googleAccountEmail(db, user.id);
  if (!configured || !email) return Response.json({ ok: true, configured, connected: false });

  const token = await accessTokenFor(db, env, context.request.url, user.id);
  if (!token) {
    // Записана връзка, която вече не дава токен, е по-лоша от липсваща:
    // таблото би показвало „свързано“, а всяка заявка би се проваляла.
    return Response.json({ ok: true, configured, connected: false, expired: true, email });
  }

  const [sites, properties] = await Promise.all([
    gscListSites(token).catch(() => []),
    ga4ListProperties(token).catch(() => []),
  ]);

  return Response.json({ ok: true, configured, connected: true, email, sites, properties });
};

export const DELETE: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  await disconnectGoogle(guard.context.db, guard.context.user.id);
  return Response.json({ ok: true });
};
