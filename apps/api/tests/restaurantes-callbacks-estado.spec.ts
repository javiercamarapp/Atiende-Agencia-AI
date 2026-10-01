// R-12: HTTP end-to-end de la bandeja de callbacks con estado, asignacion y SLA (migracion 033), sobre la pestana de Conversaciones
// de R-21. Repositorio en memoria del dominio: RLS/GRANT/funciones definer las prueba el verify contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryConversacionesRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const nombres = { [ctx.staff.owner.id]: "Owner", [ctx.staff.staffSucursalA.id]: "Staff A", [ctx.staff.admin.id]: "Admin" };
  let actor = ctx.staff.owner.id;
  let admin = true;
  const store = new InMemoryConversacionesRepository({ actorUserId: ctx.staff.owner.id, nombres });
  const deps: AppDeps = { ...ctx.deps, conversacionesRepo: () => store.comoActor(actor, admin) };
  const app = buildApp(deps);
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;
  const cb = randomUUID();
  const ahora = Date.now();
  store.callbacks.push({ organizationId: ctx.organizationId, id: cb, propertyId: ctx.propertyIdA, customerName: "Cliente", customerPhone: "+521", reason: "escalada:queja", message: "se quejo", source: "voice", resolved: false, createdAt: new Date(ahora - 20 * 60_000).toISOString(), intentos: [] });
  const como = (u: { id: string }, esAdmin: boolean) => {
    actor = u.id;
    admin = esAdmin;
  };
  return { ctx, app, base, store, cb, como };
}

describe("GET callbacks: estado, asignacion y SLA", () => {
  it("un callback historico (sin columnas de la 033) se ve nuevo, no gestionable y con el SLA calculado desde su fecha", async () => {
    const { ctx, app, base } = await construir();
    const b = (await (await app.request(`${base}/callbacks`, authedGet(ctx.staff.owner.token))).json()) as Json;
    expect(b.items[0]).toMatchObject({ estado: "nuevo", gestionable: false, asignadoA: null, motivo: "escalada:queja", sla: { objetivoMin: 15, estado: "vencido" } });
  });

  it("filtro estado: valida el valor y filtra", async () => {
    const { ctx, app, base, cb, como } = await construir();
    const t = ctx.staff.owner.token;
    expect((await app.request(`${base}/callbacks?estado=inventado`, authedGet(t))).status).toBe(400);
    como(ctx.staff.owner, true);
    await app.request(`${base}/callbacks/${cb}/estado`, authedJson(t, { accion: "tomar" }, "POST"));
    expect(((await (await app.request(`${base}/callbacks?estado=nuevo`, authedGet(t))).json()) as Json).items).toHaveLength(0);
    expect(((await (await app.request(`${base}/callbacks?estado=en_curso`, authedGet(t))).json()) as Json).items).toHaveLength(1);
  });
});

describe("POST callbacks/:id/estado", () => {
  it("flujo completo: tomar -> asignar -> resolver con nota; la lista refleja estado, asignado, quien resolvio y SLA incumplido (se tomo pasado el objetivo)", async () => {
    const { ctx, app, base, cb, como } = await construir();
    const t = ctx.staff.owner.token;
    const url = `${base}/callbacks/${cb}/estado`;
    como(ctx.staff.owner, true);
    expect(await (await app.request(url, authedJson(t, { accion: "tomar" }, "POST"))).json()).toEqual({ estado: "en_curso" });
    expect(await (await app.request(url, authedJson(t, { accion: "asignar", asignadoA: ctx.staff.staffSucursalA.id }, "POST"))).json()).toEqual({ estado: "en_curso" });
    let item = ((await (await app.request(`${base}/callbacks`, authedGet(t))).json()) as Json).items[0];
    expect(item).toMatchObject({ estado: "en_curso", gestionable: true, asignadoA: ctx.staff.staffSucursalA.id, asignadoNombre: "Staff A", sla: { estado: "incumplido" } }); // se tomo a los 20 min y el objetivo de una queja es de 15
    como(ctx.staff.staffSucursalA, false);
    expect(await (await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { accion: "resolver", nota: "Se le llamo" }, "POST"))).json()).toEqual({ estado: "resuelto" });
    como(ctx.staff.owner, true);
    item = ((await (await app.request(`${base}/callbacks`, authedGet(t))).json()) as Json).items[0];
    expect(item).toMatchObject({ estado: "resuelto", resuelto: true, resueltoPor: "Staff A", notaResolucion: "Se le llamo" });
    expect(((await (await app.request(`${base}/callbacks?soloAbiertos=1`, authedGet(t))).json()) as Json).items).toHaveLength(0);
  });

  it("reglas: staff no asigna ni reabre (403); una segunda persona no pisa al que lo tiene (409); resolver dos veces 409; reabrir uno no resuelto 409", async () => {
    const { ctx, app, base, cb, como } = await construir();
    const url = `${base}/callbacks/${cb}/estado`;
    const st = ctx.staff.staffSucursalA.token;
    como(ctx.staff.staffSucursalA, false);
    expect((await app.request(url, authedJson(st, { accion: "asignar", asignadoA: ctx.staff.owner.id }, "POST"))).status).toBe(403);
    expect((await app.request(url, authedJson(st, { accion: "tomar" }, "POST"))).status).toBe(200);
    como(ctx.staff.admin, false);
    expect((await app.request(url, authedJson(ctx.staff.admin.token, { accion: "tomar" }, "POST"))).status).toBe(409);
    como(ctx.staff.staffSucursalA, false);
    expect((await app.request(url, authedJson(st, { accion: "resolver" }, "POST"))).status).toBe(200);
    expect((await app.request(url, authedJson(st, { accion: "resolver" }, "POST"))).status).toBe(409);
    expect((await app.request(url, authedJson(st, { accion: "reabrir" }, "POST"))).status).toBe(403);
    como(ctx.staff.owner, true);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { accion: "reabrir" }, "POST"))).status).toBe(200);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { accion: "reabrir" }, "POST"))).status).toBe(409);
  });

  it("validaciones: accion invalida, asignar sin persona o con id mal formado, nota larga -> 400; callback inexistente o de otra organizacion -> 403; id mal formado 404", async () => {
    const { ctx, app, base, cb } = await construir();
    const t = ctx.staff.owner.token;
    const url = `${base}/callbacks/${cb}/estado`;
    for (const body of [{ accion: "borrar" }, {}, { accion: "asignar" }, { accion: "asignar", asignadoA: "no-uuid" }, { accion: "resolver", nota: "x".repeat(1001) }]) {
      expect((await app.request(url, authedJson(t, body, "POST"))).status).toBe(400);
    }
    expect((await app.request(`${base}/callbacks/${randomUUID()}/estado`, authedJson(t, { accion: "tomar" }, "POST"))).status).toBe(403);
    expect((await app.request(`${base}/callbacks/no-es-uuid/estado`, authedJson(t, { accion: "tomar" }, "POST"))).status).toBe(404);
  });

  it("repartidor y otra organizacion no entran; sin token 401; base sin migrar 503", async () => {
    const { ctx, app, base, cb, store } = await construir();
    const url = `${base}/callbacks/${cb}/estado`;
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { accion: "tomar" }, "POST"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.otroOrgOwner.token, { accion: "tomar" }, "POST"))).status).toBeGreaterThanOrEqual(403);
    expect((await app.request(url, { method: "POST", body: "{}" })).status).toBe(401);
    store.disponible = false;
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { accion: "tomar" }, "POST"))).status).toBe(503);
  });
});
