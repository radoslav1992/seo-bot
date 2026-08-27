/**
 * Чатът: изпращане, стрийм на отговора и картите от инструментите.
 *
 * Съобщенията вече са в HTML-а от сървъра — тук се добавят само новите. Така
 * презареждане на страницата и превключване на разговор минават без този
 * файл, а той отговаря за единственото, което браузърът трябва да прави:
 * да покаже отговора, докато пристига.
 */

interface ToolLog {
  name: string;
  ok: boolean;
  summary: string;
  data?: unknown;
  kind?: string;
}

interface AgentEvent {
  type: 'chat' | 'tool-start' | 'tool-end' | 'token' | 'done' | 'error';
  chatId?: string;
  name?: string;
  label?: string;
  text?: string;
  log?: ToolLog;
  tools?: ToolLog[];
}

const list = document.querySelector<HTMLElement>('[data-messages]');
const scroller = document.querySelector<HTMLElement>('[data-scroll]');
const form = document.querySelector<HTMLFormElement>('[data-form="chat"]');
const input = form?.querySelector<HTMLInputElement>('input[name="message"]');
const titleEl = document.querySelector<HTMLElement>('[data-title]');

let chatId = list?.dataset.chatId || '';
let busy = false;

function scrollToEnd(): void {
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function addUserMessage(text: string): void {
  if (!list) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: grid; justify-items: end';
  const label = document.createElement('p');
  label.style.cssText = 'font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-neutral-700); margin: 0 0 8px';
  label.textContent = 'Ти';
  const body = document.createElement('p');
  body.style.cssText = 'font-size: 15.5px; line-height: 1.7; margin: 0; padding: 14px 18px; background: var(--color-surface); border-left: 2px solid var(--color-text); max-width: 56ch; white-space: pre-wrap';
  body.textContent = text;
  wrap.append(label, body);
  list.append(wrap);
  scrollToEnd();
}

/** Обвивката на отговора: етикет, ред за инструментите, после текстът. */
function startBotMessage(): { steps: HTMLElement; body: HTMLElement; cards: HTMLElement } {
  const wrap = document.createElement('div');
  const label = document.createElement('p');
  label.style.cssText = 'font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-accent-700); margin: 0 0 8px';
  label.textContent = 'SEO Bot';

  const steps = document.createElement('div');
  steps.style.cssText = 'display: grid; gap: 4px; margin: 0 0 12px; font-size: 13px; color: var(--color-neutral-700)';

  const body = document.createElement('p');
  body.style.cssText = 'font-size: 16px; line-height: 1.75; margin: 0; max-width: 68ch; white-space: pre-wrap';

  const cards = document.createElement('div');
  cards.style.cssText = 'display: grid; gap: 12px; margin-top: 16px; max-width: 68ch';

  wrap.append(label, steps, body, cards);
  list?.append(wrap);
  scrollToEnd();
  return { steps, body, cards };
}

function stepLine(text: string, state: 'running' | 'ok' | 'fail'): HTMLElement {
  const line = document.createElement('p');
  line.style.cssText = 'margin: 0; display: flex; align-items: center; gap: 8px';
  const dot = document.createElement('span');
  dot.style.cssText =
    'width: 8px; height: 8px; flex: none; background: ' +
    (state === 'fail' ? 'var(--color-neutral-500)' : 'var(--color-accent)') +
    (state === 'running' ? '; animation: blink 1s steps(1) infinite' : '');
  const label = document.createElement('span');
  label.textContent = text;
  line.append(dot, label);
  return line;
}

/**
 * Картите под отговора.
 *
 * Схемата и llms.txt се показват като текст за копиране, а не се преразказват
 * от модела — преписан от модел JSON-LD е JSON-LD, на който не може да се вярва.
 */
function renderCard(log: ToolLog): HTMLElement | null {
  const data = log.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const card = document.createElement('div');
  card.className = 'card';

  const kicker = document.createElement('div');
  kicker.className = 'card-kicker';
  card.append(kicker);

  const copyable = (title: string, content: string): void => {
    kicker.textContent = title;
    const pre = document.createElement('pre');
    pre.style.cssText =
      'margin: 0; padding: 12px; background: var(--color-bg); border: 1px solid var(--color-divider); ' +
      'overflow: auto; max-height: 320px; font-size: 12.5px; line-height: 1.5; white-space: pre';
    pre.textContent = content;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost';
    button.style.fontSize = '13px';
    button.textContent = 'Копирай';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(content);
        button.textContent = 'Копирано';
        setTimeout(() => { button.textContent = 'Копирай'; }, 2000);
      } catch {
        // Клипбордът иска разрешение и сигурен контекст; при отказ поне
        // маркираме текста, за да е едно Ctrl+C разстояние.
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        button.textContent = 'Маркирано — копирай';
      }
    });
    card.append(pre, button);
  };

  switch (log.kind) {
    case 'schema': {
      copyable(`JSON-LD · ${String(data.kind ?? '')}`, String(data.snippet ?? ''));
      const problems = data.problems as string[] | undefined;
      if (problems?.length) {
        const warn = document.createElement('p');
        warn.className = 'card-body';
        warn.textContent = `Забележки: ${problems.join(' ')}`;
        card.append(warn);
      }
      return card;
    }
    case 'llmstxt': {
      copyable('llms.txt', String(data.llmsTxt ?? ''));
      const second = document.createElement('details');
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor: pointer; font-size: 13px; margin-top: 8px';
      summary.textContent = 'Блок за robots.txt';
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin: 8px 0 0; padding: 12px; background: var(--color-bg); border: 1px solid var(--color-divider); overflow: auto; font-size: 12.5px; white-space: pre';
      pre.textContent = String(data.robotsBlock ?? '');
      second.append(summary, pre);
      card.append(second);
      return card;
    }
    case 'brief': {
      kicker.textContent = 'Задание за съдържание';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = String(data.title ?? '');
      const answer = document.createElement('p');
      answer.className = 'card-body';
      answer.textContent = String(data.answerFirst ?? '');
      card.append(title, answer);

      const outline = data.outline as { heading: string; points: string[] }[] | undefined;
      if (outline?.length) {
        const list = document.createElement('ol');
        list.style.cssText = 'margin: 0; padding-left: 20px; font-size: 13.5px; line-height: 1.7';
        for (const section of outline) {
          const item = document.createElement('li');
          item.textContent = section.heading;
          list.append(item);
        }
        card.append(list);
      }
      return card;
    }
    case 'visibility': {
      kicker.textContent = 'Проверка на видимост';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = `${String(data.score ?? 0)}% споменавания`;
      const body = document.createElement('p');
      body.className = 'card-body';
      const engines = data.byEngine as { label: string; score: number; asked: number }[] | undefined;
      body.textContent = (engines ?? []).map((e) => `${e.label}: ${e.score}% (${e.asked})`).join(' · ');
      const link = document.createElement('a');
      link.href = '/tablo/';
      link.style.fontSize = '13px';
      link.textContent = 'Виж подробностите в таблото';
      card.append(title, body, link);
      return card;
    }
    case 'audit':
    case 'crawl': {
      kicker.textContent = log.kind === 'crawl' ? 'Обхождане на сайта' : 'Одит на страница';
      const body = document.createElement('p');
      body.className = 'card-body';
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = log.summary;
      const link = document.createElement('a');
      link.href = '/tablo/#odit';
      link.style.fontSize = '13px';
      link.textContent = 'Виж в таблото';
      card.append(body, link);
      return card;
    }
    default:
      return null;
  }
}

