// D-P3-22 -- autoaceptado de los XML validos que sube el cliente desde el portal (bandera por cliente `portal_autoaceptar_validos`, ENCENDIDA por omision:
// decision de Javier). Un documento se acepta solo UNICAMENTE si TODO se cumple; cualquier duda lo deja `recibido` para el staff (que ademas recibe el
// aviso `despachos.portal.documento_pendiente`). Puro: sin I/O, sin SAT/PAC. La sesion de sistema no puede leer por RLS, asi que el contexto (bandera,
// ficha, duplicado, periodo cerrado, EFOS, correcciones) lo da la funcion de sistema `system_portal_ingesta_contexto` (migracion 026).
//
// Condiciones: XML CFDI 4.0 tipo I, valido (`ok`), SIN hallazgos ni advertencias; emisor que NO figura como presunto/definitivo en la lista 69-B (y la lista
// existe: "no hay lista" NO es "limpio"); periodo no cerrado; clasificacion contable que pasa la compuerta (o comprobante emitido); bandera encendida.
// Un UUID que ya esta en el cliente se acepta como "ya existia" (sin duplicar). Un REP, una nota de credito, la nomina y todo lo demas se quedan para el staff.
import { CfdiXmlParseError, parseCfdiXml } from "@atiende/billing";
import type { CfdiXmlParseResult } from "@atiende/billing";
import { clasificarCfdi, evaluarCompuertaClasificacion } from "../bookkeeping/clasificacion-cfdi.ts";
import { clasificarDireccionCfdi, impuestosDesdeXml, montosCfdiACentavos, normalizarCamposPagoCfdi } from "../cfdi/modelo-cfdi.ts";
import { validarCfdiDespachos } from "../cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../cfdi/reglas-fiscales-avanzadas.ts";
import type { ContextoIngestaPortal, DatosAceptacionPortal } from "./types.ts";

export type MotivoNoAutoaceptado =
  | "xml_invalido"
  | "tipo_no_automatico"
  | "autoaceptar_apagado"
  | "documento_no_pendiente"
  | "periodo_cerrado"
  | "efos"
  | "efos_lista_no_disponible"
  | "con_hallazgos"
  | "monto_invalido"
  | "clasificacion_dudosa";

const MAX_RENGLONES_IMPUESTO = 50;

export type AnalisisXmlPortal =
  | { readonly ok: true; readonly parsed: CfdiXmlParseResult; readonly folioFiscal: string; readonly fecha: string; readonly rfcEmisor: string }
  | { readonly ok: false; readonly motivo: MotivoNoAutoaceptado };

/** Fase 1 (antes del contexto): lee el XML con el parser endurecido y devuelve lo que la base necesita para armar el contexto. */
export function analizarXmlParaAutoaceptado(xml: string): AnalisisXmlPortal {
  try {
    const parsed = parseCfdiXml(xml);
    if (parsed.tipo !== "I") return { ok: false, motivo: "tipo_no_automatico" };
    return { ok: true, parsed, folioFiscal: parsed.folioFiscal, fecha: parsed.fecha.slice(0, 10), rfcEmisor: parsed.rfcEmisor };
  } catch (err) {
    if (err instanceof CfdiXmlParseError) return { ok: false, motivo: "xml_invalido" };
    return { ok: false, motivo: "xml_invalido" };
  }
}

export type DecisionAutoaceptado = { readonly aceptar: true; readonly datos: DatosAceptacionPortal } | { readonly aceptar: false; readonly motivo: MotivoNoAutoaceptado };

