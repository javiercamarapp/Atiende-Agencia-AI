// ═══════════════════════════════════════════════════════════════════════════
// REGLAS FISCALES DE HOSPEDAJE — capa propia de domain-hoteles que COMPONE sobre el
// núcleo genérico de CFDI de @atiende/billing en vez de reescribirlo o modificarlo
// (infraestructura compartida y estable, usada/usable por otras verticales) — MISMO
// principio que `packages/domain-despachos/src/cfdi/reglas-fiscales-avanzadas.ts`
// (leído primero como plantilla, ver NOTA DE FIDELIDAD abajo sobre por qué se
// compone distinto).
//
// Puerto de la parte de `hoteles/packages/domain-hotel/src/fiscalHospedaje.ts` (H5,
// REQ-BO-007) específica de UN CFDI de hospedaje individual — computeIsh/computeDsa
// — y de las reglas de `hoteles/apps/api/src/routes/cfdi.ts` (H5, REQ-BO-001/002)
// que decidían RFC receptor/UsoCfdi según extranjero/global y excluían la propina
// del subtotal facturable. Fuera de alcance de este archivo (pertenecen a un futuro
// "declaraciones de hospedaje", análogo a la Fase 4 de despachos, no pedido en esta
// fase): computeIsn (ISN/nómina), computeIsrProvisional, computeDiotTotal,
// computeRetencionPlataformasDigitales — ninguno es específico de UN CFDI, todos
// son cálculos de periodo/declaración sin ruta HTTP ni migración en esta fase.
//
// NOTA DE FIDELIDAD (por qué esto NO llama a `validarCfdi()` completo, a diferencia
// de reglas-fiscales-avanzadas.ts): `validarCfdi()` valida un comprobante YA
// TIMBRADO que se está INGESTANDO (RFC/catálogos/aritmética Y sello digital/
// certificado/folio fiscal — checks que solo tienen sentido sobre el resultado ya
// emitido por un PAC). El CFDI de hospedaje de esta fase es el caso inverso: NUESTRO
// hotel es el EMISOR y esta validación corre ANTES de llamar al `CfdiPort` (para
// nunca timbrar algo mal formado) — en ese momento el folio fiscal/sello/
// certificado del comprobante final SIMPLEMENTE NO EXISTEN TODAVÍA (los devuelve el
// PAC en `CfdiTimbrado`). Forzar `validarCfdi()` aquí habría exigido fabricar esos
// 3 campos con un valor inventado ("true"/"pendiente") — precisamente el tipo de
// dato ficticio que este monorepo prohíbe (ver ADR-007/ADR-011 citados en
// mcp-servers). En vez de eso, se reutilizan las piezas REALES de `@atiende/billing`
// que sí aplican pre-timbrado (`esRfcValido`, catálogos SAT de UsoCfdi/FormaPago/
// MetodoPago/RegimenFiscal) y se implementa aquí la aritmética propia de hospedaje
// (que difiere de la genérica: incluye ISH/DSA, que `validarCfdi()` no conoce).
import { esRfcValido, cfdiCatalogs } from "@atiende/billing";
import type { HallazgoCfdi } from "@atiende/billing";
import { roundCurrency } from "../money.ts";

export const TOLERANCIA = 0.02;

/** RFC genérico para CFDI a público en general (catálogo SAT — Anexo 20). */
export const RFC_PUBLICO_GENERAL = "XAXX010101000";
/** RFC genérico para receptor EXTRANJERO sin RFC mexicano (catálogo SAT — Anexo 20,
 *  regla 2.7.1.26 RMF). H5/REQ-BO-001: un huésped extranjero SIEMPRE se factura con
 *  este RFC, nunca con uno inventado ni con el RFC público general. */
export const RFC_GENERICO_EXTRANJERO = "XEXX010101000";

function r2(n: number): number {
  return roundCurrency(n);
}

// ---------------------------------------------------------------------------
// 1) Resolución de RFC receptor + UsoCfdi — port de la decisión de
// `routes/cfdi.ts::emitirHospedajeSchema`/handler (H5 líneas 193-207): un CFDI de
// hospedaje SIEMPRE cae en uno de tres casos, resueltos ANTES de tocar el PAC.
// ---------------------------------------------------------------------------
export interface ReceptorHospedajeInput {
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  /** Obligatorio salvo esExtranjero/esGlobal. */
  readonly rfcReceptor?: string | null;
  /** Obligatorio salvo esExtranjero/esGlobal. */
  readonly usoCfdi?: string | null;
}

export interface ReceptorHospedajeResult {
  readonly rfcReceptor: string;
  readonly usoCfdi: string;
}

