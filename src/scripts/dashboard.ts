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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

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
