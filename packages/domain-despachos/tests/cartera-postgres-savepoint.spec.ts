// D-21/D-22 (migración 018): la cartera y el insert del CFDI completo corren dentro de la transacción compartida del request.
// REGLA DURA: contra la base SIN migrar el 42883/42P01/42703 debe degradar SIN dejar la transacción abortada (25P02).
// AbortAwareFakeSession reproduce el estado abortado de Postgres real (una sesión falsa plana NO lo reproduce).
import { describe, expect, it } from "vitest";
import { PostgresCarteraRepository, CarteraNoDisponibleError, CarteraSinPermisoError, CarteraDatosInvalidosError, ClienteRfcDuplicadoError, CarteraTopeExcedidoError } from "../src/cartera/index.ts";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { EstadoSatInvalidoError, EstadoSatNoDisponibleError, InvoiceAlreadyExistsError, InvoiceNoEncontradoError } from "../src/errors.ts";
import type { NewInvoiceInput } from "../src/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
const columnaInexistente = () => pgError("42703", 'column "direccion" of relation "invoice" does not exist');
const tablaInexistente = () => pgError("42P01", 'relation "despachos.cliente_ficha" does not exist');
const funcionInexistente = (nombre: string) => pgError("42883", `function despachos.${nombre}(uuid, text) does not exist`);

const FICHA = { rfc: "ABC010101AB1", tipoPersona: "moral" as const, razonSocial: "Uno SA", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual" as const, responsableId: null };

const FILA_FICHA = {
  prop_id: "p1", prop_name: "Cliente Uno", tiene_ficha: true, property_id: "p1", organization_id: "o1", rfc: "ABC010101AB1", tipo_persona: "moral",
  razon_social: "Uno SA", regimenes_fiscales: ["601"], cp_fiscal: "06600", periodicidad: "mensual", responsable_id: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("PostgresCarteraRepository.listar", () => {
  it("mapea clientes con y sin ficha", async () => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /left join despachos\.cliente_ficha/i, respond: () => [FILA_FICHA, { ...FILA_FICHA, prop_id: "p2", prop_name: "Sin ficha", tiene_ficha: false, property_id: null }] }]));
    const r = await repo.listar("o1");
    expect(r.estado).toBe("disponible");
    expect(r.clientes[0]).toMatchObject({ propertyId: "p1", nombre: "Cliente Uno", ficha: { rfc: "ABC010101AB1", tipoPersona: "moral", regimenesFiscales: ["601"] } });
    expect(r.clientes[1]).toMatchObject({ propertyId: "p2", ficha: null });
  });

  it("REGLA DURA (42P01, base sin migrar): cae a las properties sin ficha y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /left join despachos\.cliente_ficha/i, respond: tablaInexistente },
      { match: /from core\.property where organization_id/i, respond: () => [{ id: "p1", name: "Cliente Uno" }] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await new PostgresCarteraRepository(session).listar("o1");
    expect(r).toEqual({ estado: "no_disponible", clientes: [{ propertyId: "p1", nombre: "Cliente Uno", ficha: null }] });
    expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error real (42501) se repropaga, no se enmascara como 'no disponible'", async () => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /left join/i, respond: () => pgError("42501", "permission denied") }]));
    await expect(repo.listar("o1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgresCarteraRepository.obtenerFicha", () => {
  it("devuelve la ficha, null si no existe y null (sin lanzar) en la base sin migrar", async () => {
    expect(await new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /from despachos\.cliente_ficha/i, respond: () => [{ ...FILA_FICHA }] }])).obtenerFicha("p1")).toMatchObject({ rfc: "ABC010101AB1" });
    expect(await new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /from despachos\.cliente_ficha/i, respond: () => [] }])).obtenerFicha("p1")).toBeNull();
    const session = new AbortAwareFakeSession([{ match: /from despachos\.cliente_ficha/i, respond: tablaInexistente }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    expect(await new PostgresCarteraRepository(session).obtenerFicha("p1")).toBeNull();
    // la ingesta de CFDI sigue en la MISMA transacción después de esta lectura:
    await expect(session.query("select 1")).resolves.toBeDefined();
  });
});