export class ReceptorHospedajeInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceptorHospedajeInvalidoError";
  }
}

export function resolveReceptorHospedaje(input: ReceptorHospedajeInput): ReceptorHospedajeResult {
  if (input.esExtranjero && input.esGlobal) {
    throw new ReceptorHospedajeInvalidoError("Un CFDI no puede ser esExtranjero y esGlobal a la vez.");
  }
  if (input.esExtranjero) return { rfcReceptor: RFC_GENERICO_EXTRANJERO, usoCfdi: "S01" };
  if (input.esGlobal) return { rfcReceptor: RFC_PUBLICO_GENERAL, usoCfdi: "S01" };
  if (!input.rfcReceptor || !input.usoCfdi) {
    throw new ReceptorHospedajeInvalidoError("rfcReceptor y usoCfdi son obligatorios salvo esExtranjero/esGlobal.");
  }
  return { rfcReceptor: input.rfcReceptor, usoCfdi: input.usoCfdi };
}

// ---------------------------------------------------------------------------
// 2) Propina SIEMPRE excluida del CFDI — port de
// `routes/cfdi.ts` (`where folio_id = $1 and concept <> 'propina'`, H5 líneas
// 221-227). Aquí se hace un helper PURO y explícito (en vez de dejarlo implícito en
// un WHERE de SQL) para que la regla sea testeable de forma aislada — la propina no
// es contraprestación de hospedaje/A&B/extras, así que nunca se declara como
// ingreso gravado en el comprobante fiscal.
// ---------------------------------------------------------------------------
export interface CargoFacturable {
  readonly concept: string;
  readonly amount: number;
  readonly taxAmount: number;
  /** `stayDate`/`reversesChargeId` solo se usan para contar noches de hospedaje
   *  reales (DSA es por cuarto-noche, no por cargo) — un reverso de hospedaje NUNCA
   *  cuenta como una noche ocupada. */
  readonly stayDate?: string | null;
  readonly reversesChargeId?: string | null;
}

export interface ResumenCargosFacturables {
  /** Suma de `amount` de todos los cargos facturables (excluida propina). */
  readonly subtotalBase: number;
  /** Suma de `taxAmount` ya cobrado por cargo (IVA + ISH ya incluidos ahí, ver
   *  `folioEngine.ts::computeChargeAmounts`). */
  readonly taxTotal: number;
  /** Noches de hospedaje REALES posteadas (para el cálculo de DSA). */
  readonly hospedajeNights: number;
}

/** Agrega los cargos de un folio para timbrar su CFDI de hospedaje — EXCLUYE
 *  SIEMPRE `concept === 'propina'` del subtotal facturable (regla de negocio, no un
 *  detalle de query): la propina nunca es ingreso gravado del hotel. */
export function summarizeFacturableCharges(charges: readonly CargoFacturable[]): ResumenCargosFacturables {
  let subtotalBase = 0;
  let taxTotal = 0;
  let hospedajeNights = 0;
  for (const charge of charges) {
    if (charge.concept === "propina") continue;
    subtotalBase += charge.amount;
    taxTotal += charge.taxAmount;
    if (charge.concept === "hospedaje" && charge.stayDate != null && charge.reversesChargeId == null) {
      hospedajeNights += 1;
    }
  }
  return { subtotalBase: r2(subtotalBase), taxTotal: r2(taxTotal), hospedajeNights };
}

// ---------------------------------------------------------------------------
// 3) DSA (Derecho de Saneamiento Ambiental) — port literal de
// `fiscalHospedaje.ts::computeDsa`: monto FIJO por cuarto-noche ocupado (no
// porcentual), SIEMPRE parámetro (`perNightAmount`) porque cambia por municipio.
// ---------------------------------------------------------------------------
export function computeDsa(roomNights: number, perNightAmount: number): number {
  if (!Number.isInteger(roomNights) || roomNights < 0) throw new RangeError("roomNights debe ser un entero no negativo.");
  if (perNightAmount < 0) throw new RangeError("perNightAmount no puede ser negativo.");
  return r2(roomNights * perNightAmount);
}

