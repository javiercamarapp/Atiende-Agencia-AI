// R23 (migracion 120): flujo del panel para atender lo escalado sin la app de WhatsApp: asignar a una persona, voz con resumen/telefono
// para devolver la llamada y alertas (sin tomar, sin respuesta humana, llamada por devolver, pedido por aprobar > $4,000).
// Repositorio en memoria del dominio con reloj inyectado: las reglas de RLS/GRANT las verifica scripts/verify-restaurantes-conversaciones-handoff/.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryConversacionesRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
const T0 = Date.parse("2026-10-30T18:00:00.000Z");
const hace = (min: number) => new Date(T0 - min * 60_000).toISOString();

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  let ahora = T0;
  const store = new InMemoryConversacionesRepository({ actorUserId: ctx.staff.owner.id, ahora: () => new Date(ahora), nombres: { [ctx.staff.owner.id]: "Owner", [ctx.staff.staffSucursalA.id]: "Staff A" } });
  let actor = ctx.staff.owner.id;
  let admin = true;
  const deps: AppDeps = { ...ctx.deps, conversacionesRepo: () => store.comoActor(actor, admin) };
  const app = { request: (i: string, init?: RequestInit) => Promise.resolve(buildApp(deps).request(i, init)) as Promise<Resp> };
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;
  store.personal.add(ctx.staff.staffSucursalA.id);
  store.personal.add(ctx.staff.owner.id);
  const wa = (tel: string, minUltCliente: number) => {
    const id = randomUUID();
    store.conversaciones.push({ canal: "whatsapp", id, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, telefono: tel, mensajes: [{ rol: "cliente", texto: "Hola", createdAt: hace(minUltCliente) }], actividadAt: hace(minUltCliente) });
    store.numeroPorSucursal.add(ctx.propertyIdA);
    return id;
  };
  return { ctx, store, app, base, wa, como: (u: { id: string }, esAdmin: boolean) => { actor = u.id; admin = esAdmin; }, reloj: (ms: number) => { ahora = ms; } };
}

describe("asignar una escalada a otra persona", () => {
  it("el staff la asigna: queda tomada por esa persona, con nota de quien asigno, y el agente sigue callado", async () => {
    const { ctx, app, base, store, wa, como } = await construir();
    const conv = wa("+5219990000001", 3);
    const h = { id: randomUUID(), organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, canal: "whatsapp" as const, conversationId: conv, estado: "pendiente" as const, solicitadoPor: "agente" as const, motivo: "queja", solicitadaAt: hace(3), ultimoClienteAt: hace(3), tomadaPor: null, tomadaAt: null, createdAt: 0 };
    store.handoffs.push(h);
    como(ctx.staff.owner, true);
    const r = await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.owner.token, { userId: ctx.staff.staffSucursalA.id }, "POST"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ estado: "tomada", cambio: true });
    expect(h).toMatchObject({ estado: "tomada", tomadaPor: ctx.staff.staffSucursalA.id, asignadaPor: ctx.staff.owner.id });
    expect(store.notas.some((n) => n.handoffId === h.id && n.texto.includes("Staff A"))).toBe(true);
    // Repetir es idempotente: no hay cambio.
    expect((await (await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.owner.token, { userId: ctx.staff.staffSucursalA.id }, "POST"))).json()).cambio).toBe(false);
    const d = await (await app.request(`${base}/conversaciones/whatsapp/${conv}`, authedGet(ctx.staff.owner.token))).json();
    expect(d.handoff).toMatchObject({ estado: "tomada", tomadaPorNombre: "Staff A", asignadaPorNombre: "Owner" });
  });

  it("rechaza una persona sin acceso a la sucursal (403), un userId mal formado (400) y reasignar la toma de otra persona sin ser admin (403)", async () => {
    const { ctx, app, base, store, wa, como } = await construir();
    const conv = wa("+5219990000002", 2);
    const h = { id: randomUUID(), organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, canal: "whatsapp" as const, conversationId: conv, estado: "tomada" as const, solicitadoPor: "staff" as const, motivo: null, solicitadaAt: hace(5), ultimoClienteAt: null, tomadaPor: ctx.staff.owner.id, tomadaAt: hace(5), createdAt: 0 };
    store.handoffs.push(h);
    como(ctx.staff.owner, true);
    expect((await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.owner.token, { userId: randomUUID() }, "POST"))).status).toBe(403);
    expect((await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.owner.token, { userId: "no-uuid" }, "POST"))).status).toBe(400);
    como(ctx.staff.staffSucursalA, false);
    expect((await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.staffSucursalA.token, { userId: ctx.staff.staffSucursalA.id }, "POST"))).status).toBe(403);
    expect(h.tomadaPor).toBe(ctx.staff.owner.id);
    expect((await app.request(`${base}/handoffs/${h.id}/asignar`, authedJson(ctx.staff.repartidor.token, { userId: ctx.staff.staffSucursalA.id }, "POST"))).status).toBe(403);
  });
});