describe("PostgresCarteraRepository.alta / guardarFicha", () => {
  it("alta devuelve la property creada", async () => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /despachos\.cliente_alta/i, respond: () => [{ out_property_id: "p-nueva" }] }]));
    expect(await repo.alta("o1", "Cliente Nuevo", FICHA)).toEqual({ propertyId: "p-nueva" });
  });
  it("base sin migrar (42883 del propio despachos.cliente_alta) -> CarteraNoDisponibleError y la sesión no queda abortada", async () => {
    const session = new AbortAwareFakeSession([{ match: /despachos\.cliente_alta/i, respond: () => funcionInexistente("cliente_alta") }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    await expect(new PostgresCarteraRepository(session).alta("o1", "X", FICHA)).rejects.toBeInstanceOf(CarteraNoDisponibleError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });
  it("un 42883 de OTRA función (no despachos.cliente_*) NO se disfraza de 'no disponible'", async () => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /despachos\.cliente_alta/i, respond: () => pgError("42883", "function core.has_property_access(uuid) does not exist") }]));
    await expect(repo.alta("o1", "X", FICHA)).rejects.toMatchObject({ code: "42883" });
  });
  it.each([
    ["42501", CarteraSinPermisoError],
    ["22023", CarteraDatosInvalidosError],
    ["23514", CarteraDatosInvalidosError],
    ["23505", ClienteRfcDuplicadoError],
    ["54000", CarteraTopeExcedidoError],
  ])("traduce SQLSTATE %s a un error de dominio", async (code, clase) => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /cliente_ficha_guardar/i, respond: () => pgError(code, "cliente_ficha_guardar: motivo") }]));
    await expect(repo.guardarFicha("p1", FICHA)).rejects.toBeInstanceOf(clase);
  });
  it("el mensaje de datos inválidos no arrastra el prefijo interno de la función", async () => {
    const repo = new PostgresCarteraRepository(new AbortAwareFakeSession([{ match: /cliente_ficha_guardar/i, respond: () => pgError("22023", "cliente_ficha_guardar: el RFC de un cliente ya registrado no se modifica") }]));
    await expect(repo.guardarFicha("p1", FICHA)).rejects.toThrow(/^el RFC de un cliente ya registrado no se modifica$/);
  });
});

const NUEVO: NewInvoiceInput = {
  organizationId: "o1", propertyId: "p1", folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", rfcEmisor: "AAA010101AA1", rfcReceptor: "BBB010101BB1", emisorNombre: "E",
  subtotal: 100, total: 116, iva: 16, descuento: 0, categoria: "sin_clasificar", valido: true, issues: [], warnings: [], requiresHumanReview: false,
  diot: { proveedoresReportables: [], reportable: false }, fecha: "2026-07-10",
  direccion: "recibido", metodoPago: "PUE", formaPago: "03", usoCfdi: "G03", moneda: "MXN", tipoCambio: null,
  subtotalCentavos: 10000, descuentoCentavos: 0, totalCentavos: 11600, ivaTrasladadoCentavos: 1600, isrRetenidoCentavos: null, ivaRetenidoCentavos: null, iepsCentavos: null,
  impuestos: [{ naturaleza: "traslado", impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 10000, importeCentavos: 1600 }],
};
const FILA_INVOICE = {
  id: "i1", organization_id: "o1", property_id: "p1", folio_fiscal: NUEVO.folioFiscal, tipo: "I", rfc_emisor: "AAA010101AA1", rfc_receptor: "BBB010101BB1", emisor_nombre: "E",
  subtotal: "100.00", total: "116.00", iva: "16.00", descuento: "0.00", categoria: "sin_clasificar", confianza: null, valido: true, issues: [], warnings: [], requires_human_review: false,
  diot: { proveedoresReportables: [], reportable: false }, fecha: "2026-07-10", created_at: "2026-07-11T00:00:00Z",
};
const INSERT_COMPLETO = /insert into despachos\.invoice\s+\([^)]*direccion/i;
const INSERT_HISTORICO = /insert into despachos\.invoice\s+\((?![^)]*direccion)/i;
const INSERT_IMPUESTO = /insert into despachos\.invoice_impuesto/i;

