// ═══════════════════════════════════════════════════════════════════════════
// GENERACIÓN DEL XML DEL COMPLEMENTO NÓMINA 1.2 — cierre del gap de auditoría
// "Sin generación/timbrado del XML de complemento Nómina 1.2". Puerto de
// `generate_cfdi_nomina_xml` en
// ~/Desktop/supabase/despachos/b2b_ai/features/nomina_completa/service.py
// (líneas 269-435) — la ÚNICA función del original que construye el XML real
// (`xml.etree.ElementTree`) conforme a la estructura del complemento SAT;
// `generate_cfdi_nomina` (el otro generador del mismo archivo) solo arma un
// `dict` de "retrocompatibilidad", no un XML.
//
// NOTA IMPORTANTE, VERIFICADA LEYENDO EL ORIGINAL: `generate_cfdi_nomina_xml`
// existe en el repo Python pero NINGÚN endpoint de `routes.py` la invoca (el
// único endpoint `/nomina-completa/cfdi` llama al generador de `dict`, no a
// este). Es la función correcta a portar de todas formas: es la que closes
// el gap real descrito en la auditoría ("generación del XML de nómina"), el
// dict no es XML.
//
// ALCANCE DE ESTE MÓDULO (mismo criterio que packages/billing/src/cfdi/
// issuer.ts y packages/mcp-servers/cfdi/src/adapters/finkok-adapter.ts, ya
// establecido en este repo fusión): genera el XML BIEN FORMADO del
// comprobante + complemento, listo para sellar. Explícitamente FUERA de
// alcance, sin cambios respecto a la nota original de nomina/index.ts:
//   - El SELLADO real (Sello digital con la FIEL/CSD del emisor).
//   - El TIMBRADO ante un PAC (requiere credenciales reales — ver
//     finkok-adapter.ts: sin CSD verificado, nunca se fabrica un timbrado).
//   - RPA a portales SAT/IMSS.
//   - Persistencia de periodos de nómina o de CFDI ya generados.
// Un consumidor de más arriba (fuera de domain-despachos, igual que el resto
// de la arquitectura de este módulo) es responsable de tomar este XML,
// sellarlo con el CSD real del despacho/empresa, y enviarlo a un `CfdiPort`
// (packages/mcp-servers/cfdi) para timbrarlo.
//
// DECISIÓN DE FIDELIDAD (desviación deliberada del original, documentada):
// el Python defaultea `no_certificado` a un número de prueba inventado
// ("30001000000500003416") y `lugar_expedicion`/`domicilio_fiscal` a un CP
// fijo ("06600") cuando no se proveen. Este puerto NO reproduce esos
// defaults fabricados — un número de certificado o un código postal falsos
// en un documento fiscal real son peores que un error explícito: producen un
// XML que APARENTA estar sellado o expedido desde un domicilio que no es el
// real. En su lugar: `noCertificado`/`certificado` quedan vacíos por defecto
// (el llamador los rellena solo si tiene un CSD real verificado) y
// `lugarExpedicion`/`domicilioFiscalReceptor` son OBLIGATORIOS — se lanza
// error si faltan, en vez de inventar un CP. Todo lo demás (estructura del
// XML, atributos, catálogos de percepción/deducción, la fórmula de
// TotalDeducciones, el defecto de FechaPago = FechaInicialPago = primer día
// del mes) se porta 1:1.
import { esRfcValido } from "@atiende/billing";
import { r2 } from "./redondeo.ts";
import type { EmployeePayroll } from "./types.ts";

const CFDI_NS = "http://www.sat.gob.mx/cfd/4";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const NOMINA_NS = "http://www.sat.gob.mx/nomina12";
const XSI_SCHEMA_LOCATION =
  "http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd " +
  "http://www.sat.gob.mx/nomina12 http://www.sat.gob.mx/sitio_internet/cfd/nomina/nomina12.xsd";

export const TIPOS_NOMINA = ["O", "E"] as const;
export type TipoNomina = (typeof TIPOS_NOMINA)[number];

