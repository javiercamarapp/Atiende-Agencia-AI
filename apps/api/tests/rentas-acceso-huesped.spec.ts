// Rn-04 -- HTTP real (app.request) de la liberación de instrucciones de acceso al huésped:
// configuración de staff (roles finos), pago confirmado, bitácora y el cron
// /internal/rentas/acceso-huesped (guard de secreto, entrega por outbox, sin PII en logs,
// degradación contra la base sin la migración 025).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRentasAccesoRepository } from "@atiende/domain-rentas";
import type { LiberacionPendiente } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const SECRETO = "9137-PRIVADO";
const CORREO = "huesped.privado@example.com";
const OCUPACION = "33333333-3333-4333-8333-333333333333";
const CRON = { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } };
function enviar(method: "PUT", token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method, body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}
const POLITICA = { activo: true, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: true };

afterEach(() => vi.restoreAllMocks());

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const acceso = new InMemoryRentasAccesoRepository();
  acceso.unidadesPorProperty.set(ctx.propertyId, new Set([ctx.unidadId]));
  acceso.reservasConocidas.add(OCUPACION);
  const app = buildApp({ ...ctx.deps, rentasAccesoRepo: () => acceso });
  const pendiente = (extra: Partial<LiberacionPendiente> = {}): LiberacionPendiente => ({
    ocupacionId: OCUPACION,
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    checkIn: "2027-03-10",
    checkOut: "2027-03-12",
    unidadNombre: "Depa de Prueba",
    tenantNombre: "Gestora",
    huespedNombre: "Ana",
    huespedContacto: CORREO,
    tieneInstrucciones: true,
    direccionExacta: "Calle 60 #123",
    codigoAcceso: SECRETO,
    instrucciones: null,
    ...extra,
  });
  return { ctx, acceso, app, pendiente, base: `/rentas/${ctx.propertyId}` };
}

describe("política de acceso (staff)", () => {
  it("sin política configurada responde los valores por defecto APAGADOS; admin y operador:acceso_total pueden, el resto 403", async () => {
    const { ctx, app, base } = await preparar();
    const r = await app.request(`${base}/acceso-huesped/politica`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ disponible: true, configurada: false, politica: { activo: false, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: true } });
    expect((await app.request(`${base}/acceso-huesped/politica`, authedJson(ctx.staff.operadorAccesoTotal.token, undefined, {}, "GET"))).status).toBe(200);
    for (const t of [ctx.staff.contador.token, ctx.staff.limpieza.token, ctx.staff.operadorSoloCalendario.token]) {
      expect((await app.request(`${base}/acceso-huesped/politica`, authedJson(t, undefined, {}, "GET"))).status).toBe(403);
    }
    expect((await app.request(`${base}/acceso-huesped/politica`, { method: "GET" })).status).toBe(401);
  });

  it("PUT guarda la política y la siguiente lectura la refleja; valida horas, hora y banderas; roles sin acceso 403", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const put = await app.request(`${base}/acceso-huesped/politica`, enviar("PUT", t, { ...POLITICA, horas_antes_checkin: 48 }));
    expect(put.status).toBe(200);
    const leida = (await (await app.request(`${base}/acceso-huesped/politica`, authedJson(t, undefined, {}, "GET"))).json()) as { configurada: boolean; politica: { horas_antes_checkin: number } };
    expect(leida).toMatchObject({ configurada: true, politica: { horas_antes_checkin: 48 } });
    for (const malo of [{ ...POLITICA, horas_antes_checkin: 0 }, { ...POLITICA, horas_antes_checkin: 169 }, { ...POLITICA, hora_checkin: "25:00" }, { ...POLITICA, activo: "si" }]) {
      expect((await app.request(`${base}/acceso-huesped/politica`, enviar("PUT", t, malo))).status).toBe(400);
    }
    expect((await app.request(`${base}/acceso-huesped/politica`, enviar("PUT", ctx.staff.limpieza.token, POLITICA))).status).toBe(403);
    expect((await app.request(`${base}/acceso-huesped/politica`, enviar("PUT", ctx.staff.contador.token, POLITICA))).status).toBe(403);
  });

  it("contra la base sin la migración 025: GET responde disponible:false y PUT 409, nunca 500", async () => {
    const { ctx, app, acceso, base } = await preparar();
    acceso.migracion025Disponible = false;
    const t = ctx.staff.adminGestora.token;
    const r = await app.request(`${base}/acceso-huesped/politica`, authedJson(t, undefined, {}, "GET"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ disponible: false, configurada: false });
    expect((await app.request(`${base}/acceso-huesped/politica`, enviar("PUT", t, POLITICA))).status).toBe(409);
    expect(((await (await app.request(`${base}/acceso-huesped/bitacora`, authedJson(t, undefined, {}, "GET"))).json()) as { disponible: boolean }).disponible).toBe(false);
  });
});

