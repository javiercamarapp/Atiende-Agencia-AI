// El complemento nomina12:Nomina generado se valida contra el XSD oficial del SAT (nomina12.xsd, rev vigente) vendorizado
// en tests/fixtures/xsd-nomina12 (ver su README: catCFDI se recorta a c_Estado, único tipo que nomina12 usa). Usa xmllint-wasm
// (libxml2 en WebAssembly): corre igual en cualquier maquina y en CI, sin binarios del sistema.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateXML } from "xmllint-wasm";
import { describe, expect, it } from "vitest";
import { generarXmlCfdiNomina } from "../src/nomina/xml-nomina.ts";
import { procesarNomina } from "../src/nomina/payroll-engine.ts";
import type { EmployeePayrollInput } from "../src/nomina/types.ts";

const DIR = fileURLToPath(new URL("./fixtures/xsd-nomina12/", import.meta.url));
const leer = (f: string) => readFileSync(DIR + f, "utf8");
const SCHEMA = leer("nomina12.xsd");
const PRELOAD = ["catNomina.xsd", "tdCFDI.xsd", "catCFDI.c_Estado.xsd"].map((fileName) => ({ fileName, contents: leer(fileName) }));

/** Extrae el nodo nomina12:Nomina del comprobante y lo deja como documento independiente con su namespace. */
function complemento(xml: string): string {
  const m = /<nomina12:Nomina[\s\S]*<\/nomina12:Nomina>/.exec(xml);
  if (!m) throw new Error("sin complemento");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${m[0].replace("<nomina12:Nomina ", '<nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" ')}`;
}

async function validar(xml: string): Promise<{ ok: boolean; salida: string }> {
  const r = await validateXML({ xml: [{ fileName: "nomina.xml", contents: complemento(xml) }], schema: [SCHEMA], preload: PRELOAD });
  return { ok: r.valid, salida: r.errors.map((e) => e.message).join("\n") };
}

const emisor = { rfc: "DESP010101AB1", nombre: "DESPACHO SA DE CV", regimenFiscal: "601", lugarExpedicion: "06600", registroPatronal: "A1234567891" };
const receptor = { rfc: "PEAA850101ABC", nombre: "Ana Pérez", domicilioFiscalReceptor: "01000" };
const laborales = { curp: "PEAA850101HDFRRN08", numEmpleado: "EMP001", tipoContrato: "01", tipoRegimen: "02", periodicidadPago: "05", claveEntFed: "CMX", numSeguridadSocial: "12345678901", fechaInicioRelLaboral: "2020-03-01", riesgoPuesto: "1" };

function xmlDe(emp: EmployeePayrollInput, month = 2, periodo: Record<string, unknown> = {}, quincenal = false): string {
  const p = procesarNomina({ month, year: 2026, ...(quincenal ? { periodicidad: "quincenal" as const, fechaPago: String(periodo["fechaPago"] ?? "") || undefined } : {}) }, [emp]);
  return generarXmlCfdiNomina(p.employees[0]!, emisor, receptor, { year: 2026, month, diasPagados: 30, folio: "F1", ...periodo }, laborales);
}

describe("XML Nómina 1.2 contra el XSD oficial", () => {
  it("sanidad: un complemento roto SÍ falla la validación", async () => {
    const roto = xmlDe({ salarioBruto: 15000 }).replace('Version="1.2"', 'Version="1.1"');
    const r = await validar(roto);
    expect(r.ok).toBe(false);
    expect(r.salida).toContain("1.2");
  });

  it("salario medio sin subsidio", async () => {
    const r = await validar(xmlDe({ salarioBruto: 15000, fechaInicioRelLaboral: "2020-03-01" }));
    expect(r.salida).toBe("");
    expect(r.ok).toBe(true);
  });

  it("salario bajo con subsidio: OtroPago 002 con SubsidioAlEmpleo/@SubsidioCausado como elemento hijo", async () => {
    const xml = xmlDe({ salarioBruto: 9000 });
    expect(xml).toContain('<nomina12:OtroPago TipoOtroPago="002"');
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="535.65"/>');
    expect(xml).toContain('TotalOtrosPagos="0.00"');
    const r = await validar(xml);
    expect(r.salida).toBe("");
    expect(r.ok).toBe(true);
  });

  it("emisor con registro patronal, receptor con NSS, antigüedad en semanas, SBC, SDI y riesgo de puesto", async () => {
    const xml = xmlDe({ salarioBruto: 15000 });
    expect(xml).toContain('<nomina12:Emisor RegistroPatronal="A1234567891"/>');
    expect(xml).toMatch(/NumSeguridadSocial="12345678901" FechaInicioRelLaboral="2020-03-01" Antigüedad="P\d+W"/);
    expect(xml).toContain('RiesgoPuesto="1"');
    expect(xml).toContain('SalarioBaseCotApor="524.65" SalarioDiarioIntegrado="524.65"');
    const r = await validar(xml);
    expect(r.salida).toBe("");
    expect(r.ok).toBe(true);
  });

  it("aguinaldo, prima vacacional, PTU, horas extra (019 con HorasExtra) e incapacidad separan gravado y exento", async () => {
    const xml = xmlDe(
      {
        salarioBruto: 15000,
        conceptos: {
          aguinaldo: 10000,
          primaVacacional: 2000,
          ptu: 1000,
          horasExtra: [{ dias: 2, tipo: "01", horas: 6, importe: 600 }, { dias: 1, tipo: "02", horas: 3, importe: 450 }],
          incapacidades: [{ dias: 2, tipo: "02", importe: 800 }],
        },
      },
      12,
    );
    expect(xml).toContain('TipoPercepcion="002" Clave="002" Concepto="Gratificación anual (aguinaldo)" ImporteGravado="6480.70" ImporteExento="3519.30"');
    expect(xml).toContain('TipoPercepcion="021"');
    expect(xml).toContain('TipoPercepcion="003"');
    expect(xml).toContain('<nomina12:HorasExtra Dias="2" TipoHoras="01" HorasExtra="6" ImportePagado="600.00"/>');
    expect(xml).toContain('<nomina12:Incapacidad DiasIncapacidad="2" TipoIncapacidad="02" ImporteMonetario="800.00"/>');
    expect(xml).toContain('TipoDeduccion="006"');
    const r = await validar(xml);
    expect(r.salida).toBe("");
    expect(r.ok).toBe(true);
  });

  it("quincena con fechas reales: el sueldo 001, TotalPercepciones y NumDiasPagados cuadran con la quincena", async () => {
    const xml = xmlDe({ salarioBruto: 4500 }, 2, { fechaPago: "2026-02-15", fechaInicialPago: "2026-02-01", fechaFinalPago: "2026-02-15", diasPagados: 15 }, true);
    expect(xml).toContain('NumDiasPagados="15"');
    expect(xml).toContain('TotalPercepciones="4500.00"');
    expect(xml).toMatch(/TipoPercepcion="001"[^>]*ImporteGravado="4500.00"/);
    const r = await validar(xml);
    expect(r.salida).toBe("");
    expect(r.ok).toBe(true);
  });

  it("quincena sin fechas explícitas: usa la quincena de FechaPago, no el mes entero", async () => {
    const primera = xmlDe({ salarioBruto: 4500 }, 2, { fechaPago: "2026-02-15", diasPagados: 15 }, true);
    expect(primera).toContain('FechaInicialPago="2026-02-01" FechaFinalPago="2026-02-15"');
    const segunda = xmlDe({ salarioBruto: 4500 }, 2, { fechaPago: "2026-02-28", diasPagados: 15 }, true);
    expect(segunda).toContain('FechaInicialPago="2026-02-16" FechaFinalPago="2026-02-28"');
    expect((await validar(segunda)).ok).toBe(true);
  });

  it("sin subsidio no hay OtrosPagos ni TotalOtrosPagos", async () => {
    const xml = xmlDe({ salarioBruto: 15000 });
    expect(xml).not.toContain("TotalOtrosPagos");
    expect(xml).not.toContain("OtrosPagos");
    expect((await validar(xml)).ok).toBe(true);
  });

  it("FechaPago anterior a FechaInicialPago se rechaza", () => {
    expect(() => xmlDe({ salarioBruto: 4500 }, 2, { fechaPago: "2026-02-10", fechaInicialPago: "2026-02-16", fechaFinalPago: "2026-02-28", diasPagados: 15 }, true)).toThrow(/fechaPago no puede ser anterior/);
  });
});
