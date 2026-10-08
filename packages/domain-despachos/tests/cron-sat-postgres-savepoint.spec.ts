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

// D-P3-33 (migracion 024): los tipos nuevos, el nombre del cliente, los periodos y el outbox degradan sin tumbar la transaccion del cliente.
describe("PostgresCronSatRepository -- base sin la migracion 024 (AbortAwareFakeSession)", () => {
  const checkViolation = Object.assign(new Error('new row for relation "fiscal_deadline" violates check constraint "fiscal_deadline_tipo_check"'), { code: "23514" });

  it("upsert de un tipo NUEVO (ISN) con el CHECK viejo: 23514 -> omitido, SAVEPOINT recuperado, la transaccion sigue (el resto de las obligaciones del cliente se crea)", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_vencimiento_upsert/, respond: () => checkViolation }, SIGUIENTE]);
    const r = await new PostgresCronSatRepository(session).upsertVencimientoSistema("p1", { tipo: "ISN", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "baja" });
    expect(r).toMatchObject({ creado: false, omitido: true });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_cron_vencimiento_tipo_nuevo"))).toBe(true);
    await usable(session);
  });

  it("un 23514 en un tipo BASE (ISR) NO se traga: es un error real y se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_vencimiento_upsert/, respond: () => checkViolation }, SIGUIENTE]);
    await expect(new PostgresCronSatRepository(session).upsertVencimientoSistema("p1", { tipo: "ISR", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "baja" })).rejects.toMatchObject({ code: "23514" });
    await usable(session);
  });

  it("listarPeriodosVencimientosSistema y nombreClienteSistema -> vacio honesto (null) y la transaccion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_vencimientos_periodos/, respond: () => undefinedFunction("system_vencimientos_periodos") },
      { match: /system_cliente_nombre/, respond: () => undefinedFunction("system_cliente_nombre") },
      SIGUIENTE,
    ]);
    const repo = new PostgresCronSatRepository(session);
    expect(await repo.listarPeriodosVencimientosSistema("p1")).toBeNull();
    await usable(session);
    expect(await repo.nombreClienteSistema("p1")).toBeNull();
    await usable(session);
  });

  it("destinatarios y encolado de correo sin las funciones del outbox -> [] / false, sin 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /organization_notification_recipients/, respond: () => undefinedFunction("organization_notification_recipients") },
      { match: /enqueue_messaging_outbox/, respond: () => undefinedFunction("enqueue_messaging_outbox") },
      SIGUIENTE,
    ]);
    const repo = new PostgresCronSatRepository(session);
    expect(await repo.listarDestinatariosAvisoSistema("o1")).toEqual([]);
    await usable(session);
    expect(await repo.encolarCorreoSistema("o1", "vencimiento.escalado", "k", { to: "a@b.test", subject: "s", html: "h", text: "t" })).toBe(false);
    await usable(session);
  });

  it("base migrada: mapea periodos, nombre y destinatarios, y encola con la clave de dedupe", async () => {
    const encolados: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /system_vencimientos_periodos/, respond: () => [{ out_periodo: "2026-09" }, { out_periodo: "2026-08" }] },
      { match: /system_cliente_nombre/, respond: () => [{ nombre: "Cliente Uno SA de CV" }] },
      { match: /organization_notification_recipients/, respond: () => [{ email: "owner@despacho.test" }] },
      { match: /enqueue_messaging_outbox/, respond: () => { encolados.push([]); return [{ id: "x" }]; } },
    ]);
    const repo = new PostgresCronSatRepository(session);
    expect(await repo.listarPeriodosVencimientosSistema("p1")).toEqual(["2026-09", "2026-08"]);
    expect(await repo.nombreClienteSistema("p1")).toBe("Cliente Uno SA de CV");
    expect(await repo.listarDestinatariosAvisoSistema("o1")).toEqual([{ email: "owner@despacho.test" }]);
    expect(await repo.encolarCorreoSistema("o1", "vencimiento.escalado", "k", { to: "a@b.test", subject: "s", html: "h", text: "t" })).toBe(true);
    expect(encolados).toHaveLength(1);
  });
});
