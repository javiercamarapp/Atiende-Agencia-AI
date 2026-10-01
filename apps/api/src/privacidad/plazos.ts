// Plazos y serializacion de solicitudes ARCO para las vistas de plataforma y por organizacion (PL-13).
// Referencia operativa conservadora (dias de CALENDARIO), NO asesoria legal: 20 dias para responder y 15
// mas para ejecutar, contados desde que la solicitud queda confirmada/recibida (ver docs/PRIVACIDAD-PLATAFORMA.md).
import type { ArcoRequestRow } from "@atiende/db";

export const ARCO_RESPUESTA_DIAS = 20;
export const ARCO_EJECUCION_DIAS = 15;
/** Una solicitud abierta a esta distancia (o menos) de su plazo se marca "por_vencer". */
export const ARCO_POR_VENCER_DIAS = 5;
const DIA_MS = 24 * 60 * 60 * 1000;

export type EstadoPlazo = "vencida" | "por_vencer" | "en_plazo" | "sin_plazo" | "cerrada";

export interface PlazoArco {
  readonly estado: EstadoPlazo;
  /** Dias enteros hacia el plazo relevante (negativo = vencida desde hace N dias). null si no hay plazo. */
  readonly diasRestantes: number | null;
  readonly venceEnMs: number | null;
}

/** Estado del plazo relevante (respuesta si no se ha atendido; ejecucion si esta en proceso). */
export function plazoDe(row: Pick<ArcoRequestRow, "isOpen" | "dueAtMs">, nowMs: number): PlazoArco {
  if (!row.isOpen) return { estado: "cerrada", diasRestantes: null, venceEnMs: null };
  if (row.dueAtMs === null) return { estado: "sin_plazo", diasRestantes: null, venceEnMs: null };
  const restanteMs = row.dueAtMs - nowMs;
  // Dias COMPLETOS hacia el plazo (o transcurridos desde que vencio); medio dia de retraso sigue siendo 0.
  const dias = Math.trunc(restanteMs / DIA_MS) || 0;
  if (restanteMs < 0) return { estado: "vencida", diasRestantes: dias, venceEnMs: row.dueAtMs };
  return { estado: restanteMs <= ARCO_POR_VENCER_DIAS * DIA_MS ? "por_vencer" : "en_plazo", diasRestantes: dias, venceEnMs: row.dueAtMs };
}

/** Referencia corta (8 primeros caracteres del id, mayusculas): mismo criterio que el folio de citas y restaurantes. */
export function referenciaDe(requestId: string): string {
  return requestId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Fila de la API. NUNCA incluye telefono, correo ni nombre del titular (el SQL tampoco los devuelve). */
export function serializarArco(row: ArcoRequestRow, nowMs: number) {
  return {
    ...(row.organizationId ? { organizacionId: row.organizationId, organizacion: row.organizationName } : {}),
    vertical: row.vertical,
    id: row.requestId,
    referencia: referenciaDe(row.requestId),
    derecho: row.rightType,
    canal: row.channel,
    estado: row.statusBucket,
    estadoOriginal: row.nativeStatus,
    abiertaEnMs: row.openedAtMs,
    respuestaVenceEnMs: row.responseDueAtMs,
    ejecucionVenceEnMs: row.executionDueAtMs,
    resueltaEnMs: row.resolvedAtMs,
    abierta: row.isOpen,
    plazo: plazoDe(row, nowMs),
  };
}