describe("handoff de voz: resumen y telefono para devolver la llamada", () => {
  it("el detalle de la llamada escalada trae resumen y telefono, y aparece como alerta 'llamada_por_devolver'", async () => {
    const { ctx, app, base, store } = await construir();
    const conv = randomUUID();
    store.conversaciones.push({ canal: "voz", id: conv, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, telefono: null, mensajes: [], actividadAt: hace(4) });
    store.handoffs.push({ id: randomUUID(), organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, canal: "voz", conversationId: conv, estado: "pendiente", solicitadoPor: "agente", motivo: "escalada:queja", solicitadaAt: hace(4), ultimoClienteAt: null, tomadaPor: null, tomadaAt: null, createdAt: 0, resumen: "Queja por tacos fríos del pedido #812", telefonoDevolucion: "+5219991112222" });
    const d = await (await app.request(`${base}/conversaciones/voz/${conv}`, authedGet(ctx.staff.owner.token))).json();
    expect(d.handoff).toMatchObject({ estado: "pendiente", resumen: "Queja por tacos fríos del pedido #812", telefonoDevolucion: "+5219991112222" });
    const a = await (await app.request(`${base}/alertas-panel`, authedGet(ctx.staff.owner.token))).json();
    expect(a.items).toEqual([expect.objectContaining({ tipo: "llamada_por_devolver", canal: "voz", telefono: "+5219991112222", resumen: "Queja por tacos fríos del pedido #812", minutos: 4 })]);
  });
});

describe("alertas del panel", () => {
  it("chat sin tomar y chat tomado sin respuesta humana solo alertan pasado el umbral; responder o ser reciente las apaga", async () => {
    const { ctx, app, base, store, wa } = await construir();
    const nuevo = wa("+5219990000011", 12);
    const reciente = wa("+5219990000012", 3);
    const tomado = wa("+5219990000013", 15);
    const contestado = wa("+5219990000014", 15);
    const fila = (conversationId: string, extra: object) => store.handoffs.push({ id: randomUUID(), organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, canal: "whatsapp", conversationId, estado: "pendiente", solicitadoPor: "agente", motivo: "queja", solicitadaAt: hace(30), ultimoClienteAt: null, tomadaPor: null, tomadaAt: null, createdAt: store.handoffs.length, ...extra } as never);
    fila(nuevo, { solicitadaAt: hace(12) });
    fila(reciente, { solicitadaAt: hace(3) });
    fila(tomado, { estado: "tomada", tomadaPor: ctx.staff.owner.id, tomadaAt: hace(30), ultimoClienteAt: hace(15) });
    fila(contestado, { estado: "tomada", tomadaPor: ctx.staff.owner.id, tomadaAt: hace(30), ultimoClienteAt: hace(15), ultimaHumanaAt: hace(5) });
    const r = await (await app.request(`${base}/alertas-panel`, authedGet(ctx.staff.owner.token))).json();
    expect(r).toMatchObject({ disponible: true, sinRespuestaMin: 10, montoMin: 4000 });
    expect(r.items.map((i: { tipo: string; referencia: string }) => [i.tipo, i.referencia])).toEqual([
      ["sin_respuesta_humana", "+5219990000013"],
      ["sin_tomar", "+5219990000011"],
    ]);
    // Un umbral mas alto apaga la de 12 min; uno mas bajo enciende la reciente.
    expect((await (await app.request(`${base}/alertas-panel?sinRespuestaMin=14`, authedGet(ctx.staff.owner.token))).json()).items).toHaveLength(1);
    expect((await (await app.request(`${base}/alertas-panel?sinRespuestaMin=1`, authedGet(ctx.staff.owner.token))).json()).items.map((i: { referencia: string }) => i.referencia)).toContain("+5219990000012");
  });

  it("pedido por aprobar: solo los de mas de $4,000 de ESTA sucursal", async () => {
    const { ctx, app, base, store } = await construir();
    store.pedidosPorAprobar.push(
      { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orderId: randomUUID(), numero: 901, total: 4500, solicitadaAt: hace(7) },
      { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orderId: randomUUID(), numero: 902, total: 4000, solicitadaAt: hace(7) },
      { organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, orderId: randomUUID(), numero: 903, total: 9000, solicitadaAt: hace(7) },
    );
    const r = await (await app.request(`${base}/alertas-panel`, authedGet(ctx.staff.owner.token))).json();
    expect(r.items).toEqual([expect.objectContaining({ tipo: "pedido_por_aprobar", referencia: "#901", monto: 4500, minutos: 7 })]);
  });

  it("base sin migrar: disponible false y lista vacia (no un 500); el repartidor no entra; umbrales invalidos 400", async () => {
    const { ctx, app, base, store } = await construir();
    store.disponible = false;
    const r = await app.request(`${base}/alertas-panel`, authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ disponible: false, total: 0, items: [] });
    expect((await app.request(`${base}/alertas-panel`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(`${base}/alertas-panel?sinRespuestaMin=0`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });
});