async function send(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  busy = true;
  document.querySelector('[data-suggestions]')?.remove();
  addUserMessage(text);

  const { steps, body, cards } = startBotMessage();
  const running = new Map<string, HTMLElement>();
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;

  const thinking = stepLine('Мисля…', 'running');
  steps.append(thinking);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chatId || undefined, message: text }),
    });

    if (!res.ok || !res.body) {
      const error = (await res.json().catch(() => null)) as { error?: string } | null;
      thinking.remove();
      body.textContent = error?.error ?? 'Отговорът не пристигна. Опитай отново.';
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first = true;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event: AgentEvent;
        try {
          event = JSON.parse(payload) as AgentEvent;
        } catch {
          continue;
        }

        if (event.type === 'chat' && event.chatId) {
          chatId = event.chatId;
          if (list) list.dataset.chatId = chatId;
          // Адресът се обновява без презареждане — така презареждане или
          // споделяне на връзката отваря СЪЩИЯ разговор.
          history.replaceState(null, '', `/chat/?id=${chatId}`);
        }

        if (event.type === 'tool-start' && event.name) {
          thinking.remove();
          const line = stepLine(event.label ?? 'Работя…', 'running');
          running.set(event.name, line);
          steps.append(line);
          scrollToEnd();
        }

        if (event.type === 'tool-end' && event.name && event.log) {
          const line = running.get(event.name);
          line?.replaceWith(stepLine(event.log.ok ? event.log.summary.split('\n')[0]! : event.log.summary, event.log.ok ? 'ok' : 'fail'));
          running.delete(event.name);
          const card = renderCard(event.log);
          if (card) cards.append(card);
          scrollToEnd();
        }

        if (event.type === 'token' && event.text) {
          if (first) { thinking.remove(); first = false; }
          body.textContent += event.text;
          scrollToEnd();
        }

        if (event.type === 'error') {
          thinking.remove();
          if (!body.textContent) body.textContent = event.text ?? 'Нещо се обърка.';
        }
      }
    }

    thinking.remove();
    if (!body.textContent) body.textContent = 'Ботът не върна отговор. Опитай отново.';
    if (titleEl && titleEl.textContent === 'Нов чат') titleEl.textContent = text.slice(0, 48);
  } catch {
    thinking.remove();
    body.textContent = 'Връзката прекъсна. Опитай отново.';
  } finally {
    busy = false;
    if (submit) submit.disabled = false;
    input?.focus();
  }
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input?.value ?? '';
  if (input) input.value = '';
  void send(text);
});

document.querySelectorAll<HTMLButtonElement>('[data-suggest]').forEach((button) => {
  button.addEventListener('click', () => {
    void send(button.dataset.suggest ?? '');
  });
});

document.querySelector<HTMLButtonElement>('[data-new-chat]')?.addEventListener('click', async () => {
  const res = await fetch('/api/chats', { method: 'POST' });
  const data = (await res.json()) as { ok?: boolean; chat?: { id: string } };
  location.href = data.chat?.id ? `/chat/?id=${data.chat.id}` : '/chat/';
});
