// D-32 (migracion 023): el repositorio de honorarios corre dentro de la transaccion compartida del request. REGLA DURA: contra la base SIN migrar el
// 42883/42P01/42703 debe degradar SIN dejar la transaccion abortada (25P02). AbortAwareFakeSession reproduce el estado abortado de Postgres real.
import { describe, expect, it } from "vitest";
import {
  HonorariosDatosInvalidosError,
  HonorariosDuplicadoError,
  HonorariosEstadoInvalidoError,
  HonorariosNoDisponiblesError,
  HonorariosNoEncontradoError,
  HonorariosSinPermisoError,
  HonorariosTopeExcedidoError,
  PostgresHonorariosRepository,
} from "../src/honorarios/index.ts";
import type { IgualaInput } from "../src/honorarios/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
const tablaInexistente = () => pgError("42P01", 'relation "despachos.iguala" does not exist');
const columnaInexistente = () => pgError("42703", 'column "x" does not exist');
const funcionInexistente = (nombre: string) => pgError("42883", `function despachos.${nombre}(uuid, uuid) does not exist`);
const sigue = { match: /select 1/, respond: () => [{ ok: 1 }] };

const IGUALA: IgualaInput = { concepto: "Iguala", claveProdServ: "84111500", claveUnidad: "E48", montoBaseCentavos: 100_000, tasaIvaBp: 1600, retencionIsrBp: 0, retieneIvaDosTercios: false, diaEmision: 5, usoCfdi: "G03", activa: true };

const FILA_IGUALA = { id: "i1", property_id: "p1", organization_id: "o1", concepto: "Iguala", clave_prod_serv: "84111500", clave_unidad: "E48", clave_sat_estado: "por_verificar", monto_base_centavos: "100000", tasa_iva_bp: 1600, retencion_isr_bp: 0, retiene_iva_dos_tercios: false, dia_emision: 5, uso_cfdi: "G03", activa: true, created_at: "2026-07-01T00:00:00Z", updated_at: new Date("2026-07-02T00:00:00Z") };
const FILA_PREFACTURA = {
  id: "f1", property_id: "p1", organization_id: "o1", iguala_id: "i1", periodo: "2026-07", estado: "aprobada", concepto: "Iguala", clave_prod_serv: "84111500", clave_unidad: "E48", receptor_rfc: "RRR010101RR1", receptor_razon_social: "Receptor SA",
  receptor_regimen: "601", receptor_cp: "64000", uso_cfdi: "G03", fecha_emision: "2026-07-05", base_centavos: "100000", iva_centavos: "16000", retencion_isr_centavos: "0", retencion_iva_centavos: "0", total_centavos: "116000", aprobada_en: "2026-07-01T00:00:00Z",
  timbrando_en: null, timbrada_en: null, uuid_cfdi: null, pac_id: null, url_pdf: null, url_xml: null, error_timbrado: null, cancelada_en: null, motivo_cancelacion: null, folio_sustitucion: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};

