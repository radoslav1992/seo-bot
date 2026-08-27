# Пускане в Cloudflare

Приложението е Astro сайт с адаптер за Cloudflare: публичните страници се
пререндерират при билда и се качват като Worker assets, а таблото, чатът и
всичко под `/api/` се изпълняват в Worker-а.

## 1. Ресурсите в акаунта

```bash
# Базата
npx wrangler d1 create seo-bot

# Кешът (по избор — липсва ли, всичко работи, просто по-бавно)
npx wrangler kv namespace create CACHE
```

И двете команди изписват идентификатор. Впиши ги в `wrangler.jsonc` на
мястото на нулите — това не са тайни, а адреси, и стоят в хранилището,
защото Cloudflare строи оттук и връзка, добавена от таблото, се затрива при
следващия деплой.

Workers AI не иска създаване: `"ai": { "binding": "AI" }` в `wrangler.jsonc`
е достатъчно. Сметката е на акаунта.

## 2. Схемата

```bash
npm run db:migrate          # върху живата база
npm run db:migrate:local    # върху локалната, за `wrangler dev`
```

## 3. Секретите

```bash
# Подписва бисквитките за вход. Без него входът връща 503.
npx wrangler secret put SESSION_SECRET

# Шифрова Google refresh токените в базата. Без него връзката с Google
# е изключена — умишлено: токен на чужд Search Console не бива да лежи
# в чист вид дори в собствената ни база.
npx wrangler secret put TOKEN_ENC_KEY
```

Стойностите да са дълги случайни низове:

```bash
openssl rand -base64 48
```

> **`TOKEN_ENC_KEY` не се сменя лекомислено.** Смяната му прави вече
> записаните Google токени нечетими и всички потребители трябва да свържат
> акаунтите си наново. `SESSION_SECRET` при смяна просто отписва всички.

За локална разработка същите стойности отиват в `.dev.vars` (файлът е в
`.gitignore`):

```
SESSION_SECRET="…"
TOKEN_ENC_KEY="…"
```

## 4. Google Search Console и Analytics

1. В [Google Cloud Console](https://console.cloud.google.com/) създай проект.
2. Включи **Google Search Console API**, **Google Analytics Data API** и
   **Google Analytics Admin API**.
3. Настрой екрана за съгласие (външен, ако потребителите не са в твоята
   организация) с обхватите:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`
4. Създай OAuth клиент от тип **Web application** с authorized redirect URI:
   `https://ТВОЯТ-ДОМЕЙН/api/google/callback`
   Адресът трябва да съвпада ЗНАК ПО ЗНАК с `PUBLIC_SITE_URL` в
   `wrangler.jsonc` плюс `/api/google/callback`; Google отхвърля всичко друго.
5. Подай ключовете:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Докато екранът за съгласие е в режим „Testing“, само изрично добавените
тестови потребители могат да свържат акаунт.

## 5. Двигателите за проверка на видимост

Cloudflare Workers AI работи веднага и е базовата мярка. Другите двигатели
се включват със свой ключ и **не се подменят мълчаливо** с друг модел —
двигател без ключ се показва като „не е свързан“, за да не пише таблото
„ChatGPT: 71“ за число, което не идва от ChatGPT.

```bash
npx wrangler secret put OPENAI_API_KEY        # ChatGPT
npx wrangler secret put PERPLEXITY_API_KEY    # Perplexity
npx wrangler secret put GEMINI_API_KEY        # Gemini
```

## 6. Деплой

```bash
npm run deploy
```

Или закачи хранилището към Workers Builds — командата за билд е
`npm run build`, а изходната директория `dist`.

## Локална разработка

```bash
npm run dev        # Astro dev сървър, бърз, без Cloudflare binding-и
npm run preview    # wrangler dev — истинският Worker с D1 и KV
```

**Workers AI не работи при `wrangler dev --local`** — binding-ът връща
„Binding AI needs to be run remotely“. Чатът и проверката на видимост искат
`npx wrangler dev --remote` или пуснат Worker. Всичко останало — вход,
табло, анализатор, задачи — работи изцяло локално.

## Проверка след пускане

```bash
curl -s https://ТВОЯТ-ДОМЕЙН/ -o /dev/null -w '%{http_code}\n'          # 200
curl -s https://ТВОЯТ-ДОМЕЙН/tablo/ -o /dev/null -w '%{http_code}\n'    # 303 → /vhod/
curl -s https://ТВОЯТ-ДОМЕЙН/api/chats -w '\n%{http_code}\n'            # 401 без вход
```

Регистрирай акаунт, добави домейн и натисни „Нова проверка“. Първата проверка
съставя въпросите сама и отнема около минута.
