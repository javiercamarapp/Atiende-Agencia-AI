// H-P3-04 -- configuracion del hotel desde el panel: impuestos, politica de cancelacion, sobreventa, listar/editar tarifas y bitacora.
// HTTP real (app.request) sobre el repositorio en memoria, que reproduce las validaciones y la bitacora de las funciones `hoteles.set_*`
// (la autoridad real, RLS y GRANT, la cubre scripts/verify-hoteles-configuracion contra Postgres real).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@atiende/db";
import { HotelConfigUnavailableError } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

afterEach(() => vi.useRealTimers());

const put = (token: string, body: unknown): RequestInit => ({ ...authedJson(token, body), method: "PUT" });
const get = (token: string): RequestInit => authedJson(token);

async function ctxApp() {
  const ctx = await buildHotelesTestContext(buildApp);
  return { ctx, app: buildApp(ctx.deps), base: `/hoteles/${ctx.propertyId}` };
}

const IMPUESTOS_OK = { ivaRate: 0.16, ishRate: 0.04, discountThreshold: 600, dsaPerNight: 15 };

describe("configuracion/impuestos", () => {
  it("owner y gm leen y guardan; accountant solo lee; frontdesk/reservations/housekeeping/fnb ni leen ni escriben", async () => {
    const { ctx, app, base } = await ctxApp();
    for (const lector of [ctx.staff.owner, ctx.staff.gm, ctx.staff.accountant]) {
      const res = await app.request(`${base}/configuracion/impuestos`, get(lector.token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ivaRate: number; ishRate: number; aviso: string; configurado: boolean };
      expect(body).toMatchObject({ ivaRate: 0.16, ishRate: 0.03, configurado: true });
      expect(body.aviso).toMatch(/contador/i);
    }
    for (const sinAcceso of [ctx.staff.frontdesk, ctx.staff.reservations, ctx.staff.housekeeping, ctx.staff.fnb]) {
      expect((await app.request(`${base}/configuracion/impuestos`, get(sinAcceso.token))).status).toBe(403);
      expect((await app.request(`${base}/configuracion/impuestos`, put(sinAcceso.token, IMPUESTOS_OK))).status).toBe(403);
    }
    expect((await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.accountant.token, IMPUESTOS_OK))).status).toBe(403);
    const ok = await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.gm.token, IMPUESTOS_OK));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ishRate: 0.04, dsaPerNight: 15, discountThreshold: 600 });
  });

  it("una property sin configuracion guardada devuelve los valores por omision con configurado:false", async () => {
    const { ctx, app } = await ctxApp();
    // Segunda property del mismo hotel, sin tax_config sembrado.
    const otraProperty = randomUUID();
    (ctx.deps.engine as unknown as { seedProperty(p: object): void }).seedProperty({ id: otraProperty, organizationId: ctx.organizationId });
    const res = await app.request(`/hoteles/${otraProperty}/configuracion/impuestos`, get(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0, configurado: false });
  });

  it.each([
    ["IVA mayor a 1", { ...IMPUESTOS_OK, ivaRate: 1.5 }],
    ["ISH negativo", { ...IMPUESTOS_OK, ishRate: -0.01 }],
    ["IVA como texto", { ...IMPUESTOS_OK, ivaRate: "16%" }],
    ["umbral negativo", { ...IMPUESTOS_OK, discountThreshold: -1 }],
    ["DSA negativo", { ...IMPUESTOS_OK, dsaPerNight: -5 }],
    ["falta ishRate", { ivaRate: 0.16, discountThreshold: 500 }],
  ])("rechaza con 400 un rango invalido: %s", async (_nombre, body) => {
    const { ctx, app, base } = await ctxApp();
    const res = await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.owner.token, body));
    expect(res.status).toBe(400);
    // Nada se guardo: el ISH sigue en 3 %.
    expect(await (await app.request(`${base}/configuracion/impuestos`, get(ctx.staff.owner.token))).json()).toMatchObject({ ishRate: 0.03 });
  });

  it("la bitacora guarda valor anterior y nuevo, la lee owner/gm (no accountant) y repetir el mismo guardado no duplica", async () => {
    const { ctx, app, base } = await ctxApp();
    await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.owner.token, IMPUESTOS_OK));
    await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.owner.token, IMPUESTOS_OK));
    const bitacora = await app.request(`${base}/configuracion/bitacora`, get(ctx.staff.gm.token));
    expect(bitacora.status).toBe(200);
    const { entradas } = (await bitacora.json()) as { entradas: Array<{ area: string; actorUserId: string; valorAnterior: { ishRate: number }; valorNuevo: { ishRate: number } }> };
    expect(entradas).toHaveLength(1);
    expect(entradas[0]).toMatchObject({ area: "impuestos", actorUserId: ctx.staff.owner.id, valorAnterior: { ishRate: 0.03 }, valorNuevo: { ishRate: 0.04 } });
    expect((await app.request(`${base}/configuracion/bitacora`, get(ctx.staff.accountant.token))).status).toBe(403);
  });

  it("la cotizacion usa el ISH editado (el motor de cotizacion lee la configuracion guardada)", async () => {
    const { ctx, app, base } = await ctxApp();
    const cotizar = async () =>
      ((await (await app.request(`${base}/quotes`, authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }))).json()) as { totalAmount: number }).totalAmount;
    expect(await cotizar()).toBe(1500 * 1.19);
    await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.owner.token, { ...IMPUESTOS_OK, ishRate: 0.05 }));
    expect(await cotizar()).toBe(1500 * 1.21);
  });

  it("cross-tenant: el owner de OTRO hotel no lee ni escribe (403/404) y no cambia nada", async () => {
    const { ctx, app, base } = await ctxApp();
    const otraOrg = randomUUID();
    (ctx.deps.coreRepo as unknown as { addOrganization(o: object): void }).addOrganization({ id: otraOrg, slug: "otro", name: "Otro", vertical: "hoteles" });
    const id = randomUUID();
    const coreRepo = ctx.deps.coreRepo as unknown as { addStaff(s: object): void; addMembership(m: object): void };
    coreRepo.addStaff({ id, email: "owner@otro.mx", fullName: "o", passwordHash: await hashPassword("correcto-caballo-batería"), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    const m = { userId: id, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null };
    coreRepo.addMembership(m);
    (ctx.deps.engine as unknown as { seedMembership(m: object): void }).seedMembership(m);
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@otro.mx", password: "correcto-caballo-batería" }) });
    const token = ((await login.json()) as { token: string }).token;
    for (const path of ["impuestos", "politica-cancelacion", "sobreventa", "bitacora"]) {
      expect([403, 404]).toContain((await app.request(`${base}/configuracion/${path}`, get(token))).status);
    }
    expect([403, 404]).toContain((await app.request(`${base}/configuracion/impuestos`, put(token, IMPUESTOS_OK))).status);
    expect(await (await app.request(`${base}/configuracion/impuestos`, get(ctx.staff.owner.token))).json()).toMatchObject({ ishRate: 0.03 });
  });
});

