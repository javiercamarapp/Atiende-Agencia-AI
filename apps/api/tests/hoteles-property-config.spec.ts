// FASE 3 (producto) — ZONA HORARIA POR NEGOCIO, parte hoteles: test de integración
// end-to-end (HTTP real vía app.request) de GET/PUT /hoteles/:propertyId/configuracion
// (property-config.ts) -- mismo patrón que hoteles-admin-catalogo.spec.ts.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

function putJson(token: string, body: unknown): RequestInit {
  return { ...authedJson(token, body), method: "PUT" };
}

describe("GET /hoteles/:propertyId/configuracion", () => {
  it("sin zona horaria configurada, devuelve timezone:null y la efectiva es el default de plataforma", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timezone: string | null; timezonePorDefecto: string; timezoneEfectiva: string };
    expect(body.timezone).toBeNull();
    expect(body.timezonePorDefecto).toBe("America/Mexico_City");
    expect(body.timezoneEfectiva).toBe("America/Mexico_City");
  });

  it("cualquier rol de staff con acceso puede LEER la configuración (transparencia)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const role of ["frontdesk", "housekeeping", "fnb", "accountant"] as const) {
      const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, authedJson(ctx.staff[role].token));
      expect(res.status).toBe(200);
    }
  });
});

describe("PUT /hoteles/:propertyId/configuracion", () => {
  it("owner puede configurar un timezone IANA real -- se refleja de inmediato en el GET", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.owner.token, { timezone: "America/Cancun" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timezone: string | null; timezoneEfectiva: string };
    expect(body.timezone).toBe("America/Cancun");
    expect(body.timezoneEfectiva).toBe("America/Cancun");

    const getRes = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, authedJson(ctx.staff.frontdesk.token));
    expect((await getRes.json()) as { timezone: string | null }).toMatchObject({ timezone: "America/Cancun" });
  });

  it("gm también puede configurarla (ADMIN_ROLES, mismo nivel que gestión de catálogo)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.gm.token, { timezone: "America/Tijuana" }));
    expect(res.status).toBe(200);
  });

  it("frontdesk/housekeeping/fnb/accountant NO pueden configurarla (fuera de ADMIN_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const role of ["frontdesk", "housekeeping", "fnb", "accountant"] as const) {
      const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff[role].token, { timezone: "America/Cancun" }));
      expect(res.status).toBe(403);
    }
  });

  it("timezone inválido (no IANA) -> 400 validation_error, nunca se guarda", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.owner.token, { timezone: "Marte/Cráter_Gale" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");

    const getRes = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, authedJson(ctx.staff.owner.token));
    expect((await getRes.json()) as { timezone: string | null }).toMatchObject({ timezone: null }); // nunca se escribió el valor inválido.
  });

  it("campo timezone ausente -> 400 validation_error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(400);
  });

  it("timezone: null limpia una configuración previa de vuelta al default de plataforma", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.owner.token, { timezone: "America/Hermosillo" }));

    const clearRes = await app.request(`/hoteles/${ctx.propertyId}/configuracion`, putJson(ctx.staff.owner.token, { timezone: null }));
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { timezone: string | null; timezoneEfectiva: string };
    expect(body.timezone).toBeNull();
    expect(body.timezoneEfectiva).toBe("America/Mexico_City");
  });
});
