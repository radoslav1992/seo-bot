import type { APIRoute } from 'astro';
import { addCompetitor, addDomain, listCompetitors, listDomains, normalizeDomain, PLANS } from '../../lib/db';
import { guardApi, readJson } from '../../lib/guard';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const domains = await listDomains(db, user.id);
  const withCompetitors = await Promise.all(
    domains.map(async (domain) => ({
      id: domain.id,
      domain: domain.domain,
      gscSite: domain.gsc_site,
      ga4Property: domain.ga4_property,
      competitors: await listCompetitors(db, domain.id),
    })),
  );
  return Response.json({ ok: true, domains: withCompetitors, limit: PLANS[user.plan].domains });
};

interface Body {
  domain?: unknown;
  competitor?: unknown;
  domainId?: unknown;
  gscSite?: unknown;
  ga4Property?: unknown;
}

export const POST: APIRoute = async (context) => {
  const guard = guardApi(context);
  if (!guard.ok) return guard.response;
  const { db, user } = guard.context;

  const body = await readJson<Body>(context.request);
  if (!body) return Response.json({ ok: false, error: 'Невалидно запитване.' }, { status: 400 });

  // Свързване на имот в Search Console / Analytics към вече добавен домейн.
  if (typeof body.domainId === 'string') {
    const domains = await listDomains(db, user.id);
    const target = domains.find((domain) => domain.id === body.domainId);
    if (!target) return Response.json({ ok: false, error: 'Няма такъв домейн.' }, { status: 404 });

    await db
      .prepare('UPDATE domains SET gsc_site = ?, ga4_property = ? WHERE id = ? AND user_id = ?')
      .bind(
        typeof body.gscSite === 'string' && body.gscSite ? body.gscSite : target.gsc_site,
        typeof body.ga4Property === 'string' && body.ga4Property ? body.ga4Property : target.ga4_property,
        target.id,
        user.id,
      )
      .run();
    return Response.json({ ok: true });
  }

  if (typeof body.competitor === 'string') {
    const domains = await listDomains(db, user.id);
    const target = domains[0];
    if (!target) return Response.json({ ok: false, error: 'Първо добави домейн.' }, { status: 409 });

    const limit = PLANS[user.plan].competitors;
    const existing = await listCompetitors(db, target.id);
    if (existing.length >= limit) {
      return Response.json(
        { ok: false, error: `Планът ти позволява ${limit} конкурента. Смени плана, за да следиш повече.` },
        { status: 402 },
      );
    }
    if (!(await addCompetitor(db, target.id, body.competitor))) {
      return Response.json({ ok: false, error: 'Невалиден домейн на конкурент.' }, { status: 422 });
    }
    return Response.json({ ok: true });
  }

  if (typeof body.domain !== 'string' || !normalizeDomain(body.domain)) {
    return Response.json({ ok: false, error: 'Въведи валиден домейн, например tehnobaza.bg.' }, { status: 422 });
  }

  const domains = await listDomains(db, user.id);
  const limit = PLANS[user.plan].domains;
  if (domains.length >= limit && !domains.some((d) => d.domain === normalizeDomain(body.domain as string))) {
    return Response.json(
      { ok: false, error: `Планът ти позволява ${limit} домейн${limit > 1 ? 'а' : ''}. Смени плана, за да следиш повече.` },
      { status: 402 },
    );
  }

  const created = await addDomain(db, user.id, body.domain, domains.length === 0);
  if (!created) return Response.json({ ok: false, error: 'Домейнът не можа да бъде добавен.' }, { status: 422 });
  return Response.json({ ok: true, domain: { id: created.id, domain: created.domain } });
};