// ---------------------------------------------------------------------------
// 4) Desglose fiscal del CFDI de hospedaje — port literal del cálculo de
// `routes/cfdi.ts` líneas 209-241: el IVA es 16% (o la tasa configurada) de TODO lo
// gravado (incluye penalidad de no-show y A&B/extras); el ISH es lo que sobra de
// `taxTotal` una vez restado ese IVA — por construcción, solo queda ISH ahí cuando
// de verdad hubo un cargo de hospedaje real con ISH incluido (nunca se recalcula
// ISH "desde cero" sobre el subtotal agregado, que sí gravaría A&B con ISH).
// ---------------------------------------------------------------------------
export interface DesgloseCfdiHospedaje {
  readonly netAmount: number;
  readonly ivaAmount: number;
  readonly ishAmount: number;
  /** netAmount + ivaAmount + ishAmount (sin DSA todavía). */
  readonly totalSinDsa: number;
  readonly dsaMonto: number;
  /** totalSinDsa + dsaMonto — el Total real del CFDI. */
  readonly total: number;
}

export function computeCfdiHospedajeBreakdown(input: { resumen: ResumenCargosFacturables; ivaRate: number; dsaPerNight: number }): DesgloseCfdiHospedaje {
  if (!(input.ivaRate >= 0)) throw new RangeError("ivaRate debe ser un número no negativo.");
  const { subtotalBase, taxTotal, hospedajeNights } = input.resumen;
  const ivaAmount = r2(subtotalBase * input.ivaRate);
  const ishAmount = Math.max(0, r2(taxTotal - ivaAmount));
  const totalSinDsa = r2(subtotalBase + ivaAmount + ishAmount);
  const dsaMonto = computeDsa(hospedajeNights, input.dsaPerNight);
  return { netAmount: subtotalBase, ivaAmount, ishAmount, totalSinDsa, dsaMonto, total: r2(totalSinDsa + dsaMonto) };
}

// ---------------------------------------------------------------------------
// 5) CfdiRelacionados tipo 07 (aplicación de anticipo) — mismo patrón que
// despachos valida CfdiRelacionados+TipoRelacion="01" para notas de crédito (tipo
// E). H5/REQ-BO-001 documentaba esto como "PENDIENTE" en el original porque el
// `CfdiPort` de entonces no exponía el campo — el motor de reglas SÍ puede y debe
// validar la relación antes de intentar guardarla (gap que esta fase cierra a
// propósito, ver cabecera del archivo).
// ---------------------------------------------------------------------------
export const TIPO_RELACION_APLICACION_ANTICIPO = "07";

export interface AnticipoRelacionInput {
  readonly esAplicacionAnticipo: boolean;
  readonly cfdiRelacionados?: readonly string[];
  readonly tipoRelacion?: string | null;
}

/** `null` si no aplica (no es aplicación de anticipo) o si la relación es válida;
 *  un `HallazgoCfdi` en caso contrario. */
