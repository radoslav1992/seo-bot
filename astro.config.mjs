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
  // Authentication sessions live in D1; the built-in Astro KV session store
  // would be an unused second source of truth.
  session: false,
  adapter: cloudflare({
    imageService: 'compile',
    // Avoid port discovery in restricted CI containers; the inspector is
    // only used by the local workerd process during prerendering.
    inspectorPort: 9230,
    remoteBindings: false,
  }),
  integrations: [
    sitemap({
      // Таблото и чатът искат вход — покана към търсачките към тях е шум,
      // а не трафик.
      filter: (page) => !/\/(tablo|chat|vhod|404)\/?$/.test(page),
    }),
  ],
  build: { format: 'directory' },
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
});
