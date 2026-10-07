// D-P3-16: el XML de contabilidad electrónica que genera el motor se valida contra los XSD OFICIALES del SAT (1.3) vendorizados en
// tests/fixtures/contabilidad-electronica-xsd/ con xmllint-wasm (libxml2). Antes de este cambio ninguna prueba validaba contra el XSD y el
// generador heredado producía XML NO conforme (nodo Cta inexistente, FechaModificacion inexistente, TipoEnvio "B", sello vacío, sin CodAgrup).
import { describe, expect, it } from "vitest";
import { CATALOGO_ANEXO24_BASE, CatalogoSinCodigoAgrupadorError, generarXmlCatalogo, cuentasSinCodigoAgrupador } from "../src/contabilidad-electronica/catalogo-cuentas.ts";
import { generarBalanza, generarXmlBalanza } from "../src/contabilidad-electronica/balanza.ts";
import { generarPaqueteContabilidadElectronica } from "../src/contabilidad-electronica/paquete.ts";
import { CODIGOS_AGRUPADORES_SAT, esCodigoAgrupadorSat } from "../src/contabilidad-electronica/codigos-agrupadores.ts";
import { ContabilidadElectronicaDatosInvalidosError } from "../src/contabilidad-electronica/xml-comun.ts";
import { generarXmlPolizasPeriodo } from "../src/contabilidad-electronica/polizas-periodo.ts";
import type { PolizaParaXml } from "../src/contabilidad-electronica/polizas-periodo.ts";
import type { CuentaAnexo24 } from "../src/contabilidad-electronica/types.ts";
import { CODIGO_AGRUPADOR_BASE, InMemoryLibroRepository, construirCatalogoBase, catalogoLibroAAnexo24, generarPaqueteDesdeLibro } from "../src/libro/index.ts";
import type { PolizaInput } from "../src/libro/index.ts";
import { textoXsdVendorizado, validarContraXsd } from "./support/validar-xsd.ts";

const RFC = "DESP820101AB1";

function enumeracionCodAgrup(): string[] {
  const t = textoXsdVendorizado("CatalogosParaEsqContE.xsd");
  const a = t.indexOf('name="c_CodAgrup"');
  const b = t.indexOf('name="c_Moneda"');
  return [...t.slice(a, b).matchAll(/enumeration value="([^"]+)"/g)].map((m) => m[1] as string);
}

describe("lista cerrada de códigos agrupadores (Anexo 24)", () => {
  it("coincide EXACTAMENTE con la enumeración c_CodAgrup del XSD oficial vendorizado", () => {
    expect([...CODIGOS_AGRUPADORES_SAT]).toEqual(enumeracionCodAgrup());
    expect(CODIGOS_AGRUPADORES_SAT).toHaveLength(1080);
  });

  it("acepta los códigos de la lista y rechaza los demás", () => {
    expect(esCodigoAgrupadorSat("102.01")).toBe(true);
    expect(esCodigoAgrupadorSat("100")).toBe(true);
    expect(esCodigoAgrupadorSat("999.99")).toBe(false);
    expect(esCodigoAgrupadorSat("102.1")).toBe(false);
    expect(esCodigoAgrupadorSat("")).toBe(false);
    expect(esCodigoAgrupadorSat(null)).toBe(false);
  });

  it("todos los códigos propuestos del catálogo base del libro están en la lista", () => {
    for (const [cuenta, cod] of Object.entries(CODIGO_AGRUPADOR_BASE)) expect(esCodigoAgrupadorSat(cod), `${cuenta} -> ${cod}`).toBe(true);
  });

  it("el catálogo base del libro trae código agrupador en TODAS sus cuentas", () => {
    expect(construirCatalogoBase().filter((c) => !c.codigoAgrupador)).toEqual([]);
  });
});

