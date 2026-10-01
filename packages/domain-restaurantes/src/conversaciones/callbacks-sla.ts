// SLA simple de la bandeja de callbacks (R-12): tiempo hasta el PRIMER contacto (que alguien tome el callback, registre
// un intento o lo resuelva). No hay columna: se calcula con `createdAt`, `tomadoAt` y `resueltoAt`. Una persona con
// permiso puede ajustar los objetivos aqui sin migrar nada.
import type { CallbackEstado } from "./types.ts";

/** Objetivo general: una hora. */
export const SLA_CALLBACK_MIN_GENERAL = 60;
/** Motivos de escalacion urgentes (el cliente espera ya): quince minutos. */
export const SLA_CALLBACK_MIN_URGENTE = 15;
const MOTIVOS_URGENTES: ReadonlySet<string> = new Set(["escalada:queja", "escalada:alergia_salud", "escalada:urgencia", "escalada:cobro_duplicado"]);
/** Cuando queda menos de este porcentaje del objetivo sin que nadie contacte, el callback esta "por vencer". */
const POR_VENCER_FRACCION = 0.25;

export type SlaCallbackEstado = "en_plazo" | "por_vencer" | "vencido" | "cumplido" | "incumplido" | "sin_dato";

export interface SlaCallback {
  readonly objetivoMin: number;
  readonly venceAt: string;
  readonly estado: SlaCallbackEstado;
  /** Minutos que faltan (negativo si ya vencio) mientras nadie lo ha contactado; `null` si ya hubo contacto. */
  readonly minutosRestantes: number | null;
}

export interface SlaCallbackEntrada {
  readonly reason: string | null;
  readonly createdAt: string;
  readonly estado: CallbackEstado;
  readonly tomadoAt?: string | null;
  readonly resueltoAt?: string | null;
}

export function objetivoSlaCallbackMin(reason: string | null): number {
  return reason !== null && MOTIVOS_URGENTES.has(reason) ? SLA_CALLBACK_MIN_URGENTE : SLA_CALLBACK_MIN_GENERAL;
}

export function calcularSlaCallback(cb: SlaCallbackEntrada, now: Date): SlaCallback {
  const objetivoMin = objetivoSlaCallbackMin(cb.reason);
  const creado = new Date(cb.createdAt).getTime();
  const vence = creado + objetivoMin * 60_000;
  const venceAt = new Date(vence).toISOString();
  const primerContacto = [cb.tomadoAt, cb.resueltoAt]
    .filter((v): v is string => typeof v === "string")
    .map((v) => new Date(v).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  if (primerContacto !== undefined) {
    return { objetivoMin, venceAt, estado: primerContacto <= vence ? "cumplido" : "incumplido", minutosRestantes: null };
  }
  // Un callback historico resuelto antes de la migracion 033 no guardo cuando se atendio: no se inventa.
  if (cb.estado === "resuelto") return { objetivoMin, venceAt, estado: "sin_dato", minutosRestantes: null };
  const restante = Math.floor((vence - now.getTime()) / 60_000);
  const estado: SlaCallbackEstado = now.getTime() > vence ? "vencido" : vence - now.getTime() <= objetivoMin * 60_000 * POR_VENCER_FRACCION ? "por_vencer" : "en_plazo";
  return { objetivoMin, venceAt, estado, minutosRestantes: restante };
}
