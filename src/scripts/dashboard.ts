/**
 * Поведението на таблото: бутоните за инструменти, задачите и връзката с Google.
 *
 * Страницата е рендерирана на сървъра и е пълна без този файл — тук са само
 * действията. Затова всяко от тях презарежда страницата след успех, вместо
 * да пресмята наново числата в браузъра: един източник на истината, а не два.
 */

const toast = document.querySelector<HTMLElement>('[data-toast]');

function say(message: string, ok = false): void {
  if (!toast) return;
  toast.textContent = message;
  toast.className = ok ? 'notice notice-ok' : 'notice';
  toast.hidden = false;
  toast.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function post<T>(url: string, body: unknown, method = 'POST'): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  } catch {
    say('Няма връзка със сървъра. Провери мрежата и опитай отново.');
    return null;
  }
}

/* ── Инструменти ────────────────────────────────────────────────── */

interface ToolResponse {
  ok?: boolean;
  error?: string;
  summary?: string;
}

document.querySelectorAll<HTMLButtonElement>('[data-run]').forEach((button) => {
  button.addEventListener('click', async () => {
    const tool = button.dataset.run;
    if (!tool) return;

    // Аргументите идват от `data-arg-*` — така един и същ обработчик върши
    // работа и за „Нова проверка“ (без аргументи), и за „Сравни с нас“.
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(button.dataset)) {
      if (key.startsWith('arg') && key.length > 3 && value !== undefined) {
        args[key.slice(3).replace(/^[A-Z]/, (c) => c.toLowerCase())] = value;
      }
    }

    const label = button.textContent ?? '';
    button.disabled = true;
    button.textContent = 'Работя…';
    say('Проверката тече. Може да отнеме до минута — не затваряй страницата.', true);

    const data = await post<ToolResponse>('/api/tools', { tool, args });
    button.disabled = false;
    button.textContent = label;

    if (!data) return;
    if (!data.ok) { say(data.error ?? 'Инструментът не успя.'); return; }
    say('Готово. Обновявам числата…', true);
    location.reload();
  });
});

/* ── Домейн и конкуренти ────────────────────────────────────────── */

function bindForm(selector: string, field: string, success: string): void {
  document.querySelector<HTMLFormElement>(selector)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const value = String(new FormData(form).get(field) ?? '').trim();
    if (!value) return;

    const data = await post<{ ok?: boolean; error?: string }>('/api/domains', { [field]: value });
    if (!data) return;
    if (!data.ok) { say(data.error ?? 'Не се получи.'); return; }
    say(success, true);
    location.reload();
  });
}

bindForm('[data-form="domain"]', 'domain', 'Домейнът е добавен.');
bindForm('[data-form="competitor"]', 'competitor', 'Конкурентът е добавен.');

/* ── Задачи ─────────────────────────────────────────────────────── */

document.querySelectorAll<HTMLButtonElement>('[data-done]').forEach((button) => {
  button.addEventListener('click', async () => {
    const id = button.dataset.done;
    if (!id) return;
    button.disabled = true;
    const data = await post<{ ok?: boolean }>('/api/tasks', { id }, 'PATCH');
    if (data?.ok) {
      // Редът си отива веднага — изчакването на презареждане прави
      // отмятането да изглежда като нищо не се е случило.
      document.querySelector(`[data-task="${id}"]`)?.remove();
    } else {
      button.disabled = false;
      say('Задачата не можа да се отметне.');
    }
  });
});

/* ── Двигатели ──────────────────────────────────────────────────── */

