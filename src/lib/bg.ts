/**
 * Български дребни неща, които всяко място иначе прави по своему.
 *
 * Числата в интерфейса излизат от базата и почти винаги стоят до
 * съществително. „1 съобщения“ е дребна грешка, но е точно тази, която
 * читателят вижда първа и заради която спира да вярва на останалото.
 */

/** `plural(1, 'съобщение', 'съобщения')` → `1 съобщение`. */
export function plural(count: number, one: string, many: string, withNumber = true): string {
  const word = Math.abs(count) === 1 ? one : many;
  return withNumber ? `${count.toLocaleString('bg-BG')} ${word}` : word;
}

export const messages = (count: number): string => plural(count, 'съобщение', 'съобщения');
export const queries = (count: number): string => plural(count, 'заявка', 'заявки');
export const checks = (count: number): string => plural(count, 'проверка', 'проверки');
export const pages = (count: number): string => plural(count, 'страница', 'страници');
export const days = (count: number): string => plural(count, 'ден', 'дни');
export const points = (count: number): string => plural(count, 'точка', 'точки');
