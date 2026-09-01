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

/**
 * Кои от задължителните настройки липсват.
 *
 * Двете се бъркат лесно и се оправят на различни места: binding-ът идва от
 * `wrangler.jsonc` и иска нов деплой, а секретът се задава в таблото и важи
 * веднага. Отговор, който казва само „не е настроено“, праща човека да гадае
 * между двете — затова тук се изброяват поименно.
 */
export function missingConfig(env: Env | undefined): string[] {
  const missing: string[] = [];
  if (!env?.DB) missing.push('базата D1 (binding „DB“ — идва от wrangler.jsonc, иска деплой)');
  if (!env?.SESSION_SECRET) missing.push('SESSION_SECRET (Settings → Variables and Secrets)');
  return missing;
}

export function notConfigured(missing: string[]): string {
  return `Приложението не е настроено. Липсва: ${missing.join('; ')}.`;
}

export function guardApi(context: APIContext): GuardResult {
  const env = context.locals.runtime?.env;
  const missing = missingConfig(env);
  if (missing.length > 0 || !env?.DB || !env.SESSION_SECRET) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: notConfigured(missing) }, { status: 503 }),
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