describe("PostgresDespachosRepository.insertInvoice (D-22)", () => {
  it("camino nuevo: inserta el invoice completo y su desglose; mapea bigint (texto) a número", async () => {
    const session = new AbortAwareFakeSession([
      { match: INSERT_COMPLETO, respond: () => [{ ...FILA_INVOICE, direccion: "recibido", metodo_pago: "PUE", forma_pago: "03", uso_cfdi: "G03", moneda: "MXN", tipo_cambio: null, subtotal_centavos: "10000", descuento_centavos: "0", total_centavos: "11600", iva_trasladado_centavos: "1600", isr_retenido_centavos: null, iva_retenido_centavos: null, ieps_centavos: null, estado_sat: "pendiente", estado_sat_verificado_en: null }] },
      { match: INSERT_IMPUESTO, respond: () => [] },
    ]);
    const inv = await new PostgresDespachosRepository(session).insertInvoice(NUEVO);
    expect(inv).toMatchObject({ direccion: "recibido", metodoPago: "PUE", totalCentavos: 11600, ivaTrasladadoCentavos: 1600, isrRetenidoCentavos: null, estadoSat: "pendiente", subtotal: 100 });
    expect(session.calls.filter((c) => /insert into despachos\.invoice_impuesto/i.test(c))).toHaveLength(1);
  });

  it.each([["42703", columnaInexistente], ["42P01", () => pgError("42P01", 'relation "despachos.invoice_impuesto" does not exist')]])(
    "REGLA DURA (%s, base sin migrar): cae al insert histórico y la ingesta SIGUE en la misma transacción (createReview después no falla con 25P02)",
    async (_code, error) => {
      const session = new AbortAwareFakeSession([
        { match: INSERT_COMPLETO, respond: error },
        { match: INSERT_HISTORICO, respond: () => [FILA_INVOICE] },
        { match: /insert into despachos\.invoice_review/i, respond: () => [{ id: "r1" }] },
      ]);
      const inv = await new PostgresDespachosRepository(session).insertInvoice(NUEVO);
      expect(inv).toMatchObject({ id: "i1", direccion: null, moneda: null, totalCentavos: null, estadoSat: "pendiente" });
      // La consulta POSTERIOR del mismo request (createReview) NO falla: el SAVEPOINT recuperó la sesión.
      await expect(session.query("insert into despachos.invoice_review values (1)")).resolves.toBeDefined();
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    },
  );

  it("un folio duplicado (23505) NO degrada al histórico: es InvoiceAlreadyExistsError", async () => {
    const dup = () => pgError("23505", "duplicate key value violates unique constraint");
    const session = new AbortAwareFakeSession([{ match: INSERT_COMPLETO, respond: dup }, { match: INSERT_HISTORICO, respond: () => [FILA_INVOICE] }]);
    await expect(new PostgresDespachosRepository(session).insertInvoice(NUEVO)).rejects.toBeInstanceOf(InvoiceAlreadyExistsError);
    expect(session.calls.some((c) => INSERT_HISTORICO.test(c))).toBe(false);
  });

  it("un error no recuperable (23514, CHECK de la migración) se repropaga y no se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: INSERT_COMPLETO, respond: () => pgError("23514", 'violates check constraint "invoice_metodo_pago_check"') }]);
    await expect(new PostgresDespachosRepository(session).insertInvoice(NUEVO)).rejects.toMatchObject({ code: "23514" });
  });

  it("sin impuestos no hace inserts de desglose", async () => {
    const session = new AbortAwareFakeSession([{ match: INSERT_COMPLETO, respond: () => [FILA_INVOICE] }]);
    await new PostgresDespachosRepository(session).insertInvoice({ ...NUEVO, impuestos: [] });
    expect(session.calls.some((c) => /invoice_impuesto/i.test(c))).toBe(false);
  });
});

describe("PostgresDespachosRepository.listarImpuestosInvoice / registrarEstadoSatInvoice", () => {
  it("mapea el desglose; en la base sin migrar devuelve [] y la sesión sigue viva", async () => {
    const ok = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: /from despachos\.invoice_impuesto/i, respond: () => [{ naturaleza: "traslado", impuesto: "002", tipo_factor: "Tasa", tasa_o_cuota: "0.160000", base_centavos: "10000", importe_centavos: "1600" }] }]));
    expect(await ok.listarImpuestosInvoice("p1", "i1")).toEqual([{ naturaleza: "traslado", impuesto: "002", nombre: "IVA", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 10000, importeCentavos: 1600 }]);
    const session = new AbortAwareFakeSession([{ match: /from despachos\.invoice_impuesto/i, respond: () => pgError("42P01", "relation does not exist") }, { match: /select 1/, respond: () => [] }]);
    expect(await new PostgresDespachosRepository(session).listarImpuestosInvoice("p1", "i1")).toEqual([]);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("estado SAT: positivo, P0002 -> no encontrado, 22023 -> inválido, base sin migrar -> no disponible", async () => {
    const sat = (respond: () => unknown) => new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: /invoice_estado_sat_registrar/i, respond }]));
    await expect(sat(() => []).registrarEstadoSatInvoice("p1", "i1", "vigente")).resolves.toBeUndefined();
    await expect(sat(() => pgError("P0002", "x")).registrarEstadoSatInvoice("p1", "i1", "vigente")).rejects.toBeInstanceOf(InvoiceNoEncontradoError);
    await expect(sat(() => pgError("22023", "invoice_estado_sat_registrar: un CFDI cancelado no cambia de estado")).registrarEstadoSatInvoice("p1", "i1", "vigente")).rejects.toBeInstanceOf(EstadoSatInvalidoError);
    await expect(sat(() => pgError("42883", "function despachos.invoice_estado_sat_registrar(uuid, uuid, text) does not exist")).registrarEstadoSatInvoice("p1", "i1", "vigente")).rejects.toBeInstanceOf(EstadoSatNoDisponibleError);
  });
});
