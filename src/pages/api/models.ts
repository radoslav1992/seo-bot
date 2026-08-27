import type { APIRoute } from 'astro';
import { guardApi } from '../../lib/guard';
import { checkEngines, engines, isGrounded } from '../../lib/visibility';
import { DEFAULT_CHAT_MODEL, DEFAULT_FAST_MODEL, runChat } from '../../lib/ai';

export const prerender = false;

/**
 * Проверка на моделите.
 *
 * Каталогът на Workers AI се мени — модели идват и си отиват, а вчерашният
 * идентификатор може да е изчезнал. Без тази проверка това се вижда като
 * спаднал до нула резултат на таблото, което е най-лошата форма на грешка:
 * изглежда като лоша новина за бизнеса, а е грешка в конфигурацията.
 *
 * Пуска се след деплой и след всяка смяна на модел. Струва по едно кратко
 * извикване на модел, затова не се вика при всяко зареждане на таблото.
 */
export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env } = guard.context;

  if (!env.AI) {
    return Response.json({
      ok: false,
      error: 'Workers AI не е свързан. Провери `"ai": { "binding": "AI" }` в wrangler.jsonc.',
    }, { status: 503 });
  }

  // Двигателите с търсене минават през Gateway, не през binding-а — липсващият
  // токен е най-честата причина цялата видимост да е празна.
  const gatewayReady = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);

  const chatModel = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
  const fastModelId = env.FAST_MODEL || DEFAULT_FAST_MODEL;

  /** Един кратък въпрос — проверяваме дали моделът съществува, не колко е добър. */
  const ping = async (model: string): Promise<{ model: string; ok: boolean; ms: number; error?: string }> => {
    const started = Date.now();
    try {
      const result = await runChat(env, [{ role: 'user', content: 'Кажи само думата „готово“.' }], {
        model,
        maxTokens: 16,
      });
      return { model, ok: result.text.trim().length > 0, ms: Date.now() - started };
    } catch (error) {
      return {
        model,
        ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : 'няма отговор',
      };
    }
  };

  const [chat, fast, engineHealth] = await Promise.all([
    ping(chatModel),
    ping(fastModelId),
    checkEngines(env),
  ]);

  const working = engineHealth.filter((engine) => engine.ok).length;
  const groundedWorking = engineHealth.filter((engine) => engine.ok && engine.grounded).length;
  const groundedConfigured = engines(env).filter(isGrounded).length;

  return Response.json({
    ok: true,
    chat: { role: 'чат и инструменти', ...chat },
    fast: { role: 'заглавия и кратки задачи', ...fast },
    engines: engineHealth,
    configured: engines(env).length,
    working,
    gatewayReady,
    groundedConfigured,
    groundedWorking,
    // Съветът се дава тук, а не в интерфейса: който вика този маршрут, иска
    // да знае какво да поправи, а не само че нещо не е наред.
    hint: !gatewayReady && groundedConfigured > 0
      ? 'Липсват CLOUDFLARE_ACCOUNT_ID или CLOUDFLARE_API_TOKEN — без тях нито един двигател с живо търсене не работи и видимост НЕ се мери.'
      : groundedConfigured === 0
        ? 'Няма настроен двигател с живо търсене. Без такъв продуктът мери само познатост, не видимост.'
        : groundedWorking === 0
          ? 'Нито един двигател с търсене не отговаря. Провери идентификаторите на моделите срещу каталога на AI Gateway и ги задай в VISIBILITY_ENGINES.'
          : engineHealth.some((engine) => !engine.ok)
            ? 'Част от двигателите не отговарят — виж грешките и поправи идентификаторите им в VISIBILITY_ENGINES.'
            : 'Всички настроени двигатели отговарят.',
  });
};
