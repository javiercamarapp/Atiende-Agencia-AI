// paridad3 L-P3-16: bandeja de expedientes (solo lectura, paginada, solo de la organizacion propia).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

type Ctx = Awaited<ReturnType<typeof buildLicitacionesTestContext>>;
interface Fila { tenderId: string; status: string; requisitos: { total: number }; redaccion: string; checklist: string; aprobacion: { modo: string; completa: boolean }; paquete: boolean; presentada: boolean }

function sembrar(ctx: Ctx, status: string, organizationId = ctx.organizationId): string {
  const id = randomUUID();
  ctx.repo.seedTender({ id, organizationId, title: `Expediente ${status}`, submissionDeadline: null, updatedAt: "2026-09-01T00:00:00Z", source: "manual", status: status as never });
  return id;
}
const get = (ctx: Ctx, qs = "", token = ctx.staff.viewer.token) => buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}/expedientes${qs}`, authedJson(token));

describe("GET .../expedientes (L-P3-16)", () => {
  it("lista solo go / en curso / presentadas de la organizacion, con total real; las demas y las ajenas no aparecen", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, "go");
    sembrar(ctx, "in_progress");
    sembrar(ctx, "submitted");
    sembrar(ctx, "discovered");
    sembrar(ctx, "won");
    sembrar(ctx, "go", "00000000-0000-0000-0000-0000000000ff");
    const res = await get(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
    const body = (await res.json()) as { expedientes: Fila[] };
    expect(body.expedientes.map((e) => e.status).sort()).toEqual(["go", "in_progress", "submitted"]);
  });

  it("sin propuesta: redaccion pendiente, checklist sin correr y aprobacion 'sin_propuesta'", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    sembrar(ctx, "go");
    const [fila] = ((await (await get(ctx)).json()) as { expedientes: Fila[] }).expedientes;
    expect(fila).toMatchObject({ redaccion: "pendiente", checklist: "sin_correr", paquete: false, presentada: false, aprobacion: { modo: "sin_propuesta", completa: false } });
  });

  it("con propuesta creada: redaccion hecha, aprobacion doble sin completar y NO escribe nada al leer", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const id = sembrar(ctx, "go");
    await buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}/tenders/${id}/proposal`, authedJson(ctx.staff.writer.token));
    const [fila] = ((await (await get(ctx)).json()) as { expedientes: Fila[] }).expedientes;
    expect(fila!.redaccion).toBe("hecho");
    expect(fila!.aprobacion.completa).toBe(false);
    expect(fila!.paquete).toBe(false);
    // Leer dos veces no cambia el resultado (sin sincronizar aprobaciones ni sellar).
    expect(((await (await get(ctx)).json()) as { expedientes: Fila[] }).expedientes[0]).toEqual(fila);
  });

  it("filtro por estado, estado invalido -> 400, paginacion con X-Next-Offset", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    for (let i = 0; i < 3; i += 1) sembrar(ctx, "go");
    sembrar(ctx, "submitted");
    expect(((await (await get(ctx, "?status=submitted")).json()) as { expedientes: Fila[] }).expedientes).toHaveLength(1);
    expect((await get(ctx, "?status=won")).status).toBe(400);
    const p1 = await get(ctx, "?limit=3");
    expect(p1.headers.get("x-total-count")).toBe("4");
    expect(p1.headers.get("x-next-offset")).toBe("3");
    expect(((await (await get(ctx, "?limit=3&offset=3")).json()) as { expedientes: Fila[] }).expedientes).toHaveLength(1);
  });

  it("sin sesion: 401", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    expect((await buildApp(ctx.deps).request(`/licitaciones/${ctx.propertyId}/expedientes`)).status).toBe(401);
  });
});
