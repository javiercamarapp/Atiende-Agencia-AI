// Rn-05 -- HTTP real: confirmar el bloqueo de mantenimiento que propone una incidencia GRAVE.
// Roles (solo gestión, nunca `limpieza`), idempotencia (409 la segunda vez), solape con una
// reserva (conflicto capa_cruzada, nunca cancela), y defensa en profundidad (incidencia de
// otra unidad / leve / sin rango).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

async function reportar(ctx: Awaited<ReturnType<typeof buildRentasTestContext>>, app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias`, authedJson(ctx.staff.limpieza.token, body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("POST .../incidencias/:incidenciaId/confirmar-bloqueo", () => {
  it("el admin confirma una incidencia grave: crea el bloqueo MANTENIMIENTO y la segunda confirmación es 409", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await reportar(ctx, app, { severidad: "grave", titulo: "Fuga de agua", propuestaBloqueoRango: { inicio: "2027-05-10", fin: "2027-05-14" } });
    const url = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/${id}/confirmar-bloqueo`;
    const res = await app.request(url, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { incidenciaId: string; bloqueoId: string; conflictosCapaCruzada: number };
    expect(body).toMatchObject({ incidenciaId: id, conflictosCapaCruzada: 0 });
    const bloqueos = (await (await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/bloqueos`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"))).json()) as { bloqueos: { id: string; razon: string }[] };
    expect(bloqueos.bloqueos).toEqual([expect.objectContaining({ id: body.bloqueoId, razon: "MANTENIMIENTO" })]);
    expect((await app.request(url, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(409);
  });

  it("limpieza (quien reporta), contador y solo-calendario reciben 403: la separación de funciones se respeta", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await reportar(ctx, app, { severidad: "grave", titulo: "Cerradura rota", propuestaBloqueoRango: { inicio: "2027-05-10", fin: "2027-05-14" } });
    const url = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/${id}/confirmar-bloqueo`;
    for (const t of [ctx.staff.limpieza.token, ctx.staff.contador.token, ctx.staff.operadorSoloCalendario.token]) {
      expect((await app.request(url, authedJson(t, {}))).status).toBe(403);
    }
    expect((await app.request(url, authedJson(ctx.staff.operadorAccesoTotal.token, {}))).status).toBe(201);
  });

  it("un rango provisto explícitamente reemplaza al propuesto; sin ninguno es 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sinRango = await reportar(ctx, app, { severidad: "grave", titulo: "Sin rango propuesto" });
    const urlSin = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/${sinRango}/confirmar-bloqueo`;
    expect((await app.request(urlSin, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(400);
    expect((await app.request(urlSin, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2027-06-01", fin: "2027-06-03" } }))).status).toBe(201);
    expect((await app.request(urlSin.replace(sinRango, sinRango), authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2027-6-1", fin: "2027-06-03" } }))).status).toBe(400);
  });

  it("una incidencia leve no admite bloqueo (400) y una inexistente o de otra unidad es 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const leve = await reportar(ctx, app, { severidad: "leve", titulo: "Foco fundido" });
    const t = ctx.staff.adminGestora.token;
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/${leve}/confirmar-bloqueo`, authedJson(t, { rango: { inicio: "2027-05-10", fin: "2027-05-12" } }))).status).toBe(400);
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/00000000-0000-4000-8000-000000000000/confirmar-bloqueo`, authedJson(t, {}))).status).toBe(404);
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/incidencias/${leve}/confirmar-bloqueo`, authedJson(t, {}))).status).toBe(404);
  });

  it("si el rango solapa una reserva confirmada, el bloqueo se crea y se reporta el conflicto capa_cruzada; la reserva NO se cancela", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const t = ctx.staff.adminGestora.token;
    const reserva = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(t, { rango: { inicio: "2027-05-11", fin: "2027-05-13" }, huespedNombre: "Ana" }));
    expect(reserva.status).toBe(201);
    const id = await reportar(ctx, app, { severidad: "grave", titulo: "Techo", propuestaBloqueoRango: { inicio: "2027-05-10", fin: "2027-05-14" } });
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias/${id}/confirmar-bloqueo`, authedJson(t, {}));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { conflictosCapaCruzada: number }).conflictosCapaCruzada).toBe(1);
    const ocupaciones = (await (await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ocupaciones`, authedJson(t, undefined, {}, "GET"))).json()) as { items?: { capa: string; estado: string }[]; ocupaciones?: { capa: string; estado: string }[] };
    const lista = ocupaciones.items ?? ocupaciones.ocupaciones ?? [];
    expect(lista.find((o) => o.capa === "reserva")?.estado).toBe("confirmado");
  });
});
