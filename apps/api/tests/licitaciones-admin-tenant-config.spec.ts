// FASE 3 (producto) — zona horaria por negocio, parte 4/4 (licitaciones):
// GET/PATCH /v1/licitaciones/:orgSlug/admin/tenant-config -- UI mínima
// owner/admin para configurar `licitaciones.tenant_config.timezone` (migración
// 027). Mismo patrón de test HTTP que `licitaciones-admin.spec.ts` (mismo
// archivo de rutas, `admin.ts`).
import { describe, expect, it, vi } from "vitest";
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
    expect(body.tenant_config).toEqual({ organization_id: ctx.organizationId, timezone: null, new_match_min_score: null });
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

describe("umbral del aviso de nuevo match en tenant-config (L-P3-09)", () => {
  const RUTA = "/v1/licitaciones/empresa-de-prueba/admin/tenant-config";

  it("owner/admin guarda el umbral (0-100) y GET lo devuelve junto a la zona horaria; un PATCH solo de la zona no lo borra", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(RUTA, patchJson(ctx.staff.admin.token, { new_match_min_score: 70 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tenant_config: Record<string, unknown> }).tenant_config).toEqual({ organization_id: ctx.organizationId, timezone: null, new_match_min_score: 70 });

    const soloZona = await app.request(RUTA, patchJson(ctx.staff.owner.token, { timezone: "America/Tijuana" }));
    expect(((await soloZona.json()) as { tenant_config: Record<string, unknown> }).tenant_config).toMatchObject({ timezone: "America/Tijuana", new_match_min_score: 70 });

    const get = await app.request(RUTA, { headers: { authorization: `Bearer ${ctx.staff.viewer.token}` } });
    expect(((await get.json()) as { tenant_config: Record<string, unknown> }).tenant_config).toMatchObject({ new_match_min_score: 70 });
    expect((await ctx.repo.getNewMatchContext(ctx.organizationId))!.minScore).toBe(70);
  });

  it("null explicito vuelve a 'solo elegibles'; 0 y 100 son validos", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const valor of [0, 100]) {
      const r = await app.request(RUTA, patchJson(ctx.staff.owner.token, { new_match_min_score: valor }));
      expect(((await r.json()) as { tenant_config: { new_match_min_score: number } }).tenant_config.new_match_min_score).toBe(valor);
    }
    const borrar = await app.request(RUTA, patchJson(ctx.staff.owner.token, { new_match_min_score: null }));
    expect(((await borrar.json()) as { tenant_config: { new_match_min_score: number | null } }).tenant_config.new_match_min_score).toBeNull();
  });

  it.each([[-1], [101], [70.5], ["70"], [true], [[70]]])("rechaza %j con 400 (entero 0-100 o null)", async (valor) => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(RUTA, patchJson(ctx.staff.owner.token, { new_match_min_score: valor }))).status).toBe(400);
  });

  it("solo owner/admin edita: analyst, writer, reviewer y viewer reciben 403 y el umbral no cambia", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const quien of ["analyst", "writer", "reviewer", "viewer"] as const) {
      expect((await app.request(RUTA, patchJson(ctx.staff[quien].token, { new_match_min_score: 10 }))).status).toBe(403);
    }
    expect((await ctx.repo.getNewMatchContext(ctx.organizationId))!.minScore).toBeNull();
  });

  it("base sin la migracion 039: guardar el umbral responde 503 (nunca un 200 falso) y leer sigue funcionando", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const { TenantConfigNotMigratedError } = await import("@atiende/domain-licitaciones");
    vi.spyOn(ctx.repo, "upsertTenantConfig").mockRejectedValue(new TenantConfigNotMigratedError());
    const app = buildApp(ctx.deps);
    expect((await app.request(RUTA, patchJson(ctx.staff.owner.token, { new_match_min_score: 50 }))).status).toBe(503);
    expect((await app.request(RUTA, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } })).status).toBe(200);
  });
});
