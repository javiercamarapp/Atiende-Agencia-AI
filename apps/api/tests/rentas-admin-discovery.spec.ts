// Fase 12 rentas — GET /v1/rentas/:orgSlug/admin/propiedades: plumbing de
// descubrimiento slug -> lista de properties, indispensable para que el panel web de
// staff (apps/web/src/verticals/rentas/RentasShell.tsx) pueda resolver una property
// real antes de pedir nada de negocio. Mismo criterio de test que
// hoteles-admin-discovery.spec.ts: HTTP real vía app.request, sin mockear el repo.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildRentasTestContext, authedJson } from "./rentas-fixtures.ts";

describe("GET /v1/rentas/:orgSlug/admin/propiedades", () => {
  it("lista las properties activas de la organización del staff autenticado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/propiedades", authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { propiedades: { propertyId: string; nombre: string }[] };
    expect(body.propiedades).toHaveLength(1);
    expect(body.propiedades[0]).toMatchObject({ propertyId: ctx.propertyId, nombre: "Rentas de Prueba — Matriz" });
  });

  it("un staff sin membership conocida en este contexto nunca ve las properties -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const otherCtx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/propiedades", authedJson(otherCtx.staff.adminGestora.token));
    expect(res.status).toBe(403);
  });

  it("slug inexistente -- 404 real, nunca una lista vacía silenciosa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/esta-gestora-no-existe/admin/propiedades", authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
  });

  it("sin token -- 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/rentas/rentas-de-prueba/admin/propiedades");
    expect(res.status).toBe(401);
  });
});
