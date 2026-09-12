// Puerto de `b2b_ai/features/reconciliacion_ingresos_egresos/classification_rules.py`
// + partes de `service.py` — clasificación automática de depósitos bancarios para
// efectos de presunción de ingresos (CFF Art. 59 fr. III): distingue ingreso gravable
// real de financiamiento/aportación de socio/garantía (NO gravables, pero que el SAT
// puede presumir como ingreso si el contribuyente no los desvirtúa con documentación).
// 100% lógica pura, sin llamadas externas.

export type ClasificacionDeposito = "ingreso" | "financiamiento" | "aportacion_socio" | "garantia" | "otro_no_gravable";

/** Mismo set en dos nombres en el origen (`CLASIFICACIONES_NO_TRIVIALES` en
 * service.py y `CLASIFICACIONES_REQUIEREN_DOCUMENTO_SOPORTE` en models.py,
 * duplicado — DRY roto documentado, no replicado: aquí es una sola constante). */
export const CLASIFICACIONES_REQUIEREN_DOCUMENTO_SOPORTE: readonly ClasificacionDeposito[] = ["financiamiento", "aportacion_socio", "garantia"];

/** Umbral bajo el cual una clasificación se marca sospechosa/requiere revisión
 * humana — REQ-IVA, `UMBRAL_CONFIANZA_SOSPECHOSA` en el origen. */
export const UMBRAL_CONFIANZA_SOSPECHOSA = 0.7;

export const NOTA_ART_59_FR_III_CFF = "Art. 59 fr. III CFF exige facultades de comprobación previas (PRODECON 1/2026)";

export interface ResultadoClasificacionDeposito {
  readonly clasificacion: ClasificacionDeposito;
  readonly confidence: number;
  readonly articuloCff: string | null;
  readonly requiresHumanReview: boolean;
}

interface ReglaClasificacion {
  readonly clasificacion: ClasificacionDeposito;
  readonly confidence: number;
  readonly articuloCff: string;
  readonly patron: RegExp;
}

// Orden de evaluación EXACTO del origen — primera regla que matchea gana (no hay
// scoring comparativo entre reglas). Los patrones se aplican sobre
// `(descripcion + " " + referencia)` en MAYÚSCULAS.
const REGLAS: readonly ReglaClasificacion[] = [
  {
    clasificacion: "ingreso",
    confidence: 0.95,
    articuloCff: "CFF Art. 14, LIVA Art. 1",
    patron: /CFDI|UUID|FACTURA|FACT\.|FAC|INV\.|INVOICE|TIMBR/,
  },
  {
    clasificacion: "financiamiento",
    confidence: 0.85,
    articuloCff: "CFF Art. 59 fr. III",
    patron: /PR[ÉE]STAMO|FINANCIAMIENTO|CREDITO|CR[ÉE]DITO|LOAN|BANCO.*DEPOSITO|DEPOSITO.*BANC|CAPITAL.*TRABAJO|LINEA.*CREDITO/,
  },
  {
    clasificacion: "aportacion_socio",
    confidence: 0.9,
    articuloCff: "CFF Art. 59 fr. III",
    patron: /APORTACI[ÓO]N|SOCIO|CAPITAL.*SOCIAL|CONTRIBUCI[ÓO]N.*SOCIO/,
  },
  {
    clasificacion: "garantia",
    confidence: 0.85,
    articuloCff: "CFF Art. 59 fr. III",
    patron: /GARANT[ÍI]A|DEP[ÓO]SITO.*GARANT|COLATERAL|FIANZA|AVAL|SEGURO.*DEP[ÓO]SITO/,
  },
];

/**
 * `clasificar_deposito` (reglas puras — sin el chequeo contra auxiliares contables
 * por número de cuenta, que requiere el catálogo del cliente; ver
 * `clasificarDepositoConAuxiliar` para esa variante si se necesita).
 */
export function clasificarDeposito(descripcion: string, referencia: string | null = null): ResultadoClasificacionDeposito {
  const texto = `${descripcion} ${referencia ?? ""}`.toUpperCase();

  for (const regla of REGLAS) {
    if (regla.patron.test(texto)) {
      return {
        clasificacion: regla.clasificacion,
        confidence: regla.confidence,
        articuloCff: regla.articuloCff,
        // Nota de fidelidad: el origen hardcodea el literal 0.7 en `service.py`
        // (`clasificar_deposito`) en vez de referenciar
        // `UMBRAL_CONFIANZA_SOSPECHOSA` (mismo valor hoy, DRY roto documentado) —
        // aquí SÍ se referencia la misma constante en ambos lugares.
        requiresHumanReview: regla.confidence < UMBRAL_CONFIANZA_SOSPECHOSA,
      };
    }
  }

  return {
    clasificacion: "otro_no_gravable",
    confidence: 0.5,
    articuloCff: null,
    requiresHumanReview: true,
  };
}

/** `puede_persistirse`/`assert_puede_persistirse` — una clasificación no trivial
 * (financiamiento/aportación/garantía) no puede persistirse/exportarse sin
 * documento de soporte (REQ-IVA-002/003). */
export function puedePersistirseClasificacion(clasificacion: ClasificacionDeposito, documentoSoporteId: string | null): boolean {
  if (!CLASIFICACIONES_REQUIEREN_DOCUMENTO_SOPORTE.includes(clasificacion)) return true;
  return documentoSoporteId !== null && documentoSoporteId.trim().length > 0;
}

export interface CasoDepositoSospechoso {
  readonly esSospechoso: boolean;
  readonly nota: string | null;
}

/**
 * `evaluar_caso_deposito_sospechoso` — por diseño del origen (sin valor de rechazo
 * en el enum de estado), el sistema NUNCA puede negar automáticamente una
 * devolución de IVA por esto: solo marca "requiere revisión humana" con la nota
 * legal exacta. `bajoPresuncionArt59` = la clasificación es una de las 3 no
 * triviales.
 */
export function evaluarCasoDepositoSospechoso(clasificacion: ClasificacionDeposito, documentoSoporteId: string | null, confidence: number): CasoDepositoSospechoso {
  const bajoPresuncionArt59 = CLASIFICACIONES_REQUIEREN_DOCUMENTO_SOPORTE.includes(clasificacion);
  const sinDocumentoSoporte = documentoSoporteId === null || documentoSoporteId.trim().length === 0;
  const esSospechoso = bajoPresuncionArt59 && (sinDocumentoSoporte || confidence < UMBRAL_CONFIANZA_SOSPECHOSA);
  return { esSospechoso, nota: esSospechoso ? NOTA_ART_59_FR_III_CFF : null };
}

/** `calcular_balance_iva` — fórmulas exactas del origen (incluida la redundancia
 * documentada: `ivaAcreditable`/`saldoFavor` son la misma fórmula calculada dos
 * veces en el origen; aquí se calcula una sola vez y se expone en ambos campos). */
export interface BalanceIva {
  readonly ivaAcreditable: number;
  readonly saldoFavor: number;
  readonly saldoContra: number;
  readonly discrepancia: number;
}

export function calcularBalanceIva(ivaPagado: number, ivaCobrado: number, declarado: number): BalanceIva {
  const favor = Math.max(0, ivaPagado - ivaCobrado);
  const contra = Math.max(0, ivaCobrado - ivaPagado);
  const discrepancia = Math.abs(ivaCobrado - ivaPagado - declarado);
  return { ivaAcreditable: favor, saldoFavor: favor, saldoContra: contra, discrepancia };
}
