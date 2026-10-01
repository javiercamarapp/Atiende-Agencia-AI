// Tablas `estado -> tono` de despachos para <StatusBadge> de @atiende/ui (PR-8 del plan de
// diseno-ux, F-09): reemplazan los mapas `{ variant, className }` con pares de colores crudos
// (bg-green-100 text-green-800 dark:...) de cada pagina. Un estado que la tabla aun no
// conoce cae a "neutral" (via `statusTone`) en vez de pintarse mal. La carga semantica es la
// misma de antes: verde = bien/hecho, ambar = atencion, naranja/rojo = urgente, azul = en curso.
import type { StatusTone } from "@atiende/ui";

type Tabla = Readonly<Record<string, StatusTone>>;

/** Estatus de un periodo de cierre mensual (`ClosePeriod.status`). */
export const PERIODO_STATUS_TONES: Tabla = { open: "info", closed: "success", overdue: "danger" };

/** Estatus de una tarea del cierre mensual (`CloseTask.status`). */
export const TAREA_STATUS_TONES: Tabla = { pending: "neutral", in_progress: "info", blocked: "danger", done: "success", skipped: "neutral" };

/** Nivel de coincidencia de un deposito en la conciliacion bancaria. */
export const NIVEL_COINCIDENCIA_TONES: Tabla = { exacto: "success", fuzzy: "info", multi_linea: "info", llm: "info", manual: "neutral" };

/** Severidad de una alerta de conciliacion. */
export const SEVERIDAD_ALERTA_TONES: Tabla = { info: "info", warning: "warning", critical: "danger" };

/** Estatus de una verificacion de devolucion de IVA (`match` / `mismatch` / `missing`). */
export const ESTATUS_VERIFICACION_TONES: Tabla = { match: "success", mismatch: "danger", missing: "danger" };

/** Estado de un mapeo de la migracion de catalogo. */
export const MIGRACION_ESTADO_TONES: Tabla = { pendiente: "warning", aprobado: "success", rechazado: "danger", editado: "info" };

/** Tipo de coincidencia de un mapeo de la migracion de catalogo. */
export const MIGRACION_MATCH_TONES: Tabla = { exacto: "success", alerta_riesgo: "danger", fuzzy: "warning", sin_match: "neutral" };

/** Prioridad de un vencimiento fiscal. */
export const VENCIMIENTO_PRIORIDAD_TONES: Tabla = { critica: "danger", alta: "warning", media: "warning", baja: "success" };

/** Estado de un vencimiento fiscal. */
export const VENCIMIENTO_ESTADO_TONES: Tabla = { pendiente: "neutral", en_proceso: "info", completado: "success", vencido: "danger", escalado: "warning" };

/** Antiguedad de una cuenta por cobrar (cobranza): verde -> ambar -> rojo conforme envejece. */
export const COBRANZA_BUCKET_TONES: Tabla = { "0-30": "success", "31-60": "warning", "61-90": "warning", "90+": "danger" };

/** Nivel de atencion de un cliente en el tablero del despacho. */
export const NIVEL_ATENCION_TONES: Tabla = { critico: "danger", atencion: "warning", al_corriente: "success", sin_datos: "neutral" };

/** Severidad de una anomalia del tablero: la alta es roja; el resto, neutro (como antes: contorno). */
export const SEVERIDAD_ANOMALIA_TONES: Tabla = { alta: "danger", media: "neutral", baja: "neutral" };

/** Tono de la confianza de una poliza sugerida: ambar si requiere revision, verde si es alta, azul en el resto. */
export function confianzaTone(confidence: number, needsHumanReview: boolean): StatusTone {
  if (needsHumanReview) return "warning";
  return confidence >= 0.85 ? "success" : "info";
}
