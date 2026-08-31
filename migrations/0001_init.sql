-- Схемата на SEO Bot.
--
-- Всички моменти във времето са UTC милисекунди от епохата (INTEGER).
-- Локалното време е представяне, не данни: „10:00 софийско“ в базата става
-- неразбираемо при смяна на лятното часово време и несравнимо със записите
-- на проверките, които вървят по разписание в UTC.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  -- PBKDF2-SHA256, форматът е `pbkdf2$<итерации>$<сол>$<хеш>` — параметрите
  -- пътуват със самия хеш, за да може броят итерации да се вдигне, без
  -- старите пароли да станат неразпознаваеми.
  password_hash TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'pro' | 'business'
  credits       INTEGER NOT NULL DEFAULT 50,
  credits_limit INTEGER NOT NULL DEFAULT 50,
  renews_utc    INTEGER,
  created_utc   INTEGER NOT NULL
);

-- Имейлът е ключът за вход, значи трябва да е един. Уникалността стои в
-- базата, а не в кода: проверка „зает ли е имейлът“, последвана от вмъкване,
-- е състезание — между двете заявки друг може да е регистрирал същия адрес.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_utc);

CREATE TABLE IF NOT EXISTS domains (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain      TEXT NOT NULL,          -- без схема и без `www.`: `tehnobaza.bg`
  is_primary  INTEGER NOT NULL DEFAULT 0,
  -- Адресът на имота в Search Console (`sc-domain:...` или URL префикс) и
  -- идентификаторът на потока в GA4. Пазят се тук, а не в акаунта на Google,
  -- защото един акаунт може да покрива десет домейна.
  gsc_site    TEXT,
  ga4_property TEXT,
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS domains_user ON domains (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS domains_user_domain ON domains (user_id, domain);

CREATE TABLE IF NOT EXISTS competitors (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL,
  domain      TEXT NOT NULL,
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS competitors_domain ON competitors (domain_id);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain_id   TEXT,
  title       TEXT NOT NULL DEFAULT 'Нов чат',
  created_utc INTEGER NOT NULL,
  updated_utc INTEGER NOT NULL
);
-- Списъкът в страничната лента е „моите чатове, най-скорошният отгоре“ —
-- индексът е точно по този въпрос, за да не се чете цялата таблица.
CREATE INDEX IF NOT EXISTS chats_user_updated ON chats (user_id, updated_utc DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL,          -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  -- Кои инструменти е ползвал ботът за този отговор, като JSON. Показва се
  -- под съобщението: отговор без проследима сметка е мнение, не одит.
  tools_json  TEXT,
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created_utc);

CREATE TABLE IF NOT EXISTS audits (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain_id   TEXT NOT NULL,
  url         TEXT NOT NULL,
  geo_score   INTEGER NOT NULL DEFAULT 0,
  tech_score  INTEGER NOT NULL DEFAULT 0,
  issues      INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL,
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audits_domain ON audits (domain_id, created_utc DESC);

-- Една проверка на видимост = един въпрос, зададен на един двигател.
--
-- Редовете са суровината: резултатът „62“ на таблото е агрегат върху тях и
-- се пресмята при четене. Пазенето на агрегата вместо редовете прави
-- невъзможен въпросът „кои точно заявки паднаха“, а той е целият продукт.
CREATE TABLE IF NOT EXISTS visibility_checks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain_id   TEXT NOT NULL,
  query       TEXT NOT NULL,
  engine      TEXT NOT NULL,          -- 'chatgpt' | 'perplexity' | 'gemini' | 'ai-overviews'
  mentioned   INTEGER NOT NULL DEFAULT 0,
  position    INTEGER,                -- поредност на споменаване в отговора, ако има
  competitors TEXT NOT NULL DEFAULT '',  -- запетаи: кой друг е споменат
  excerpt     TEXT NOT NULL DEFAULT '',
  created_utc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visibility_domain ON visibility_checks (domain_id, created_utc DESC);
CREATE INDEX IF NOT EXISTS visibility_engine ON visibility_checks (domain_id, engine, created_utc DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  domain_id   TEXT,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'medium',  -- 'high' | 'medium' | 'low'
  impact      INTEGER NOT NULL DEFAULT 0,      -- очаквани точки видимост
  status      TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'done'
  source      TEXT NOT NULL DEFAULT 'bot',     -- 'bot' | 'audit' | 'user'
  created_utc INTEGER NOT NULL,
  done_utc    INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks (user_id, status, created_utc DESC);

-- Връзката с Google (Search Console и Analytics).
--
-- Пази се само refresh токенът и то шифрован с AES-GCM на ключ от секретите.
-- Достъпният токен живее минути и се взема наново при всяка заявка — няма
-- смисъл да се пази нещо, което ще е невалидно, преди да потрябва.
CREATE TABLE IF NOT EXISTS google_accounts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  email             TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '',
  created_utc       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS google_accounts_user ON google_accounts (user_id);

-- Еднократните низове за OAuth потока (защита срещу CSRF при връщането).
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_utc INTEGER NOT NULL
);
