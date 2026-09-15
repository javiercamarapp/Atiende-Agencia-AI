// Fase 7 (cierre de gap de auditoría "Sin generación/timbrado del XML de
// complemento Nómina 1.2") — pruebas de `generarXmlCfdiNomina`, puerto de
// `generate_cfdi_nomina_xml` (nomina_completa/service.py). Cubre: estructura
// del XML producida (namespaces, atributos del comprobante/complemento/
// percepciones/deducciones), las validaciones que lanzan `Error` en vez de
// fabricar datos fiscales, y el caso borde sin deducciones (empleado sin
// ISR/IMSS obrero -> el nodo `<nomina12:Deducciones>` no se emite, igual que
// el original).
import { describe, expect, it } from "vitest";
import { generarXmlCfdiNomina } from "../src/nomina/xml-nomina.ts";
import type { DatosEmisorNominaXml, DatosPeriodoNominaXml, DatosReceptorNominaXml } from "../src/nomina/xml-nomina.ts";
import type { EmployeePayroll } from "../src/nomina/types.ts";

function empleado(overrides: Partial<EmployeePayroll> = {}): EmployeePayroll {
  return {
    employeeId: "E1",
    nombre: "Ana Pérez",
    salarioDiario: 500,
    salarioBruto: 15000,
    percepciones: 500,
    deducciones: 1900,
    taxes: { isr: 1500, imssPatronal: 2137.5, imssObrero: 400, infonavit: 750, total: 2650 },
    neto: 13100,
    diasPagados: 30,
    ...overrides,
  };
}

function emisor(overrides: Partial<DatosEmisorNominaXml> = {}): DatosEmisorNominaXml {
  return {
    rfc: "DESP010101AB1",
    nombre: "DESPACHO DE PRUEBA SA DE CV",
    regimenFiscal: "601",
    lugarExpedicion: "06600",
    ...overrides,
  };
}

function receptor(overrides: Partial<DatosReceptorNominaXml> = {}): DatosReceptorNominaXml {
  return {
    rfc: "PEAA850101ABC",
    nombre: "Ana Pérez",
    domicilioFiscalReceptor: "01000",
    ...overrides,
  };
}

function periodo(overrides: Partial<DatosPeriodoNominaXml> = {}): DatosPeriodoNominaXml {
  return {
    year: 2026,
    month: 7,
    diasPagados: 30,
    folio: "F0001",
    ...overrides,
  };
}

function datosLaborales(overrides: Partial<import("../src/nomina/xml-nomina.ts").DatosLaboralesNominaXml> = {}) {
  return {
    curp: "PEAA850101HDFRRN08",
    numEmpleado: "EMP001",
    tipoContrato: "01",
    tipoRegimen: "02",
    periodicidadPago: "05",
    claveEntFed: "CMX",
    ...overrides,
  };
}

