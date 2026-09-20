// FASE 3 (producto) — zona horaria por negocio, parte despachos (migración 012,
// `despachos.property_config`). Primera ruta HTTP real de esta config -- ver
// `apps/api/src/routes/verticals/despachos/configuracion.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { DespachosConfigUnavailableError } from "@atiende/domain-despachos";
import type { InMemoryAuditSink } from "@atiende/core-authz";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) },
    body: raw,
  };
}

describe("GET /despachos/:propertyId/configuracion", () => {
  it("sin fila configurada todavía -- nunca 404, zonaHoraria: null", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configuracion: { propertyId: ctx.propertyId, organizationId: ctx.organizationId, zonaHoraria: null } });
  });

  it("readonly SÍ puede ver (lectura de config ya persistida)", async () => {
    await ctx.despachosRepo.upsertPropertyConfigZonaHoraria(ctx.propertyId, ctx.organizationId, "America/Hermosillo");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configuracion: { zonaHoraria: string | null } };
    expect(body.configuracion.zonaHoraria).toBe("America/Hermosillo");
  });
});

describe("PATCH /despachos/:propertyId/configuracion", () => {
  it("admin (owner real de despachos) configura una zona horaria IANA válida -- persiste y audita", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff.admin.token, { zona_horaria: "America/Chihuahua" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configuracion: { zonaHoraria: string | null } };
    expect(body.configuracion.zonaHoraria).toBe("America/Chihuahua");

    const persisted = await ctx.despachosRepo.findPropertyConfig(ctx.propertyId);
    expect(persisted?.zonaHoraria).toBe("America/Chihuahua");

    const auditSink = ctx.deps.despachosAuditSink as InMemoryAuditSink;
    const entry = auditSink.entries.find((e) => e.action === "despachos.configuracion:zona_horaria_actualizada");
    expect(entry).toBeDefined();
    expect(entry!.metadata).toMatchObject({ antes: null, despues: "America/Chihuahua" });
  });

  it("contador/auditor/readonly NUNCA pueden escribir -- solo admin (mandato 'owner/gm')", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["contador", "auditor", "readonly"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff[rol].token, { zona_horaria: "America/Mazatlan" }));
      expect(res.status).toBe(403);
    }
    expect(await ctx.despachosRepo.findPropertyConfig(ctx.propertyId)).toBeNull();
  });

  it("timezone IANA inválido -- 400, nunca escribe (mismo criterio que citas/admin.ts::optionalTimeZone)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff.admin.token, { zona_horaria: "Marte/Cráter" }));
    expect(res.status).toBe(400);
    expect(await ctx.despachosRepo.findPropertyConfig(ctx.propertyId)).toBeNull();
  });

  it("zona_horaria: null -- borra la configuración explícita, vuelve al default de plataforma", async () => {
    await ctx.despachosRepo.upsertPropertyConfigZonaHoraria(ctx.propertyId, ctx.organizationId, "America/Cancun");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff.admin.token, { zona_horaria: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configuracion: { zonaHoraria: string | null } };
    expect(body.configuracion.zonaHoraria).toBeNull();
  });

  it("campo ausente -- 400 (zona_horaria es requerido: string IANA o null explícito)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff.admin.token, {}));
    expect(res.status).toBe(400);
  });

  it("REGLA DURA de compatibilidad: base sin la migración 012 -- 503 honesto, nunca un 500 crudo", async () => {
    const original = ctx.despachosRepo.upsertPropertyConfigZonaHoraria.bind(ctx.despachosRepo);
    ctx.despachosRepo.upsertPropertyConfigZonaHoraria = async () => {
      throw new DespachosConfigUnavailableError();
    };
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/configuracion`, patchJson(ctx.staff.admin.token, { zona_horaria: "America/Mexico_City" }));
    expect(res.status).toBe(503);
    ctx.despachosRepo.upsertPropertyConfigZonaHoraria = original;
  });
});
