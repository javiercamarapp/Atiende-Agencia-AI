// ═══════════════════════════════════════════════════════════════════════════
// REGLAS FISCALES AVANZADAS — capa propia de domain-despachos que COMPONE sobre
// `validarCfdi()` de @atiende/billing (6 reglas base: aritmética, subtotal, IVA
// global, catálogos SAT, sello/certificado/folio, RFC) en vez de reescribirla o
// modificar packages/billing (infraestructura compartida y estable — la usan/usarán
// otras verticales para su propio CFDI de cobro SaaS).
//
// Puerto de la parte de
// ~/Desktop/supabase/despachos/b2b_ai/cfdi/validator.py::validate_cfdi que
// packages/billing/src/cfdi/validator.ts NO cubre (ver diseño Fase 1 despachos §2,
// tabla de gaps línea por línea):
//   - Retenciones ISR/IVA restadas del total (líneas 183-196, 304-316)
//   - Fechas: FechaTimbrado anterior a Fecha, warning si el timbrado se retrasa
//     ≥4 días completos (líneas 283-302 — ver NOTA DE FIDELIDAD abajo)
//   - IEPS (warning, declaración separada) (líneas 317-323)
//   - DIOT: proveedores_reportables + flag de revisión humana (líneas 325-339)
//   - Nómina: MetodoPago debe ser PUE, warning si falta TotalPercepciones (341-348)
//   - Notas de crédito (tipo E): exige CfdiRelacionados + TipoRelacion="01" (159-182)
//
// NOTA DE FIDELIDAD (verificada ejecutando el Python real, no asumida — ver
// packages/domain-despachos/tests/fixtures/golden-python-output.json, casos 06/07/08):
// el comentario del origen dice "Regla 2.7.1.35 RMF: plazo de 72 horas", pero el
// código usa `(fecha_timbrado - fecha).days`, que trunca a días COMPLETOS. Un timbrado
// a 72h01m (3 días y 1 minuto) da `.days == 3`, que NO es `> 3`, así que el warning NO
// se dispara pese a exceder 72h nominales — solo se dispara a partir de 4 días
// completos (96h+). Esto es un defecto heredado del original, no una mejora ni un bug
// de la reescritura: se replica EXACTO a propósito (ver diseño Fase 1 §5, punto 4:
// "si el rewrite 'mejora' esto sin que el original lo hiciera, hay que decidirlo
// explícitamente y no como efecto colateral silencioso de traducir el código" — la
// decisión aquí es NO mejorarlo en Fase 1, dejarlo anotado).
// ═══════════════════════════════════════════════════════════════════════════

import { validarCfdi } from "@atiende/billing";
import type { ConceptoCfdi, DatosCfdi, HallazgoCfdi } from "@atiende/billing";

export const TOLERANCIA = 0.02;
// Tolerancia de retenciones: $1.00 (referencial — la tasa de 10%/2-3 es solo un
// supuesto típico de honorarios, no una regla fija; port literal de validator.py
// líneas 191/196: `Decimal("1.00")`).
const TOLERANCIA_RETENCION = 1.0;

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number): string {
  return n.toFixed(2);
}

export interface NominaCfdi {
  readonly totalPercepciones?: number | null;
}

export interface DatosCfdiDespachos extends DatosCfdi {
  /** Retención de ISR (honorarios: típicamente 10% referencial del subtotal). */
  readonly retencionIsr?: number | null;
  /** Retención de IVA (honorarios: típicamente 2/3 del IVA trasladado). */
  readonly retencionIva?: number | null;
  readonly ieps?: number | null;
  /** ISO 8601, naive (sin zona) — igual convención que el parser del origen. */
  readonly fecha?: string | null;
  readonly fechaTimbrado?: string | null;
  /** Solo aplica a tipo="E" (nota de crédito). */
  readonly cfdiRelacionados?: readonly string[];
  readonly tipoRelacion?: string;
  readonly nomina?: NominaCfdi | null;
  readonly emisorNombre?: string;
  /** Tasa de IVA de la factura (0.16 / 0.08 / 0 / etc.) — override explícito para el
   * registro DIOT. Si se omite, se DERIVA de `iva / subtotal` cuando ambos son
   * conocidos (ver Fase 2 §3.1: la agregación DIOT real necesita esta tasa porque
   * decide `tipoOperacion` del renglón agregado — sin ella no se puede agregar). */
  readonly tasaIva?: number | null;
  /** Moneda del CFDI — default "MXN" (Fase 2 §3.1: dato que `agregarDiot` necesita). */
  readonly moneda?: string;
  /** Tipo de cambio a MXN — default 1 (Fase 2 §3.1). */
  readonly tipoCambio?: number;
}

