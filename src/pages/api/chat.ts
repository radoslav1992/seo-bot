import type { APIRoute } from 'astro';
import { runAgent, titleForChat, type AgentEvent } from '../../lib/agent';
import type { ChatMessage } from '../../lib/ai';
import {
  addMessage, createChat, getChat, listCompetitors, listMessages, primaryDomain, refundCredits, renameChat,
  spendCredits,
} from '../../lib/db';
import { guardApi, readJson } from '../../lib/guard';

export const prerender = false;

/** Едно съобщение = 1 кредит, както пише под полето за писане. */
const MESSAGE_COST = 1;
/** Колко от историята влиза в подканата. Повече значи по-скъпо без да значи по-точно. */
const HISTORY_LIMIT = 12;

interface Body {
  chatId?: unknown;
  message?: unknown;
}

/**
 * Отговорът е Server-Sent Events, а не един JSON.
 *
 * Ходът може да отнеме десетки секунди, когато ботът обхожда сайт или пита
 * четири двигателя. Без стрийм това е празен екран и въртяща се стрелка;
 * със стрийм потребителят вижда КОЙ инструмент работи в момента — а това е
 * и обяснението защо чакането си струва.
 */
export const POST: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { env, db, user } = guard.context;

  if (!env.AI) {
    return Response.json({ ok: false, error: 'Моделите не са налични на този сървър.' }, { status: 503 });
  }

  const body = await readJson<Body>(context.request);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return Response.json({ ok: false, error: 'Празно съобщение.' }, { status: 400 });
  if (message.length > 4000) {
    return Response.json({ ok: false, error: 'Съобщението е твърде дълго (максимум 4000 знака).' }, { status: 413 });
  }

  const domain = await primaryDomain(db, user.id);

  // Чатът се проверява срещу потребителя — подаден чужд идентификатор води
  // до нов чат, а не до чужд разговор.
  let chat = typeof body?.chatId === 'string' ? await getChat(db, user.id, body.chatId) : null;
  if (!chat) chat = await createChat(db, user.id, domain?.id ?? null);

  if (!(await spendCredits(db, user.id, MESSAGE_COST))) {
    return Response.json(
      { ok: false, error: 'Кредитите свършиха. Добави кредити или смени плана, за да продължиш.' },
      { status: 402 },
    );
  }

  const previous = await listMessages(db, chat.id, HISTORY_LIMIT * 2);
  await addMessage(db, chat.id, 'user', message);

  // Заглавието се прави от първото съобщение — след това не се пипа, за да
  // не се преименува чат, който потребителят вече е разпознал в списъка.
  const isFirst = previous.length === 0;

  const history: ChatMessage[] = [
    ...previous.slice(-HISTORY_LIMIT).map((row) => ({
      role: row.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    })),
    { role: 'user', content: message },
  ];

  const chatId = chat.id;
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: AgentEvent) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chat', chatId })}\n\n`));

      let answer = '';
      let tools: unknown[] = [];
      try {
        for await (const event of runAgent(
          {
            env,
            db,
            user,
            domain,
            competitors: domain ? await listCompetitors(db, domain.id) : [],
            requestUrl: context.request.url,
          },
          history,
        )) {
          if (event.type === 'done') {
            answer = event.text ?? '';
            tools = event.tools ?? [];
          }
          send(controller, event);
        }
      } catch (error) {
        send(controller, {
          type: 'error',
          text: error instanceof Error ? error.message : 'Нещо се обърка при отговора.',
        });
      }

      // Записът е накрая на потока: дори при прекъснат отговор това, което
      // ботът е успял да каже, остава в историята.
      //
      // А не успее ли да каже нищо — кредитът се връща. Плащане за празен
      // отговор е грешката, която потребителят помни най-дълго.
      try {
        if (answer.trim()) await addMessage(db, chatId, 'assistant', answer, tools);
        else await refundCredits(db, user.id, MESSAGE_COST);
        if (isFirst) await renameChat(db, chatId, await titleForChat(env, message));
      } catch {
        /* записът не бива да събаря вече изпратения отговор */
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Спира буферирането по пътя — иначе стриймът пристига наведнъж накрая
      // и цялата работа по него е напразна.
      'X-Accel-Buffering': 'no',
    },
  });
};

export const ALL: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
