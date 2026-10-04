// D-P3-01 / brief paridad3-despachos-fiscal-correcciones (paso 2): el total coherente de un CFDI incluye el IEPS (003) y los
// impuestos locales del complemento `implocal` (ISH). Antes un CFDI legitimo de gasolinera, restaurante con IEPS u hotel con ISH
// salia `valido=false` (`total_incoherente`) y desaparecia de los pagos provisionales.
// Los XML son fixtures armados a mano (estructura CFDI 4.0 real; no hay PAC ni credenciales en el repo).
import { describe, expect, it } from "vitest";
import { parseCfdiXml } from "@atiende/billing";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";

interface Opts {
  readonly subtotal: string;
  readonly total: string;
  readonly concepto: string;
  readonly impuestos: string;
  readonly complemento?: string;
}

function xmlCfdi(o: Opts): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-07-01T10:00:00" Sello="AbCdEf1234==" FormaPago="03"
  NoCertificado="00001000000504465028" Certificado="MIIF" SubTotal="${o.subtotal}" Moneda="MXN" Total="${o.total}" TipoDeComprobante="I" Exportacion="01" MetodoPago="PUE" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="CON950820K12" Nombre="PROVEEDOR DE PRUEBA SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="CLI010101CL1" Nombre="CLIENTE SA DE CV" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>${o.concepto}</cfdi:Conceptos>
  ${o.impuestos}
  <cfdi:Complemento>
    ${o.complemento ?? ""}
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-07-01T10:05:00" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

function validar(xml: string) {
  const { impuestos: _impuestos, ...parsed } = parseCfdiXml(xml);
  const datos: DatosCfdiDespachos = { ...parsed, tipo: parsed.tipo as DatosCfdiDespachos["tipo"] };
  return { parsed, resultado: validarCfdiDespachos(datos) };
}

// Gasolina Magna: 100 L a $10.00 sin impuestos; IEPS por cuota $6.17/L = 617.00; IVA 16 % sobre (1000 + 617) = 258.72; total 1875.72.
const GASOLINA = xmlCfdi({
  subtotal: "1000.00",
  total: "1875.72",
  concepto: `<cfdi:Concepto ClaveProdServ="15101514" Cantidad="100" ClaveUnidad="LTR" Descripcion="Magna" ValorUnitario="10.00" Importe="1000.00" ObjetoImp="02">
    <cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="100.00" Impuesto="003" TipoFactor="Cuota" TasaOCuota="6.170000" Importe="617.00"/>
      <cfdi:Traslado Base="1617.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="258.72"/>
    </cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`,
  impuestos: `<cfdi:Impuestos TotalImpuestosTrasladados="875.72"><cfdi:Traslados>
    <cfdi:Traslado Base="100.00" Impuesto="003" TipoFactor="Cuota" TasaOCuota="6.170000" Importe="617.00"/>
    <cfdi:Traslado Base="1617.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="258.72"/>
  </cfdi:Traslados></cfdi:Impuestos>`,
});

// Restaurante: alimentos de alta densidad calorica, IEPS 8 % sobre 500 = 40.00; IVA 16 % sobre 540 = 86.40; total 626.40.
const RESTAURANTE = xmlCfdi({
  subtotal: "500.00",
  total: "626.40",
  concepto: `<cfdi:Concepto ClaveProdServ="90101501" Cantidad="1" ClaveUnidad="E48" Descripcion="Consumo" ValorUnitario="500.00" Importe="500.00" ObjetoImp="02">
    <cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="500.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="40.00"/>
      <cfdi:Traslado Base="540.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="86.40"/>
    </cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`,
  impuestos: `<cfdi:Impuestos TotalImpuestosTrasladados="126.40"><cfdi:Traslados>
    <cfdi:Traslado Base="500.00" Impuesto="003" TipoFactor="Tasa" TasaOCuota="0.080000" Importe="40.00"/>
    <cfdi:Traslado Base="540.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="86.40"/>
  </cfdi:Traslados></cfdi:Impuestos>`,
});