export function validateAnticipoRelacion(input: AnticipoRelacionInput): HallazgoCfdi | null {
  if (!input.esAplicacionAnticipo) return null;
  const relacionados = input.cfdiRelacionados ?? [];
  if (relacionados.length === 0) {
    return { codigo: "anticipo_sin_relacion", mensaje: "Un CFDI que aplica un anticipo debe referenciar el UUID del CFDI de anticipo en CfdiRelacionados.", ref: "Anexo 20" };
  }
  if (input.tipoRelacion !== TIPO_RELACION_APLICACION_ANTICIPO) {
    return {
      codigo: "tipo_relacion_invalido",
      mensaje: `TipoRelacion='${input.tipoRelacion ?? ""}' inválido para aplicación de anticipo (esperado '${TIPO_RELACION_APLICACION_ANTICIPO}').`,
      ref: "Anexo 20",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6) Validación compuesta del CFDI de hospedaje completo — reutiliza las piezas
// REALES de @atiende/billing (RFC, catálogos SAT) que sí aplican pre-timbrado; NO
// llama a `validarCfdi()` completo (ver NOTA DE FIDELIDAD en la cabecera del
// archivo) y calcula su PROPIA coherencia de total (incluye ISH/DSA, que
// `validarCfdi()` no conoce).
// ---------------------------------------------------------------------------
export interface DatosCfdiHospedaje {
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly usoCfdi: string;
  readonly metodoPago: string;
  readonly regimenFiscalEmisor: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly ishMonto: number;
  readonly dsaMonto: number;
  readonly descuento: number;
  readonly total: number;
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
  readonly esAplicacionAnticipo: boolean;
  readonly cfdiRelacionados?: readonly string[];
  readonly tipoRelacion?: string | null;
}

export interface ResultadoValidacionCfdiHospedaje {
  readonly ok: boolean;
  readonly issues: readonly HallazgoCfdi[];
  readonly warnings: readonly string[];
  readonly checks: { readonly pass: number; readonly fail: number };
}

export function validarCfdiHospedaje(datos: DatosCfdiHospedaje): ResultadoValidacionCfdiHospedaje {
  const issues: HallazgoCfdi[] = [];
  const warnings: string[] = [];
  let pass = 0;
  let fail = 0;
  const failLocal = (codigo: string, mensaje: string, ref?: string) => {
    issues.push({ codigo, mensaje, ref });
    fail += 1;
  };
  const okLocal = () => {
    pass += 1;
  };

  // ---- RFC (pieza real de @atiende/billing, no reescrita) ----
  if (!esRfcValido(datos.rfcEmisor)) failLocal("rfc_emisor_invalido", `RFC emisor inválido: '${datos.rfcEmisor}'`, "CFF art. 29-A");
  else okLocal();
  if (!esRfcValido(datos.rfcReceptor)) failLocal("rfc_receptor_invalido", `RFC receptor inválido: '${datos.rfcReceptor}'`, "CFF art. 29-A");
  else okLocal();

  // ---- Catálogos SAT (piezas reales de @atiende/billing, no reescritas) ----
  // NOTA: no se valida FormaPago aquí -- `CfdiPort.TimbrarInput` (el contrato real
  // del transporte, `@atiende/mcp-cfdi`) NUNCA la incluye, mismo criterio que el
  // original (`fiscalHospedaje.ts`/`routes/cfdi.ts`): un folio de hotel puede
  // liquidarse con VARIOS métodos de pago mezclados (efectivo+tarjeta+transferencia
  // sobre el mismo folio, ver folios.ts), así que "la" FormaPago de UN CFDI agregado
  // no tiene una fuente única confiable -- introducir un valor aquí sería fabricar
  // un dato que el sistema real no conoce, no una validación real.
  if (!cfdiCatalogs.esUsoCfdiValido(datos.usoCfdi)) failLocal("uso_cfdi_invalido", `UsoCFDI '${datos.usoCfdi}' no está en el catálogo SAT.`, "c_UsoCFDI");
  else okLocal();
  if (!cfdiCatalogs.esMetodoPagoValido(datos.metodoPago)) failLocal("metodo_pago_invalido", `MetodoPago '${datos.metodoPago}' no está en el catálogo SAT.`, "c_MetodoPago");
  else okLocal();
  if (!cfdiCatalogs.esRegimenValido(datos.regimenFiscalEmisor)) failLocal("regimen_fiscal_invalido", `RegimenFiscal '${datos.regimenFiscalEmisor}' no está en el catálogo SAT.`, "c_RegimenFiscal");
  else okLocal();

  // ---- Total coherente CON ISH/DSA (la aritmética propia de hospedaje) ----
  const esperado = r2(datos.subtotal + datos.iva + datos.ishMonto + datos.dsaMonto - datos.descuento);
  if (Math.abs(esperado - datos.total) > TOLERANCIA) {
    failLocal("total_incoherente", `SubTotal + IVA + ISH + DSA − Descuento = ${esperado.toFixed(2)} pero Total=${datos.total.toFixed(2)}`, "Anexo 20 / Guia de llenado");
  } else {
    okLocal();
  }

  // ---- RFC genérico correcto según extranjero/global ----
  if (datos.esExtranjero && datos.rfcReceptor !== RFC_GENERICO_EXTRANJERO) {
    failLocal("rfc_extranjero_incorrecto", `Un receptor extranjero debe facturarse con el RFC genérico '${RFC_GENERICO_EXTRANJERO}'.`, "Anexo 20");
  } else if (datos.esExtranjero) {
    okLocal();
  }
  if (datos.esGlobal && datos.rfcReceptor !== RFC_PUBLICO_GENERAL) {
    failLocal("rfc_global_incorrecto", `Un CFDI global a público en general debe usar el RFC '${RFC_PUBLICO_GENERAL}'.`, "Anexo 20");
  } else if (datos.esGlobal) {
    okLocal();
  }

  // ---- CfdiRelacionados tipo 07 para aplicación de anticipo ----
  const anticipoIssue = validateAnticipoRelacion({ esAplicacionAnticipo: datos.esAplicacionAnticipo, cfdiRelacionados: datos.cfdiRelacionados, tipoRelacion: datos.tipoRelacion });
  if (anticipoIssue) {
    issues.push(anticipoIssue);
    fail += 1;
  } else if (datos.esAplicacionAnticipo) {
    okLocal();
  }

  if (datos.esNoShow) {
    warnings.push("CFDI emitido sobre una penalización de no-show (sin estancia real): confirmar que la política de cancelación autoriza cobrarla como contraprestación de hospedaje.");
  }

  return { ok: fail === 0, issues, warnings, checks: { pass, fail } };
}
