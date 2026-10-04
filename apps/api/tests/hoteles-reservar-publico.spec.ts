// H-42 -- motor de reservas DIRECTO PUBLICO de hoteles (disponibilidad, cotizacion, confirmacion, estado y cancelacion por token, sin login).
// Integracion HTTP real (app.request) sobre el espejo en memoria. RLS/GRANT/funciones SQL y la carrera real por la ultima habitacion las cubre
// scripts/verify-hoteles-reservar-publico contra Postgres real; aqui se cubre el contrato HTTP, la validacion, los tokens y el manejo del cobro.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryPaymentsPort, InMemoryReservarDirectoRepository, type PaymentsPort } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const ORG = "hotel-de-prueba";
const BASE = `/v1/hoteles/${ORG}/reservar`;
const ORIGIN = "http://localhost:5173";
const PM = "pm_test_12345678";

const addDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function setup(opts: { payments?: PaymentsPort } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryReservarDirectoRepository();
  const roomTypeId = randomUUID();
  repo.seedProperty(ctx.propertyId, { organizationId: ctx.organizationId, name: "Hotel de Prueba — Matriz" });
  repo.seedRoomType(ctx.propertyId, roomTypeId, "Doble", 2);
  repo.seedInventory(ctx.propertyId, roomTypeId, addDays(0), addDays(60), 1, 100_000);
  repo.setPolicy(ctx.propertyId, { webEnabled: true, holdsEnabled: true, depositPct: 0.3 });
  repo.setTerms(ctx.propertyId, { freeUntilHours: 48, penaltyPct: 0.25 });
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, hotelesReservarPublicoRepo: () => repo, ...(opts.payments ? { hotelesPaymentsPort: opts.payments } : {}) });
  return { ctx, repo, roomTypeId, emisiones, app: buildApp(deps) };
}
type App = ReturnType<typeof buildApp>;

let ipSeq = 0;
function post(path: string, body: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  const raw = JSON.stringify(body);
  ipSeq += 1;
  return [path, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), origin: ORIGIN, "x-forwarded-for": `198.18.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`, ...headers } }];
}
let keySeq = 0;
const idem = () => ({ "idempotency-key": `idem-${Date.now()}-${(keySeq += 1)}` });

async function cotizar(app: App, roomTypeId: string, llegada = addDays(10), salida = addDays(12), huespedes = 2) {
  const res = await app.request(...post(`${BASE}/cotizacion`, { llegada, salida, huespedes, tipoHabitacionId: roomTypeId }));
  return { res, body: (await res.json()) as Record<string, any> };
}
const HUESPED = { nombre: "Ana Torres", telefono: "+52 999 123 4567", correo: "ana.torres@example.com" };
async function confirmar(app: App, quoteToken: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = idem(), huesped = HUESPED) {
  return app.request(...post(`${BASE}/confirmar`, { quoteToken, huesped, consentimientoAviso: true, ...extra }, headers));
}

