import type { APIRoute } from 'astro';
import { exchangeCode, fetchGoogleEmail, googleConfig, saveGoogleAccount } from '../../../lib/google';
import { guardApi } from '../../../lib/guard';

export const prerender = false;

/** Десет минути е повече, отколкото трае едно влизане в Google. */
const STATE_TTL_MS = 10 * 60 * 1000;

function back(context: Parameters<APIRoute>[0], status: string): Response {
  return context.redirect(`/tablo/?google=${status}`, 303);
}

export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env, db, user } = guard.context;

  const config = googleConfig(env, context.request.url);
  if (!config || !env.TOKEN_ENC_KEY) return back(context, 'not-configured');

  const error = context.url.searchParams.get('error');
  if (error) return back(context, 'denied');

  const code = context.url.searchParams.get('code');
  const state = context.url.searchParams.get('state');
  if (!code || !state) return back(context, 'invalid');

  // Низът се ИЗТРИВА при проверката — веднъж използван, не важи втори път.
  const row = await db
    .prepare('SELECT user_id, created_utc FROM oauth_states WHERE state = ?')
    .bind(state)
    .first<{ user_id: string; created_utc: number }>();
  await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();

  if (!row || row.user_id !== user.id || Date.now() - row.created_utc > STATE_TTL_MS) {
    return back(context, 'invalid');
  }

  const tokens = await exchangeCode(config, code);
  if (!tokens.refresh_token) {
    // Google дава refresh токен само при `prompt=consent`. Липсва ли —
    // връзката би издържала час и после мълчаливо би спряла, затова не я
    // записваме изобщо.
    return back(context, 'no-refresh');
  }

  const email = tokens.access_token ? await fetchGoogleEmail(tokens.access_token) : '';
  await saveGoogleAccount(db, env.TOKEN_ENC_KEY, user.id, tokens.refresh_token, email);
  return back(context, 'ok');
};
