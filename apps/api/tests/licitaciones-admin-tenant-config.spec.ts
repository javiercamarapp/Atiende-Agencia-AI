// FASE 3 (producto) — zona horaria por negocio, parte 4/4 (licitaciones):
// GET/PATCH /v1/licitaciones/:orgSlug/admin/tenant-config -- UI mínima
// owner/admin para configurar `licitaciones.tenant_config.timezone` (migración
// 027). Mismo patrón de test HTTP que `licitaciones-admin.spec.ts` (mismo
// archivo de rutas, `admin.ts`).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

/** `authedJson` (licitaciones-fixtures.ts) siempre fija `method: "POST"` cuando
 * hay body -- spreadearlo DESPUÉS de un `{ method: "PATCH", ... }` literal lo
 * pisaría de vuelta a "POST" (bug real, no hipotético: así fallaba este mismo
 * archivo en su primera versión, 404 en vez de 200/403/400 porque Hono no
 * encuentra ningún handler POST en esta ruta). Mismo patrón que
 * `licitaciones-admin-staff.spec.ts`/`licitaciones-company-data.spec.ts`: un
 * helper local propio para PATCH. */
function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw };
}

describe("GET /v1/licitaciones/:orgSlug/admin/tenant-config", () => {
  it("organización sin configurar todavía -- 'vacío honesto', nunca 404 ni un default inventado", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_config: { organization_id: string; timezone: string | null } };
    expect(body.tenant_config).toEqual({ organization_id: ctx.organizationId, timezone: null });
  });

  it("cualquier miembro de la organización puede LEER -- leer el valor vigente no es una decisión (mismo criterio que GET .../admin/branches)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", { headers: { authorization: `Bearer ${ctx.staff.viewer.token}` } });
    expect(res.status).toBe(200);
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config");
    expect(res.status).toBe(401);
  });

  it("responde 404 para un slug que no existe", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/no-existe/admin/tenant-config", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/licitaciones/:orgSlug/admin/tenant-config", () => {
  it("owner SÍ puede configurar un timezone IANA real -- se persiste y GET lo refleja", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: "America/Tijuana" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_config: { organization_id: string; timezone: string | null } };
    expect(body.tenant_config.timezone).toBe("America/Tijuana");

    const getRes = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const getBody = (await getRes.json()) as { tenant_config: { timezone: string | null } };
    expect(getBody.tenant_config.timezone).toBe("America/Tijuana");
  });

  it("admin (no owner) TAMBIÉN puede -- mismo umbral que STAFF_INVITE_ROLES", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.admin.token, { timezone: "America/Cancun" }));
    expect(res.status).toBe(200);
  });

  it.each(["analyst", "writer", "reviewer", "viewer"] as const)("NEGATIVO (rol insuficiente): '%s' -- RECHAZADO (403), esta configuración es MÁS angosta que WRITE_ROLES", async (role) => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff[role].token, { timezone: "America/Tijuana" }));
    expect(res.status).toBe(403);
  });

  it("rechaza un timezone que no es IANA válido (400) -- validado ANTES de escribir, mismo Intl.DateTimeFormat que resolverZonaHorariaNegocio", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: "Marte/Colonia_1" }));
    expect(res.status).toBe(400);

    // Nunca se escribió nada -- GET sigue viendo el estado "sin configurar".
    const getRes = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const getBody = (await getRes.json()) as { tenant_config: { timezone: string | null } };
    expect(getBody.tenant_config.timezone).toBeNull();
  });

  it("timezone: null explícito SÍ borra un valor ya configurado -- vuelve al 'sin configurar' (default de plataforma)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: "America/Tijuana" }));

    const clearRes = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: null }));
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { tenant_config: { timezone: string | null } };
    expect(body.tenant_config.timezone).toBeNull();
  });

  it("PATCH vacío ({}) deja el valor actual intacto -- 'ausente' nunca borra (a diferencia de 'null' explícito)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: "America/Tijuana" }));

    const noopRes = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, {}));
    expect(noopRes.status).toBe(200);
    const body = (await noopRes.json()) as { tenant_config: { timezone: string | null } };
    expect(body.tenant_config.timezone).toBe("America/Tijuana");
  });
});