describe("generarXmlCfdiNomina — estructura del XML", () => {
  it("genera un comprobante bien formado con los namespaces cfdi/xsi/nomina12", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales());

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:cfdi="http://www.sat.gob.mx/cfd/4"');
    expect(xml).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(xml).toContain('xmlns:nomina12="http://www.sat.gob.mx/nomina12"');
    expect(xml).toContain('<cfdi:Comprobante');
    expect(xml).toContain('</cfdi:Comprobante>');

    // Comprobante: Version 4.0, TipoDeComprobante N, Total=SubTotal=percepciones
    // (salarioBruto 15000 + percepciones 500 = 15500) -- el Total del
    // comprobante NUNCA resta ISR/IMSS del trabajador (ver comentario de
    // cabecera del módulo y nomina-integracion.e2e.spec.ts).
    expect(xml).toContain('Version="4.0"');
    expect(xml).toContain('TipoDeComprobante="N"');
    expect(xml).toContain('SubTotal="15500.00"');
    expect(xml).toContain('Total="15500.00"');
    expect(xml).toContain('Folio="F0001"');
    expect(xml).toContain('LugarExpedicion="06600"');

    // Emisor / Receptor
    expect(xml).toContain('<cfdi:Emisor Rfc="DESP010101AB1" Nombre="DESPACHO DE PRUEBA SA DE CV" RegimenFiscal="601"/>');
    expect(xml).toContain('Rfc="PEAA850101ABC"');
    expect(xml).toContain('DomicilioFiscalReceptor="01000"');
    expect(xml).toContain('RegimenFiscalReceptor="605"'); // default
    expect(xml).toContain('UsoCFDI="CN01"');

    // Complemento Nómina 1.2
    expect(xml).toContain('<nomina12:Nomina');
    expect(xml).toContain('Version="1.2"');
    expect(xml).toContain('TipoNomina="O"'); // default
    expect(xml).toContain('NumDiasPagados="30"');
    expect(xml).toContain('TotalPercepciones="15500.00"');
    expect(xml).toContain('TotalDeducciones="1900.00"'); // isr 1500 + imssObrero 400

    // Percepciones: un solo concepto "Sueldos, Salarios, Rayas y Jornales"
    expect(xml).toContain('TotalSueldos="15500.00"');
    expect(xml).toContain('TipoPercepcion="001"');
    expect(xml).toContain('Concepto="Sueldos, Salarios, Rayas y Jornales"');
    expect(xml).toContain('ImporteGravado="15500.00"');

    // Deducciones: ISR (002) e IMSS obrero (001)
    expect(xml).toContain('<nomina12:Deducciones TotalOtrasDeducciones="400.00" TotalImpuestosRetenidos="1500.00">');
    expect(xml).toContain('TipoDeduccion="002" Clave="002" Concepto="ISR" Importe="1500.00"');
    expect(xml).toContain('TipoDeduccion="001" Clave="001" Concepto="Seguridad social (IMSS)" Importe="400.00"');

    // Well-formedness básica: cada elemento con hijos abre y cierra exactamente
    // una vez, en el orden correcto (sin depender de un parser XML externo --
    // mismo criterio "sin dependencias nuevas" de mcp-servers/cfdi/src/port.ts).
    for (const tag of ["cfdi:Comprobante", "cfdi:Conceptos", "cfdi:Complemento", "nomina12:Nomina", "nomina12:Percepciones", "nomina12:Deducciones"]) {
      expect(xml.split(`<${tag}`).length - 1).toBe(1);
      expect(xml.split(`</${tag}>`).length - 1).toBe(1);
    }
    expect(xml.indexOf("<cfdi:Comprobante")).toBeLessThan(xml.indexOf("</cfdi:Comprobante>"));
    expect(xml.lastIndexOf("</cfdi:Comprobante>")).toBe(xml.length - "</cfdi:Comprobante>".length);
  });

  // CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "XML de nómina 1.2 no valida contra
  // el XSD real del SAT"): estas 4 piezas eran obligatorias en el XSD real y no se
  // emitían antes de esta corrección — ver NOTA en la cabecera de xml-nomina.ts.
  it("Exportacion='01' (atributo obligatorio de cfdi:Comprobante desde CFDI 4.0)", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales());
    expect(xml).toContain('Exportacion="01"');
  });

  it("cfdi:Conceptos con un Concepto de servicios de nómina, ObjetoImp='01' (nodo obligatorio, antes ausente)", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales());
    expect(xml).toContain("<cfdi:Conceptos>");
    expect(xml).toContain('ClaveProdServ="84111505"');
    expect(xml).toContain('ClaveUnidad="ACT"');
    expect(xml).toContain('ObjetoImp="01"');
    expect(xml).toContain('Importe="15500.00"');
    // cfdi:Conceptos debe ir ANTES de cfdi:Complemento en el XML (orden del XSD).
    expect(xml.indexOf("<cfdi:Conceptos>")).toBeLessThan(xml.indexOf("<cfdi:Complemento>"));
  });

  it("nomina12:Receptor con los datos laborales del trabajador (nodo obligatorio, antes ausente)", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ curp: "peaa850101hdfrrn08", claveEntFed: "cmx" }));
    // CURP y ClaveEntFed se normalizan a mayúsculas.
    expect(xml).toContain('<nomina12:Receptor Curp="PEAA850101HDFRRN08" NumEmpleado="EMP001" TipoContrato="01" TipoRegimen="02" PeriodicidadPago="05" ClaveEntFed="CMX"/>');
    // nomina12:Receptor debe ir dentro de nomina12:Nomina, antes de Percepciones.
    expect(xml.indexOf("<nomina12:Receptor")).toBeGreaterThan(xml.indexOf("<nomina12:Nomina"));
    expect(xml.indexOf("<nomina12:Receptor")).toBeLessThan(xml.indexOf("<nomina12:Percepciones"));
  });

  it("nomina12:Percepciones incluye TotalGravado/TotalExento (atributos obligatorios, antes ausentes)", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales());
    expect(xml).toContain('<nomina12:Percepciones TotalSueldos="15500.00" TotalGravado="15500.00" TotalExento="0.00">');
  });

  it("FechaFinalPago usa el último día real del mes, incluyendo febrero bisiesto", () => {
    const xmlFeb2026 = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ month: 2, year: 2026 }), datosLaborales()); // no bisiesto
    expect(xmlFeb2026).toContain('FechaFinalPago="2026-02-28"');

    const xmlFeb2028 = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ month: 2, year: 2028 }), datosLaborales()); // bisiesto
    expect(xmlFeb2028).toContain('FechaFinalPago="2028-02-29"');
  });

  it("FechaPago y FechaInicialPago son el primer día del mes (fidelidad literal del original)", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ month: 7, year: 2026 }), datosLaborales());
    expect(xml).toContain('FechaPago="2026-07-01"');
    expect(xml).toContain('FechaInicialPago="2026-07-01"');
    expect(xml).toContain('Fecha="2026-07-01T00:00:00"');
  });

  it("sin ISR ni IMSS obrero -> no emite <nomina12:Deducciones> (igual que el original)", () => {
    const emp = empleado({ taxes: { isr: 0, imssPatronal: 0, imssObrero: 0, infonavit: 0, total: 0 } });
    const xml = generarXmlCfdiNomina(emp, emisor(), receptor(), periodo(), datosLaborales());
    expect(xml).not.toContain("nomina12:Deducciones");
    expect(xml).toContain('TotalDeducciones="0.00"');
  });

  it("escapa caracteres especiales XML en Nombre (& < > \" ')", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor({ nombre: 'Despacho "Fiscal" & Asociados <SA>' }), receptor(), periodo(), datosLaborales());
    expect(xml).toContain("Despacho &quot;Fiscal&quot; &amp; Asociados &lt;SA&gt;");
    expect(xml).not.toContain('Nombre="Despacho "Fiscal"'); // no debe romper el atributo
  });

  // CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "XML de nómina 1.2 no valida contra
  // el XSD real del SAT"): NoCertificado/Certificado son OPCIONALES en el XSD real,
  // pero con facets (length=20 dígitos / base64 no vacío) que un valor de cadena
  // VACÍA viola -- verificado validando contra el XSD real (xmllint), que rechaza
  // `NoCertificado=""` con "this differs from the allowed length of '20'". Sin CSD
  // real, el atributo se OMITE por completo (nunca se emite vacío).
  it("sin CSD real, NoCertificado/Certificado se OMITEN (nunca se emiten vacíos -- un valor vacío viola el XSD real)", () => {
    const sinSellar = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales());
    expect(sinSellar).not.toContain("NoCertificado");
    expect(sinSellar).not.toContain("Certificado=");

    const sellado = generarXmlCfdiNomina(empleado(), emisor({ noCertificado: "00001000000504465028", certificado: "MIIF...base64..." }), receptor(), periodo(), datosLaborales());
    expect(sellado).toContain('NoCertificado="00001000000504465028"');
    expect(sellado).toContain('Certificado="MIIF...base64..."');
  });

  it("permite tipoNomina=E (extraordinaria) y serie explícita", () => {
    const xml = generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ tipoNomina: "E", serie: "EXT" }), datosLaborales());
    expect(xml).toContain('TipoNomina="E"');
    expect(xml).toContain('Serie="EXT"');
  });
});