export interface ProveedorReportableDiot {
  readonly rfcProveedor: string;
  readonly nombreProveedor: string;
  readonly totalOperacion: string;
  readonly ivaAcreditable: string;
  readonly periodo: string;
  // ---- Campos añadidos en Fase 2 (aditivo — ver diseño §3.1) ----
  // Sin estos, `agregarDiot()` (declaraciones/diot-aggregate.ts) no puede agrupar: la
  // Fase 1 solo emitía lo que su propio golden-set validaba (issues/warnings/reportable/
  // proveedoresReportables básicos), no lo que la agregación DIOT real necesita por
  // factura. Opcionales para no romper ningún consumidor existente de Fase 1 —
  // `validarCfdiDespachos()` ya los rellena siempre que hay datos suficientes (ver
  // abajo), así que en la práctica están presentes para todo invoice tipo "I".
  /** Tasa de IVA de la factura — decide `tipoOperacion` en la agregación DIOT. */
  readonly tasaIva?: number | null;
  /** Moneda del CFDI (default "MXN" si no se especificó en `datos`). */
  readonly moneda?: string;
  /** Tipo de cambio a MXN (default 1 si no se especificó en `datos`). */
  readonly tipoCambio?: number;
  /** Fecha de emisión completa (ISO), a diferencia de `periodo` (truncado a "YYYY-MM"). */
  readonly fecha?: string | null;
}

export interface DiotResult {
  readonly proveedoresReportables: readonly ProveedorReportableDiot[];
  readonly reportable: boolean;
}

export interface ResultadoValidacionCfdiDespachos {
  readonly ok: boolean;
  readonly issues: readonly HallazgoCfdi[];
  readonly warnings: readonly string[];
  /** Contador diagnóstico agregado (billing + capa avanzada). NO se afirma paridad
   * 1:1 con `checks.pass/fail` del Python original: la composición reatribuye el
   * check de total (billing corre uno sin retenciones; esta capa lo sustituye por el
   * completo cuando hay retenciones) de forma distinta a como el Python cuenta un
   * único check unificado — el golden-set (ver tests/) compara `issues`/`warnings`/
   * `diot`/`requiresHumanReview` campo por campo, no este contador. */
  readonly checks: { readonly pass: number; readonly fail: number };
  readonly diot: DiotResult;
  readonly requiresHumanReview: boolean;
  readonly referenceNotes: readonly string[];
}

/** YYYY-MM-DDTHH:mm:ss (con o sin milisegundos/Z) parseado como fecha NAIVE — igual
 * que `_parse_fecha` del origen (strptime sin timezone): construimos con Date.UTC
 * para que la resta de dos fechas naive dé el mismo delta sin importar el huso
 * horario de la máquina que ejecuta el proceso. */
function parseFechaNaive(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
}

function toBillingConceptos(conceptos: readonly ConceptoCfdi[]): ConceptoCfdi[] {
  return conceptos.map((c) => ({ cantidad: c.cantidad, valorUnitario: c.valorUnitario, importe: c.importe }));
}

