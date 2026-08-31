import type { APIRoute } from 'astro';
import { randomId } from '../../../lib/auth';
import { authorizeUrl, googleConfig, googleScopes } from '../../../lib/google';
import { guardApi } from '../../../lib/guard';

export const prerender = false;

/** Започва OAuth потока към Google. */
export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env, db, user } = guard.context;

  const config = googleConfig(env, context.request.url);
  if (!config || !env.TOKEN_ENC_KEY) {
    return Response.json(
      { ok: false, error: 'Връзката с Google не е настроена на този сървър (липсват GOOGLE_CLIENT_ID/SECRET или TOKEN_ENC_KEY).' },
      { status: 503 },
    );
  }

  // Еднократен низ в базата, вързан за потребителя. Без него върнатият от
  // Google код може да бъде подхлъзнат от чужд браузър и да закачи чужд
  // Google акаунт към този профил.
  const state = randomId(24);
  await db
    .prepare('INSERT INTO oauth_states (state, user_id, created_utc) VALUES (?, ?, ?)')
    .bind(state, user.id, Date.now())
    .run();

  return context.redirect(authorizeUrl(config, state, googleScopes(env)), 302);
};
