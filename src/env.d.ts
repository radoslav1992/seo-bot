/// <reference types="astro/client" />

/**
 * Ръчни декларации вместо `@cloudflare/workers-types`.
 *
 * Пакетът тежи мегабайти дефиниции заради шепата методи отдолу и внася
 * глобални типове, които се разминават с тези на Astro. Тук стои само това,
 * което приложението наистина ползва.
 */

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface D1Result<T> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<{ success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface KVNamespace {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Workers AI. `run` връща обект или поток според `stream`. */
interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

interface Env {
  /** Workers AI — моделите зад чата и зад проверката на видимост. */
  AI?: AiBinding;
  /** Данните. Bound in wrangler.jsonc → `d1_databases`. */
  DB?: D1Database;
  /** Кеш за одити и проверки. Липсва ли, всичко работи, просто по-бавно. */
  CACHE?: KVNamespace;
  /** Статичният билд — позволява на Worker-а да анализира собствените си страници. */
  ASSETS?: AssetsBinding;

  /** Подписва бисквитките за вход. Без него входът връща 503. */
  SESSION_SECRET?: string;
  /** Шифрова Google refresh токените в D1. Без него връзката с Google е изключена. */
  TOKEN_ENC_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  PUBLIC_SITE_URL?: string;
  /** Моделът за чата и инструментите. Трябва да поддържа tool calling. */
  CHAT_MODEL?: string;
  /** По-малкият модел за заглавия и кратки задачи. */
  FAST_MODEL?: string;
  /**
   * Двигателите за проверка на видимост, като JSON низ (виж wrangler.jsonc).
   * Празно значи „ползвай вградения списък“.
   */
  VISIBILITY_ENGINES?: string;

  /**
   * По избор: живите двигатели покрай моделите на Cloudflare. Липсва ли
   * ключът, двигателят се показва като „не отговаря“ и не се подменя с друг.
   */
  OPENAI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Влезлият потребител, ако има. Попълва се от `src/middleware.ts`. */
    user?: import('./lib/auth').SessionUser | null;
  }
}