export function validarCfdiDespachos(datos: DatosCfdiDespachos): ResultadoValidacionCfdiDespachos {
  // ---- 1-6: reglas base, compuestas sin tocar packages/billing ----
  const baseResult = validarCfdi({ ...datos, conceptos: toBillingConceptos(datos.conceptos) });

  const issues: HallazgoCfdi[] = [];
  const warnings: string[] = [...baseResult.warnings];
  let pass = baseResult.checks.pass;
  let fail = 0;

  const tieneRetenciones = datos.retencionIsr != null || datos.retencionIva != null;
  const retencionIsr = datos.retencionIsr ?? 0;
  const retencionIva = datos.retencionIva ?? 0;
  const descuento = datos.descuento ?? 0;
  const iva = datos.iva ?? null;

  for (const issue of baseResult.issues) {
    // El check de total de billing NO conoce retenciones (formula sin retención) —
    // cuando el CFDI SÍ declara retenciones, ese check produciría un falso positivo
    // (o un falso negativo si por coincidencia igual cuadrara); lo sustituimos abajo
    // por la fórmula completa (subtotal + IVA − descuento − retenciones), igual que
    // el original hace en un solo check unificado (validator.py líneas 176-196).
    if (issue.codigo === "total_incoherente" && tieneRetenciones) continue;
    issues.push(issue);
    fail += 1;
  }

  const failLocal = (codigo: string, mensaje: string, ref?: string) => {
    issues.push({ codigo, mensaje, ref });
    fail += 1;
  };
  const okLocal = () => {
    pass += 1;
  };

  // ---- Notas de crédito (tipo E): CfdiRelacionados + TipoRelacion ----
  // Port literal de validator.py líneas 159-182 — corre ANTES del check de total en
  // el original; el orden no afecta el resultado (issues/warnings se comparan como
  // conjunto, no por posición — ver golden-set).
  if (datos.tipo === "E") {
    const relacionados = datos.cfdiRelacionados ?? [];
    const tipoRelacion = datos.tipoRelacion ?? "";
    if (relacionados.length === 0) {
      failLocal("nota_credito_sin_relacion", "Nota de crédito (tipo E) sin CfdiRelacionados. Debe referenciar al menos un UUID (Anexo 20).", "Anexo 20");
    } else if (tipoRelacion !== "01" && tipoRelacion !== "") {
      warnings.push(`Nota de crédito con TipoRelacion='${tipoRelacion}' (esperado '01' — Nota de crédito).`);
    } else if (tipoRelacion === "01" && relacionados.length > 0) {
      okLocal();
    }
    if (!tipoRelacion && relacionados.length > 0) {
      failLocal("tipo_relacion_faltante", "TipoRelacion es obligatorio para notas de crédito (tipo E).", "Anexo 20");
    }
  }

  // ---- Total coherente, reemplazando el check base cuando hay retenciones ----
  if (tieneRetenciones) {
    const retTot = retencionIsr + retencionIva;
    const esperado = r2(datos.subtotal + (iva ?? 0) - descuento - retTot);
    if (Math.abs(esperado - datos.total) > TOLERANCIA) {
      if (datos.tipo === "E" && datos.total === 0) {
        okLocal();
      } else {
        failLocal(
          "total_incoherente",
          `SubTotal + IVA − Descuento − Retenciones = ${money(esperado)} pero Total=${money(datos.total)}`,
          "Anexo 20 / Guia de llenado",
        );
      }
    } else {
      okLocal();
    }
  }

  // ---- Fechas (validator.py líneas 283-302) ----
  const fEmi = parseFechaNaive(datos.fecha);
  const fTimb = parseFechaNaive(datos.fechaTimbrado);
  if (datos.fecha !== undefined) {
    if (fEmi === null) {
      failLocal("fecha_invalida", `Fecha de emisión inválida: '${datos.fecha}'`);
    } else {
      okLocal();
    }
  }
  if (fTimb !== null && fEmi !== null && fTimb < fEmi) {
    failLocal("fecha_timbrado_anterior", "FechaTimbrado es anterior a la fecha de emisión.", "Anexo 20");
  } else if (fTimb !== null && fEmi !== null) {
    // Truncamiento a días completos — ver NOTA DE FIDELIDAD en la cabecera del
    // archivo: NO es un umbral de 72h exactas pese al comentario del origen.
    const diasCompletos = Math.floor((fTimb - fEmi) / 86_400_000);
    if (diasCompletos > 3) {
      warnings.push(`CFDI timbrado ${diasCompletos} días después de emisión (Regla 2.7.1.35 RMF: plazo de 72 horas).`);
    }
    okLocal();
  } else if (datos.fecha !== undefined && fTimb === null) {
    warnings.push("Sin TimbreFiscalDigital (comprobante no timbrado).");
  }

  // ---- Retenciones: warnings de desviación (validator.py líneas 283-302... 8) ----
  if (datos.retencionIsr != null && datos.subtotal) {
    const esperado = r2(datos.subtotal * 0.1);
    if (Math.abs(datos.retencionIsr - esperado) > TOLERANCIA_RETENCION) {
      warnings.push(`Retención ISR ${money(datos.retencionIsr)} no coincide con 10% referencial (${money(esperado)}); revisar caso.`);
    }
  }
  if (datos.retencionIva != null && iva) {
    const esperado = r2(iva * 0.6667);
    if (Math.abs(datos.retencionIva - esperado) > TOLERANCIA_RETENCION) {
      warnings.push(`Retención IVA ${money(datos.retencionIva)} no coincide con 2/3 del IVA (${money(esperado)}); revisar caso.`);
    }
  }

  // ---- IEPS (warning) ----
  if (datos.ieps != null && datos.ieps > 0) {
    warnings.push(`CFDI contiene IEPS (${money(datos.ieps)}). El IEPS requiere declaración separada (Art. 2 Ley IEPS). La DIOT solo reporta IVA.`);
  }

  // ---- DIOT: proveedores reportables (validator.py líneas 325-339) ----
  const referenceNotes: string[] = [];
  const proveedoresReportables: ProveedorReportableDiot[] = [];
  let diotReportable = false;
  if (datos.tipo === "I" && datos.subtotal > 0) {
    diotReportable = true;
    // tasaIva: override explícito si vino en `datos`, si no se DERIVA de iva/subtotal
    // (ver Fase 2 §3.1) — sin esto `agregarDiot()` no puede decidir tipoOperacion.
    const tasaIvaEfectiva = datos.tasaIva ?? (iva != null && datos.subtotal > 0 ? r2(iva / datos.subtotal) : null);
    proveedoresReportables.push({
      rfcProveedor: datos.rfcEmisor ?? "",
      nombreProveedor: datos.emisorNombre ?? "",
      totalOperacion: money(datos.total || datos.subtotal),
      ivaAcreditable: iva ? money(iva) : "0",
      periodo: fEmi !== null ? isoFromUtc(fEmi).slice(0, 7) : "",
      tasaIva: tasaIvaEfectiva,
      moneda: datos.moneda ?? "MXN",
      tipoCambio: datos.tipoCambio ?? 1,
      fecha: datos.fecha ?? null,
    });
    if (iva && iva > 0) {
      referenceNotes.push("Proveedor reportable en DIOT (art. 32 LISR, art. 31 LIVA). Requiere revisión humana antes de presentar.");
    }
  }

  // ---- Nómina (validator.py líneas 341-348) ----
  // NOTA DE FIDELIDAD (verificada, ver golden-set caso 11): el original hace
  // `if nomina:` sobre un dict Python, que es FALSO para un dict VACÍO (`{}`) — un
  // `nomina={}` NO dispara ni el check de MetodoPago ni el warning de
  // TotalPercepciones. Pero el flag `requires_human_review` usa
  // `nomina is not None` (no la misma verdad-dad), que SÍ es verdadero para `{}`. Un
  // objeto JS `{}` es siempre truthy (a diferencia de un dict Python vacío), así que
  // replicamos la semántica exacta con dos condiciones separadas en vez de un solo
  // `if (datos.nomina)` ingenuo, que habría corrido el bloque interno de más.
  const nominaPresente = datos.nomina != null; // Python: `nomina is not None`
  const nominaConDatos = datos.nomina != null && Object.keys(datos.nomina).length > 0; // Python: `if nomina:`
  if (nominaConDatos) {
    if (datos.metodoPago !== "PUE") {
      failLocal("nomina_metodo_pago", "El CFDI de nómina debe usar MetodoPago PUE.", "Complemento de Nomina 1.2");
    }
    if (datos.nomina!.totalPercepciones == null) {
      warnings.push("Nómina sin TotalPercepciones declarado.");
    }
  }

  const requiresHumanReview = issues.length > 0 || diotReportable || nominaPresente || datos.tipo === "E" || datos.tipo === "P";

  return {
    ok: fail === 0,
    issues,
    warnings,
    checks: { pass, fail },
    diot: { proveedoresReportables, reportable: diotReportable },
    requiresHumanReview,
    referenceNotes,
  };
}

function isoFromUtc(ms: number): string {
  return new Date(ms).toISOString();
}

export { esDiotTipoOperacionValido } from "./catalogs-avanzados.ts";