/** Fase 2 (con el contexto de la base): decide y, si procede, arma lo que `system_portal_cfdi_aceptar` ingiere. */
export function decidirAutoaceptado(analisis: Extract<AnalisisXmlPortal, { ok: true }>, contexto: ContextoIngestaPortal): DecisionAutoaceptado {
  const no = (motivo: MotivoNoAutoaceptado): DecisionAutoaceptado => ({ aceptar: false, motivo });
  if (contexto.documentoEstado !== "recibido" || contexto.documentoTipo !== "cfdi_xml") return no("documento_no_pendiente");
  if (!contexto.autoaceptar) return no("autoaceptar_apagado");
  if (contexto.periodoCerrado && !contexto.existe) return no("periodo_cerrado");
  if (contexto.efosSituacion === "presunto" || contexto.efosSituacion === "definitivo") return no("efos");
  if (!contexto.efosListaDisponible) return no("efos_lista_no_disponible");

  const { parsed } = analisis;
  const { impuestos: desglose, ...resto } = parsed;
  const datos: DatosCfdiDespachos = { ...resto, tipo: "I" };
  const resultado = validarCfdiDespachos(datos);
  if (!resultado.ok || resultado.issues.length > 0 || resultado.warnings.length > 0) return no("con_hallazgos");

  let montos: ReturnType<typeof montosCfdiACentavos>;
  try {
    montos = montosCfdiACentavos({ subtotal: datos.subtotal, total: datos.total, descuento: datos.descuento, iva: datos.iva, retencionIsr: datos.retencionIsr, retencionIva: datos.retencionIva, ieps: datos.ieps });
  } catch {
    return no("monto_invalido");
  }
  const pago = normalizarCamposPagoCfdi({ metodoPago: datos.metodoPago, formaPago: datos.formaPago, usoCfdi: datos.usoCfdi, moneda: datos.moneda, tipoCambio: datos.tipoCambio });

  // Clasificacion contable: la misma de la ingesta del staff, con las correcciones del cliente; si dudosa (y no es una venta del cliente), lo ve una persona.
  const direccion = clasificarDireccionCfdi(contexto.fichaRfc, datos.rfcEmisor, datos.rfcReceptor);
  const cls = clasificarCfdi(
    { tipo: "I", direccion, rfcEmisor: datos.rfcEmisor, conceptos: parsed.conceptos.map((c) => ({ descripcion: c.descripcion ?? null, claveProdServ: c.claveProdServ ?? null })) },
    contexto.correcciones.map((c) => ({ rfcEmisor: c.rfcEmisor, claveProdServ: c.claveProdServ, categoria: c.categoria, cuenta: c.cuenta })),
  );
  if (cls && direccion !== "emitido" && evaluarCompuertaClasificacion(cls.confianza, { umbral: contexto.umbral }).requiereRevision) return no("clasificacion_dudosa");

  const invoice: Record<string, unknown> = {
    folio_fiscal: datos.folioFiscal,
    tipo: "I",
    rfc_emisor: datos.rfcEmisor,
    rfc_receptor: datos.rfcReceptor,
    emisor_nombre: datos.emisorNombre ?? null,
    subtotal: datos.subtotal,
    total: datos.total,
    iva: datos.iva ?? null,
    descuento: datos.descuento ?? 0,
    valido: true,
    issues: [],
    warnings: [],
    // La decision humana que la cola de revision pedia (p. ej. "proveedor reportable en DIOT") la sustituye la politica del cliente: encendida por omision.
    requires_human_review: false,
    diot: resultado.diot,
    fecha: analisis.fecha,
    metodo_pago: pago.metodoPago,
    forma_pago: pago.formaPago,
    uso_cfdi: pago.usoCfdi,
    moneda: pago.moneda,
    tipo_cambio: pago.tipoCambio,
    subtotal_centavos: montos.subtotalCentavos,
    descuento_centavos: montos.descuentoCentavos,
    total_centavos: montos.totalCentavos,
    iva_trasladado_centavos: montos.ivaTrasladadoCentavos,
    isr_retenido_centavos: montos.isrRetenidoCentavos,
    iva_retenido_centavos: montos.ivaRetenidoCentavos,
    ieps_centavos: montos.iepsCentavos,
  };
  const impuestos = impuestosDesdeXml(desglose)
    .slice(0, MAX_RENGLONES_IMPUESTO)
    .map((i) => ({ naturaleza: i.naturaleza, impuesto: i.impuesto, tipo_factor: i.tipoFactor, tasa_o_cuota: i.tasaOCuota, base_centavos: i.baseCentavos, importe_centavos: i.importeCentavos }));
  return {
    aceptar: true,
    datos: {
      invoice,
      impuestos,
      clasificacion: cls ? { categoria: cls.categoria, confianza: cls.confianza, method: cls.metodo, razon: cls.razon, cuenta: cls.cuenta, empate: cls.empate } : null,
    },
  };
}
