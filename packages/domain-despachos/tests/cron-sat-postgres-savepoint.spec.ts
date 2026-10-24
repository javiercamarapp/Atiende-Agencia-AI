// REGLA DURA de compatibilidad con la base sin migrar para el repositorio de sistema de los crons (migracion 022): con
// AbortAwareFakeSession (reproduce el estado abortado 25P02 de una transaccion real, no una sesion falsa plana) cada metodo
// degrada a "no disponible aun" DENTRO de un SAVEPOINT y deja la transaccion utilizable.
import { describe, expect, it } from "vitest";
import { CronSatNoDisponibleError, PostgresCronSatRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function undefinedFunction(nombre: string): Error & { code: string } {
  return Object.assign(new Error(`function despachos.${nombre}(integer, integer) does not exist`), { code: "42883" });
}
const SIGUIENTE = { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const usable = (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });

describe("PostgresCronSatRepository -- base sin la migracion 022", () => {
  it.each([
    ["listarCfdiPendientesEstatusSat", /system_cfdi_pendientes_estatus_sat/, (r: PostgresCronSatRepository) => r.listarCfdiPendientesEstatusSat(10, 6)],
    ["listarEfosAfectadosSistema", /system_efos_invoices_afectados/, (r: PostgresCronSatRepository) => r.listarEfosAfectadosSistema(10)],
    ["listarClientesFichaSistema", /system_despachos_clientes_ficha/, (r: PostgresCronSatRepository) => r.listarClientesFichaSistema(10)],
  ])("%s -> null (no disponible) y la transaccion sigue utilizable (sin 25P02)", async (_n, match, llamar) => {
    const session = new AbortAwareFakeSession([{ match, respond: () => undefinedFunction("system_x") }, SIGUIENTE]);
    expect(await llamar(new PostgresCronSatRepository(session))).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_cron_"))).toBe(true);
    await usable(session);
  });

  it.each([
    ["registrarEstatusSatSistema", /system_cfdi_registrar_estatus_sat/, (r: PostgresCronSatRepository) => r.registrarEstatusSatSistema("i1", "vigente")],
    ["upsertVencimientoSistema", /system_vencimiento_upsert/, (r: PostgresCronSatRepository) => r.upsertVencimientoSistema("p1", { tipo: "ISR", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "alta" })],
    ["listarVencimientosPorEscalarSistema", /system_vencimientos_por_escalar/, (r: PostgresCronSatRepository) => r.listarVencimientosPorEscalarSistema("p1", "2026-11-17")],
    ["escalarVencimientoSistema", /system_vencimiento_escalar/, (r: PostgresCronSatRepository) => r.escalarVencimientoSistema("d1", "nivel_2", "x")],
  ])("%s -> CronSatNoDisponibleError y la transaccion sigue utilizable", async (_n, match, llamar) => {
    const session = new AbortAwareFakeSession([{ match, respond: () => undefinedFunction("system_x") }, SIGUIENTE]);
    await expect(llamar(new PostgresCronSatRepository(session))).rejects.toBeInstanceOf(CronSatNoDisponibleError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_cron_"))).toBe(true);
    await usable(session);
  });

  it("base con 022 pero SIN 027: el barrido priorizado (4 argumentos) cae a la funcion de 2 argumentos dentro de un SAVEPOINT", async () => {
    let n = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /system_cfdi_pendientes_estatus_sat/,
        respond: () => (++n === 1 ? undefinedFunction("system_cfdi_pendientes_estatus_sat") : [{ out_invoice_id: "i1", out_organization_id: "o1", out_property_id: "p1", out_folio_fiscal: "u1", out_rfc_emisor: "AAA010101AA1", out_rfc_receptor: "BBB010101BB1", out_total: "116.00", out_estado_sat: "pendiente" }]),
      },
      SIGUIENTE,
    ]);
    const filas = await new PostgresCronSatRepository(session).listarCfdiPendientesEstatusSat(10, 6, 2, 15);
    expect(filas).toEqual([{ invoiceId: "i1", organizationId: "o1", propertyId: "p1", folioFiscal: "u1", rfcEmisor: "AAA010101AA1", rfcReceptor: "BBB010101BB1", total: 116, estadoSat: "pendiente" }]);
    expect(n).toBe(2);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_cron_cfdi_pendientes_sat_v2"))).toBe(true);
    await usable(session);
  });

  it("base con 022 pero SIN 027: registrar con detalle (6 argumentos) cae a la funcion de 2 argumentos y la transaccion sigue utilizable", async () => {
    let n = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /system_cfdi_registrar_estatus_sat/,
        respond: () => (++n === 1 ? undefinedFunction("system_cfdi_registrar_estatus_sat") : [{ out_organization_id: "o1", out_property_id: "p1", out_estado_anterior: "pendiente", out_estado_nuevo: "vigente", out_cambio_a_cancelado: false }]),
      },
      SIGUIENTE,
    ]);
    const r = await new PostgresCronSatRepository(session).registrarEstatusSatSistema("i1", "vigente", { esCancelable: null, estatusCancelacion: "En proceso", codigoEstatus: null, validacionEfos: null });
    expect(r).toEqual({ organizationId: "o1", propertyId: "p1", estadoAnterior: "pendiente", estadoNuevo: "vigente", cambioACancelado: false, cancelacionEnProcesoNueva: false });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_cron_cfdi_registrar_sat_v2"))).toBe(true);
    await usable(session);
  });

  it("base migrada (027): registra con el detalle y reporta la cancelacion en proceso nueva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_cfdi_registrar_estatus_sat/, respond: () => [{ out_organization_id: "o1", out_property_id: "p1", out_estado_anterior: "vigente", out_estado_nuevo: "vigente", out_cambio_a_cancelado: false, out_cancelacion_en_proceso_nueva: true }] },
    ]);
    const r = await new PostgresCronSatRepository(session).registrarEstatusSatSistema("i1", "vigente", { esCancelable: "Cancelable con aceptación", estatusCancelacion: "En proceso", codigoEstatus: "S - ok", validacionEfos: "200" });
    expect(r.cancelacionEnProcesoNueva).toBe(true);
  });

  it("un error de Postgres que NO es 'migracion pendiente' se propaga tal cual (no se enmascara como no disponible)", async () => {
    const real = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const session = new AbortAwareFakeSession([{ match: /system_cfdi_pendientes_estatus_sat/, respond: () => real }, SIGUIENTE]);
    await expect(new PostgresCronSatRepository(session).listarCfdiPendientesEstatusSat(10, 6)).rejects.toBe(real);
    await usable(session);
  });

  it("base migrada: mapea las filas y convierte numeric a numero y la fecha a ISO", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_cfdi_pendientes_estatus_sat/, respond: () => [{ out_invoice_id: "i1", out_organization_id: "o1", out_property_id: "p1", out_folio_fiscal: "u1", out_rfc_emisor: "AAA010101AA1", out_rfc_receptor: "BBB010101BB1", out_total: "1160.50", out_estado_sat: "pendiente" }] },
      { match: /system_vencimientos_por_escalar/, respond: () => [{ out_deadline_id: "d1", out_tipo: "ISR", out_periodo: "2026-10", out_fecha_limite: new Date("2026-11-17T00:00:00Z"), out_prioridad: "alta", out_nivel_max: null }] },
      { match: /system_vencimiento_escalar/, respond: () => [{ r: true }] },
    ]);
    const repo = new PostgresCronSatRepository(session);
    expect(await repo.listarCfdiPendientesEstatusSat(10, 6)).toEqual([{ invoiceId: "i1", organizationId: "o1", propertyId: "p1", folioFiscal: "u1", rfcEmisor: "AAA010101AA1", rfcReceptor: "BBB010101BB1", total: 1160.5, estadoSat: "pendiente" }]);
    expect(await repo.listarVencimientosPorEscalarSistema("p1", "2026-11-17")).toEqual([{ id: "d1", tipo: "ISR", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "alta", nivelMax: null }]);
    expect(await repo.escalarVencimientoSistema("d1", "nivel_2", "x")).toBe(true);
  });
});
