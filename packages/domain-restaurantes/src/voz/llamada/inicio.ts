// Decision de INICIO de llamada: se evalua antes de abrir la sesion con el proveedor (que es lo que cuesta). Si no pasa, la
// llamada no consume Gemini: se dice el pregrabado y se deja callback (R-12).
import { mensajeSaludoRespaldo, type MensajeId } from "./mensajes.ts";

export interface EntradaInicioLlamada {
  /** `voice_config.habilitado` de la sucursal. */
  readonly habilitado: boolean;
  /** Gasto del mes de la organizacion en voz (micro-USD), ya leido del registro de costos. `null` = no se pudo leer. */
  readonly gastoMesMicroUsd: number | null;
  /** Tope mensual en micro-USD. `null` = sin tope configurado. */
  readonly topeMensualMicroUsd: number | null;
  /** Hora local de Merida (0-23 o "HH:MM") para elegir el saludo pregrabado; sin ella se usa el saludo sin hora. */
  readonly horaLocal?: number | string;
}

export type DecisionInicio =
  | { readonly ok: true }
  | { readonly ok: false; readonly razon: "deshabilitada" | "tope_mensual"; readonly mensaje: MensajeId };

/**
 * `gastoMesMicroUsd` desconocido con tope configurado NO bloquea: fallar abierto en la lectura del gasto es preferible a
 * dejar sin atencion a un restaurante por un fallo del registro de costos (el limite por llamada sigue vigente). El
 * controlador lo registra como evento para que se vea.
 */
export function evaluarInicioLlamada(e: EntradaInicioLlamada): DecisionInicio {
  if (!e.habilitado) return { ok: false, razon: "deshabilitada", mensaje: e.horaLocal === undefined ? "saludo_respaldo" : mensajeSaludoRespaldo(e.horaLocal) };
  if (e.topeMensualMicroUsd !== null && e.gastoMesMicroUsd !== null && e.gastoMesMicroUsd >= e.topeMensualMicroUsd) {
    return { ok: false, razon: "tope_mensual", mensaje: "tope_mensual" };
  }
  return { ok: true };
}
