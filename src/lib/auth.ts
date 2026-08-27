/**
 * Вход, регистрация и сесии.
 *
 * Всичко минава през WebCrypto — това, което Worker-ът има без библиотеки.
 * Паролите се хешират с PBKDF2-SHA256, а сесията е ред в D1 плюс подписана
 * бисквитка: така „излез от всички устройства“ е DELETE, а не изчакване
 * токенът да изтече.
 */

const COOKIE = 'sb_session';
/** Тридесет дни — колкото „Запомни ме“ в дизайна обещава. */
const TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * Итерациите се пазят В хеша, не тук. Така броят може да се вдигне утре, без
 * вчерашните пароли да станат неразпознаваеми — проверката чете своя брой от
 * записа, а не от кода.
 */
const PBKDF2_ITERATIONS = 210_000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  plan: 'free' | 'pro' | 'business';
  credits: number;
  creditsLimit: number;
  renewsUtc: number | null;
}

/* ---------------------------------------------------------------- */
/* Малки помощници                                                   */
/* ---------------------------------------------------------------- */

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Сравнение в постоянно време — иначе времето за отговор издава колко от подписа съвпада. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------------------------------------------------------- */
/* Пароли                                                            */
/* ---------------------------------------------------------------- */

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterationsRaw || !saltRaw || !hashRaw) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const hash = await pbkdf2(password, fromBase64(saltRaw), iterations);
  return safeEqual(toBase64(hash), hashRaw);
}

/** Правилата от дизайна: поне 10 знака и поне една цифра. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Паролата трябва да е поне 10 символа.';
  if (!/\d/.test(password)) return 'Паролата трябва да съдържа поне една цифра.';
  if (password.length > 256) return 'Паролата е твърде дълга.';
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value) && value.length <= 254;
}

/* ---------------------------------------------------------------- */
/* Бисквитката                                                       */
/* ---------------------------------------------------------------- */

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toBase64(new Uint8Array(signature)).replace(/=+$/, '');
}

/**
 * Бисквитката носи идентификатора на сесията И подпис върху него.
 *
 * Подписът не пази тайна — той пази от познаване: без него всеки може да
 * пробва милион случайни идентификатора срещу базата и всеки опит е заявка,
 * която ние плащаме. С подписа непознатите стойности отпадат преди D1.
 */
export async function issueCookie(sessionId: string, secret: string): Promise<string> {
  return `${sessionId}.${await sign(sessionId, secret)}`;
}

export async function readCookieValue(value: string | undefined, secret: string): Promise<string | null> {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  return safeEqual(signature, await sign(id, secret)) ? id : null;
}

export function cookieHeader(value: string, maxAge = TTL_SECONDS): string {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    // `Lax`, а не `Strict`: връщането от Google OAuth е навигация отвън и при
    // `Strict` бисквитката не тръгва — потребителят се озовава излязъл точно
    // в момента, в който свързва акаунта си.
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export const clearCookieHeader = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export const COOKIE_NAME = COOKIE;
export const SESSION_TTL_SECONDS = TTL_SECONDS;

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/* ---------------------------------------------------------------- */
/* Шифроване на чужди токени (Google refresh token)                  */
/* ---------------------------------------------------------------- */

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Google refresh токенът е дълготраен ключ към чужди данни — той е
 * единственото в тази база, чието изтичане е чужд проблем, не наш. Затова не
 * лежи в чист вид: изтекъл дъмп на D1 без `TOKEN_ENC_KEY` не отваря ничий
 * Search Console.
 */
export async function encryptSecret(plain: string, key: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    await encryptionKey(key),
    new TextEncoder().encode(plain),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(stored: string, key: string): Promise<string | null> {
  const [ivRaw, dataRaw] = stored.split('.');
  if (!ivRaw || !dataRaw) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivRaw) as unknown as BufferSource },
      await encryptionKey(key),
      fromBase64(dataRaw) as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
