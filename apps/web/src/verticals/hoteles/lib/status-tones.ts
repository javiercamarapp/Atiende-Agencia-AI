// Tablas `estado -> tono` de hoteles para <StatusBadge> de @atiende/ui (PR-6 del plan de
// diseno-ux, F-09): reemplazan las funciones y mapas sueltos `estado -> variant` de Badge
// ("default" | "secondary" | "destructive") de Cfdi/CfdiListado/Housekeeping/Tickets/Reputacion/
// Privacidad/... Un estado que la tabla aun no conoce cae a "neutral" (via `statusTone`) en vez
// de pintarse mal. Solo cambia el tono (color semantico en claro y oscuro); el texto sigue
// siendo la señal accesible y las etiquetas de cada pagina no cambian.
import type { StatusTone } from "@atiende/ui";

/** `cfdi_emision.estado`. */
export const CFDI_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  pendiente: "warning",
  timbrado: "success",
  en_proceso_cancelacion: "warning",
  cancelado: "danger",
  rechazado: "danger",
};

/** Estado de una habitacion en el tablero de housekeeping. */
export const HABITACION_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  sucia: "danger",
  disponible: "success",
};

/** Estado de SLA de un ticket de huesped. */
export const SLA_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  vencido: "danger",
  por_vencer: "warning",
};

/** Sentimiento de una resena. */
export const SENTIMIENTO_TONES: Readonly<Record<string, StatusTone>> = {
  muy_negativo: "danger",
  negativo: "danger",
  positivo: "success",
  muy_positivo: "success",
};

/** Plazo de una solicitud ARCO. */
export const ARCO_PLAZO_TONES: Readonly<Record<string, StatusTone>> = {
  en_plazo: "success",
  por_vencer: "warning",
  vencida: "danger",
  cerrada: "neutral",
};

/** Estado de una alerta de fraude. */
export const FRAUDE_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  pendiente: "warning",
};

/** Estado de una recomendacion de revenue. */
export const RECOMENDACION_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  aplicada: "success",
  descartada: "neutral",
  expirada: "neutral",
};
