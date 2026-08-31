import type { APIRoute } from 'astro';
import { addTask, completeTask, listTasks, primaryDomain } from '../../lib/db';
import { guardApi, readJson } from '../../lib/guard';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const tasks = await listTasks(guard.context.db, guard.context.user.id, 30);
  return Response.json({ ok: true, tasks });
};

export const POST: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const body = await readJson<{ title?: unknown; detail?: unknown; priority?: unknown; impact?: unknown }>(
    context.request,
  );
  if (typeof body?.title !== 'string' || body.title.trim().length < 3) {
    return Response.json({ ok: false, error: 'Задачата трябва да има заглавие.' }, { status: 422 });
  }

  const domain = await primaryDomain(db, user.id);
  const id = await addTask(db, user.id, {
    domainId: domain?.id ?? null,
    title: body.title.trim(),
    detail: typeof body.detail === 'string' ? body.detail : '',
    priority: typeof body.priority === 'string' ? body.priority : 'medium',
    impact: typeof body.impact === 'number' ? body.impact : 0,
    source: 'user',
  });
  return Response.json({ ok: true, id });
};

export const PATCH: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;

  const body = await readJson<{ id?: unknown }>(context.request);
  if (typeof body?.id !== 'string') {
    return Response.json({ ok: false, error: 'Липсва идентификатор.' }, { status: 400 });
  }
  await completeTask(guard.context.db, guard.context.user.id, body.id);
  return Response.json({ ok: true });
};