describe("PostgresHonorariosRepository: lecturas", () => {
  it("mapea igualas y prefacturas (bigint como texto -> entero)", async () => {
    const repo = new PostgresHonorariosRepository(new AbortAwareFakeSession([{ match: /from despachos\.iguala/i, respond: () => [FILA_IGUALA] }, { match: /from despachos\.prefactura/i, respond: () => [FILA_PREFACTURA] }]));
    expect(await repo.listarIgualas("p1")).toMatchObject({ estado: "disponible", igualas: [{ id: "i1", montoBaseCentavos: 100_000, claveSatEstado: "por_verificar", periodicidad: "mensual", updatedAt: "2026-07-02T00:00:00.000Z" }] });
    const l = await repo.listarPrefacturas("p1", "2026-07");
    expect(l.prefacturas[0]).toMatchObject({ id: "f1", totalCentavos: 116_000, estado: "aprobada", receptor: { rfc: "RRR010101RR1", regimenFiscal: "601" }, uuid: null });
    expect(await repo.obtenerPrefactura("p1", "f1")).toMatchObject({ id: "f1" });
  });
  it("un monto que excede el rango entero seguro se rechaza en vez de perder precision", async () => {
    const repo = new PostgresHonorariosRepository(new AbortAwareFakeSession([{ match: /from despachos\.iguala/i, respond: () => [{ ...FILA_IGUALA, monto_base_centavos: "99999999999999999999" }] }]));
    await expect(repo.listarIgualas("p1")).rejects.toThrow(/rango entero seguro/);
  });
  it.each([
    ["42P01", tablaInexistente],
    ["42703", columnaInexistente],
  ])("REGLA DURA (%s, base sin migrar): las tres lecturas degradan a 'no disponible' y la sesion sigue utilizable", async (_c, error) => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.iguala/i, respond: error }, { match: /from despachos\.prefactura/i, respond: error }, sigue]);
    const repo = new PostgresHonorariosRepository(session);
    expect(await repo.listarIgualas("p1")).toEqual({ estado: "no_disponible", igualas: [] });
    expect(await repo.listarPrefacturas("p1", null)).toEqual({ estado: "no_disponible", prefacturas: [] });
    expect(await repo.obtenerPrefactura("p1", "f1")).toBeNull();
    // el resto del request sigue en la MISMA transaccion:
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(3);
  });
  it("un error real (42501) en una lectura se repropaga, no se disfraza de 'no disponible'", async () => {
    const repo = new PostgresHonorariosRepository(new AbortAwareFakeSession([{ match: /from despachos\.iguala/i, respond: () => pgError("42501", "permission denied") }]));
    await expect(repo.listarIgualas("p1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgresHonorariosRepository: escrituras", () => {
  it("llama a cada funcion de la 023 con sus argumentos y devuelve lo que corresponde", async () => {
    const llamadas: string[] = [];
    const session = new AbortAwareFakeSession([
      { match: /despachos\.iguala_guardar/i, respond: () => (llamadas.push("guardar"), [{ iguala_guardar: "i-nueva" }]) },
      { match: /despachos\.iguala_eliminar/i, respond: () => (llamadas.push("eliminar"), []) },
      { match: /despachos\.prefactura_generar/i, respond: () => (llamadas.push("generar"), [{ prefactura_generar: null }]) },
      { match: /despachos\.prefactura_aprobar/i, respond: () => (llamadas.push("aprobar"), []) },
      { match: /despachos\.prefactura_reservar_timbrado/i, respond: () => (llamadas.push("reservar"), [{ prefactura_reservar_timbrado: true }]) },
      { match: /despachos\.prefactura_registrar_timbre/i, respond: () => (llamadas.push("timbre"), []) },
      { match: /despachos\.prefactura_registrar_fallo/i, respond: () => (llamadas.push("fallo"), []) },
      { match: /despachos\.prefactura_cancelar/i, respond: () => (llamadas.push("cancelar"), []) },
    ]);
    const repo = new PostgresHonorariosRepository(session);
    expect(await repo.guardarIguala("p1", null, IGUALA)).toBe("i-nueva");
    await repo.eliminarIguala("p1", "i1");
    expect(await repo.generarPrefactura("p1", "i1", "2026-07", { baseCentavos: 100_000, ivaCentavos: 16_000, retencionIsrCentavos: 0, retencionIvaCentavos: 0, totalCentavos: 116_000 })).toBeNull();
    await repo.aprobar("p1", "f1");
    expect(await repo.reservarTimbrado("p1", "f1", 900)).toBe(true);
    await repo.registrarTimbre("p1", "f1", { uuid: "11111111-1111-4111-8111-111111111111", pacId: "pac", urlPdf: null, urlXml: null });
    await repo.registrarFallo("p1", "f1", "pac_error");
    await repo.cancelar("p1", "f1", { motivo: "02", folioSustitucion: null, acusePac: false });
    expect(llamadas).toEqual(["guardar", "eliminar", "generar", "aprobar", "reservar", "timbre", "fallo", "cancelar"]);
  });
  it("base sin migrar (42883 de la propia funcion) -> HonorariosNoDisponiblesError y la sesion no queda abortada", async () => {
    const session = new AbortAwareFakeSession([{ match: /despachos\.prefactura_reservar_timbrado/i, respond: () => funcionInexistente("prefactura_reservar_timbrado") }, sigue]);
    await expect(new PostgresHonorariosRepository(session).reservarTimbrado("p1", "f1", 900)).rejects.toBeInstanceOf(HonorariosNoDisponiblesError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });
  it("un 42883 de OTRA funcion (no despachos.iguala_* / prefactura_*) NO se disfraza de 'no disponible'", async () => {
    const repo = new PostgresHonorariosRepository(new AbortAwareFakeSession([{ match: /despachos\.iguala_guardar/i, respond: () => pgError("42883", "function core.has_property_access(uuid, uuid) does not exist") }]));
    await expect(repo.guardarIguala("p1", null, IGUALA)).rejects.toMatchObject({ code: "42883" });
  });
  it.each([
    ["42501", HonorariosSinPermisoError],
    ["22023", HonorariosDatosInvalidosError],
    ["23514", HonorariosTopeExcedidoError],
    ["23505", HonorariosDuplicadoError],
    ["55000", HonorariosEstadoInvalidoError],
    ["P0002", HonorariosNoEncontradoError],
  ])("SQLSTATE %s de la base -> error de dominio, con la sesion recuperada", async (code, Clase) => {
    const session = new AbortAwareFakeSession([{ match: /despachos\.prefactura_aprobar/i, respond: () => pgError(code, "prefactura_aprobar: detalle") }, sigue]);
    await expect(new PostgresHonorariosRepository(session).aprobar("p1", "f1")).rejects.toBeInstanceOf(Clase);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });
  it("el mensaje de dominio no repite el prefijo interno de la funcion", async () => {
    const repo = new PostgresHonorariosRepository(new AbortAwareFakeSession([{ match: /despachos\.prefactura_aprobar/i, respond: () => pgError("55000", "prefactura_aprobar: solo se aprueba una prefactura en borrador (estado actual: aprobada)") }]));
    await expect(repo.aprobar("p1", "f1")).rejects.toThrow("solo se aprueba una prefactura en borrador (estado actual: aprobada)");
  });
});