describe("catálogo de cuentas contra CatalogoCuentas_1_3.xsd", () => {
  it("el catálogo heredado (4 dígitos, 31 cuentas) con SubCtaDe y CodAgrup es válido", async () => {
    const xml = generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: RFC, ejercicio: 2026, mes: 1 });
    const r = await validarContraXsd(xml, "CatalogoCuentas_1_3");
    expect(r.errores).toEqual([]);
    expect(r.valido).toBe(true);
  });

  it("el catálogo base de un cliente (7 dígitos, niveles 1 y 2) es válido", async () => {
    const cuentas = catalogoLibroAAnexo24(construirCatalogoBase());
    const xml = generarXmlCatalogo(cuentas, { rfc: "XAXX010101000", ejercicio: 2026, mes: 7 });
    const r = await validarContraXsd(xml, "CatalogoCuentas_1_3");
    expect(r.errores).toEqual([]);
    expect(xml).toContain('SubCtaDe="1020000"');
    expect(xml).not.toContain("FechaModificacion");
    expect(xml).not.toContain("Sello=");
    expect(xml).not.toContain("noCertificado=");
  });

  it("emite CodAgrup, NumCta, Desc, Nivel y Natur en cada nodo Ctas, y SubCtaDe solo en nivel > 1", () => {
    const xml = generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: RFC, ejercicio: 2026, mes: 1 });
    expect(xml).toContain('<catalogocuentas:Ctas CodAgrup="100" NumCta="1000" Desc="ACTIVO" Nivel="1" Natur="D"/>');
    expect(xml).toContain('<catalogocuentas:Ctas CodAgrup="102.01" NumCta="1101" Desc="BANCOS" SubCtaDe="1100" Nivel="3" Natur="D"/>');
  });

  it("escapa y recorta el texto libre y sigue siendo válido", async () => {
    const cuentas: CuentaAnexo24[] = [{ codigo: "1000", descripcion: `Gastos "raros" & <especiales> ${"x".repeat(500)}`, nivel: 1, naturaleza: "D", grupo: "", codAgrup: "100" }];
    const xml = generarXmlCatalogo(cuentas, { rfc: RFC, ejercicio: 2026, mes: 1 });
    expect(xml).toContain("&quot;raros&quot; &amp; &lt;especiales&gt;");
    expect((await validarContraXsd(xml, "CatalogoCuentas_1_3")).errores).toEqual([]);
  });

  it("se NIEGA a generar mientras haya cuentas sin código agrupador y devuelve la lista de las que faltan", () => {
    const cuentas: CuentaAnexo24[] = [
      { codigo: "1000", descripcion: "ACTIVO", nivel: 1, naturaleza: "D", grupo: "", codAgrup: "100" },
      { codigo: "1100", descripcion: "SIN CODIGO", nivel: 1, naturaleza: "D", grupo: "" },
      { codigo: "1200", descripcion: "CODIGO VACIO", nivel: 1, naturaleza: "D", grupo: "", codAgrup: "  " },
      { codigo: "1300", descripcion: "CODIGO FUERA DE LISTA", nivel: 1, naturaleza: "D", grupo: "", codAgrup: "999.99" },
    ];
    expect(cuentasSinCodigoAgrupador(cuentas).map((c) => `${c.codigo}:${c.motivo}`)).toEqual(["1100:faltante", "1200:faltante", "1300:invalido"]);
    try {
      generarXmlCatalogo(cuentas, { rfc: RFC, ejercicio: 2026, mes: 1 });
      throw new Error("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogoSinCodigoAgrupadorError);
      expect((err as CatalogoSinCodigoAgrupadorError).cuentas.map((c) => c.codigo)).toEqual(["1100", "1200", "1300"]);
    }
  });

  it("las cuentas existentes de la base sin código (migración 028 sin asignar) hacen que el XML se niegue: nunca se inventa un código", () => {
    // Lo que devuelve la base tras la migración 028 para un cliente anterior: nivel 1, sin padre y SIN código.
    const heredado = construirCatalogoBase().map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza }));
    const cuentas = catalogoLibroAAnexo24(heredado);
    expect(cuentasSinCodigoAgrupador(cuentas)).toHaveLength(heredado.length);
    expect(() => generarXmlCatalogo(cuentas, { rfc: RFC, ejercicio: 2026, mes: 1 })).toThrow(CatalogoSinCodigoAgrupadorError);
  });

  it("exige SubCtaDe en nivel > 1, que el padre exista y sea de nivel n-1", () => {
    const base: CuentaAnexo24 = { codigo: "1000", descripcion: "ACTIVO", nivel: 1, naturaleza: "D", grupo: "", codAgrup: "100" };
    const sinPadre: CuentaAnexo24 = { codigo: "1100", descripcion: "X", nivel: 2, naturaleza: "D", grupo: "", codAgrup: "100.01" };
    expect(() => generarXmlCatalogo([base, sinPadre], { rfc: RFC, ejercicio: 2026, mes: 1 })).toThrow(/sin cuenta padre/);
    expect(() => generarXmlCatalogo([base, { ...sinPadre, subCtaDe: "9999" }], { rfc: RFC, ejercicio: 2026, mes: 1 })).toThrow(/no está en el catálogo/);
    expect(() => generarXmlCatalogo([base, { ...sinPadre, nivel: 3, subCtaDe: "1000" }], { rfc: RFC, ejercicio: 2026, mes: 1 })).toThrow(/nivel 2/);
    expect(() => generarXmlCatalogo([base, { ...sinPadre, subCtaDe: "1000" }], { rfc: RFC, ejercicio: 2026, mes: 1 })).not.toThrow();
  });

  it("rechaza RFC, ejercicio y mes fuera del XSD en vez de emitir un XML inválido", () => {
    const cuentas = [CATALOGO_ANEXO24_BASE[0]!];
    expect(() => generarXmlCatalogo(cuentas, { rfc: "", ejercicio: 2026, mes: 1 })).toThrow(ContabilidadElectronicaDatosInvalidosError);
    expect(() => generarXmlCatalogo(cuentas, { rfc: "no es rfc", ejercicio: 2026, mes: 1 })).toThrow(ContabilidadElectronicaDatosInvalidosError);
    expect(() => generarXmlCatalogo(cuentas, { rfc: RFC, ejercicio: 2014, mes: 1 })).toThrow(/Ejercicio/);
    expect(() => generarXmlCatalogo(cuentas, { rfc: RFC, ejercicio: 2026, mes: 13 })).toThrow(/Mes/);
  });

  it("CONTROL del validador: el XML que generaba la versión anterior NO es conforme", async () => {
    const heredado =
      '<?xml version="1.0" encoding="UTF-8"?>\n<Cat:Catalogo xmlns:Cat="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" Version="1.3" RFC="DESP820101AB1" Anio="2026" Mes="01" FechaModificacion="2026-01-31T23:59:59" Sello="" noCertificado="" Certificado="">\n  <Cat:Ctas>\n      <Cat:Cta NumCta="1101" Desc="BANCOS" Nivel="3" Natur="D"/>\n  </Cat:Ctas>\n</Cat:Catalogo>\n';
    const r = await validarContraXsd(heredado, "CatalogoCuentas_1_3");
    expect(r.valido).toBe(false);
    expect(r.errores.length).toBeGreaterThan(0);
  });
});

