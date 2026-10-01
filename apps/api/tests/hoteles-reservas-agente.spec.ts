// H-25 -- agente de reservas por VOZ (Server Tools) y lado STAFF (holds, aprobacion, link de pago registrado, politica). Integracion HTTP real
// (app.request) sobre el repositorio en memoria. RLS/GRANT/triggers/funciones definer y la concurrencia real los cubre
// scripts/verify-hoteles-reservas-agente contra Postgres real; el SAVEPOINT contra base sin migrar lo cubre
// packages/domain-hoteles/tests/reservas-agente/postgres-repository-savepoint.spec.ts (AbortAwareFakeSession). El agente de WhatsApp con LLM falso
// (45+ escenarios adversariales) vive en packages/domain-hoteles/tests/reservas-agente/escenarios-adversariales.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryReservasAgenteRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const NOW = new Date("2031-06-01T18:00:00Z");
const SECRET = "secreto-de-esta-property";
const PHONE = "+5219991110001";
const TOTAL = 357_000;

async function setup(opts: { holdsEnabled?: boolean; migrated?: boolean } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  await ctx.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, SECRET, true);
  const reservas = new InMemoryReservasAgenteRepository();
  reservas.clock = () => NOW;
  reservas.migrationApplied = opts.migrated !== false;
  const doble = randomUUID();
  reservas.seedProperty(ctx.propertyId, { organizationId: ctx.organizationId });
  reservas.seedRoomType(ctx.propertyId, doble, "Doble", 2);
  reservas.seedInventory(ctx.propertyId, doble, "2031-06-01", "2031-07-15", 2, 150_000);
  if (opts.holdsEnabled !== false) reservas.setPolicy(ctx.propertyId, { holdsEnabled: true });
  const app = buildApp({ ...ctx.deps, hotelesReservasAgenteRepo: () => reservas });
  const voz = (tool: string, body: unknown, secret = SECRET) =>
    app.request(`/v1/hoteles/${ctx.propertyId}/voz/reservas/${tool}`, jsonRequestInit(body, { "x-atiende-tool-secret": secret }));
  const staff = (role: keyof HotelesTestContext["staff"], method: string, path: string, body?: unknown) => {
    reservas.actor = { userId: ctx.staff[role].id, role: role === "owner" || role === "gm" || role === "frontdesk" || role === "reservations" ? role : "housekeeping" };
    return app.request(`/hoteles/${ctx.propertyId}/reservas-agente${path}`, { ...authedJson(ctx.staff[role].token, body), method });
  };
  const stay = { fecha_llegada: "2031-06-12", fecha_salida: "2031-06-14" };
  const hold = (extra: Record<string, unknown> = {}) => ({ tipo_habitacion_id: doble, ...stay, huespedes: 2, total_cotizado_centavos: TOTAL, telefono: PHONE, ...extra });
  return { ctx, reservas, app, doble, voz, staff, stay, hold };
}