describe("instrucciones de acceso (el secreto)", () => {
  it("el admin las guarda y las lee (con Cache-Control no-store); un rol sin acceso recibe 403 y nunca el secreto", async () => {
    const { ctx, app, base } = await preparar();
    const url = `${base}/unidades/${ctx.unidadId}/acceso-instrucciones`;
    const t = ctx.staff.adminGestora.token;
    const vacia = (await (await app.request(url, authedJson(t, undefined, {}, "GET"))).json()) as { instrucciones: unknown };
    expect(vacia.instrucciones).toBeNull();
    const put = await app.request(url, enviar("PUT", t, { direccion_exacta: " Calle 60 #123 ", codigo_acceso: SECRETO, instrucciones: "Caja junto a la puerta" }));
    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    const leida = await app.request(url, authedJson(t, undefined, {}, "GET"));
    expect(leida.headers.get("cache-control")).toBe("no-store");
    expect(await leida.json()).toMatchObject({ disponible: true, instrucciones: { direccion_exacta: "Calle 60 #123", codigo_acceso: SECRETO } });
    for (const otro of [ctx.staff.contador.token, ctx.staff.limpieza.token, ctx.staff.operadorSoloCalendario.token]) {
      const r = await app.request(url, authedJson(otro, undefined, {}, "GET"));
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain(SECRETO);
    }
  });

  it("valida el cuerpo y el id; una unidad que no es de la property es 404", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    expect((await app.request(`${base}/unidades/${ctx.unidadId}/acceso-instrucciones`, enviar("PUT", t, { direccion_exacta: "  " }))).status).toBe(400);
    expect((await app.request(`${base}/unidades/no-es-uuid/acceso-instrucciones`, authedJson(t, undefined, {}, "GET"))).status).toBe(400);
    const ajena = "44444444-4444-4444-8444-444444444444";
    expect((await app.request(`${base}/unidades/${ajena}/acceso-instrucciones`, enviar("PUT", t, { direccion_exacta: "x" }))).status).toBe(404);
  });
});

describe("POST .../reservas/:ocupacionId/pago-confirmado", () => {
  it("confirma y revoca el pago; reserva inexistente 404; rol sin acceso 403; cuerpo inválido 400; base sin migrar 409", async () => {
    const { ctx, app, acceso, base } = await preparar();
    const url = `${base}/reservas/${OCUPACION}/pago-confirmado`;
    const t = ctx.staff.adminGestora.token;
    const ok = await app.request(url, authedJson(t, { confirmado: true }));
    expect(await ok.json()).toEqual({ reserva_id: OCUPACION, pago_confirmado: true });
    expect(acceso.pagosConfirmados.has(OCUPACION)).toBe(true);
    expect(await (await app.request(url, authedJson(t, { confirmado: false }))).json()).toEqual({ reserva_id: OCUPACION, pago_confirmado: false });
    expect((await app.request(`${base}/reservas/55555555-5555-4555-8555-555555555555/pago-confirmado`, authedJson(t, { confirmado: true }))).status).toBe(404);
    expect((await app.request(url, authedJson(ctx.staff.limpieza.token, { confirmado: true }))).status).toBe(403);
    expect((await app.request(url, authedJson(t, { confirmado: "si" }))).status).toBe(400);
    acceso.migracion025Disponible = false;
    expect((await app.request(url, authedJson(t, { confirmado: true }))).status).toBe(409);
  });
});

