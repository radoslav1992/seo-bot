// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

import { SITE } from './src/data/site.mjs';

/**
 * Публичните страници се пререндерират при билда и се качват като статични
 * файлове на Worker-а. Приложението (табло, чат) и всичко под `/api/` излиза
 * от това с `export const prerender = false` и се изпълнява в Worker-а —
 * там са и връзките към D1 и Workers AI.
 */
export default defineConfig({
  site: SITE.url,
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: { enabled: true },
  }),
  integrations: [
    sitemap({
      // Таблото и чатът искат вход — покана към търсачките към тях е шум,
      // а не трафик.
      filter: (page) => !/\/(tablo|chat|vhod)\/?$/.test(page),
    }),
  ],
  build: { format: 'directory' },
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
});