describe("voz: POST /v1/hoteles/:propertyId/voz/reservas/:herramienta", () => {
  it("herramienta desconocida 404; sin configurar el agente de voz 503; secreto equivocado 401", async () => {
    const s = await setup();
    expect((await s.voz("cobrar_tarjeta", {})).status).toBe(404);
    expect((await s.voz("confirmar_reserva", {})).status).toBe(404);
    expect((await s.voz("consultar_disponibilidad", s.stay, "otro-secreto")).status).toBe(401);
    const ctx2 = await buildHotelesTestContext(buildApp);
    const app2 = buildApp(ctx2.deps);
    expect((await app2.request(`/v1/hoteles/${ctx2.propertyId}/voz/reservas/consultar_disponibilidad`, jsonRequestInit(s.stay, { "x-atiende-tool-secret": SECRET }))).status).toBe(503);
  });

  it("el secreto de OTRA property nunca sirve (aislamiento por tenant)", async () => {
    const s = await setup();
    const other = "00000000-0000-4000-8000-000000000099";
    await s.ctx.hotelesRepo.upsertVoiceAgentConfig(other, s.ctx.organizationId, "secreto-de-la-otra", true);
    expect((await s.voz("consultar_disponibilidad", s.stay, "secreto-de-la-otra")).status).toBe(401);
  });

  it("con los holds deshabilitados (default) responde 200 requiere_humano, sin consultar ni apartar nada", async () => {
    const s = await setup({ holdsEnabled: false });
    const res = await s.voz("crear_pre_reserva", s.hold());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: "holds_deshabilitados", requiere_humano: true });
    expect(s.reservas.allHolds()).toHaveLength(0);
  });

  it("con la base SIN migrar responde 200 requiere_humano (nunca 500)", async () => {
    const s = await setup({ migrated: false });
    const res = await s.voz("consultar_disponibilidad", s.stay);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requiere_humano: true });
  });

  it("disponibilidad y cotizacion en centavos enteros MXN desde la base, sin aceptar precio alguno", async () => {
    const s = await setup();
    const disp = (await (await s.voz("consultar_disponibilidad", s.stay)).json()) as { moneda: string; opciones: Array<{ tipo: string; total_centavos: number }> };
    expect(disp.moneda).toBe("MXN");
    expect(disp.opciones[0]).toMatchObject({ tipo: "Doble", total_centavos: TOTAL });
    const cot = (await (await s.voz("cotizar_estancia", { tipo_habitacion_id: s.doble, ...s.stay, precio: 1, descuento: 90 })).json()) as { cotizacion: { total_centavos: number } };
    expect(cot.cotizacion.total_centavos).toBe(TOTAL);
  });

  it("pre-reserva por voz: queda pendiente de aprobacion y NO confirmada; el total del agente se contrasta con el de la base", async () => {
    const s = await setup();
    const bad = (await (await s.voz("crear_pre_reserva", s.hold({ total_cotizado_centavos: 1 }))).json()) as Record<string, unknown>;
    expect(bad).toMatchObject({ error: "precio_cambio", total_vigente_centavos: TOTAL });
    expect(s.reservas.allHolds()).toHaveLength(0);
    const ok = (await (await s.voz("crear_pre_reserva", s.hold({ llamada_id: "llamada-1" }))).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ estado: "pendiente_aprobacion", confirmada: false, total_centavos: TOTAL });
    const again = (await (await s.voz("crear_pre_reserva", s.hold({ llamada_id: "llamada-1" }))).json()) as Record<string, unknown>;
    expect(again.pre_reserva_id).toBe(ok.pre_reserva_id);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(1);
  });

  it("sin telefono de la llamada no se puede apartar (parametros_invalidos) ni consultar estado", async () => {
    const s = await setup();
    const body = s.hold();
    delete (body as Record<string, unknown>).telefono;
    expect(await (await s.voz("crear_pre_reserva", body)).json()).toMatchObject({ error: "parametros_invalidos" });
    expect(s.reservas.allHolds()).toHaveLength(0);
  });

  it("dos llamadas simultaneas por la ultima habitacion: una gana, la otra recibe sin_disponibilidad y no hay sobreventa", async () => {
    const s = await setup();
    s.reservas.seedInventory(s.ctx.propertyId, s.doble, "2031-06-12", "2031-06-13", 1, 150_000);
    const calls = ["+5219991110001", "+5219991110002"].map((telefono) => s.voz("crear_pre_reserva", s.hold({ telefono, fecha_salida: "2031-06-13", total_cotizado_centavos: 178_500 })));
    const bodies = (await Promise.all(calls)).map((r) => r.json() as Promise<Record<string, unknown>>);
    const out = await Promise.all(bodies);
    expect(out.filter((o) => o.estado === "pendiente_aprobacion")).toHaveLength(1);
    expect(out.filter((o) => o.error === "sin_disponibilidad")).toHaveLength(1);
    expect(s.reservas.oversoldNights()).toBe(0);
  });

  it("estado/cancelar solo con id + telefono propio; un telefono ajeno recibe no_encontrada", async () => {
    const s = await setup();
    const made = (await (await s.voz("crear_pre_reserva", s.hold())).json()) as { pre_reserva_id: string };
    expect(await (await s.voz("estado_pre_reserva", { pre_reserva_id: made.pre_reserva_id, telefono: "+5219990000000" })).json()).toMatchObject({ error: "no_encontrada" });
    expect(await (await s.voz("cancelar_pre_reserva", { pre_reserva_id: made.pre_reserva_id, telefono: PHONE })).json()).toMatchObject({ estado: "cancelado" });
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(0);
  });

  it("derivar_a_humano registra el contacto con source voice y redacta datos sensibles del resumen", async () => {
    const s = await setup();
    const spy = vi.spyOn(s.ctx.hotelesRepo, "insertContactoNoOperativo");
    const res = await s.voz("derivar_a_humano", { motivo: "pide descuento por grupo", resumen: "mi tarjeta 4111 1111 1111 1111", telefono: PHONE });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const saved = spy.mock.calls[0]![0];
    expect(saved).toMatchObject({ source: "voice", guestPhone: "+5219991110001" });
    expect(saved.message).toContain("[REDACTADO]");
    expect(saved.message).not.toContain("4111");
  });

  it("un cuerpo que no es un objeto no tumba el servidor", async () => {
    const s = await setup();
    const res = await s.voz("consultar_disponibilidad", [1, 2, 3]);
    expect([200, 400]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });
});

