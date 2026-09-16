-- Ограничаване на опитите за вход и регистрация. Ключът е HMAC-подобен
-- SHA-256 отпечатък от адреса, браузъра, обхвата и SESSION_SECRET; сурови IP
-- адреси не се записват.
CREATE TABLE IF NOT EXISTS rate_limits (
  key              TEXT PRIMARY KEY,
  window_start_utc INTEGER NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 0,
  expires_utc      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits (expires_utc);
