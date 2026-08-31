import type { APIRoute } from 'astro';
import {
  exchangeCode, fetchGoogleEmail, googleConfig, googleScopes, gscListSites, matchSiteForDomain,
  saveGoogleAccount,
} from '../../../lib/google';
import { listDomains } from '../../../lib/db';
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
  await saveGoogleAccount(db, env.TOKEN_ENC_KEY, user.id, tokens.refresh_token, email, googleScopes(env));

  /*
   * Имотът се закача сам, докато токенът е още в ръка.
   *
   * Иначе „свързах Google“ и „ботът вижда данните ми“ са две различни неща,
   * а между тях стои падащо меню, в което повечето хора не знаят разликата
   * между `sc-domain:` и адрес с префикс. Не се ли уцели — менюто си остава
   * там и потребителят избира ръчно.
   */
  let matched: string | null = null;
  if (tokens.access_token) {
    try {
      const [sites, domains] = await Promise.all([
        gscListSites(tokens.access_token),
        listDomains(db, user.id),
      ]);
      for (const domain of domains) {
        if (domain.gsc_site) continue;
        const site = matchSiteForDomain(sites, domain.domain);
        if (!site) continue;
        await db
          .prepare('UPDATE domains SET gsc_site = ? WHERE id = ? AND user_id = ?')
          .bind(site, domain.id, user.id)
          .run();
        matched = matched ?? site;
      }
    } catch {
      /* закачането е удобство, не условие — връзката вече е записана */
    }
  }

  return back(context, matched ? 'ok-matched' : 'ok');
};