describe("GET /v1/hoteles/:orgSlug/reservar y /disponibilidad (sin login)", () => {
  it("la configuracion publica solo expone politica del hotel: anticipo, topes y terminos de cancelacion", async () => {
    const { app } = await setup();
    const res = await app.request(BASE, { headers: { "x-forwarded-for": "198.51.100.1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { disponible: boolean; propiedades: Array<Record<string, unknown>> };
    expect(body.disponible).toBe(true);
    expect(body.propiedades[0]).toMatchObject({ slug: "hotel-de-prueba-matriz", reservaEnLinea: true, anticipoPct: 0.3, cancelacion: { ventanaGratisHoras: 48, penalidadPct: 0.25 } });
    expect(Object.keys(body.propiedades[0]!)).not.toContain("maxActiveHolds");
  });
  it("hotel inexistente = 404 y base sin migrar = disponible false (nunca 500)", async () => {
    const { app, repo } = await setup();
    expect((await app.request(`/v1/hoteles/otro-hotel/reservar`)).status).toBe(404);
    repo.migrationApplied = false;
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
    expect((await app.request(`${BASE}/disponibilidad?llegada=${addDays(10)}&salida=${addDays(12)}&huespedes=2`)).status).toBe(200);
  });
  it("la disponibilidad lista tipos y precio desde, nunca el inventario exacto ni ids de huespedes", async () => {
    const { app, roomTypeId } = await setup();
    const res = await app.request(`${BASE}/disponibilidad?llegada=${addDays(10)}&salida=${addDays(12)}&huespedes=2`, { headers: { "x-forwarded-for": "198.51.100.2" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opciones: Array<Record<string, unknown>> };
    expect(body.opciones).toHaveLength(1);
    expect(body.opciones[0]).toMatchObject({ tipoHabitacionId: roomTypeId, nombre: "Doble", disponible: true });
    expect(Object.keys(body.opciones[0]!).sort()).toEqual(["desdePorNocheCentavos", "disponible", "maxOcupacion", "motivo", "nombre", "tipoHabitacionId", "totalCentavos"]);
    expect(JSON.stringify(body)).not.toMatch(/freeRooms|bookedRooms|total_rooms|guestEmail|contactPhone/i);
  });
  it("valida fechas y ocupacion: 400 con mensaje seguro (jamas 500)", async () => {
    const { app } = await setup();
    const q = (s: string) => app.request(`${BASE}/disponibilidad?${s}`, { headers: { "x-forwarded-for": "198.51.100.3" } });
    expect((await q(`llegada=2026-02-31&salida=2026-03-02&huespedes=2`)).status).toBe(400);
    expect((await q(`llegada=${addDays(12)}&salida=${addDays(10)}&huespedes=2`)).status).toBe(400);
    expect((await q(`llegada=${addDays(10)}&salida=${addDays(12)}&huespedes=0`)).status).toBe(400);
    expect((await q(`llegada=${addDays(10)}&salida=${addDays(12)}`)).status).toBe(400);
    expect((await q(`llegada=${addDays(-3)}&salida=${addDays(-1)}&huespedes=2`)).status).toBe(400);
  });
  it("sin reserva en linea habilitada lo dice honestamente", async () => {
    const { app, repo, ctx } = await setup();
    repo.setPolicy(ctx.propertyId, { webEnabled: false });
    const res = await app.request(`${BASE}/disponibilidad?llegada=${addDays(10)}&salida=${addDays(12)}&huespedes=2`, { headers: { "x-forwarded-for": "198.51.100.4" } });
    expect(await res.json()).toMatchObject({ disponible: true, reservaEnLinea: false });
  });
});

describe("POST /reservar/cotizacion", () => {
  it("el servidor calcula el precio y firma un quoteToken sin datos personales", async () => {
    const { app, roomTypeId } = await setup();
    const { res, body } = await cotizar(app, roomTypeId);
    expect(res.status).toBe(200);
    expect(body.cotizacion.totalCentavos).toBe(238_000); // 2 noches x 100000 + IVA 16% + ISH 3%
    expect(body.anticipo).toMatchObject({ porcentaje: 0.3, centavos: 71_400, requerido: true });
    expect(body.quoteToken).toMatch(/^q1\./);
    expect(Buffer.from(String(body.quoteToken).split(".")[1]!, "base64url").toString()).not.toMatch(/ana|example|999/i);
  });
  it("ignora cualquier precio mandado por el navegador y rechaza origenes no permitidos y tipos ajenos", async () => {
    const { app, roomTypeId } = await setup();
    const res = await app.request(...post(`${BASE}/cotizacion`, { llegada: addDays(10), salida: addDays(12), huespedes: 2, tipoHabitacionId: roomTypeId, totalCentavos: 1 }));
    expect(((await res.json()) as any).cotizacion.totalCentavos).toBe(238_000);
    expect((await app.request(...post(`${BASE}/cotizacion`, { llegada: addDays(10), salida: addDays(12), huespedes: 2, tipoHabitacionId: roomTypeId }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await cotizar(app, randomUUID())).res.status).toBe(404);
    expect((await cotizar(app, roomTypeId, addDays(10), addDays(12), 5)).res.status).toBe(400); // la Doble no cabe 5
    expect((await app.request(...post(`${BASE}/cotizacion`, { llegada: addDays(10), salida: addDays(12), huespedes: 2, tipoHabitacionId: "no-uuid" }))).status).toBe(400);
  });
  it("sin inventario responde 409 sin_disponibilidad", async () => {
    const { app, roomTypeId, repo } = await setup();
    await confirmar(app, (await cotizar(app, roomTypeId)).body.quoteToken, { metodoPagoToken: PM });
    expect(repo.allHolds()).toHaveLength(1);
    const otra = await cotizar(app, roomTypeId);
    expect(otra.res.status).toBe(409);
    expect(otra.body.code).toBe("sin_disponibilidad");
  });
});

describe("POST /reservar/confirmar", () => {
  it("con metodo de pago tokenizado cobra el anticipo, confirma y devuelve un token de estado; avisa al staff sin PII", async () => {
    const { app, roomTypeId, repo, emisiones } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    const res = await confirmar(app, q.quoteToken, { metodoPagoToken: PM });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ estado: "confirmada", totalCentavos: 238_000, anticipoCentavos: 71_400, pago: { estado: "capturado" } });
    expect(body.rastreoToken).toMatch(/^e1\./);
    expect(repo.allReservations().map((r) => r.channel)).toEqual(["directo_web"]);
    expect(JSON.stringify(body)).not.toMatch(/test_h42|ana\.torres|999 123/);
    expect(emisiones.map((e) => e.evento)).toEqual(["hoteles.reserva_directa.nueva"]);
    expect(JSON.stringify(emisiones)).not.toMatch(/Ana|ana\.torres|999/);
  });
  it("guardia de precio: si el precio vigente difiere del cotizado responde 409 con el total vigente y NO retiene nada", async () => {
    const { app, roomTypeId, repo, ctx } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    repo.seedInventory(ctx.propertyId, roomTypeId, addDays(0), addDays(60), 1, 120_000);
    const res = await confirmar(app, q.quoteToken, { metodoPagoToken: PM });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "precio_cambio", totalCentavos: 285_600 });
    expect(repo.allHolds()).toHaveLength(0);
  });
  it("carrera por la ultima habitacion: dos confirmaciones simultaneas -> una gana y la otra recibe 409", async () => {
    const { app, roomTypeId, repo, ctx } = await setup();
    const [a, b] = await Promise.all([cotizar(app, roomTypeId), cotizar(app, roomTypeId)]);
    const otro = { nombre: "Luis Mora", telefono: "+52 999 765 4321", correo: "luis.mora@example.com" };
    const [r1, r2] = await Promise.all([confirmar(app, a.body.quoteToken, { metodoPagoToken: PM }), confirmar(app, b.body.quoteToken, { metodoPagoToken: PM }, idem(), otro)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(repo.allHolds().filter((h) => h.status !== "cancelado")).toHaveLength(1);
    expect(repo.booked(ctx.propertyId, roomTypeId, addDays(10))).toBe(1);
  });
  it("sin metodo de pago el hold queda pendiente de pago (202) y visible, sin cobrar nada", async () => {
    const { app, roomTypeId, repo } = await setup();
    const res = await confirmar(app, (await cotizar(app, roomTypeId)).body.quoteToken);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ estado: "pago_pendiente", pago: { estado: "pendiente" } });
    expect(repo.allHolds()[0]).toMatchObject({ status: "pendiente_pago", paymentStatus: "pendiente", channel: "web" });
  });
  it("sin llave de la pasarela (el cobro lanza): 503 honesto y el hold queda apartado pendiente de pago", async () => {
    const sinLlave: PaymentsPort = { charge: async () => { throw new Error("STRIPE_SECRET_KEY no configurada"); } };
    const { app, roomTypeId, repo } = await setup({ payments: sinLlave });
    const res = await confirmar(app, (await cotizar(app, roomTypeId)).body.quoteToken, { metodoPagoToken: PM });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("pago_no_disponible");
    expect(JSON.stringify(body)).not.toMatch(/STRIPE|llave/i);
    expect(body.estado).toBe("pago_pendiente");
    expect(repo.allHolds()[0]).toMatchObject({ status: "pendiente_pago" });
  });
  it("pago rechazado: 402 y el hold sigue apartado", async () => {
    const rechaza: PaymentsPort = { charge: async () => ({ status: "fallido", externalPaymentId: "pi_fail" }) };
    const { app, roomTypeId, repo } = await setup({ payments: rechaza });
    const res = await confirmar(app, (await cotizar(app, roomTypeId)).body.quoteToken, { metodoPagoToken: PM });
    expect(res.status).toBe(402);
    expect(repo.allHolds()[0]).toMatchObject({ status: "pendiente_pago", paymentStatus: "fallido" });
  });
  it("Idempotency-Key: el reintento con la misma llave no duplica el hold; sin llave 400", async () => {
    const { app, roomTypeId, repo } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    const h = idem();
    const r1 = await confirmar(app, q.quoteToken, {}, h);
    const r2 = await confirmar(app, q.quoteToken, {}, h);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(repo.allHolds()).toHaveLength(1);
    expect((await confirmar(app, q.quoteToken, {}, {})).status).toBe(400);
  });
  it("valida: consentimiento obligatorio, token adulterado o vencido, datos de tarjeta, origen y honeypot (sin guardar nada)", async () => {
    const { app, roomTypeId, repo } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    expect((await confirmar(app, q.quoteToken, { consentimientoAviso: false })).status).toBe(400);
    expect((await confirmar(app, `${q.quoteToken}x`)).status).toBe(400);
    expect((await confirmar(app, "q1.eyJ4IjoxfQ.firmafalsa-firmafalsa")).status).toBe(400);
    expect((await confirmar(app, q.quoteToken, { metodoPagoToken: "4242424242424242" })).status).toBe(400);
    expect((await confirmar(app, q.quoteToken, {}, idem(), { ...HUESPED, correo: "no-es-correo" })).status).toBe(400);
    expect((await app.request(...post(`${BASE}/confirmar`, { quoteToken: q.quoteToken, huesped: HUESPED, consentimientoAviso: true }, { ...idem(), origin: "https://evil.example" }))).status).toBe(403);
    const robot = await confirmar(app, q.quoteToken, { sitioWeb: "http://spam.example" });
    expect(robot.status).toBe(202);
    expect(JSON.stringify(await robot.json())).not.toMatch(/rastreoToken/);
    expect(repo.allHolds()).toHaveLength(0);
  });
  it("un quoteToken vencido responde 409 cotizacion_vencida", async () => {
    const { app, roomTypeId } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    const ahora = Date.now();
    const realNow = Date.now;
    Date.now = () => ahora + 16 * 60_000;
    try {
      const res = await confirmar(app, q.quoteToken);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "cotizacion_vencida" });
    } finally {
      Date.now = realNow;
    }
  });
  it("topes por contacto: a la sexta confirmacion con el mismo correo en una hora responde 429", async () => {
    const { app, roomTypeId } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    const codigos: number[] = [];
    for (let i = 0; i < 7; i += 1) codigos.push((await confirmar(app, q.quoteToken, { sitioWeb: "" })).status);
    expect(codigos).toContain(429);
  });
  it("cross-tenant: el quoteToken de un hotel no sirve en otro slug", async () => {
    const { app, roomTypeId } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    expect((await app.request(...post(`/v1/hoteles/otro-hotel/reservar/confirmar`, { quoteToken: q.quoteToken, huesped: HUESPED, consentimientoAviso: true }, idem()))).status).toBe(404);
  });
  it("base sin migrar: 503 (nunca 500)", async () => {
    const { app, roomTypeId, repo } = await setup();
    const { body: q } = await cotizar(app, roomTypeId);
    repo.migrationApplied = false;
    expect((await confirmar(app, q.quoteToken)).status).toBe(503);
  });
});

describe("GET /reservar/estado/:token y cancelacion", () => {
  async function reservada(s: Awaited<ReturnType<typeof setup>>, llegada = addDays(10), salida = addDays(12)) {
    const { body: q } = await cotizar(s.app, s.roomTypeId, llegada, salida);
    const res = await confirmar(s.app, q.quoteToken, { metodoPagoToken: PM });
    return (await res.json()) as Record<string, any>;
  }
  const estado = (app: App, token: string, org = ORG) => app.request(`/v1/hoteles/${org}/reservar/estado/${token}`, { headers: { "x-forwarded-for": "198.51.100.9" } });
  const cancelar = (app: App, token: string, body: unknown = {}, headers: Record<string, string> = idem()) => app.request(...post(`${BASE}/estado/${token}/cancelar`, body, headers));

  it("el estado por token no trae datos personales ni referencias de la pasarela", async () => {
    const s = await setup();
    const r = await reservada(s);
    const res = await estado(s.app, r.rastreoToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ estado: "confirmada", hotel: "Hotel de Prueba — Matriz", tipoHabitacion: "Doble", cancelable: true });
    expect(JSON.stringify(body)).not.toMatch(/ana\.torres|999|test_|paymentRef|pi_/i);
  });
  it("sin enumeracion: token adulterado, de otra organizacion, de un hold inexistente o con el slug equivocado responden LO MISMO (404)", async () => {
    const s = await setup();
    const r = await reservada(s);
    const cuerpo = async (x: Response) => ({ status: x.status, json: await x.json() });
    const adulterado = await cuerpo(await estado(s.app, `${r.rastreoToken}x`));
    const basura = await cuerpo(await estado(s.app, "no-es-un-token"));
    const otroHotel = await cuerpo(await estado(s.app, r.rastreoToken, "otro-hotel"));
    expect(adulterado.status).toBe(404);
    expect(basura).toEqual(adulterado);
    expect(otroHotel).toEqual(adulterado);
    // el token de cotizacion no valida como token de estado
    const { body: q } = await cotizar(s.app, s.roomTypeId, addDays(20), addDays(21));
    expect(await cuerpo(await estado(s.app, q.quoteToken))).toEqual(adulterado);
  });
  it("cancelar con penalidad: dentro de la ventana de 48 h cobra 25% del total y devuelve el resto del anticipo via PaymentsPort", async () => {
    const s = await setup();
    const r = await reservada(s, addDays(1), addDays(2)); // llegada en menos de 48 h
    expect(r.cancelacion.siCancelasAhora).toMatchObject({ penalidadCents: 29_750 });
    const res = await cancelar(s.app, r.rastreoToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.estado).toBe("cancelada");
    // total 119000 (100000 + IVA 16% + ISH 3%); penalidad 25% = 29750; anticipo 30% = 35700 -> reembolso 5950
    expect(body.cancelacion.resultado).toEqual({ penalidadCentavos: 29_750, reembolsoCentavos: 5_950 });
    expect(body.pago.reembolso).toBe("procesado");
    expect(s.repo.booked(s.ctx.propertyId, s.roomTypeId, addDays(1))).toBe(0);
    // idempotente: cancelar de nuevo no vuelve a reembolsar ni falla
    const otra = await cancelar(s.app, r.rastreoToken);
    expect(otra.status).toBe(200);
    expect(((await otra.json()) as any).estado).toBe("cancelada");
  });
  it("cancelar fuera de la ventana no tiene penalidad: reembolsa todo el anticipo", async () => {
    const s = await setup();
    const r = await reservada(s, addDays(15), addDays(17));
    const body = (await (await cancelar(s.app, r.rastreoToken)).json()) as Record<string, any>;
    expect(body.cancelacion.resultado).toEqual({ penalidadCentavos: 0, reembolsoCentavos: 71_400 });
  });
  it("sin llave de la pasarela el reembolso queda como solicitud para el staff y se notifica", async () => {
    const sinRefund: PaymentsPort = { charge: async (i) => ({ status: "capturado", externalPaymentId: `pi_${i.idempotencyKey}` }) };
    const s = await setup({ payments: sinRefund });
    const r = await reservada(s, addDays(15), addDays(17));
    const body = (await (await cancelar(s.app, r.rastreoToken)).json()) as Record<string, any>;
    expect(body.estado).toBe("cancelada");
    expect(body.pago.reembolso).toBe("solicitado");
    expect(s.emisiones.map((e) => e.evento)).toContain("hoteles.reserva_directa.reembolso_pendiente");
  });
  it("cancelar exige Idempotency-Key, cuerpo vacio, origen permitido y un token valido", async () => {
    const s = await setup();
    const r = await reservada(s);
    expect((await cancelar(s.app, r.rastreoToken, {}, {})).status).toBe(400);
    expect((await cancelar(s.app, r.rastreoToken, { total: 0 })).status).toBe(400);
    expect((await cancelar(s.app, r.rastreoToken, {}, { ...idem(), origin: "https://evil.example" })).status).toBe(403);
    expect((await cancelar(s.app, `${r.rastreoToken}x`)).status).toBe(404);
    expect((await estado(s.app, r.rastreoToken).then((x) => x.json()) as any).estado).toBe("confirmada");
  });
  it("cancelar un hold pendiente de pago libera el inventario sin cobro ni reembolso", async () => {
    const s = await setup();
    const { body: q } = await cotizar(s.app, s.roomTypeId);
    const r = (await (await confirmar(s.app, q.quoteToken)).json()) as Record<string, any>;
    expect(s.repo.booked(s.ctx.propertyId, s.roomTypeId, addDays(10))).toBe(1);
    const body = (await (await cancelar(s.app, r.rastreoToken)).json()) as Record<string, any>;
    expect(body.estado).toBe("cancelada");
    expect(s.repo.booked(s.ctx.propertyId, s.roomTypeId, addDays(10))).toBe(0);
  });
});

