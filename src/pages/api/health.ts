import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/** Minimal deployment probe. It never returns secrets or customer data. */
export const GET: APIRoute = async () => {
  let database = false;
  if (env.DB) {
    database = await env.DB.prepare('SELECT 1 AS ok FROM users LIMIT 1')
      .first<{ ok: number }>()
      .then(() => true)
      .catch(() => false);
  }

  const checks = {
    database,
    sessionSecret: Boolean(env.SESSION_SECRET),
    workersAI: Boolean(env.AI),
  };
  const ready = Object.values(checks).every(Boolean);
  return Response.json(
    { ok: ready, status: ready ? 'ready' : 'configuration-required', checks },
    { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
