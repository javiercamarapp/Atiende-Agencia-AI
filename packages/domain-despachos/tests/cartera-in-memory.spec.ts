// D-21/D-22 -- dobles en memoria: replican las reglas de la migración 018 que ejercen las pruebas de rutas.
import { describe, expect, it } from "vitest";
import { CARTERA_TOPE_POR_ORGANIZACION, CarteraDatosInvalidosError, CarteraNoDisponibleError, CarteraTopeExcedidoError, ClienteRfcDuplicadoError, InMemoryCarteraRepository, validarFichaCliente } from "../src/cartera/index.ts";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { EstadoSatInvalidoError, InvoiceNoEncontradoError } from "../src/errors.ts";

function ficha(rfc: string, extra: Record<string, unknown> = {}) {
  const r = validarFichaCliente({ rfc, razonSocial: "Cliente SA", regimenesFiscales: ["601"], cpFiscal: "06600", ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.errores));
  return r.valor;
}

describe("InMemoryCarteraRepository", () => {
  it("alta crea property + ficha, y listar las devuelve ordenadas solo de SU organización", async () => {
    const repo = new InMemoryCarteraRepository();
    await repo.alta("o1", "Zeta", ficha("ZZZ010101ZZ1"));
    await repo.alta("o1", "Alfa", ficha("AAA010101AA1"));
    await repo.alta("o2", "Otro despacho", ficha("OOO010101OO1"));
    const r = await repo.listar("o1");
    expect(r.estado).toBe("disponible");
    expect(r.clientes.map((c) => c.nombre)).toEqual(["Alfa", "Zeta"]);
    expect(r.clientes.every((c) => c.ficha !== null)).toBe(true);
  });
  it("RFC único por organización pero repetible entre organizaciones", async () => {
    const repo = new InMemoryCarteraRepository();
    await repo.alta("o1", "A", ficha("AAA010101AA1"));
    await expect(repo.alta("o1", "B", ficha("AAA010101AA1"))).rejects.toBeInstanceOf(ClienteRfcDuplicadoError);
    await expect(repo.alta("o2", "B", ficha("AAA010101AA1"))).resolves.toBeDefined();
  });
  it("el RFC de una ficha existente no cambia; el resto sí", async () => {
    const repo = new InMemoryCarteraRepository();
    const { propertyId } = await repo.alta("o1", "A", ficha("AAA010101AA1"));
    await expect(repo.guardarFicha(propertyId, ficha("BBB010101BB1"))).rejects.toBeInstanceOf(CarteraDatosInvalidosError);
    await repo.guardarFicha(propertyId, ficha("AAA010101AA1", { cpFiscal: "11000", periodicidad: "bimestral" }));
    expect(await repo.obtenerFicha(propertyId)).toMatchObject({ cpFiscal: "11000", periodicidad: "bimestral" });
  });
  it("una property sembrada sin ficha puede completarla (cliente anterior a la migración)", async () => {
    const repo = new InMemoryCarteraRepository();
    const p = repo.sembrarCliente("o1", "Heredado");
    expect(await repo.obtenerFicha(p)).toBeNull();
    await repo.guardarFicha(p, ficha("HHH010101HH1"));
    expect((await repo.obtenerFicha(p))?.rfc).toBe("HHH010101HH1");
  });
  it("tope por organización", async () => {
    const repo = new InMemoryCarteraRepository();
    for (let i = 0; i < CARTERA_TOPE_POR_ORGANIZACION; i += 1) repo.sembrarCliente("o1", `C${i}`);
    await expect(repo.alta("o1", "uno más", ficha("AAA010101AA1"))).rejects.toBeInstanceOf(CarteraTopeExcedidoError);
  });
  it("base sin migrar: lectura honesta y escritura con error tipado", async () => {
    const repo = new InMemoryCarteraRepository();
    repo.sembrarCliente("o1", "Cliente", ficha("AAA010101AA1"));
    repo.disponible = false;
    expect(await repo.listar("o1")).toMatchObject({ estado: "no_disponible", clientes: [{ nombre: "Cliente", ficha: null }] });
    await expect(repo.alta("o1", "X", ficha("BBB010101BB1"))).rejects.toBeInstanceOf(CarteraNoDisponibleError);
  });
});

describe("InMemoryDespachosRepository (D-22)", () => {
  const base = { organizationId: "o1", propertyId: "p1", folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I" as const, rfcEmisor: "AAA010101AA1", rfcReceptor: "BBB010101BB1", emisorNombre: null, subtotal: 100, total: 116, iva: 16, descuento: 0, categoria: "sin_clasificar" as const, valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { proveedoresReportables: [], reportable: false }, fecha: "2026-07-10" };
  it("el insert sin campos nuevos deja null/pendiente (no inventa valores)", async () => {
    const repo = new InMemoryDespachosRepository();
    const inv = await repo.insertInvoice(base);
    expect(inv).toMatchObject({ direccion: null, moneda: null, totalCentavos: null, estadoSat: "pendiente", estadoSatVerificadoEn: null });
    expect(await repo.listarImpuestosInvoice("p1", inv.id)).toEqual([]);
  });
  it("persiste modelo completo y desglose; el desglose es invisible desde otra property", async () => {
    const repo = new InMemoryDespachosRepository();
    const inv = await repo.insertInvoice({ ...base, direccion: "emitido", moneda: "USD", tipoCambio: 17.5, totalCentavos: 11600, impuestos: [{ naturaleza: "traslado", impuesto: "002", tipoFactor: "Tasa", tasaOCuota: "0.160000", baseCentavos: 10000, importeCentavos: 1600 }] });
    expect(inv).toMatchObject({ direccion: "emitido", moneda: "USD", tipoCambio: 17.5, totalCentavos: 11600 });
    expect(await repo.listarImpuestosInvoice("p1", inv.id)).toEqual([expect.objectContaining({ nombre: "IVA", importeCentavos: 1600 })]);
    expect(await repo.listarImpuestosInvoice("otra-property", inv.id)).toEqual([]);
  });
  it("estado SAT: cancelado es terminal, otra property no lo ve, id inexistente falla", async () => {
    const repo = new InMemoryDespachosRepository();
    const inv = await repo.insertInvoice(base);
    await repo.registrarEstadoSatInvoice("p1", inv.id, "vigente");
    expect((await repo.findInvoice("p1", inv.id))?.estadoSat).toBe("vigente");
    await repo.registrarEstadoSatInvoice("p1", inv.id, "cancelado");
    await expect(repo.registrarEstadoSatInvoice("p1", inv.id, "vigente")).rejects.toBeInstanceOf(EstadoSatInvalidoError);
    await expect(repo.registrarEstadoSatInvoice("otra-property", inv.id, "cancelado")).rejects.toBeInstanceOf(InvoiceNoEncontradoError);
    await expect(repo.registrarEstadoSatInvoice("p1", "no-existe", "vigente")).rejects.toBeInstanceOf(InvoiceNoEncontradoError);
  });
});
