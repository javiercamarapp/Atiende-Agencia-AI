// El complemento nomina12:Nomina generado se valida contra el XSD oficial del SAT (nomina12.xsd, rev vigente) vendorizado
// en tests/fixtures/xsd-nomina12 (ver su README: catCFDI se recorta a c_Estado, único tipo que nomina12 usa). Usa xmllint.
// Localmente se omite si no hay xmllint; en CI (CI=true) su ausencia es un fallo, no un salto silencioso.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generarXmlCfdiNomina } from "../src/nomina/xml-nomina.ts";
import { procesarNomina } from "../src/nomina/payroll-engine.ts";
import type { EmployeePayrollInput } from "../src/nomina/types.ts";

const XSD = fileURLToPath(new URL("./fixtures/xsd-nomina12/nomina12.xsd", import.meta.url));
const hayXmllint = spawnSync("xmllint", ["--version"]).error === undefined;
const enCi = process.env["CI"] === "true";

/** Extrae el nodo nomina12:Nomina del comprobante y lo deja como documento independiente con su namespace. */
function complemento(xml: string): string {
  const m = /<nomina12:Nomina[\s\S]*<\/nomina12:Nomina>/.exec(xml);
  if (!m) throw new Error("sin complemento");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${m[0].replace("<nomina12:Nomina ", '<nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" ')}`;
}

function validar(xml: string): { ok: boolean; salida: string } {
  const dir = mkdtempSync(join(tmpdir(), "nomina-xsd-"));
  const f = join(dir, "n.xml");
  writeFileSync(f, complemento(xml));
  const r = spawnSync("xmllint", ["--noout", "--schema", XSD, f], { encoding: "utf8" });
  return { ok: r.status === 0, salida: `${r.stdout}${r.stderr}` };
}

const emisor = { rfc: "DESP010101AB1", nombre: "DESPACHO SA DE CV", regimenFiscal: "601", lugarExpedicion: "06600", registroPatronal: "A1234567891" };
const receptor = { rfc: "PEAA850101ABC", nombre: "Ana Pérez", domicilioFiscalReceptor: "01000" };
const laborales = { curp: "PEAA850101HDFRRN08", numEmpleado: "EMP001", tipoContrato: "01", tipoRegimen: "02", periodicidadPago: "05", claveEntFed: "CMX", numSeguridadSocial: "12345678901", fechaInicioRelLaboral: "2020-03-01", riesgoPuesto: "1" };

function xmlDe(emp: EmployeePayrollInput, month = 2, periodo: Record<string, unknown> = {}): string {
  const p = procesarNomina({ month, year: 2026 }, [emp]);
  return generarXmlCfdiNomina(p.employees[0]!, emisor, receptor, { year: 2026, month, diasPagados: 30, folio: "F1", ...periodo }, laborales);
}

describe.skipIf(!hayXmllint && !enCi)("XML Nómina 1.2 contra el XSD oficial", () => {
  it("hay xmllint (en CI es obligatorio)", () => {
    expect(hayXmllint).toBe(true);
    expect(execFileSync("xmllint", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).length).toBeGreaterThanOrEqual(0);
  });

  it("sanidad: un complemento roto SÍ falla la validación", () => {
    const roto = xmlDe({ salarioBruto: 15000 }).replace('Version="1.2"', 'Version="1.1"');
    expect(validar(roto).ok).toBe(false);
  });

  it("salario medio sin subsidio", () => {
    const r = validar(xmlDe({ salarioBruto: 15000, fechaInicioRelLaboral: "2020-03-01" }));
    expect(r.salida).toContain("validates");
  });

  it("salario bajo con subsidio: OtroPago 002 con SubsidioAlEmpleo/@SubsidioCausado como elemento hijo", () => {
    const xml = xmlDe({ salarioBruto: 9000 });
    expect(xml).toContain('<nomina12:OtroPago TipoOtroPago="002"');
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="535.65"/>');
    expect(xml).toContain('TotalOtrosPagos="0.00"');
    expect(validar(xml).salida).toContain("validates");
  });

  it("emisor con registro patronal, receptor con NSS, antigüedad en semanas, SBC, SDI y riesgo de puesto", () => {
    const xml = xmlDe({ salarioBruto: 15000 });
    expect(xml).toContain('<nomina12:Emisor RegistroPatronal="A1234567891"/>');
    expect(xml).toMatch(/NumSeguridadSocial="12345678901" FechaInicioRelLaboral="2020-03-01" Antigüedad="P\d+W"/);
    expect(xml).toContain('RiesgoPuesto="1"');
    expect(xml).toContain('SalarioBaseCotApor="524.65" SalarioDiarioIntegrado="524.65"');
    expect(validar(xml).salida).toContain("validates");
  });

  it("aguinaldo, prima vacacional, PTU, horas extra (019 con HorasExtra) e incapacidad separan gravado y exento", () => {
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
    const r = validar(xml);
    expect(r.salida, r.salida).toContain("validates");
  });

  it("quincena con fechas reales", () => {
    const xml = xmlDe({ salarioBruto: 9000 }, 2, { fechaPago: "2026-02-15", fechaInicialPago: "2026-02-01", fechaFinalPago: "2026-02-15", diasPagados: 15 });
    expect(validar(xml).salida).toContain("validates");
  });
});