/** Данните идват от нашия API, но минават през `innerHTML` — екранираме ги. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}


interface EngineHealth {
  id: string;
  label: string;
  provider: string;
  model?: string;
  grounded: boolean;
  ok: boolean;
  ms: number;
  error?: string;
}

interface ModelsResponse {
  ok?: boolean;
  error?: string;
  chat?: { model: string; ok: boolean; ms: number; error?: string; role: string };
  fast?: { model: string; ok: boolean; ms: number; error?: string; role: string };
  engines?: EngineHealth[];
  working?: number;
  configured?: number;
  gatewayReady?: boolean;
  groundedConfigured?: number;
  groundedWorking?: number;
  hint?: string;
}

const modelsBox = document.querySelector<HTMLElement>('[data-models]');

/** `grounded` е `null` за моделите на самото приложение (чат и бърз). */
function row(
  label: string,
  detail: string,
  ok: boolean,
  ms: number,
  grounded: boolean | null,
  error?: string,
): string {
  const badge =
    grounded === null
      ? ''
      : grounded
        ? '<span class="tag tag-accent" style="margin-left: 8px">с търсене</span>'
        : '<span class="tag tag-neutral" style="margin-left: 8px">без търсене</span>';
  return `
    <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 12px 24px; align-items: baseline;
                padding: 12px 0; border-bottom: 1px solid var(--color-neutral-300)">
      <div>
        <p style="font-weight: 600; font-size: 15px; margin: 0 0 2px">${escapeHtml(label)}${badge}</p>
        <p style="font-size: 12.5px; color: var(--color-neutral-700); margin: 0; font-family: ui-monospace, monospace">
          ${escapeHtml(detail)}</p>
        ${error ? `<p style="font-size: 12.5px; color: var(--color-accent-700); margin: 4px 0 0">${escapeHtml(error)}</p>` : ''}
      </div>
      <span class="${ok ? 'tag tag-accent' : 'tag tag-outline'}">${ok ? 'отговаря' : 'не отговаря'}</span>
      <span class="num" style="font-size: 13px; color: var(--color-neutral-700); white-space: nowrap">${ms} ms</span>
    </div>`;
}

document.querySelector<HTMLButtonElement>('[data-check-models]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  if (!modelsBox) return;

  button.disabled = true;
  const label = button.textContent ?? '';
  button.textContent = 'Проверявам…';
  modelsBox.innerHTML = '<p style="font-size: 14px; color: var(--color-neutral-700); margin: 0">Питам всеки модел…</p>';

  let data: ModelsResponse | null = null;
  try {
    data = (await (await fetch('/api/models')).json()) as ModelsResponse;
  } catch {
    modelsBox.innerHTML = '<p class="notice" style="margin: 0">Проверката не мина. Опитай отново.</p>';
  }

  button.disabled = false;
  button.textContent = label;
  if (!data) return;

  if (!data.ok) {
    modelsBox.innerHTML = `<p class="notice" style="margin: 0">${escapeHtml(data.error ?? 'Проверката не мина.')}</p>`;
    return;
  }

  const engines = data.engines ?? [];
  // Двигателите с търсене отгоре — те са тези, от които зависи видимостта.
  const ordered = [...engines].sort((a, b) => Number(b.grounded) - Number(a.grounded));
  const allWell = data.working === data.configured && (data.groundedWorking ?? 0) > 0;

  modelsBox.innerHTML =
    (data.chat ? row(`Чат — ${data.chat.role}`, data.chat.model, data.chat.ok, data.chat.ms, null, data.chat.error) : '') +
    (data.fast ? row(`Бърз — ${data.fast.role}`, data.fast.model, data.fast.ok, data.fast.ms, null, data.fast.error) : '') +
    ordered
      .map((engine) => row(engine.label, engine.model ?? engine.provider, engine.ok, engine.ms, engine.grounded, engine.error))
      .join('') +
    `<p style="font-size: 13.5px; line-height: 1.7; color: ${allWell ? 'var(--color-neutral-700)' : 'var(--color-accent-700)'}; margin: 16px 0 0">
       ${data.groundedWorking}/${data.groundedConfigured} двигателя с търсене отговарят
       (${data.working}/${data.configured} общо). ${escapeHtml(data.hint ?? '')}</p>`;
});

/* ── Google ─────────────────────────────────────────────────────── */

