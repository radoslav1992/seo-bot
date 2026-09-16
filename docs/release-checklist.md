# Release checklist

## Required before public traffic

- [ ] Confirm the operator name, EIK, address and `info@kova.bg` in `src/data/site.mjs`.
- [ ] Apply all D1 migrations, including `0003_rate_limits.sql`.
- [ ] Set `SESSION_SECRET` and `TOKEN_ENC_KEY` to different random values.
- [ ] Deploy, then confirm `/api/health` returns `200` and `status: ready`.
- [ ] Register a fresh account and verify login, logout, domain creation and credit deduction.
- [ ] In **Табло → Двигатели**, run the model check and confirm at least one engine reports real search.
- [ ] Run one site audit and one AI visibility check against a domain you control.
- [ ] Confirm `https://seobot.bg/sitemap-index.xml`, `/robots.txt` and `/llms.txt`.
- [ ] Test Google OAuth with an allowed account if Search Console is advertised at launch.
- [ ] Review the beta terms with a Bulgarian legal professional before accepting paid customers.

## Automated gate

```bash
npm ci
npm run release:check
```

The gate must finish with zero Astro diagnostics, a successful production
build and zero production dependency vulnerabilities.

## Post-deploy smoke test

| Check | Expected result |
|---|---|
| `/` | Public homepage renders and the primary CTA opens registration |
| `/api/health` | HTTP 200 with all checks `true` |
| `/tablo/` while signed out | Redirect to `/vhod/` |
| `/api/chats` while signed out | HTTP 401 JSON response |
| 11 rapid login attempts | HTTP 429 with `Retry-After` |
| Cross-site POST | HTTP 403 |

## Not part of this beta release

- Automated billing or subscriptions
- Automated password reset email
- Scheduled daily visibility checks
- Team roles, white-label PDF reports, public API or webhooks