describe("configuracion/politica-cancelacion", () => {
  const POLITICA = { freeUntilHours: 72, penaltyPct: 0.25, guestText: "  Cancelación gratis hasta 72 horas antes.  " };

  it("sin guardar devuelve los valores por omision; owner guarda (texto recortado); accountant lee; frontdesk 403", async () => {
    const { ctx, app, base } = await ctxApp();
    expect(await (await app.request(`${base}/configuracion/politica-cancelacion`, get(ctx.staff.accountant.token))).json()).toMatchObject({ configurado: true });
    const res = await app.request(`${base}/configuracion/politica-cancelacion`, put(ctx.staff.owner.token, POLITICA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ freeUntilHours: 72, penaltyPct: 0.25, guestText: "Cancelación gratis hasta 72 horas antes.", configurado: true });
    expect((await app.request(`${base}/configuracion/politica-cancelacion`, put(ctx.staff.frontdesk.token, POLITICA))).status).toBe(403);
    expect((await app.request(`${base}/configuracion/politica-cancelacion`, put(ctx.staff.accountant.token, POLITICA))).status).toBe(403);
  });

  it.each([
    ["penalidad mayor a 1", { ...POLITICA, penaltyPct: 1.2 }],
    ["horas negativas", { ...POLITICA, freeUntilHours: -1 }],
    ["horas fraccionarias", { ...POLITICA, freeUntilHours: 1.5 }],
    ["texto demasiado largo", { ...POLITICA, guestText: "x".repeat(1001) }],
  ])("rechaza con 400: %s", async (_n, body) => {
    const { ctx, app, base } = await ctxApp();
    expect((await app.request(`${base}/configuracion/politica-cancelacion`, put(ctx.staff.owner.token, body))).status).toBe(400);
  });

  it("la cancelacion usa la politica EDITADA: con 0 h libres y 25 % de penalidad cancelar dentro de la ventana cobra penalidad", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T12:00:00.000Z"));
    const { ctx, app, base } = await ctxApp();
    await app.request(`${base}/configuracion/politica-cancelacion`, put(ctx.staff.owner.token, { freeUntilHours: 4000, penaltyPct: 0.25, guestText: null }));
    const crear = await app.request(`${base}/reservas`, authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-cfg-cancel" }));
    const reserva = (await crear.json()) as { id: string };
    const cancelar = await app.request(`${base}/reservas/${reserva.id}/cancelar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(cancelar.status).toBe(200);
    const body = (await cancelar.json()) as { penalizacionCancelacion: number };
    expect(body.penalizacionCancelacion).toBeGreaterThan(0);
  });
});

describe("configuracion/sobreventa", () => {
  it("lista los tipos con 0 por omision; owner edita; lo editado se respeta en la disponibilidad; frontdesk 403; tipo ajeno 404", async () => {
    const { ctx, app, base } = await ctxApp();
    const lista = await app.request(`${base}/configuracion/sobreventa`, get(ctx.staff.accountant.token));
    expect(((await lista.json()) as { tipos: Array<{ roomTypeId: string; maxOverbookRooms: number }> }).tipos).toEqual([
      expect.objectContaining({ roomTypeId: ctx.roomTypeId, maxOverbookRooms: 0 }),
    ]);
    const res = await app.request(`${base}/configuracion/sobreventa/${ctx.roomTypeId}`, put(ctx.staff.owner.token, { maxOverbookRooms: 3, thresholdPct: 90 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ roomTypeId: ctx.roomTypeId, maxOverbookRooms: 3, thresholdPct: 90 });
    // El adaptador de disponibilidad (mismo que usa la reserva) lee el valor editado: 2 de 2 + 3 de sobreventa.
    await ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, "2026-12-01", 2);
    await expect(ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, "2026-12-01", 3)).resolves.toBeUndefined();
    expect((await app.request(`${base}/configuracion/sobreventa/${ctx.roomTypeId}`, put(ctx.staff.frontdesk.token, { maxOverbookRooms: 1 }))).status).toBe(403);
    expect((await app.request(`${base}/configuracion/sobreventa/${randomUUID()}`, put(ctx.staff.owner.token, { maxOverbookRooms: 1 }))).status).toBe(404);
    expect((await app.request(`${base}/configuracion/sobreventa/no-es-uuid`, put(ctx.staff.owner.token, { maxOverbookRooms: 1 }))).status).toBe(400);
  });

  it.each([[-1], [101], [1.5], ["2"]])("rechaza maxOverbookRooms=%s con 400", async (valor) => {
    const { ctx, app, base } = await ctxApp();
    expect((await app.request(`${base}/configuracion/sobreventa/${ctx.roomTypeId}`, put(ctx.staff.owner.token, { maxOverbookRooms: valor }))).status).toBe(400);
  });
});

describe("tarifas: listar y editar", () => {
  async function tarifasDe(app: ReturnType<typeof buildApp>, base: string, token: string, query = "desde=2026-12-01&hasta=2026-12-31") {
    const res = await app.request(`${base}/tarifas?${query}`, get(token));
    return { res, body: (await res.json()) as { tarifas: Array<{ id: string; date: string; price: number; manualPriceAt: string | null; roomTypeId: string }>; truncado: boolean } };
  }

  it("lista una fila por noche del rango, ordenada por fecha, filtrable por tipo; accountant lee, frontdesk 403", async () => {
    const { ctx, app, base } = await ctxApp();
    const { res, body } = await tarifasDe(app, base, ctx.staff.owner.token);
    expect(res.status).toBe(200);
    expect(body.tarifas.map((t) => t.date)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    expect(body.tarifas.every((t) => t.price === 1500 && t.manualPriceAt === null)).toBe(true);
    expect((await tarifasDe(app, base, ctx.staff.accountant.token)).res.status).toBe(200);
    expect((await tarifasDe(app, base, ctx.staff.frontdesk.token)).res.status).toBe(403);
    expect((await tarifasDe(app, base, ctx.staff.owner.token, `desde=2026-12-01&hasta=2026-12-31&roomTypeId=${randomUUID()}`)).body.tarifas).toEqual([]);
  });

  it.each([["fecha mala", "desde=2026-13-45&hasta=2026-12-31"], ["hasta antes de desde", "desde=2026-12-10&hasta=2026-12-01"], ["rango de mas de un anio", "desde=2026-01-01&hasta=2027-12-31"], ["roomTypeId invalido", "roomTypeId=abc"]])(
    "rechaza con 400: %s",
    async (_n, query) => {
      const { ctx, app, base } = await ctxApp();
      expect((await tarifasDe(app, base, ctx.staff.owner.token, query)).res.status).toBe(400);
    },
  );

  it("editar el precio: la cotizacion lo usa, queda marcado como manual, la bitacora lo registra y repetirlo es idempotente", async () => {
    const { ctx, app, base } = await ctxApp();
    const { body } = await tarifasDe(app, base, ctx.staff.owner.token);
    const objetivo = body.tarifas[0]!;
    const editar = () => app.request(`${base}/tarifas/${objetivo.id}`, put(ctx.staff.gm.token, { precio: 1800 }));
    const res = await editar();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: objetivo.id, price: 1800, manualPriceAt: expect.any(String) });
    expect((await editar()).status).toBe(200);
    const cot = await app.request(`${base}/quotes`, authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }));
    expect(((await cot.json()) as { netAmount: number }).netAmount).toBe(1800);
    const { entradas } = (await (await app.request(`${base}/configuracion/bitacora`, get(ctx.staff.owner.token))).json()) as { entradas: Array<{ area: string; valorAnterior: { price: number }; valorNuevo: { price: number } }> };
    expect(entradas).toHaveLength(1);
    expect(entradas[0]).toMatchObject({ area: "tarifa", valorAnterior: { price: 1500 }, valorNuevo: { price: 1800 } });
  });

  it("frontdesk y accountant no editan (403); precio invalido 400; tarifa inexistente o id mal formado -> 404/400", async () => {
    const { ctx, app, base } = await ctxApp();
    const { body } = await tarifasDe(app, base, ctx.staff.owner.token);
    const id = body.tarifas[0]!.id;
    expect((await app.request(`${base}/tarifas/${id}`, put(ctx.staff.frontdesk.token, { precio: 1 }))).status).toBe(403);
    expect((await app.request(`${base}/tarifas/${id}`, put(ctx.staff.accountant.token, { precio: 1 }))).status).toBe(403);
    expect((await app.request(`${base}/tarifas/${id}`, put(ctx.staff.owner.token, { precio: -1 }))).status).toBe(400);
    expect((await app.request(`${base}/tarifas/${id}`, put(ctx.staff.owner.token, { precio: "caro" }))).status).toBe(400);
    expect((await app.request(`${base}/tarifas/${id}`, put(ctx.staff.owner.token, { precio: 10, estanciaMinima: 0 }))).status).toBe(400);
    expect((await app.request(`${base}/tarifas/${randomUUID()}`, put(ctx.staff.owner.token, { precio: 10 }))).status).toBe(404);
    expect((await app.request(`${base}/tarifas/xyz`, put(ctx.staff.owner.token, { precio: 10 }))).status).toBe(400);
  });
});

describe("base sin migrar: lectura con valores por omision, escritura 503 honesta", () => {
  it("si la escritura lanza HotelConfigUnavailableError la ruta responde 503 (nunca 500) con el aviso 'no disponible aun'", async () => {
    const { ctx, app, base } = await ctxApp();
    const original = ctx.hotelesRepo.saveTaxSettings.bind(ctx.hotelesRepo);
    ctx.hotelesRepo.saveTaxSettings = async () => {
      throw new HotelConfigUnavailableError("saveTaxSettings");
    };
    const res = await app.request(`${base}/configuracion/impuestos`, put(ctx.staff.owner.token, IMPUESTOS_OK));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toMatch(/no disponible a[uú]n/i);
    ctx.hotelesRepo.saveTaxSettings = original;
  });
});
