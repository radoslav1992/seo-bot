import { defineMiddleware } from 'astro:middleware';
import { userFromRequest } from './lib/db';

/**
 * Четенето на сесията става веднъж, тук.
 *
 * Иначе всяка страница и всеки маршрут го правят сами и рано или късно един
 * от тях забравя — а забравената проверка на страница с данни не изглежда
 * като грешка, изглежда като работеща страница.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  /*
   * Пререндерираните страници минават през middleware-а И ПРИ БИЛДА, където
   * заглавките на заявката не съществуват. Четенето им там е предупреждение
   * и празен резултат, така че статичните страници просто се пропускат —
   * те и без това не показват нищо лично.
   */
  if (context.isPrerendered) return next();

  const env = context.locals.runtime?.env;
  context.locals.user = await userFromRequest(
    env?.DB,
    env?.SESSION_SECRET,
    context.request.headers.get('cookie'),
  ).catch(() => null);
  return next();
});