describe("generarXmlCfdiNomina — validaciones (nunca fabrica datos fiscales)", () => {
  it("RFC de emisor ausente -> Error explícito, no XML con RFC vacío", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor({ rfc: "" }), receptor(), periodo(), datosLaborales())).toThrow("RFC del emisor es obligatorio");
  });

  it("RFC de receptor ausente -> Error explícito", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor({ rfc: "" }), periodo(), datosLaborales())).toThrow("RFC del receptor es obligatorio");
  });

  it("RFC con formato inválido -> Error (no genera un XML con un RFC malformado)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor({ rfc: "NO-ES-UN-RFC" }), receptor(), periodo(), datosLaborales())).toThrow(/formato válido/);
  });

  it("nombre de emisor/receptor ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor({ nombre: "  " }), receptor(), periodo(), datosLaborales())).toThrow("nombre del emisor");
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor({ nombre: "" }), periodo(), datosLaborales())).toThrow("nombre del receptor");
  });

  it("régimen fiscal del emisor ausente -> Error (a diferencia del original, NO defaultea a '601' fabricado)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor({ regimenFiscal: "" }), receptor(), periodo(), datosLaborales())).toThrow("régimen fiscal del emisor");
  });

  it("lugarExpedicion ausente -> Error (a diferencia del original, NO defaultea a un CP fabricado)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor({ lugarExpedicion: "" }), receptor(), periodo(), datosLaborales())).toThrow("lugar de expedición");
  });

  it("domicilioFiscalReceptor ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor({ domicilioFiscalReceptor: "" }), periodo(), datosLaborales())).toThrow("domicilio fiscal");
  });

  it("folio ausente -> Error (este puerto no genera un folio aleatorio por sí mismo -- ver NOTA DE FIDELIDAD)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ folio: "" }), datosLaborales())).toThrow("folio es obligatorio");
  });

  it("month fuera de 1-12 -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ month: 13 }), datosLaborales())).toThrow("period.month");
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ month: 0 }), datosLaborales())).toThrow("period.month");
  });

  it("diasPagados <= 0 -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo({ diasPagados: 0 }), datosLaborales())).toThrow("diasPagados");
  });

  // CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "XML de nómina 1.2 no valida contra
  // el XSD real del SAT"): nomina12:Receptor es obligatorio en el XSD real — estos
  // datos NUNCA se fabrican (ver NOTA de cabecera de xml-nomina.ts).
  it("CURP ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ curp: "" }))).toThrow("CURP del trabajador es obligatorio");
  });

  it("CURP con formato inválido -> Error (no genera un XML con un CURP malformado)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ curp: "NO-ES-UN-CURP" }))).toThrow(/formato válido/);
  });

  it("numEmpleado ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ numEmpleado: "" }))).toThrow("número de empleado es obligatorio");
  });

  it("tipoContrato ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ tipoContrato: "" }))).toThrow("TipoContrato");
  });

  it("tipoRegimen ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ tipoRegimen: "" }))).toThrow("TipoRegimen");
  });

  it("periodicidadPago ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ periodicidadPago: "" }))).toThrow("PeriodicidadPago");
  });

  it("claveEntFed ausente -> Error", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ claveEntFed: "" }))).toThrow("ClaveEntFed");
  });

  it("claveEntFed fuera del catálogo c_Estado -> Error (no inventa una entidad federativa)", () => {
    expect(() => generarXmlCfdiNomina(empleado(), emisor(), receptor(), periodo(), datosLaborales({ claveEntFed: "XXX" }))).toThrow(/no es una clave de entidad federativa válida/);
  });
});