describe("GET /internal/rentas/acceso-huesped (cron)", () => {
  it("rechaza sin el secreto interno", async () => {
    const { app } = await preparar();
    expect((await app.request("/internal/rentas/acceso-huesped", { method: "POST" })).status).toBe(401);
    expect((await app.request("/internal/rentas/acceso-huesped", { method: "POST", headers: { "x-atiende-internal-secret": "otro" } })).status).toBe(401);
  });

  it("sin reservas por liberar responde ok con ceros ", async () => {
    const { app } = await preparar();
    const res = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, disponible: true, liberadas: 0, omitidas_sin_contacto: 0, omitidas_sin_instrucciones: 0, errores: 0, truncada: false });
  });

  it("libera la reserva pendiente: encola el correo con las instrucciones, la marca y la deja en la bitácora; la segunda corrida no repite", async () => {
    const { ctx, app, acceso, pendiente, base } = await preparar();
    acceso.pendientes.push(pendiente());
    const res = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(await res.json()).toMatchObject({ ok: true, liberadas: 1, errores: 0 });
    const outbox = ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.acceso_huesped");
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox[0])).toContain(SECRETO);
    expect(acceso.liberadas.has(OCUPACION)).toBe(true);
    const again = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(await again.json()).toMatchObject({ liberadas: 0 });
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.acceso_huesped")).toHaveLength(1);
    const bit = (await (await app.request(`${base}/acceso-huesped/bitacora`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"))).json()) as { eventos: { evento: string; reserva_id: string }[] };
    expect(bit.eventos).toEqual([expect.objectContaining({ evento: "liberada", reserva_id: OCUPACION })]);
    expect(JSON.stringify(bit)).not.toContain(CORREO);
    expect(JSON.stringify(bit)).not.toContain(SECRETO);
  });

  it("huésped sin correo: no se encola nada, queda 'omitida_sin_contacto'", async () => {
    const { ctx, app, acceso, pendiente } = await preparar();
    acceso.pendientes.push(pendiente({ huespedContacto: "+52 999 000 0000" }));
    const body = (await (await app.request("/internal/rentas/acceso-huesped", CRON)).json()) as { liberadas: number; omitidas_sin_contacto: number };
    expect(body).toMatchObject({ liberadas: 0, omitidas_sin_contacto: 1 });
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.acceso_huesped")).toHaveLength(0);
  });

  it("contra la base sin la migración 025 responde 200 con disponible:false (nunca 500)", async () => {
    const { app, acceso } = await preparar();
    acceso.migracion025Disponible = false;
    const res = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false, liberadas: 0 });
  });

  it("no filtra correo ni código a los logs aunque falle la entrega", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, app, acceso, pendiente } = await preparar();
    acceso.pendientes.push(pendiente());
    const original = ctx.rentasRepo.enqueueMessagingOutbox.bind(ctx.rentasRepo);
    ctx.rentasRepo.enqueueMessagingOutbox = async (...args: Parameters<typeof original>) => {
      if (args[3] === "reserva.acceso_huesped") throw Object.assign(new Error(`fallo con ${CORREO} ${SECRETO}`), { code: "40P01" });
      return original(...args);
    };
    const res = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, liberadas: 0, errores: 1 });
    expect(acceso.liberadas.size).toBe(0);
    const logs = JSON.stringify(spy.mock.calls);
    expect(logs).not.toContain(CORREO);
    expect(logs).not.toContain(SECRETO);
  });
});
