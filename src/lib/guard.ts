/**
 * Проверката „влязъл ли е“ за страници и за маршрути.
 *
 * Двете се различават само по отговора при отказ: страницата пренасочва към
 * входа, а маршрутът връща 401 — пренасочване в отговор на `fetch` изглежда
 * като успех и после се чупи при разчитането на JSON.
 */

import type { APIContext } from 'astro';
import type { SessionUser } from './auth';

export interface AppContext {
  env: Env;
  db: D1Database;
  user: SessionUser;
}

export type GuardResult = { ok: true; context: AppContext } | { ok: false; response: Response };

const NOT_CONFIGURED = 'Приложението не е настроено: липсва връзка с базата или SESSION_SECRET.';

export function guardApi(context: APIContext): GuardResult {
  const env = context.locals.runtime?.env;
  if (!env?.DB || !env.SESSION_SECRET) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: NOT_CONFIGURED }, { status: 503 }),
    };
  }
  const user = context.locals.user;
  if (!user) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'Влез в акаунта си.' }, { status: 401 }),
    };
  }
  return { ok: true, context: { env, db: env.DB, user } };
}

/** Прочита JSON тялото и се проваля тихо на невалидно — викащият решава какво значи. */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
