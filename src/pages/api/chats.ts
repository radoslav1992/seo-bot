import type { APIRoute } from 'astro';
import { createChat, deleteChat, getChat, listChats, listMessages, primaryDomain } from '../../lib/db';
import { guardApi, readJson } from '../../lib/guard';

export const prerender = false;

/** GET /api/chats → списък; GET /api/chats?id=… → съобщенията на един чат. */
export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const id = context.url.searchParams.get('id');
  if (id) {
    const chat = await getChat(db, user.id, id);
    if (!chat) return Response.json({ ok: false, error: 'Няма такъв чат.' }, { status: 404 });
    const messages = await listMessages(db, chat.id);
    return Response.json({
      ok: true,
      chat: { id: chat.id, title: chat.title },
      messages: messages.map((row) => ({
        role: row.role,
        content: row.content,
        tools: row.tools_json ? JSON.parse(row.tools_json) : [],
        at: row.created_utc,
      })),
    });
  }

  const chats = await listChats(db, user.id);
  return Response.json({
    ok: true,
    chats: chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      messages: chat.messages,
      updated: chat.updated_utc,
    })),
  });
};

export const POST: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const domain = await primaryDomain(db, user.id);
  const chat = await createChat(db, user.id, domain?.id ?? null);
  return Response.json({ ok: true, chat: { id: chat.id, title: chat.title, messages: 0, updated: chat.updated_utc } });
};

export const DELETE: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const body = await readJson<{ id?: unknown }>(context.request);
  const id = typeof body?.id === 'string' ? body.id : context.url.searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'Липсва идентификатор.' }, { status: 400 });

  await deleteChat(db, user.id, id);
  return Response.json({ ok: true });
};
