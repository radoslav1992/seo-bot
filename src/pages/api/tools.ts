import type { APIRoute } from 'astro';
import { listCompetitors, primaryDomain } from '../../lib/db';
import { guardApi, readJson } from '../../lib/guard';
import { prepareToolRuntime, runTool, TOOLS } from '../../lib/tools';

export const prerender = false;

/**
 * Директно извикване на инструмент, без чат.
 *
 * Бутоните в таблото („Нова проверка“, „Обходи сайта“) вършат същото, което
 * ботът прави сам — само че потребителят го поиска изрично. Един и същ код
 * зад двата пътя значи, че поправка на инструмент важи и за двата.
 */
export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  return Response.json({
    ok: true,
    tools: Object.entries(TOOLS).map(([name, tool]) => ({
      name,
      description: tool.schema.description,
      credits: tool.credits,
    })),
  });
};

export const POST: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env, db, user } = guard.context;

  const body = await readJson<{ tool?: unknown; args?: unknown }>(context.request);
  const name = typeof body?.tool === 'string' ? body.tool : '';
  if (!TOOLS[name]) return Response.json({ ok: false, error: 'Няма такъв инструмент.' }, { status: 404 });

  prepareToolRuntime(env, context.request.url);
  const domain = await primaryDomain(db, user.id);

  const log = await runTool(
    name,
    (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>,
    { env, db, user, domain, requestUrl: context.request.url },
  );

  // Провалът на инструмент не е провал на заявката: клиентът иска да покаже
  // причината, а не да види мрежова грешка.
  return Response.json({
    ok: log.ok,
    error: log.ok ? undefined : log.summary,
    summary: log.summary,
    data: log.data,
    kind: log.kind,
    credits: log.credits,
    competitors: domain ? await listCompetitors(db, domain.id) : [],
  });
};
