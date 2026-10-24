// Rn-P3-05/06/07 -- cadena de dinero de rentas en piloto automatico, de punta a punta por HTTP real contra los repositorios en memoria:
// el iCal trae el codigo de confirmacion de Airbnb, el CSV de pagos crea/concilia los movimientos (idempotente, con vista previa), la
// reserva directa con monto crea su movimiento en la misma transaccion, modificar/cancelar la marca en revision y el aviso diario de
// reservas sin movimiento solo se emite desde el cron.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const ICS = readFileSync(new URL("../../../packages/domain-rentas/tests/fixtures/airbnb-reserva.ics", import.meta.url), "utf8");
const CSV = readFileSync(new URL("../../../packages/domain-rentas/tests/fixtures/pagos/airbnb-transacciones.csv", import.meta.url), "utf8");
const AIRBNB_NETO = { yaNetoDeComision: true, comisionBasisPoints: 300, fuente: "Airbnb: la comision se descuenta del pago al anfitrion" } as const;
const gestor = { comisionGestorBasisPoints: 1000, comisionGestorBase: "neto_de_canal" } as const;

type Ctx = Awaited<ReturnType<typeof buildRentasTestContext>>;

async function conReservaDeAirbnb() {
  const ctx = await buildRentasTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const airbnb = (await ctx.rentasRepo.findCanalPorCodigo("airbnb"))!;
  ctx.rentasRepo.seedReglaComisionCanal({ propertyId: null, canalId: airbnb.id, config: AIRBNB_NETO });
  const cfg = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
  expect(cfg.status).toBeLessThan(300);
  ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ICS });
  const cron = await app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
  expect(cron.status).toBe(200);
  const ocupacion = [...ctx.calendarStore.ocupaciones.values()].find((o) => o.codigoConfirmacion === "HMAB12CD34");
  return { ctx, app, ocupacionId: ocupacion?.id ?? null, airbnb };
}

const importar = (ctx: Ctx, app: ReturnType<typeof buildApp>, body: Record<string, unknown>, token = ctx.staff.adminGestora.token) =>
  app.request(`/rentas/${ctx.propertyId}/payouts/importar-csv`, authedJson(token, { canalCodigo: "airbnb", contenidoCsv: CSV, ...gestor, ...body }));