describe("KPI room-nights directas (staff)", () => {
  it("cuenta solo noches de reservas directo_web contra el total y exige sesion de staff", async () => {
    const s = await setup();
    const { body: q } = await cotizar(s.app, s.roomTypeId, addDays(10), addDays(12));
    await confirmar(s.app, q.quoteToken, { metodoPagoToken: PM });
    s.repo.seedReservation(s.ctx.propertyId, addDays(10), addDays(16), "recepcion"); // 6 noches de otro canal
    const url = `/hoteles/${s.ctx.propertyId}/revenue/room-nights-directas?desde=${addDays(0)}&hasta=${addDays(40)}`;
    expect((await s.app.request(url)).status).toBe(401);
    const res = await s.app.request(url, authedJson(s.ctx.staff.gm.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: true, directas: 2, total: 8, porcentaje: 0.25 });
    expect((await s.app.request(`/hoteles/${s.ctx.propertyId}/revenue/room-nights-directas?desde=${addDays(5)}&hasta=${addDays(1)}`, authedJson(s.ctx.staff.gm.token))).status).toBe(400);
  });
  it("base sin migrar: disponible false, nunca 500", async () => {
    const s = await setup();
    s.repo.migrationApplied = false;
    const res = await s.app.request(`/hoteles/${s.ctx.propertyId}/revenue/room-nights-directas`, authedJson(s.ctx.staff.gm.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
  });
});