describe("balanza de comprobación contra BalanzaComprobacion_1_3.xsd", () => {
  const lineas = generarBalanza(
    CATALOGO_ANEXO24_BASE,
    [
      { cuenta: "1101", debe: 1000, haber: 0 },
      { cuenta: "4100", debe: 0, haber: 1000 },
      { cuenta: "2101", debe: 200, haber: 0 }, // saldo acreedor negativo: el XSD lo admite (importe con signo)
    ],
    "2026-01",
    { "1101": "500.50" },
  ).lineas;

  it("balanza normal (N) es válida y NO lleva FechaModBal ni sello", async () => {
    const xml = generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1 });
    const r = await validarContraXsd(xml, "BalanzaComprobacion_1_3");
    expect(r.errores).toEqual([]);
    expect(xml).toContain('TipoEnvio="N"');
    expect(xml).not.toContain("FechaModBal");
    expect(xml).not.toContain("FechaModificacion");
    expect(xml).not.toContain("Sello=");
    expect(xml).toContain('<BCE:Ctas NumCta="1101" SaldoIni="500.50" Debe="1000.00" Haber="0.00" SaldoFin="1500.50"/>');
  });

  it("balanza complementaria (C) con FechaModBal es válida", async () => {
    const xml = generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "C", fechaModBal: "2026-02-15" });
    const r = await validarContraXsd(xml, "BalanzaComprobacion_1_3");
    expect(r.errores).toEqual([]);
    expect(xml).toContain('TipoEnvio="C" FechaModBal="2026-02-15"');
  });

  it("el mes 13 (ajustes) es válido solo en la balanza", async () => {
    const xml = generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 13 });
    expect((await validarContraXsd(xml, "BalanzaComprobacion_1_3")).errores).toEqual([]);
  });

  it("C exige FechaModBal válida; N no la admite; B ya no existe", () => {
    expect(() => generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "C" })).toThrow(/FechaModBal/);
    expect(() => generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "C", fechaModBal: "2026-02-30" })).toThrow(/FechaModBal/);
    expect(() => generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "C", fechaModBal: "2014-12-31" })).toThrow(/FechaModBal/);
    expect(() => generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "N", fechaModBal: "2026-02-15" })).toThrow(/solo se declara/);
    expect(() => generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "B" as never })).toThrow(/TipoEnvio/);
  });

  it("no genera una balanza vacía", () => {
    expect(() => generarXmlBalanza([], { rfc: RFC, ejercicio: 2026, mes: 1 })).toThrow(/no tiene cuentas/);
  });

  it("CONTROL del validador: TipoEnvio B, FechaModificacion y la estructura Cta anterior son inválidos", async () => {
    const heredado =
      '<?xml version="1.0" encoding="UTF-8"?>\n<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" Version="1.3" TipoEnvio="B" RFC="DESP820101AB1" Mes="01" Anio="2026" FechaModificacion="2026-01-31T23:59:59" Sello="" noCertificado="" Certificado="">\n  <BCE:Ctas>\n      <BCE:Cta NumCta="1101" SaldoIni="0.00" Debe="1000.00" Haber="0.00" SaldoFin="1000.00"/>\n  </BCE:Ctas>\n</BCE:Balanza>\n';
    expect((await validarContraXsd(heredado, "BalanzaComprobacion_1_3")).valido).toBe(false);
  });
});