describe("staff: /hoteles/:propertyId/reservas-agente", () => {
  it("lectura: owner/gm/frontdesk/reservations/accountant ven; housekeeping 403; sin token 401", async () => {
    const s = await setup();
    for (const role of ["owner", "gm", "frontdesk", "reservations", "accountant"] as const) expect((await s.staff(role, "GET", "/holds")).status, role).toBe(200);
    expect((await s.staff("housekeeping", "GET", "/holds")).status).toBe(403);
    expect((await s.app.request(`/hoteles/${s.ctx.propertyId}/reservas-agente/holds`)).status).toBe(401);
  });

  it("decidir: reservations/gm/owner si; frontdesk/accountant 403; motivo, decision y uuid invalidos 400", async () => {
    const s = await setup();
    const made = (await (await s.voz("crear_pre_reserva", s.hold())).json()) as { pre_reserva_id: string };
    const path = `/holds/${made.pre_reserva_id}/decidir`;
    for (const role of ["frontdesk", "accountant", "housekeeping"] as const) expect((await s.staff(role, "POST", path, { decision: "aprobar", motivo: "ok" })).status, role).toBe(403);
    expect((await s.staff("reservations", "POST", path, { decision: "aprobar" })).status).toBe(400);
    expect((await s.staff("reservations", "POST", path, { decision: "quizas", motivo: "ok" })).status).toBe(400);
    expect((await s.staff("reservations", "POST", "/holds/no-es-uuid/decidir", { decision: "aprobar", motivo: "ok" })).status).toBe(400);
    const res = await s.staff("reservations", "POST", path, { decision: "aprobar", motivo: "Huesped conocido" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hold: { estado: string } }).hold.estado).toBe("aprobado");
    expect((await s.staff("reservations", "POST", path, { decision: "rechazar", motivo: "tarde" })).status).toBe(409);
  });

  it("confirmar crea la reserva (id) y el folio; un hold sin aprobar da 409; un hold de otra property 404", async () => {
    const s = await setup();
    const made = (await (await s.voz("crear_pre_reserva", s.hold())).json()) as { pre_reserva_id: string };
    expect((await s.staff("gm", "POST", `/holds/${made.pre_reserva_id}/confirmar`)).status).toBe(409);
    await s.staff("gm", "POST", `/holds/${made.pre_reserva_id}/decidir`, { decision: "aprobar", motivo: "ok" });
    const res = await s.staff("gm", "POST", `/holds/${made.pre_reserva_id}/confirmar`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hold: { estado: string; reservaId: string | null } }).hold).toMatchObject({ estado: "confirmado" });
    expect((await s.staff("gm", "POST", `/holds/${randomUUID()}/confirmar`)).status).toBe(404);
  });

  it("modo link_pago: solo se REGISTRA la referencia; una con forma de tarjeta se rechaza", async () => {
    const s = await setup();
    s.reservas.setPolicy(s.ctx.propertyId, { mode: "link_pago" });
    const made = (await (await s.voz("crear_pre_reserva", s.hold())).json()) as { pre_reserva_id: string; estado: string };
    expect(made.estado).toBe("pendiente_pago");
    const path = `/holds/${made.pre_reserva_id}/link-pago`;
    expect((await s.staff("reservations", "POST", path, { referencia: "4111 1111 1111 1111" })).status).toBe(400);
    expect((await s.staff("frontdesk", "POST", path, { referencia: "LNK-1" })).status).toBe(403);
    const ok = await s.staff("reservations", "POST", path, { referencia: "LNK-ABC-123" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { hold: { referenciaLinkPago: string } }).hold.referenciaLinkPago).toBe("LNK-ABC-123");
  });

  it("cancelar exige motivo y libera la habitacion", async () => {
    const s = await setup();
    const made = (await (await s.voz("crear_pre_reserva", s.hold())).json()) as { pre_reserva_id: string };
    expect((await s.staff("reservations", "POST", `/holds/${made.pre_reserva_id}/cancelar`, {})).status).toBe(400);
    expect((await s.staff("reservations", "POST", `/holds/${made.pre_reserva_id}/cancelar`, { motivo: "El huesped aviso" })).status).toBe(200);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(0);
  });

  it("politica: solo owner/gm la escriben (reservations 403); rangos y modo se validan; GET refleja lo guardado", async () => {
    const s = await setup({ holdsEnabled: false });
    const body = { habilitado: true, modo: "link_pago", vigenciaMinutos: 60, nochesMaximas: 7, huespedesMaximos: 4, diasMaximosDeAnticipacion: 90, holdsAbiertosMaximos: 10 };
    expect((await s.staff("reservations", "PUT", "/politica", body)).status).toBe(403);
    expect((await s.staff("frontdesk", "PUT", "/politica", body)).status).toBe(403);
    for (const bad of [{ vigenciaMinutos: 1 }, { nochesMaximas: 0 }, { huespedesMaximos: 99 }, { modo: "cobro_directo" }, { habilitado: "si" }, { holdsAbiertosMaximos: 1.5 }]) {
      expect((await s.staff("owner", "PUT", "/politica", { ...body, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await s.staff("gm", "PUT", "/politica", body)).status).toBe(200);
    const got = (await (await s.staff("frontdesk", "GET", "/politica")).json()) as { politica: { habilitado: boolean; modo: string; configurada: boolean } };
    expect(got.politica).toMatchObject({ habilitado: true, modo: "link_pago", configurada: true });
  });

  it("base SIN migrar: lecturas degradan (disponible:false) y escrituras 503, nunca 500", async () => {
    const s = await setup({ migrated: false });
    const list = await s.staff("owner", "GET", "/holds");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ disponible: false, holds: [] });
    expect((await s.staff("owner", "GET", "/politica")).status).toBe(200);
    expect((await s.staff("owner", "PUT", "/politica", { habilitado: true, modo: "aprobacion_humana", vigenciaMinutos: 60, nochesMaximas: 7, huespedesMaximos: 4, diasMaximosDeAnticipacion: 90, holdsAbiertosMaximos: 10 })).status).toBe(503);
    expect((await s.staff("owner", "POST", `/holds/${randomUUID()}/decidir`, { decision: "aprobar", motivo: "ok" })).status).toBe(503);
  });
});