describe("iCal -> codigo de confirmacion -> importar CSV de pagos", () => {
  it("el cron iCal guarda el codigo HM... de la reserva; el CSV (vista previa) no escribe; confirmar crea el movimiento; repetir es idempotente", async () => {
    const { ctx, app, ocupacionId } = await conReservaDeAirbnb();
    expect(ocupacionId).not.toBeNull();

    const previa = await importar(ctx, app, { aplicar: false });
    expect(previa.status).toBe(200);
    const pb = (await previa.json()) as { aplicado: boolean; resumen: { creadas: number; pendientes: number }; lineas: Array<{ resultado: string }> };
    expect(pb).toMatchObject({ aplicado: false, resumen: { creadas: 1, pendientes: 2 } });
    expect((await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token))).status).toBe(404);

    const aplicada = await importar(ctx, app, { aplicar: true });
    expect(aplicada.status).toBe(201);
    const ab = (await aplicada.json()) as { importacionId: string; resumen: { creadas: number } };
    expect(ab.resumen.creadas).toBe(1);
    const mov = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.contador.token));
    expect(mov.status).toBe(200);
    // Finanzas-1: Airbnb entrega neto -> recibido = lo del reporte, sin restar la comision del canal otra vez.
    expect(await mov.json()).toMatchObject({ ingresoBrutoCentavos: 873000, montoRecibidoCentavos: 873000, comisionCanalCentavos: 0, comisionGestorCentavos: 87300, netoCentavos: 785700 });

    const otra = await importar(ctx, app, { aplicar: true });
    expect(await otra.json()).toMatchObject({ resumen: { creadas: 0, yaImportadas: 3 } });
    expect(ctx.rentasRepo.lineasImportadas.size).toBe(3);

    const cola = await app.request(`/rentas/${ctx.propertyId}/finanzas/cola-importacion`, authedJson(ctx.staff.contador.token));
    const cb = (await cola.json()) as { disponible: boolean; items: Array<{ codigoConfirmacion: string | null; resultado: string }> };
    expect(cb.disponible).toBe(true);
    expect(cb.items.map((i) => i.codigoConfirmacion).sort()).toEqual(["HMAB12CD34", "HMZZ99YY88"]);

    // Cada subida confirmada deja su renglon en la bitacora (la segunda tambien: es el registro de que alguien volvio a subir el archivo).
    const bitacora = ctx.rentasRepo.auditLog.filter((a) => a.action === "payout.importado_csv");
    expect(bitacora).toHaveLength(2);
    expect(bitacora[0]).toMatchObject({ entityType: "payout", entityId: ab.importacionId });
  });

  it("roles: contador solo lee (POST importar 403), limpieza no entra a ninguna lectura; una property ajena no se alcanza", async () => {
    const { ctx, app } = await conReservaDeAirbnb();
    expect((await importar(ctx, app, { aplicar: false }, ctx.staff.contador.token)).status).toBe(403);
    expect((await importar(ctx, app, { aplicar: false }, ctx.staff.limpieza.token)).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/finanzas/sin-movimiento?periodo=2026-10`, authedJson(ctx.staff.contador.token))).status).toBe(200);
    expect((await app.request(`/rentas/${ctx.propertyId}/finanzas/sin-movimiento?periodo=2026-10`, authedJson(ctx.staff.limpieza.token))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/finanzas/cola-importacion`, authedJson(ctx.staff.limpieza.token))).status).toBe(403);
    const ajena = await app.request(`/rentas/${randomUUID()}/payouts/importar-csv`, authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", contenidoCsv: CSV, ...gestor, aplicar: true }));
    expect([403, 404]).toContain(ajena.status);
    expect(ctx.rentasRepo.lineasImportadas.size).toBe(0);
  });

  it("archivo de mas de 2 MB -> 413; canal sin parser -> 422 honesto; formato no reconocido -> 400; con filas con error no se aplica", async () => {
    const { ctx, app } = await conReservaDeAirbnb();
    const grande = await importar(ctx, app, { contenidoCsv: "Type,Confirmation Code,Currency,Paid out\n" + "x".repeat(2 * 1024 * 1024 + 10) });
    expect([413, 400]).toContain(grande.status);
    expect(grande.status).toBe(413);

    const booking = await app.request(`/rentas/${ctx.propertyId}/payouts/importar-csv`, authedJson(ctx.staff.adminGestora.token, { canalCodigo: "booking", contenidoCsv: CSV, ...gestor }));
    expect(booking.status).toBe(422);
    expect(await booking.json()).toMatchObject({ code: "formato_reporte_no_soportado" });

    const raro = await importar(ctx, app, { contenidoCsv: "a,b\n1,2\n" });
    expect(raro.status).toBe(400);

    const conError = await importar(ctx, app, { contenidoCsv: "Type,Confirmation Code,Currency,Paid out\nReservation,HMAAAAAAAA,mxn,10\n", aplicar: true });
    expect(conError.status).toBe(422);
    expect(await conError.json()).toMatchObject({ code: "reporte_con_errores" });
    expect(ctx.rentasRepo.importacionesPagos).toHaveLength(0);

    const sinGestor = await app.request(`/rentas/${ctx.propertyId}/payouts/importar-csv`, authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", contenidoCsv: CSV }));
    expect(sinGestor.status).toBe(400);
  });

  it("base sin migrar (42703): importar responde 503 'no disponible aun' y la cola/revision responden disponible:false, sin 500", async () => {
    const { ctx } = await conReservaDeAirbnb();
    const sinMigrar = Object.assign(new Error('column "codigo_confirmacion" does not exist'), { code: "42703" });
    const repo = ctx.rentasRepo;
    const proxy = new Proxy(repo, {
      get(t, p, r) {
        if (p === "findCandidatasImportacion" || p === "listColaImportacion" || p === "listMovimientosEnRevision" || p === "marcarMovimientoRevisado") return async () => { throw sinMigrar; };
        return Reflect.get(t, p, r);
      },
    });
    const app = buildApp({ ...ctx.deps, rentasRepo: () => proxy });
    const r = await importar(ctx, app, { aplicar: false });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "rentas_finanzas_autopiloto_no_disponible" });
    const cola = await app.request(`/rentas/${ctx.propertyId}/finanzas/cola-importacion`, authedJson(ctx.staff.adminGestora.token));
    expect(await cola.json()).toMatchObject({ disponible: false, items: [] });
    const rev = await app.request(`/rentas/${ctx.propertyId}/finanzas/movimientos-en-revision`, authedJson(ctx.staff.adminGestora.token));
    expect(await rev.json()).toMatchObject({ disponible: false, items: [] });
    const revisado = await app.request(`/rentas/${ctx.propertyId}/reservas/${randomUUID()}/movimiento/revisado`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(revisado.status).toBe(503);
  });
});

