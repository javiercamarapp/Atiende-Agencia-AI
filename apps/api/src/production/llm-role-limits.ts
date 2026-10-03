// Tope DIARIO por defecto de turnos LLM por rol (CHAT-07). Un "turno" es una llamada al gateway (`complete()`): una pregunta del
// Copiloto usa dos (elegir herramienta y redactar) y una tercera si la guardia de cifras pide el reintento. Cada organizacion puede
// tener un tope propio por rol (`PUT /superadmin/gasto-api/organizaciones/:id/topes-rol`); sin fila propia manda este default.
// Los roles que no aparecen aqui (agentes de WhatsApp, extraccion de requisitos...) NO tienen tope diario: su gasto lo acotan el
// presupuesto por corrida/dia del gateway y el tope mensual.
import { COMPACTACION_HISTORIAL_ROLE, COMPUERTA_ESCALAMIENTO_ROLE, ENRUTADOR_TURNO_ROLE, TITULOS_RESUMENES_ROLE } from "./llm-models.ts";

/** Llamadas por dia de un rol `<vertical>:data_chat` (unas 200 preguntas). */
export const DEFAULT_DATA_CHAT_DAILY_TURNS = 400;
/** Reintentos por guardia de cifras de un rol `<vertical>:data_chat_retry`. */
export const DEFAULT_DATA_CHAT_RETRY_DAILY_TURNS = 100;
/** Cada rol de reporte PDF (`reportes:*`). */
export const DEFAULT_REPORTE_DAILY_TURNS = 40;

const FIXED_DEFAULTS: Readonly<Record<string, number>> = {
  [ENRUTADOR_TURNO_ROLE]: 600,
  [COMPUERTA_ESCALAMIENTO_ROLE]: 300,
  [TITULOS_RESUMENES_ROLE]: 300,
  [COMPACTACION_HISTORIAL_ROLE]: 150,
};

/** Tope diario por defecto de `role`; `undefined` = el rol no tiene tope diario. */
export function defaultRoleDailyTurnLimit(role: string): number | undefined {
  const fijo = FIXED_DEFAULTS[role];
  if (fijo !== undefined) return fijo;
  if (/:data_chat$/.test(role)) return DEFAULT_DATA_CHAT_DAILY_TURNS;
  if (/:data_chat_retry$/.test(role)) return DEFAULT_DATA_CHAT_RETRY_DAILY_TURNS;
  if (role.startsWith("reportes:")) return DEFAULT_REPORTE_DAILY_TURNS;
  return undefined;
}
