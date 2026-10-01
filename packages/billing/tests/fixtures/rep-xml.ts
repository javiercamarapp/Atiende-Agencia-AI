// Fixtures sintéticos de complemento de pago 2.0 (CFDI 4.0 tipo P). No provienen de un PAC ni del SAT: RFC de
// prueba públicos del SAT y UUID inventados.
export const UUID_FACTURA_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const UUID_FACTURA_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
export const UUID_REP = 'cccccccc-3333-4333-8333-cccccccccccc';

export interface OpcionesRep {
  readonly doctos?: string;
  readonly version?: string;
  readonly tipo?: string;
  readonly extra?: string;
}

/** Un DoctoRelacionado con IVA 16% trasladado: factura de 1,160.00 (base 1,000.00) pagada en parcialidad 1 por 580.00. */
export function doctoXml(o: { id?: string; parcialidad?: number; saldoAnt?: string; pagado?: string; insoluto?: string; base?: string; iva?: string; moneda?: string; equivalencia?: string; objetoImp?: string } = {}): string {
  const {
    id = UUID_FACTURA_1,
    parcialidad = 1,
    saldoAnt = '1160.00',
    pagado = '580.00',
    insoluto = '580.00',
    base = '500.00',
    iva = '80.00',
    moneda = 'MXN',
    equivalencia = '1',
    objetoImp = '02',
  } = o;
  const impuestos =
    objetoImp === '02'
      ? `<pago20:ImpuestosDR><pago20:TrasladosDR><pago20:TrasladoDR BaseDR="${base}" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="${iva}"/></pago20:TrasladosDR></pago20:ImpuestosDR>`
      : '';
  return `<pago20:DoctoRelacionado IdDocumento="${id}" Serie="A" Folio="10" MonedaDR="${moneda}" EquivalenciaDR="${equivalencia}" NumParcialidad="${parcialidad}" ImpSaldoAnt="${saldoAnt}" ImpPagado="${pagado}" ImpSaldoInsoluto="${insoluto}" ObjetoImpDR="${objetoImp}">${impuestos}</pago20:DoctoRelacionado>`;
}

export function repXml(o: OpcionesRep = {}): string {
  const { doctos = doctoXml(), version = '2.0', tipo = 'P', extra = '' } = o;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="P" Folio="1" Fecha="2026-09-20T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="${tipo}" Exportacion="01" LugarExpedicion="64000" NoCertificado="00001000000500000000" Sello="AbC=">
  <cfdi:Emisor Rfc="EKU9003173C9" Nombre="Escuela Kemper Urgate" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Cliente Demo" DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601" UsoCFDI="CP01"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/></cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="${version}">
      <pago20:Totales MontoTotalPagos="580.00"/>
      <pago20:Pago FechaPago="2026-09-18T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="580.00">
        ${doctos}
      </pago20:Pago>
      ${extra}
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${UUID_REP.toUpperCase()}" FechaTimbrado="2026-09-20T12:00:05"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}