export interface DatosEmisorNominaXml {
  readonly rfc: string;
  readonly nombre: string;
  /** c_RegimenFiscal (Anexo 20) — p. ej. "601" (General de Ley Personas
   * Morales). Obligatorio: a diferencia del original, este puerto no lo
   * defaultea (ver NOTA DE FIDELIDAD de cabecera). */
  readonly regimenFiscal: string;
  /** Código postal (5 dígitos) del domicilio que expide el comprobante.
   * Obligatorio, sin default fabricado. */
  readonly lugarExpedicion: string;
  /** Número de certificado de sello digital (CSD) real del emisor. Vacío por
   * defecto — el sellado real es responsabilidad del llamador (fuera de
   * alcance de este módulo). NUNCA rellenar con un número de prueba. */
  readonly noCertificado?: string;
  /** Certificado (base64) real del CSD del emisor. Vacío por defecto, mismo
   * criterio que `noCertificado`. */
  readonly certificado?: string;
}

export interface DatosReceptorNominaXml {
  readonly rfc: string;
  readonly nombre: string;
  /** c_RegimenFiscal del receptor. Default "605" (Sueldos y Salarios e
   * Ingresos Asimilados a Salarios) — a diferencia de `regimenFiscal` del
   * emisor, este SÍ tiene un default legítimo: es prácticamente el único
   * régimen fiscal posible para un trabajador que recibe un CFDI de nómina
   * (no es un dato fabricado sobre una identidad, es la clasificación fiscal
   * correcta del tipo de ingreso). */
  readonly regimenFiscalReceptor?: string;
  /** Código postal (5 dígitos) del domicilio fiscal registrado del receptor.
   * Obligatorio, sin default fabricado. */
  readonly domicilioFiscalReceptor: string;
}