describe("paquete desde el libro (catálogo + balanza) contra los XSD", () => {
  const P = "p1";
  const INGRESO: PolizaInput = {
    tipo: "ingreso",
    fecha: "2026-07-20",
    concepto: "Honorarios",
    movimientos: [
      { cuenta: "1050000", concepto: "", debeCentavos: 116000, haberCentavos: 0 },
      { cuenta: "4080000", concepto: "", debeCentavos: 0, haberCentavos: 100000 },
      { cuenta: "2600400", concepto: "", debeCentavos: 0, haberCentavos: 16000 },
    ],
  };

  it("catálogo y balanza de julio son válidos con saldo inicial de un mes anterior", async () => {
    const repo = new InMemoryLibroRepository();
    await repo.sembrarCatalogo(P, construirCatalogoBase());
    await repo.registrarPoliza(P, { ...INGRESO, fecha: "2026-06-10" });
    await repo.registrarPoliza(P, INGRESO);
    const cuentas = (await repo.listarCuentas(P)).datos;
    const balanza = (await repo.balanza(P, 2026, 7)).datos;
    const paquete = generarPaqueteDesdeLibro({ cuentas, balanza, ejercicio: 2026, mes: 7, rfc: RFC, razonSocial: "Despacho", generadoEn: "2026-08-01T10:00:00.000Z" });
    expect((await validarContraXsd(paquete.catalogo.xml, "CatalogoCuentas_1_3")).errores).toEqual([]);
    expect((await validarContraXsd(paquete.balanza.xml, "BalanzaComprobacion_1_3")).errores).toEqual([]);
    expect(paquete.balanza.xml).toContain('NumCta="1050000" SaldoIni="1160.00"');
    expect(paquete.balanza.cuadrada).toBe(true);
  });

  it("si la balanza usa una cuenta fuera del catálogo el paquete no se arma", () => {
    expect(() =>
      generarPaqueteContabilidadElectronica({
        catalogo: CATALOGO_ANEXO24_BASE,
        rfc: RFC,
        ejercicio: 2026,
        mes: 1,
        asientos: [{ cuenta: "7777", debe: 10, haber: 0 }],
        generadoEn: "2026-02-01T09:00:00Z",
      }),
    ).toThrow(/no están en el catálogo/);
  });
});

