// XML sintetico (RFC de prueba del SAT, UUID inventados) con DESCRIPCION y ClaveProdServ controlables: alimenta las pruebas del clasificador contable (D-P3-13),
// del autoaceptado del portal (D-P3-22) y de las polizas del periodo (D-P3-14).
import { RFC_CLIENTE, RFC_PROVEEDOR } from "./cfdi-xml.ts";

export interface CfdiClasificableOpciones {
  readonly uuid: string;
  readonly descripcion?: string | null;
  readonly claveProdServ?: string | null;
  /** Por omision un CFDI RECIBIDO: lo emite el proveedor y lo recibe el cliente. */
  readonly emisor?: string;
  readonly receptor?: string;
  readonly tipo?: string;
  readonly fecha?: string;
  readonly formaPago?: string;
  /** Datos que provocan un hallazgo del motor fiscal (p. ej. total que no cuadra). */
  readonly total?: string;
  readonly sello?: string;
}

export function cfdiXmlClasificable(o: CfdiClasificableOpciones): string {
  const { uuid, descripcion = "Honorarios por asesoría y consultoría", claveProdServ = null, emisor = RFC_PROVEEDOR, receptor = RFC_CLIENTE, tipo = "I", fecha = "2026-07-01T10:00:00", formaPago = "03", total = "1160.00", sello = "AbCdEf1234==" } = o;
  const cp = claveProdServ ? ` ClaveProdServ="${claveProdServ}"` : "";
  const desc = descripcion === null ? "" : ` Descripcion="${descripcion}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="${fecha}" Sello="${sello}" FormaPago="${formaPago}" NoCertificado="00001000000504465028"
  Certificado="MIIF" SubTotal="1000.00" Moneda="MXN" Total="${total}" TipoDeComprobante="${tipo}" Exportacion="01" MetodoPago="PUE" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="${emisor}" Nombre="EMISOR DE PRUEBA SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptor}" Nombre="RECEPTOR DE PRUEBA" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto${cp} Cantidad="1" ClaveUnidad="E48"${desc} ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${fecha}" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}
