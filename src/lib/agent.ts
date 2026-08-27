/**
 * Разговорът: моделът, инструментите и редът между тях.
 *
 * Цикълът е прост нарочно — моделът предлага инструменти, ние ги изпълняваме
 * и връщаме резултата, докато не спре да иска. Ограничението е в броя
 * обиколки, не във времето: Worker-ът има таван на процесорното време и
 * незавършващ цикъл там не се вижда като бавен отговор, а като прекъсната
 * връзка.
 */

import { fastModel, runChat, streamChat, type ChatMessage, type ToolSchema } from './ai';
import { prepareToolRuntime, runTool, TOOLS, toolSchemas, type ToolContext, type ToolRunLog } from './tools';
import type { DomainRow } from './db';
import type { SessionUser } from './auth';

/** Най-много три обиколки с инструменти — след това ботът отговаря с каквото има. */
const MAX_TOOL_ROUNDS = 3;
/** И най-много шест извиквания общо, за да не изяде една заявка целия бюджет. */
const MAX_TOOL_CALLS = 6;

export interface AgentContext {
  env: Env;
  db: D1Database;
  user: SessionUser;
  domain: DomainRow | null;
  competitors: string[];
  requestUrl: string;
}

/**
 * Подканата на бота.
 *
 * Дълга е, защото всеки ред в нея заменя грешка, която моделът иначе прави:
 * говори на английски, изсипва суровия JSON на инструмента в отговора,
 * съветва без да е погледнал сайта, или обещава позиции.
 */
export function systemPrompt(context: AgentContext): string {
  const domain = context.domain?.domain;
  return [
    'Ти си SEO Bot — асистент за SEO и GEO (Generative Engine Optimization) видимост на български бизнес.',
    '',
    'ЕЗИК: Пиши САМО на български. Технически термини (schema.org, canonical, llms.txt, CTR) остават на латиница.',
    '',
    'КОНТЕКСТ:',
    domain ? `· Проследяван домейн: ${domain}` : '· Потребителят още няма зададен домейн — предложи да добави един от таблото.',
    context.competitors.length ? `· Следени конкуренти: ${context.competitors.join(', ')}` : '',
    `· План: ${context.user.plan}, оставащи кредити: ${context.user.credits}.`,
    '',
    'КАК РАБОТИШ:',
    '1. Преди да съветваш за сайта — погледни го. Имаш инструменти; предположението не е отговор.',
    '2. За позиции и заявки ползвай Search Console (реални числа), не оценки. За трафик — Analytics.',
    '3. За „споменават ли ни AI моделите“ ползвай check_ai_visibility. Това е измерване, не мнение.',
    '4. Когато установиш конкретно действие с измеримо влияние — запиши го със create_task.',
    '',
    'КАК ПИШЕШ:',
    '· Кратко и по същество. Числа и конкретика вместо общи препоръки.',
    '· Води с отговора, после обяснението. Първите две изречения трябва да са полезни сами по себе си.',
    '· Подреждай причините по тежест и казвай коя колко струва.',
    '· Не преписвай суровите данни от инструментите — интерфейсът вече ги показва като карта. ' +
      'Обобщи какво значат и какво следва.',
    '· Не обещавай позиции и споменавания. Алгоритмите на търсачките и на AI моделите не са наши.',
    '· Ако инструмент върне грешка или липсващ достъп — кажи го направо и предложи какво да направи потребителят.',
    '· Завършвай с една конкретна следваща стъпка, когато има смисъл.',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface AgentEvent {
  type: 'tool-start' | 'tool-end' | 'token' | 'done' | 'error';
  name?: string;
  label?: string;
  text?: string;
  log?: ToolRunLog;
  tools?: ToolRunLog[];
}

/**
 * Изпълнява един ход: обиколките с инструменти, после стриймва отговора.
 *
 * Разделено е нарочно. Стриймът е за човека — иска да види, че нещо се случва.
 * Обиколките с инструменти не се стриймват, защото в тях няма какво да се
 * чете: те са извикване и резултат, а не текст.
 */
export async function* runAgent(
  context: AgentContext,
  history: ChatMessage[],
): AsyncGenerator<AgentEvent, void, void> {
  prepareToolRuntime(context.env, context.requestUrl);

  const toolContext: ToolContext = {
    env: context.env,
    db: context.db,
    user: context.user,
    domain: context.domain,
    requestUrl: context.requestUrl,
  };

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(context) }, ...history];
  const schemas: ToolSchema[] = toolSchemas();
  const logs: ToolRunLog[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS && logs.length < MAX_TOOL_CALLS; round++) {
      const decision = await runChat(context.env, messages, { tools: schemas, maxTokens: 900 });
      if (decision.toolCalls.length === 0) {
        // Ако моделът вече е написал отговора вместо да поиска инструмент, не
        // го караме да го пише втори път — това е и по-бързо, и по-евтино.
        if (round === 0 && decision.text.trim()) {
          yield { type: 'token', text: decision.text };
          yield { type: 'done', text: decision.text, tools: logs };
          return;
        }
        break;
      }

      for (const call of decision.toolCalls.slice(0, MAX_TOOL_CALLS - logs.length)) {
        const definition = TOOLS[call.name];
        yield { type: 'tool-start', name: call.name, label: definition?.running ?? 'Работя…' };

        const log = await runTool(call.name, call.arguments, toolContext);
        logs.push(log);
        yield { type: 'tool-end', name: call.name, log };

        messages.push({
          role: 'assistant',
          content: `Извиквам ${call.name}(${JSON.stringify(call.arguments)}).`,
        });
        messages.push({
          role: 'tool',
          name: call.name,
          content: log.ok ? log.summary : `ГРЕШКА: ${log.summary}`,
        });
      }
    }

    if (logs.length > 0) {
      messages.push({
        role: 'system',
        content:
          'Данните от инструментите са по-горе. Отговори на потребителя на български: първо изводът, ' +
          'после причините по тежест, накрая една следваща стъпка. Не преписвай суровите данни.',
      });
    }

    let answer = '';
    const stream = await streamChat(context.env, messages, { maxTokens: 1800 });
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        answer += value;
        yield { type: 'token', text: value };
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done', text: answer, tools: logs };
  } catch (error) {
    yield {
      type: 'error',
      text: error instanceof Error ? error.message : 'Нещо се обърка при отговора.',
      tools: logs,
    };
  }
}

/**
 * Заглавие на чата от първото съобщение.
 *
 * Дребна задача — затова малкият модел. Не успее ли, режем самото съобщение:
 * заглавие „Как се движи видимостта ни…“ е по-добро от „Нов чат“ и не струва
 * втора заявка.
 */
export async function titleForChat(env: Env, firstMessage: string): Promise<string> {
  const fallback = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 48);
  try {
    const result = await runChat(
      env,
      [
        { role: 'system', content: 'Връщаш само заглавие на български, до 6 думи, без кавички и без точка.' },
        { role: 'user', content: firstMessage.slice(0, 500) },
      ],
      { model: fastModel(env), maxTokens: 40, temperature: 0.3 },
    );
    const title = result.text.replace(/^["'„]|["'“.]$/g, '').trim();
    return title.length >= 3 && title.length <= 60 ? title : fallback || 'Нов чат';
  } catch {
    return fallback || 'Нов чат';
  }
}
