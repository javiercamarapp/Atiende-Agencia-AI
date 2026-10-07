// REGLA DURA de compatibilidad con la base sin migrar para el repositorio del piloto (migracion 027): con AbortAwareFakeSession (reproduce el
// estado abortado 25P02 de una transaccion real) cada metodo degrada a "no disponible aun" DENTRO de un SAVEPOINT y deja la transaccion utilizable.
import { describe, expect, it } from "vitest";
import { PilotoEntradaInvalidaError, PilotoNoDisponibleError, PilotoNoEncontradoError, PilotoSinAccesoError, PostgresPilotoRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const noExiste = (nombre: string): Error & { code: string } => Object.assign(new Error(`function despachos.${nombre}() does not exist`), { code: "42883" });
const sinTabla = (): Error & { code: string } => Object.assign(new Error('relation "despachos.cliente_automatizacion" does not exist'), { code: "42P01" });
const SIGUIENTE = { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const usable = (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
const sesion = (match: RegExp, error: Error) => new AbortAwareFakeSession([{ match, respond: () => error }, SIGUIENTE]);

describe("PostgresPilotoRepository -- base sin la migracion 027", () => {
  it.each([
    ["obtenerAutomatizacion", /cliente_automatizacion/, (r: PostgresPilotoRepository) => r.obtenerAutomatizacion("p1"), sinTabla()],
    ["listarSolicitudes", /solicitud_documentos/, (r: PostgresPilotoRepository) => r.listarSolicitudes("p1"), Object.assign(new Error('relation "despachos.solicitud_documentos" does not exist'), { code: "42P01" })],
    ["resumenSolicitudesPeriodo", /solicitud_documentos/, (r: PostgresPilotoRepository) => r.resumenSolicitudesPeriodo(2026, 6), Object.assign(new Error('relation "despachos.solicitud_documentos" does not exist'), { code: "42P01" })],
    ["estadoModulosCierre", /cierre_estado_modulos/, (r: PostgresPilotoRepository) => r.estadoModulosCierre("p1", 2026, 6), noExiste("cierre_estado_modulos")],
    ["listarArtefactos", /cierre_artefacto/, (r: PostgresPilotoRepository) => r.listarArtefactos("p1", "c1"), Object.assign(new Error('relation "despachos.cierre_artefacto" does not exist'), { code: "42P01" })],
    ["entregaDelPeriodo", /cierre_entrega/, (r: PostgresPilotoRepository) => r.entregaDelPeriodo("p1", "c1"), Object.assign(new Error('relation "despachos.cierre_entrega" does not exist'), { code: "42P01" })],
    ["portalSolicitudes", /portal_cliente_solicitudes/, (r: PostgresPilotoRepository) => r.portalSolicitudes("h"), noExiste("portal_cliente_solicitudes")],
    ["portalVincular", /portal_cliente_solicitud_vincular/, (r: PostgresPilotoRepository) => r.portalVincular("h", "d", "r"), noExiste("portal_cliente_solicitud_vincular")],
    ["portalReportes", /portal_cliente_reportes/, (r: PostgresPilotoRepository) => r.portalReportes("h"), noExiste("portal_cliente_reportes")],
    ["portalReporteContenido", /portal_cliente_reporte_contenido/, (r: PostgresPilotoRepository) => r.portalReporteContenido("h", "a"), noExiste("portal_cliente_reporte_contenido")],
  ])("%s -> { disponible: false } y la transaccion sigue utilizable (sin 25P02)", async (_n, match, llamar, error) => {
    const session = sesion(match, error);
    expect(await llamar(new PostgresPilotoRepository(session))).toEqual({ disponible: false });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_piloto_"))).toBe(true);
    await usable(session);
  });

  it.each([
    ["solicitudesPorCrear", /system_solicitudes_por_crear/, (r: PostgresPilotoRepository) => r.solicitudesPorCrear("2026-07-01", 10)],
    ["solicitudesParaRecordatorio", /system_solicitudes_para_recordatorio/, (r: PostgresPilotoRepository) => r.solicitudesParaRecordatorio("2026-07-01", 10)],
    ["periodosCierreAbiertos", /system_periodos_cierre_abiertos/, (r: PostgresPilotoRepository) => r.periodosCierreAbiertos(10)],
  ])("%s (lectura del cron) -> null y la transaccion sigue utilizable", async (_n, match, llamar) => {
    const session = sesion(match, noExiste("system_x"));
    expect(await llamar(new PostgresPilotoRepository(session))).toBeNull();
    await usable(session);
  });

  it.each([
    ["guardarAutomatizacion", /cliente_automatizacion_guardar/, (r: PostgresPilotoRepository) => r.guardarAutomatizacion("p1", { contactoCorreo: null, envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} })],
    ["crearSolicitud", /solicitud_documentos_crear/, (r: PostgresPilotoRepository) => r.crearSolicitud("p1", 2026, 6)],
    ["marcarRenglonNoAplica", /solicitud_renglon_no_aplica/, (r: PostgresPilotoRepository) => r.marcarRenglonNoAplica("p1", "r1", "no aplica")],
    ["forzarCierre", /periodo_cierre_forzar/, (r: PostgresPilotoRepository) => r.forzarCierre("p1", "c1", "motivo de al menos diez", ["balanza"])],
    ["crearEntrega", /cierre_entrega_crear/, (r: PostgresPilotoRepository) => r.crearEntrega("p1", "c1")],
    ["guardarArtefacto", /cierre_artefacto_guardar/, (r: PostgresPilotoRepository) => r.guardarArtefacto("p1", "c1", "contabilidad_balanza_xml", "b.xml", new Uint8Array([1]))],
    ["crearSolicitudSistema", /system_solicitud_crear/, (r: PostgresPilotoRepository) => r.crearSolicitudSistema("p1", 2026, 6)],
    ["crearEnlaceSistema", /system_portal_enlace_crear/, (r: PostgresPilotoRepository) => r.crearEnlaceSistema("p1", "h".repeat(64), "Solicitud 2026-06", 35)],
    ["autocompletarTareasSistema", /system_cierre_tareas_autocompletar/, (r: PostgresPilotoRepository) => r.autocompletarTareasSistema("c1", ["t1"])],
  ])("%s (escritura) -> PilotoNoDisponibleError y la transaccion sigue utilizable", async (_n, match, llamar) => {
    const session = sesion(match, noExiste("x"));
    await expect(llamar(new PostgresPilotoRepository(session))).rejects.toBeInstanceOf(PilotoNoDisponibleError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_piloto_"))).toBe(true);
    await usable(session);
  });
});

describe("PostgresPilotoRepository -- errores de las funciones", () => {
  const conCodigo = (code: string, msg: string) => Object.assign(new Error(msg), { code });
  it.each([
    ["P0002", PilotoNoEncontradoError],
    ["42501", PilotoSinAccesoError],
    ["22023", PilotoEntradaInvalidaError],
    ["23514", PilotoEntradaInvalidaError],
  ])("SQLSTATE %s -> error de dominio tipado", async (code, Clase) => {
    const session = sesion(/solicitud_documentos_crear/, conCodigo(code, "solicitud_documentos_crear: algo"));
    await expect(new PostgresPilotoRepository(session).crearSolicitud("p1", 2026, 6)).rejects.toBeInstanceOf(Clase);
    await usable(session);
  });

  it("un error que no es de migracion pendiente ni de dominio se propaga tal cual (no se enmascara)", async () => {
    const real = conCodigo("40P01", "deadlock detected");
    const session = sesion(/cierre_estado_modulos/, real);
    await expect(new PostgresPilotoRepository(session).estadoModulosCierre("p1", 2026, 6)).rejects.toBe(real);
    await usable(session);
  });

  it("el mensaje del dominio no arrastra el prefijo de la funcion de Postgres", async () => {
    const session = sesion(/cliente_automatizacion_guardar/, conCodigo("22023", "cliente_automatizacion_guardar: correo de contacto inválido"));
    await expect(new PostgresPilotoRepository(session).guardarAutomatizacion("p1", { contactoCorreo: "x", envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} })).rejects.toThrow("correo de contacto inválido");
  });
});

describe("PostgresPilotoRepository -- base migrada", () => {
  it("estadoModulosCierre mapea las columnas de cierre_estado_modulos (numeric/bigint llegan como texto)", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /cierre_estado_modulos/,
        respond: () => [
          { out_debe_centavos: "1000000", out_haber_centavos: "1000100", out_polizas: 12, out_polizas_descuadradas: 1, out_cfdi_total: 10, out_cfdi_sin_poliza: 2, out_cfdi_invalidos: 0, out_conciliacion_sesiones: 1, out_conciliacion_abiertas: 0, out_movimientos: 100, out_movimientos_conciliados: 90, out_pagos_provisionales: 2, out_solicitud_estado: "abierta", out_solicitud_pendientes: 3, out_periodicidad: "bimestral" },
        ],
      },
    ]);
    expect(await new PostgresPilotoRepository(session).estadoModulosCierre("p1", 2026, 6)).toEqual({
      disponible: true,
      valor: { debeCentavos: 1_000_000, haberCentavos: 1_000_100, polizas: 12, polizasDescuadradas: 1, cfdiTotal: 10, cfdiSinPoliza: 2, cfdiInvalidos: 0, conciliacionSesiones: 1, conciliacionAbiertas: 0, movimientos: 100, movimientosConciliados: 90, pagosProvisionales: 2, solicitudEstado: "abierta", solicitudPendientes: 3, periodicidad: "bimestral" },
    });
  });

  it("obtenerAutomatizacion sin fila devuelve los valores por omision (envio APAGADO)", async () => {
    const session = new AbortAwareFakeSession([{ match: /cliente_automatizacion/, respond: () => [] }]);
    const r = await new PostgresPilotoRepository(session).obtenerAutomatizacion("p1");
    expect(r).toEqual({ disponible: true, valor: { contactoCorreo: null, envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} } });
  });

  it("guardarAutomatizacion manda la plantilla en el formato de la base (snake_case)", async () => {
    const llamadas: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /cliente_automatizacion_guardar/, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      llamadas.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresPilotoRepository(session).guardarAutomatizacion("p1", { contactoCorreo: "a@b.com", envioReportesCierre: true, solicitudActiva: true, solicitudDia: 5, plantilla: { nomina: true, estadosCuenta: ["123"] } });
    const plantilla = llamadas.flat().find((p) => typeof p === "string" && p.startsWith("{"));
    expect(JSON.parse(plantilla as string)).toEqual({ nomina: true, estados_cuenta: ["123"] });
  });
});