async function crearDirecta(ctx: Ctx, app: ReturnType<typeof buildApp>, rango: { inicio: string; fin: string }, extra: Record<string, unknown> = {}) {
  return app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango, ...extra }));
}

describe("reserva directa -> movimiento automatico (Rn-P3-07)", () => {
  it("con monto crea el movimiento en la misma peticion (canal manual, sin comision de canal) y queda en la bitacora", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await crearDirecta(ctx, app, { inicio: "2026-11-10", fin: "2026-11-13" }, { montoBrutoCentavos: 300000, moneda: "MXN", ...gestor });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; movimiento: { netoCentavos: number; origen: string } };
    expect(body.movimiento).toMatchObject({ montoBrutoCentavos: 300000, comisionCanalCentavos: 0, comisionGestorCentavos: 30000, netoCentavos: 270000, origen: "directa_automatica" });
    const mov = await app.request(`/rentas/${ctx.propertyId}/reservas/${body.id}/movimiento`, authedJson(ctx.staff.adminGestora.token));
    expect(mov.status).toBe(200);
    expect(ctx.rentasRepo.auditLog.some((a) => a.action === "reserva.movimiento_financiero_registrado" && a.entityId === body.id)).toBe(true);
  });

  it("un operador (sin permiso de finanzas) con monto o cotizar:true recibe 403 y NO se crea la reserva; sin monto si puede reservar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const token = ctx.staff.operadorAccesoTotal.token;
    const antes = ctx.calendarStore.ocupaciones.size;
    for (const extra of [{ montoBrutoCentavos: 300000, moneda: "MXN", ...gestor }, { cotizar: true, ...gestor }]) {
      const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(token, { rango: { inicio: "2026-11-10", fin: "2026-11-13" }, ...extra }));
      expect(res.status).toBe(403);
    }
    expect(ctx.calendarStore.ocupaciones.size).toBe(antes);
    expect(ctx.rentasRepo.auditLog.some((a) => a.action === "reserva.movimiento_financiero_registrado")).toBe(false);
    const sinMonto = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(token, { rango: { inicio: "2026-11-10", fin: "2026-11-13" } }));
    expect(sinMonto.status).toBe(201);
  });

  it("cotizar:true toma el monto del cotizador de la unidad; sin tarifa -> 422 y NO se crea la reserva", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await crearDirecta(ctx, app, { inicio: "2026-11-10", fin: "2026-11-12" }, { cotizar: true, ...gestor });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { movimiento: { montoBrutoCentavos: number; moneda: string } };
    expect(body.movimiento.montoBrutoCentavos).toBeGreaterThan(0);

    const sinTarifa = await buildRentasTestContext(buildApp);
    const app2 = buildApp({ ...sinTarifa.deps, rentasRepo: () => new Proxy(sinTarifa.rentasRepo, { get: (t, p, r) => (p === "loadPricingContext" ? async () => null : Reflect.get(t, p, r)) }) });
    const antes = sinTarifa.calendarStore.ocupaciones.size;
    const r2 = await crearDirecta(sinTarifa, app2, { inicio: "2026-11-10", fin: "2026-11-12" }, { cotizar: true, ...gestor });
    expect(r2.status).toBe(422);
    expect(sinTarifa.calendarStore.ocupaciones.size).toBe(antes);
  });

  it("sin monto nada cambia: la reserva se crea, no hay movimiento y aparece en 'sin movimiento' del periodo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await crearDirecta(ctx, app, { inicio: "2026-11-10", fin: "2026-11-13" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; movimiento?: unknown };
    expect(body.movimiento).toBeUndefined();
    const lista = await app.request(`/rentas/${ctx.propertyId}/finanzas/sin-movimiento?periodo=2026-11`, authedJson(ctx.staff.contador.token));
    expect(await lista.json()).toMatchObject({ periodo: "2026-11", total: 1, items: [{ ocupacionId: body.id, inicio: "2026-11-10", fin: "2026-11-13" }] });
    const otroMes = await app.request(`/rentas/${ctx.propertyId}/finanzas/sin-movimiento?periodo=2026-12`, authedJson(ctx.staff.contador.token));
    expect(await otroMes.json()).toMatchObject({ total: 0, items: [] });
    expect((await app.request(`/rentas/${ctx.propertyId}/finanzas/sin-movimiento?periodo=2026-13`, authedJson(ctx.staff.contador.token))).status).toBe(400);
  });

  it("validacion: monto sin comision del gestor, ambos modos, moneda invalida -> 400 y no se crea la reserva", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const extra of [{ montoBrutoCentavos: 1000, moneda: "MXN" }, { montoBrutoCentavos: 1000, cotizar: true, ...gestor }, { montoBrutoCentavos: 10.5, moneda: "MXN", ...gestor }, { montoBrutoCentavos: 1000, moneda: "mxn", ...gestor }, { moneda: "MXN" }]) {
      expect((await crearDirecta(ctx, app, { inicio: "2026-11-10", fin: "2026-11-13" }, extra)).status).toBe(400);
    }
    expect(ctx.calendarStore.ocupaciones.size).toBe(0);
  });

  it("modificar fechas o cancelar la reserva marca el movimiento en revision SIN recalcularlo; 'revisado' lo limpia", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const a = (await (await crearDirecta(ctx, app, { inicio: "2026-11-10", fin: "2026-11-13" }, { montoBrutoCentavos: 300000, moneda: "MXN", ...gestor })).json()) as { id: string };
    const b = (await (await crearDirecta(ctx, app, { inicio: "2026-12-10", fin: "2026-12-13" }, { montoBrutoCentavos: 100000, moneda: "MXN", ...gestor })).json()) as { id: string };
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`;
    expect((await app.request(`${base}/${a.id}`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-11-11", fin: "2026-11-15" } }, {}, "PATCH"))).status).toBe(200);
    expect((await app.request(`${base}/${b.id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(200);
    const rev = await app.request(`/rentas/${ctx.propertyId}/finanzas/movimientos-en-revision`, authedJson(ctx.staff.contador.token));
    const rb = (await rev.json()) as { items: Array<{ ocupacionId: string; motivo: string; netoCentavos: number }> };
    expect(rb.items.map((i) => [i.ocupacionId, i.motivo, i.netoCentavos]).sort()).toEqual([[a.id, "reserva_modificada", 270000], [b.id, "reserva_cancelada", 90000]].sort());
    // contador no puede resolver; admin_gestora si; 404 si ya no esta marcado.
    const revisadoUrl = `/rentas/${ctx.propertyId}/reservas/${a.id}/movimiento/revisado`;
    expect((await app.request(revisadoUrl, authedJson(ctx.staff.contador.token, {}))).status).toBe(403);
    expect((await app.request(revisadoUrl, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(200);
    expect((await app.request(revisadoUrl, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(404);
    expect(ctx.rentasRepo.auditLog.some((x) => x.action === "reserva.movimiento_revisado" && x.entityId === a.id)).toBe(true);
  });
});

describe("aviso diario rentas.finanzas.reservas_sin_movimiento (solo lo emite el cron)", () => {
  const dia = (offset: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  afterEach(() => {
    delete process.env.RENTAS_AVISO_SIN_MOVIMIENTO_OFF;
  });
  const cron = (app: ReturnType<typeof buildApp>) => app.request("/internal/rentas/checkin-recordatorio", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

  it("emite UN aviso por organizacion y periodo con solo conteos; ningun GET emite; una reserva con movimiento no cuenta", async () => {
    const base = await buildRentasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(base.deps);
    const app = buildApp(deps);
    // dos reservas pasadas (check-in antes de hoy) sin movimiento y una con movimiento
    const sinMov1 = await crearDirecta(base, app, { inicio: dia(-6), fin: dia(-4) });
    const sinMov2 = await crearDirecta(base, app, { inicio: dia(-3), fin: dia(-2) });
    const conMov = await crearDirecta(base, app, { inicio: dia(-20), fin: dia(-18) }, { montoBrutoCentavos: 1000, moneda: "MXN", ...gestor });
    for (const r of [sinMov1, sinMov2, conMov]) expect(r.status).toBe(201);
    await app.request(`/rentas/${base.propertyId}/finanzas/sin-movimiento?periodo=${dia(-6).slice(0, 7)}`, authedJson(base.staff.contador.token));
    expect(emisiones).toHaveLength(0);

    expect((await cron(app)).status).toBe(200);
    const avisos = emisiones.filter((e) => e.evento === "rentas.finanzas.reservas_sin_movimiento");
    // Cada periodo (mes anterior y en curso) solo emite si tiene reservas pasadas sin movimiento: si los -6/-3 dias caen en meses distintos hay 2 avisos.
    expect(avisos.length).toBeGreaterThanOrEqual(1);
    const total = avisos.reduce((n, a) => n + Number(/: (\d+)\./.exec(a.cuerpo ?? "")![1]), 0);
    expect(total).toBe(2);
    for (const a of avisos) {
      expect(a).toMatchObject({ organizationId: base.organizationId, categoria: "cierres", severidad: "atencion", roles: ["admin_gestora", "contador"], enlace: "/rentas/{orgSlug}/finanzas" });
      expect(a.dedupeKey).toMatch(new RegExp(`^rentas\\.finanzas\\.reservas_sin_movimiento:${base.organizationId}:\\d{4}-\\d{2}$`));
      expect(a.cuerpo).not.toMatch(/@|\+\d/);
    }
  });

  it("kill switch RENTAS_AVISO_SIN_MOVIMIENTO_OFF=1 y un fallo al emitir no cambian la respuesta del cron", async () => {
    const base = await buildRentasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(base.deps, { alEmitir: () => { throw Object.assign(new Error("42883"), { code: "42883" }); } });
    const app = buildApp(deps);
    expect((await crearDirecta(base, app, { inicio: dia(-4), fin: dia(-3) })).status).toBe(201);
    const normal = await cron(app);
    expect(normal.status).toBe(200);
    expect(await normal.json()).toEqual({ ok: true, procesadas: 0, enviados: 0, sin_correo: 0, fallos: 0 });
    process.env.RENTAS_AVISO_SIN_MOVIMIENTO_OFF = "1";
    const n = emisiones.length;
    expect((await cron(app)).status).toBe(200);
    expect(emisiones.length).toBe(n);
  });
});