// Hotel: hospedaje 2000.00, IVA 16 % = 320.00, ISH estatal 3 % (complemento implocal) = 60.00; total 2380.00.
const HOTEL = xmlCfdi({
  subtotal: "2000.00",
  total: "2380.00",
  concepto: `<cfdi:Concepto ClaveProdServ="90111500" Cantidad="1" ClaveUnidad="E48" Descripcion="Hospedaje" ValorUnitario="2000.00" Importe="2000.00" ObjetoImp="02">
    <cfdi:Impuestos><cfdi:Traslados>
      <cfdi:Traslado Base="2000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="320.00"/>
    </cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`,
  impuestos: `<cfdi:Impuestos TotalImpuestosTrasladados="320.00"><cfdi:Traslados>
    <cfdi:Traslado Base="2000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="320.00"/>
  </cfdi:Traslados></cfdi:Impuestos>`,
  complemento: `<implocal:ImpuestosLocales xmlns:implocal="http://www.sat.gob.mx/implocal" version="1.0" TotaldeRetenciones="0.00" TotaldeTraslados="60.00">
    <implocal:TrasladosLocales ImpLocTrasladado="ISH" TasadeTraslado="3.00" Importe="60.00"/>
  </implocal:ImpuestosLocales>`,
});

describe("total coherente con IEPS e impuestos locales (D-P3-01)", () => {
  it("gasolinera con IEPS por cuota: valido, sin total_incoherente y sin aviso de IVA global", () => {
    const { parsed, resultado } = validar(GASOLINA);
    expect(parsed.ieps).toBe(617);
    expect(parsed.iva).toBe(258.72);
    expect(resultado.issues).toEqual([]);
    expect(resultado.ok).toBe(true);
    // IVA = 16 % de (subtotal + IEPS): no es el 16 % del subtotal, y NO debe avisar en falso.
    expect(resultado.warnings.some((w) => w.startsWith("IVA global"))).toBe(false);
  });

  it("restaurante con IEPS 8 %: valido", () => {
    const { parsed, resultado } = validar(RESTAURANTE);
    expect(parsed.ieps).toBe(40);
    expect(resultado.issues).toEqual([]);
    expect(resultado.ok).toBe(true);
  });

  it("hotel con ISH (implocal TotaldeTraslados): valido", () => {
    const { parsed, resultado } = validar(HOTEL);
    expect(parsed.impuestosLocalesTraslados).toBe(60);
    expect(resultado.issues).toEqual([]);
    expect(resultado.ok).toBe(true);
  });

  it("negativo: el mismo hotel con un Total que ignora el ISH (2320) SI es incoherente", () => {
    const { resultado } = validar(HOTEL.replace('Total="2380.00"', 'Total="2320.00"'));
    expect(resultado.issues.map((i) => i.codigo)).toEqual(["total_incoherente"]);
    expect(resultado.ok).toBe(false);
  });

  it("negativo: una gasolina cuyo Total omite el IEPS (1258.72) SI es incoherente", () => {
    const { resultado } = validar(GASOLINA.replace('Total="1875.72"', 'Total="1258.72"'));
    expect(resultado.issues.map((i) => i.codigo)).toEqual(["total_incoherente"]);
  });

  it("las retenciones locales (cedular) se restan del total", () => {
    const xml = HOTEL.replace('TotaldeRetenciones="0.00"', 'TotaldeRetenciones="10.00"').replace('Total="2380.00"', 'Total="2370.00"');
    const { parsed, resultado } = validar(xml);
    expect(parsed.impuestosLocalesRetenciones).toBe(10);
    expect(resultado.issues).toEqual([]);
  });

  it("con retenciones federales (ISR/IVA) la formula completa tambien suma IEPS y locales", () => {
    const resultado = validarCfdiDespachos({
      tipo: "I", subtotal: 1000, total: 1000 + 160 + 50 + 20 - 100, descuento: 0, iva: 160, ieps: 50, impuestosLocalesTraslados: 20, retencionIsr: 100,
      conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }], usoCfdi: "G03", formaPago: "03", metodoPago: "PUE", regimenFiscalEmisor: "612",
      rfcEmisor: "CON950820K12", rfcReceptor: "CLI010101CL1", tieneSello: true, noCertificado: "00001000000504465028", folioFiscal: "x",
    });
    expect(resultado.issues.filter((i) => i.codigo === "total_incoherente")).toEqual([]);
  });
});
