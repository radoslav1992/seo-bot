# Пускане през GitHub

Cloudflare следи хранилището и строи сам при всяко бутане в `main`
(Workers Builds). GitHub Actions тук **не публикува** — то само проверява, че
проектът се компилира. Два независими пътя към една и съща услуга рано или
късно качват две различни версии една върху друга.

## 1. Ресурсите в акаунта

Веднъж, от лаптоп или от Cloudflare таблото:

```bash
npx wrangler d1 create seo-bot
npx wrangler kv namespace create CACHE   # по избор — липсва ли, всичко работи, просто по-бавно
```

И двете команди изписват идентификатор. Впиши ги в `wrangler.jsonc` на
мястото на нулите и бутни промяната. Това не са тайни, а адреси, и стоят в
хранилището точно защото Cloudflare строи оттук: връзка, добавена ръчно от
таблото, се затрива при следващия деплой.

Workers AI не иска създаване — `"ai": { "binding": "AI" }` е достатъчно.

## 2. Закачането на хранилището

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository**
→ избираш `radoslav1992/seo-bot`.

| Поле | Стойност |
|---|---|
| Branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cf` |
| Root directory | *(празно)* |

`deploy:cf` пуска миграциите на D1 **преди** качването и чак после деплойва —
за да не посрещне новият код стара схема. Първият билд ще се провали, ако
`database_id` още е нули; това е нарочно шумно.

## 3. Секретите

Worker → **Settings** → **Variables and Secrets** → тип **Secret**.

| Секрет | Задължителен | За какво |
|---|---|---|
| `SESSION_SECRET` | да | Подписва бисквитките за вход. Без него входът връща 503. |
| `TOKEN_ENC_KEY` | да | Шифрова Google refresh токените в базата. Без него връзката с Google е изключена. |
| `CLOUDFLARE_API_TOKEN` | **да, за видимостта** | AI Gateway. С него наведнъж работят ChatGPT, Claude, Grok и Qwen — без техните ключове. Без него видимост НЕ се мери. |
| `GOOGLE_CLIENT_ID` | за GSC/GA | OAuth клиент |
| `GOOGLE_CLIENT_SECRET` | за GSC/GA | същият клиент |
| `GEMINI_API_KEY` | не | Gemini като двигател (Gateway още не проксира търсенето на Google) |
| `PERPLEXITY_API_KEY` | не | Perplexity като двигател |

Стойностите да са дълги случайни низове:

```bash
openssl rand -base64 48
```

> **`TOKEN_ENC_KEY` не се сменя лекомислено.** Смяната му прави вече
> записаните Google токени нечетими и всички потребители трябва да свържат
> акаунтите си наново. `SESSION_SECRET` при смяна просто отписва всички.

Секретите се задават **веднъж** и преживяват деплоите — за разлика от
`vars`, които идват от `wrangler.jsonc` при всяко качване.

## 4. AI Gateway — без него няма видимост

Двигателите с живо търсене минават през Cloudflare AI Gateway. Това е и
причината да не са нужни ключове за OpenAI, Anthropic, xAI и Alibaba: с
**Unified Billing** те се плащат от сметката в Cloudflare.

1. Dashboard → **AI** → **AI Gateway** → Create gateway. Името впиши в
   `AI_GATEWAY_ID` в `wrangler.jsonc` (по подразбиране `seo-bot`).
2. Включи **Unified Billing** за gateway-а и зареди кредит. Cloudflare взема
   5% такса върху заредената сума.
3. Впиши идентификатора на акаунта в `CLOUDFLARE_ACCOUNT_ID` в
   `wrangler.jsonc` (не е тайна — адрес е, не ключ).
4. Създай API токен с права за AI Gateway и го подай като секрет
   `CLOUDFLARE_API_TOKEN`.

Пропуснеш ли това, приложението работи, но мери само „познатост“ (какво
моделите знаят наизуст), а таблото го казва изрично вместо да показва нула.
Подробности: [docs/models.md](models.md).

## 5. Домейнът

Worker → **Settings** → **Domains & Routes** → Add custom domain.

После оправи `PUBLIC_SITE_URL` в `wrangler.jsonc` и в `src/data/site.mjs`,
защото от тях се смятат каноничните адреси, sitemap-ът и — важното — адресът
за връщане на Google OAuth.

## 6. Google Search Console и Analytics

1. В [Google Cloud Console](https://console.cloud.google.com/) създай проект.
2. Включи **Google Search Console API**, **Google Analytics Data API** и
   **Google Analytics Admin API**.
3. Настрой екрана за съгласие (външен, ако потребителите не са в твоята
   организация) с обхватите:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`
4. Създай OAuth клиент тип **Web application** с authorized redirect URI:
   `https://ТВОЯТ-ДОМЕЙН/api/google/callback`

   Адресът трябва да съвпада **знак по знак** с `PUBLIC_SITE_URL` плюс
   `/api/google/callback`; Google отхвърля всичко друго.
5. Подай `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` като секрети (стъпка 3).

Докато екранът за съгласие е в режим „Testing“, само изрично добавените
тестови потребители могат да свържат акаунт.

## 7. Проверката след първия деплой

```bash
curl -s https://ТВОЯТ-ДОМЕЙН/ -o /dev/null -w '%{http_code}\n'          # 200
curl -s https://ТВОЯТ-ДОМЕЙН/tablo/ -o /dev/null -w '%{http_code}\n'    # 303 → /vhod/
curl -s https://ТВОЯТ-ДОМЕЙН/api/chats -w '\n%{http_code}\n'            # 401 без вход
```

После, в браузъра:

1. Регистрирай акаунт и добави домейн.
2. **Табло → Двигатели → „Провери моделите“.** Задължителната стъпка. Гледай
   реда „N/M двигателя **с търсене** отговарят“ — само те мерят видимост.
   Не отговори ли модел, поправи `VISIBILITY_ENGINES` или `CHAT_MODEL` в
   `wrangler.jsonc` и бутни. Подробностите са в [docs/models.md](models.md).
3. „Нова проверка“ — първата отнема около минута.

## Локална разработка

```bash
npm install
npm run db:migrate:local
npm run dev        # Astro dev сървър — бърз, без Cloudflare binding-и
npm run preview    # wrangler dev — истинският Worker с D1 и KV
```

Секретите за локално отиват в `.dev.vars` (в `.gitignore`):

```
SESSION_SECRET="…"
TOKEN_ENC_KEY="…"
```

**Workers AI не работи при `wrangler dev --local`** — binding-ът връща
„Binding AI needs to be run remotely“. Чатът и проверката на видимост искат
`npx wrangler dev --remote`. Всичко останало — вход, табло, анализатор,
задачи — работи изцяло локално.
