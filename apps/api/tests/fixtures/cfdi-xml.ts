// XML sintetico (RFC de prueba del SAT, UUID inventados) para las pruebas de la carga masiva de CFDI (D-13).
export const RFC_CLIENTE = "EKU9003173C9";
export const RFC_PROVEEDOR = "CON950820K12";
export const RFC_PUBLICO = "XAXX010101000";

export interface CfdiXmlOpciones {
  readonly uuid: string;
  readonly tipo?: string;
  readonly emisor?: string;
  readonly receptor?: string;
  readonly fecha?: string;
  readonly metodoPago?: string;
}

/** CFDI 4.0 de ingreso/egreso con IVA 16% y timbre (camino feliz del parser). */
export function cfdiXml(o: CfdiXmlOpciones): string {
  const { uuid, tipo = "I", emisor = RFC_CLIENTE, receptor = RFC_PUBLICO, fecha = "2026-07-01T10:00:00", metodoPago = "PUE" } = o;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="${fecha}" Sello="AbCdEf1234==" FormaPago="03" NoCertificado="00001000000504465028"
  Certificado="MIIF" SubTotal="1000.00" Moneda="MXN" Total="1160.00" TipoDeComprobante="${tipo}" Exportacion="01" MetodoPago="${metodoPago}" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR DE PRUEBA SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR DE PRUEBA" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="616" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

/** CFDI con DTD/entidad externa (vector XXE / expansion de entidades): debe rechazarse siempre. */
export function cfdiXmlConDtd(uuid: string): string {
  return cfdiXml({ uuid }).replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE cfdi:Comprobante [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>');
}

/** Recibo de nomina (tipo N): la carga masiva lo rechaza con motivo. */
export function nominaXml(uuid: string): string {
  return cfdiXml({ uuid, tipo: "N" });
}

/** Complemento de pago 2.0 (REP) que liquida `uuidFactura` (PPD) por 2,900.00 de 5,800.00; emitido por `RFC_CLIENTE`. */
export function repXml(uuidRep: string, uuidFactura: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-07-15T12:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P" NoCertificado="00001000000500000000" Sello="AbC=">
  <cfdi:Emisor Rfc="${RFC_CLIENTE}" Nombre="Cliente SA de CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${RFC_PROVEEDOR}" UsoCFDI="CP01"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ValorUnitario="0" Importe="0"/></cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0"><pago20:Pago FechaPago="2026-07-14T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="2900.00"><pago20:DoctoRelacionado IdDocumento="${uuidFactura}" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="5800.00" ImpPagado="2900.00" ImpSaldoInsoluto="2900.00" ObjetoImpDR="02"><pago20:ImpuestosDR><pago20:TrasladosDR><pago20:TrasladoDR BaseDR="2500.00" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="400.00"/></pago20:TrasladosDR></pago20:ImpuestosDR></pago20:DoctoRelacionado></pago20:Pago></pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuidRep}" FechaTimbrado="2026-07-15T12:00:05" RfcProvCertif="AAA010101AAA" SelloCFD="x" NoCertificadoSAT="00001000000500000000" SelloSAT="x"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}