describe("pólizas del periodo contra PolizasPeriodo_1_3.xsd", () => {
  const CUENTAS = new Map([
    ["1050000", "Clientes"],
    ["4080000", "Ingresos por servicios"],
    ["2600400", "IVA trasladado"],
  ]);
  const poliza: PolizaParaXml = {
    tipo: "ingreso",
    folio: 7,
    fecha: "2026-07-20",
    concepto: 'Honorarios de julio & "ajustes"',
    movimientos: [
      { cuenta: "1050000", concepto: "", debeCentavos: 116000, haberCentavos: 0 },
      { cuenta: "4080000", concepto: "Honorarios", debeCentavos: 0, haberCentavos: 100000 },
      { cuenta: "2600400", concepto: "IVA trasladado", debeCentavos: 0, haberCentavos: 16000 },
    ],
  };
  const base = { rfc: RFC, ejercicio: 2026, mes: 7 };

  it("solicitud AF con número de orden es válida", async () => {
    const xml = generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "AF", numOrden: "ABC1234567/26" });
    const r = await validarContraXsd(xml, "PolizasPeriodo_1_3");
    expect(r.errores).toEqual([]);
    expect(xml).toContain('NumUnIdenPol="I-202607-0007"');
    expect(xml).toContain('Debe="1160.00" Haber="0.00"');
    expect(xml).toContain("&amp; &quot;ajustes&quot;");
    expect(xml).not.toContain("Sello=");
  });

  it("solicitud CO con número de trámite es válida; una partida sin concepto toma el de la póliza", async () => {
    const xml = generarXmlPolizasPeriodo([poliza, { ...poliza, tipo: "diario", folio: 1 }], CUENTAS, { ...base, tipoSolicitud: "CO", numTramite: "AB123456789012" });
    expect((await validarContraXsd(xml, "PolizasPeriodo_1_3")).errores).toEqual([]);
    expect(xml).toContain('NumUnIdenPol="D-202607-0001"');
    expect(xml).toContain('NumCta="1050000" DesCta="Clientes" Concepto="Honorarios de julio &amp; &quot;ajustes&quot;"');
  });

  it("recorta los textos largos al máximo del XSD y sigue siendo válido", async () => {
    const larga: PolizaParaXml = { ...poliza, concepto: "c".repeat(300), movimientos: poliza.movimientos.map((m) => ({ ...m, concepto: "" })) };
    const cuentas = new Map(CUENTAS).set("1050000", "d".repeat(150));
    const xml = generarXmlPolizasPeriodo([larga], cuentas, { ...base, tipoSolicitud: "DE", numTramite: "AB123456789012" });
    expect((await validarContraXsd(xml, "PolizasPeriodo_1_3")).errores).toEqual([]);
  });

  it("AF/FC exigen orden y rechazan trámite; DE/CO al revés; el formato se valida", () => {
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "AF" })).toThrow(/número de orden/);
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "FC", numOrden: "ABC1234567-26" })).toThrow(/número de orden/);
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "AF", numOrden: "ABC1234567/26", numTramite: "AB123456789012" })).toThrow(/no llevan|no lleva/);
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "DE" })).toThrow(/número de trámite/);
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "CO", numTramite: "AB123456789012", numOrden: "ABC1234567/26" })).toThrow(/no llevan/);
    expect(() => generarXmlPolizasPeriodo([poliza], CUENTAS, { ...base, tipoSolicitud: "XX" as never })).toThrow(/TipoSolicitud/);
  });

  it("no declara pólizas descuadradas, de otro periodo, con cuentas fuera del catálogo ni un periodo vacío", () => {
    const op = { ...base, tipoSolicitud: "DE" as const, numTramite: "AB123456789012" };
    expect(() => generarXmlPolizasPeriodo([{ ...poliza, movimientos: poliza.movimientos.slice(0, 2) }], CUENTAS, op)).toThrow(/descuadrada/);
    expect(() => generarXmlPolizasPeriodo([{ ...poliza, fecha: "2026-08-01" }], CUENTAS, op)).toThrow(/no es del periodo/);
    expect(() => generarXmlPolizasPeriodo([poliza], new Map(), op)).toThrow(/no está en el catálogo/);
    expect(() => generarXmlPolizasPeriodo([], CUENTAS, op)).toThrow(/no tiene pólizas/);
  });
});
