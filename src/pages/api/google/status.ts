import type { APIRoute } from 'astro';
import {
  accessTokenFor, analyticsEnabled, disconnectGoogle, ga4ListProperties, googleAccountEmail,
  googleAccountScopes, googleScopes, gscListSites,
} from '../../../lib/google';
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

  const [sites, properties, granted] = await Promise.all([
    gscListSites(token).catch(() => []),
    analyticsEnabled(env) ? ga4ListProperties(token).catch(() => []) : Promise.resolve([]),
    googleAccountScopes(db, user.id),
  ]);

  /*
   * Обхватите, които инсталацията иска СЕГА, срещу тези, с които е издаден
   * токенът. Разминаване значи, че потребителят трябва да свърже наново —
   * иначе новата функция просто мълчаливо не работи за него.
   */
  const wanted = googleScopes(env).split(' ').filter(Boolean);
  const missing = wanted.filter((scope) => !granted.includes(scope));

  return Response.json({
    ok: true, configured, connected: true, email, sites, properties,
    scopes: granted,
    needsReconnect: missing.length > 0,
    missingScopes: missing,
  });
};

export const DELETE: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  await disconnectGoogle(guard.context.db, guard.context.user.id);
  return Response.json({ ok: true });
};