interface GoogleStatus {
  ok?: boolean;
  configured?: boolean;
  connected?: boolean;
  expired?: boolean;
  email?: string;
  sites?: { siteUrl: string; permissionLevel: string }[];
  properties?: { name: string; displayName: string }[];
}

const googleBox = document.querySelector<HTMLElement>('[data-google]');

async function renderGoogle(): Promise<void> {
  if (!googleBox) return;

  let status: GoogleStatus | null = null;
  try {
    const res = await fetch('/api/google/status');
    status = (await res.json()) as GoogleStatus;
  } catch {
    googleBox.innerHTML = '<p style="font-size: 14px; margin: 0">Връзката с Google не можа да се провери.</p>';
    return;
  }

  if (!status?.configured) {
    googleBox.innerHTML =
      '<p style="font-size: 14px; line-height: 1.7; margin: 0; color: var(--color-neutral-700)">' +
      'Връзката с Google не е настроена на този сървър. Администраторът трябва да зададе ' +
      '<code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> и <code>TOKEN_ENC_KEY</code>.</p>';
    return;
  }

  if (!status.connected) {
    googleBox.innerHTML =
      (status.expired
        ? '<p class="notice" style="margin: 0 0 16px">Връзката с Google е изтекла. Свържи отново, за да продължим да четем данните.</p>'
        : '') +
      '<a class="btn btn-primary" href="/api/google/connect" style="color: var(--color-bg)">Свържи Google</a>' +
      '<p style="font-size: 13.5px; color: var(--color-neutral-700); margin: 16px 0 0">' +
      'Искаме достъп само за четене до Search Console и Analytics.</p>';
    return;
  }

  const sites = status.sites ?? [];
  const properties = status.properties ?? [];

  googleBox.innerHTML = `
    <p style="font-size: 14px; margin: 0 0 20px">Свързан акаунт: <strong>${escapeHtml(status.email ?? '')}</strong></p>
    <div class="split-2" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; max-width: 760px">
      <div class="field">
        <label for="gsc-site">Имот в Search Console</label>
        <select class="input" id="gsc-site">
          <option value="">— избери —</option>
          ${sites.map((site) => `<option value="${escapeHtml(site.siteUrl)}">${escapeHtml(site.siteUrl)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="ga4-property">Имот в Analytics 4</label>
        <select class="input" id="ga4-property">
          <option value="">— избери —</option>
          ${properties.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.displayName)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px">
      <button type="button" class="btn btn-primary" id="save-google" style="color: var(--color-bg)">Запази избора</button>
      <button type="button" class="btn btn-ghost" id="disconnect-google">Прекъсни връзката</button>
    </div>
    ${sites.length === 0 && properties.length === 0
      ? '<p style="font-size: 13.5px; color: var(--color-neutral-700); margin: 16px 0 0">Този акаунт няма достъп до имоти. Влез с акаунта, който управлява сайта.</p>'
      : ''}
  `;

  document.getElementById('save-google')?.addEventListener('click', async () => {
    const domains = await fetch('/api/domains').then((res) => res.json() as Promise<{ domains?: { id: string }[] }>);
    const domainId = domains.domains?.[0]?.id;
    if (!domainId) { say('Първо добави домейн.'); return; }

    const data = await post<{ ok?: boolean; error?: string }>('/api/domains', {
      domainId,
      gscSite: (document.getElementById('gsc-site') as HTMLSelectElement | null)?.value ?? '',
      ga4Property: (document.getElementById('ga4-property') as HTMLSelectElement | null)?.value ?? '',
    });
    say(data?.ok ? 'Записано. Ботът вече чете реалните данни.' : (data?.error ?? 'Записът не успя.'), Boolean(data?.ok));
  });

  document.getElementById('disconnect-google')?.addEventListener('click', async () => {
    await post('/api/google/status', {}, 'DELETE');
    void renderGoogle();
  });
}

void renderGoogle();