export interface DatosPeriodoNominaXml {
  readonly year: number;
  readonly month: number;
  /** Días pagados del periodo — se refleja en NumDiasPagados. */
  readonly diasPagados: number;
  /** Default "O" (Ordinaria), igual que el original. */
  readonly tipoNomina?: TipoNomina;
  /** Folio del comprobante. A diferencia del original (que genera un UUID
   * truncado si falta), este puerto lo exige explícito: mantiene el motor
   * puro/determinista (mismo criterio que el resto de packages/domain-
   * despachos/src/nomina — "sin I/O, sin fechas de sistema", ver cabecera de
   * payroll-engine.ts). Generar un folio por defecto (p. ej. con
   * `randomUUID()`) es responsabilidad de la capa que sí hace I/O — la ruta
   * HTTP, igual que `core-auth/middleware.ts` genera IDs de request ahí y no
   * en el dominio. */
  readonly folio: string;
  /** Default "NOM" — es solo la serie/etiqueta de foliación propia del
   * emisor, no un dato fiscal sensible; seguro de defaultear. */
  readonly serie?: string;
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function attrs(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`).join(" ");
}

/** Puerto de `calendar.monthrange(year, month)[1]` — último día del mes,
 * considerando años bisiestos. Cálculo calendárico puro a partir de
 * `year`/`month` explícitos (nunca lee el reloj del sistema). */
function ultimoDiaDelMes(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function requireNoVacio(value: string | undefined, mensaje: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(mensaje);
  return trimmed;
}

/**
 * Genera el XML (SIN sellar) del CFDI 4.0 con el complemento Nómina 1.2 para
 * UN empleado de un periodo ya procesado por `procesarNomina`/
 * `calcularImpuestosNomina` — el SAT exige un CFDI de nómina por empleado
 * por periodo, nunca uno agregado.
 *
 * Reutiliza directamente las cifras YA CALCULADAS de `empleado` (nunca
 * recalcula ISR/IMSS aquí, evitando una segunda fuente de verdad): el
 * concepto "Sueldos, Salarios, Rayas y Jornales" se arma con
 * `salarioBruto + percepciones`, y las deducciones con `taxes.isr`/
 * `taxes.imssObrero` — exactamente el mismo criterio que ya usa
 * `nomina-integracion.e2e.spec.ts` para alimentar `validarCfdiDespachos`
 * (Total del comprobante = percepciones totales; ISR/IMSS del trabajador
 * viven en el complemento, no se restan del Total del comprobante — así
 * emite un CFDI de nómina real).
 *
 * Lanza `Error` con un mensaje claro si falta un campo obligatorio — nunca
 * genera un XML fiscal con datos fabricados/adivinados (ver NOTA DE
 * FIDELIDAD de cabecera del archivo).
 */
export function generarXmlCfdiNomina(empleado: EmployeePayroll, emisor: DatosEmisorNominaXml, receptor: DatosReceptorNominaXml, periodo: DatosPeriodoNominaXml): string {
  const emisorRfc = requireNoVacio(emisor.rfc, "CFDI Nómina: el RFC del emisor es obligatorio.");
  const receptorRfc = requireNoVacio(receptor.rfc, "CFDI Nómina: el RFC del receptor es obligatorio.");
  const emisorNombre = requireNoVacio(emisor.nombre, "CFDI Nómina: el nombre del emisor es obligatorio.");
  const receptorNombre = requireNoVacio(receptor.nombre, "CFDI Nómina: el nombre del receptor es obligatorio.");
  const regimenFiscalEmisor = requireNoVacio(emisor.regimenFiscal, "CFDI Nómina: el régimen fiscal del emisor es obligatorio.");
  const lugarExpedicion = requireNoVacio(emisor.lugarExpedicion, "CFDI Nómina: el lugar de expedición (código postal) del emisor es obligatorio.");
  const domicilioFiscalReceptor = requireNoVacio(receptor.domicilioFiscalReceptor, "CFDI Nómina: el domicilio fiscal (código postal) del receptor es obligatorio.");
  const folio = requireNoVacio(periodo.folio, "CFDI Nómina: el folio es obligatorio.");

  if (!esRfcValido(emisorRfc)) throw new Error(`CFDI Nómina: el RFC del emisor "${emisorRfc}" no tiene un formato válido.`);
  if (!esRfcValido(receptorRfc)) throw new Error(`CFDI Nómina: el RFC del receptor "${receptorRfc}" no tiene un formato válido.`);
  if (!Number.isInteger(periodo.year) || periodo.year < 2000) throw new Error("CFDI Nómina: period.year inválido.");
  if (!Number.isInteger(periodo.month) || periodo.month < 1 || periodo.month > 12) throw new Error("CFDI Nómina: period.month debe estar entre 1 y 12.");
  if (!Number.isFinite(periodo.diasPagados) || periodo.diasPagados <= 0) throw new Error("CFDI Nómina: diasPagados debe ser mayor a 0.");

  const { year, month } = periodo;
  const mm = String(month).padStart(2, "0");
  const dd = String(ultimoDiaDelMes(year, month)).padStart(2, "0");
  const tipoNomina = periodo.tipoNomina ?? "O";
  const serie = periodo.serie ?? "NOM";
  const regimenFiscalReceptor = (receptor.regimenFiscalReceptor ?? "605").trim();

  // Total percibido = base del concepto único "Sueldos, Salarios, Rayas y
  // Jornales" del comprobante. El Total del comprobante NO resta ISR/IMSS
  // del trabajador (esas deducciones viven en el complemento) — mismo
  // criterio ya verificado en nomina-integracion.e2e.spec.ts.
  const subtotal = r2(empleado.salarioBruto + empleado.percepciones);
  const isr = empleado.taxes.isr;
  const imssObrero = empleado.taxes.imssObrero;
  const totalDeducciones = r2(isr + imssObrero);

  const comprobanteAttrs = attrs([
    ["Version", "4.0"],
    ["Serie", serie],
    ["Folio", folio],
    // NOTA DE FIDELIDAD: el original arma `Fecha`/`FechaPago`/
    // `FechaInicialPago` como el PRIMER día del mes (no una fecha de pago
    // real distinta) — se porta tal cual, es una simplificación del
    // original, no un ajuste de este puerto.
    ["Fecha", `${year}-${mm}-01T00:00:00`],
    ["FormaPago", "03"],
    ["NoCertificado", emisor.noCertificado ?? ""],
    ["Certificado", emisor.certificado ?? ""],
    ["SubTotal", fmt2(subtotal)],
    ["Moneda", "MXN"],
    ["Total", fmt2(subtotal)],
    ["TipoDeComprobante", "N"],
    ["MetodoPago", "PUE"],
    ["LugarExpedicion", lugarExpedicion],
    ["xsi:schemaLocation", XSI_SCHEMA_LOCATION],
  ]);

  const emisorAttrs = attrs([
    ["Rfc", emisorRfc],
    ["Nombre", emisorNombre],
    ["RegimenFiscal", regimenFiscalEmisor],
  ]);

  const receptorAttrs = attrs([
    ["Rfc", receptorRfc],
    ["Nombre", receptorNombre],
    ["DomicilioFiscalReceptor", domicilioFiscalReceptor],
    ["RegimenFiscalReceptor", regimenFiscalReceptor],
    ["UsoCFDI", "CN01"],
  ]);

  const nominaAttrs = attrs([
    ["Version", "1.2"],
    ["TipoNomina", tipoNomina],
    ["FechaPago", `${year}-${mm}-01`],
    ["FechaInicialPago", `${year}-${mm}-01`],
    ["FechaFinalPago", `${year}-${mm}-${dd}`],
    ["NumDiasPagados", String(periodo.diasPagados)],
    ["TotalPercepciones", fmt2(subtotal)],
    ["TotalDeducciones", fmt2(totalDeducciones)],
  ]);

  const percepcionesAttrs = attrs([["TotalSueldos", fmt2(subtotal)]]);
  const percepcionAttrs = attrs([
    ["TipoPercepcion", "001"],
    ["Clave", "001"],
    ["Concepto", "Sueldos, Salarios, Rayas y Jornales"],
    ["ImporteGravado", fmt2(subtotal)],
    ["ImporteExento", "0.00"],
  ]);

  let deduccionesBloque = "";
  if (isr > 0 || imssObrero > 0) {
    const deduccionesAttrs = attrs([
      ["TotalOtrasDeducciones", fmt2(imssObrero)],
      ["TotalImpuestosRetenidos", fmt2(isr)],
    ]);
    const nodos: string[] = [];
    if (isr > 0) {
      nodos.push(
        `        <nomina12:Deduccion ${attrs([
          ["TipoDeduccion", "002"],
          ["Clave", "002"],
          ["Concepto", "ISR"],
          ["Importe", fmt2(isr)],
        ])}/>`,
      );
    }
    if (imssObrero > 0) {
      nodos.push(
        `        <nomina12:Deduccion ${attrs([
          ["TipoDeduccion", "001"],
          ["Clave", "001"],
          ["Concepto", "Seguridad social (IMSS)"],
          ["Importe", fmt2(imssObrero)],
        ])}/>`,
      );
    }
    deduccionesBloque = `\n      <nomina12:Deducciones ${deduccionesAttrs}>\n${nodos.join("\n")}\n      </nomina12:Deducciones>`;
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<cfdi:Comprobante xmlns:cfdi="${CFDI_NS}" xmlns:xsi="${XSI_NS}" xmlns:nomina12="${NOMINA_NS}" ${comprobanteAttrs}>`,
    `  <cfdi:Emisor ${emisorAttrs}/>`,
    `  <cfdi:Receptor ${receptorAttrs}/>`,
    `  <cfdi:Complemento>`,
    `    <nomina12:Nomina ${nominaAttrs}>`,
    `      <nomina12:Percepciones ${percepcionesAttrs}>`,
    `        <nomina12:Percepcion ${percepcionAttrs}/>`,
    `      </nomina12:Percepciones>${deduccionesBloque}`,
    `    </nomina12:Nomina>`,
    `  </cfdi:Complemento>`,
    `</cfdi:Comprobante>`,
  ].join("\n");
}
