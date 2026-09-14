// Tipos base de mensajería con huésped — port de rentas/packages/domain/src/mensajeria/
// tipos.ts (Lote 6, H-056 a H-061). Carpeta exclusiva de este lote, mismo criterio que
// ./pricing/tipos.ts, ./finanzas/tipos.ts: solo tipos + constantes puras, sin I/O.
//
// Fuente de las políticas de canal: docs/investigacion/RV10-mensajes-huesped.md del
// repo origen (no copiado a este monorepo) — cada constante documentaba si su origen
// era [DATO] (fuente primaria verificada), [R] (fuente secundaria de proveedor,
// confianza media-baja) o [E] (supuesto/decisión de producto sin fuente publicada).
// Esa procedencia se preserva textualmente en los comentarios de ./politica.ts.

/** Solo los tres canales para los que el origen documenta mensajería real con
 * huésped — "manual" (rentas.canal, reserva directa) nunca es un canal de
 * mensajería: una reserva directa se atiende por el contacto que el huésped ya dio al
 * crearla, no por un hilo de mensajería de plataforma. */
export const CANALES_MENSAJERIA = ["airbnb", "vrbo", "booking"] as const;
export type CanalMensajeriaCodigo = (typeof CANALES_MENSAJERIA)[number];

export type IdiomaMensaje = "es" | "en";

export type DireccionMensaje = "entrante" | "saliente";

/** `canal`: llegó vía el simulador de canal (sin adaptador real de ningún canal
 * conectado todavía — ver ./canalMensajeria.ts). `manual`: un operador transcribe un
 * mensaje recibido fuera de banda (ej. llamada telefónica) — NUNCA un mensaje que la
 * IA generó y envió por su cuenta: eso no existe en este dominio (ver
 * ./colaAprobacion.ts, `intentarEnvioAutomatico` siempre lanza). */
export type OrigenMensaje = "canal" | "simulador" | "manual";

export type EventoPlantilla = "confirmacion" | "pre_llegada" | "check_in" | "check_out" | "resena";

export type EstadoBorrador = "pendiente_aprobacion" | "aprobado" | "rechazado" | "enviado";

export type SenalEscalamiento = "queja" | "emergencia" | "reembolso" | "vip";

/** Mensaje entrante del huésped tratado SIEMPRE como dato estructurado: ningún campo
 * de esta interfaz se interpreta como instrucción de sistema ni cambia qué funciones
 * puede invocar el generador de borradores (ver ./borrador.ts y
 * ../agentes/generadorBorradorIA.ts). */
export interface MensajeEntradaHuesped {
  readonly texto: string;
  readonly idioma: IdiomaMensaje;
}

/** Contexto de la reserva/propiedad — resuelto por el SERVIDOR desde la
 * conversación/property autenticada, nunca a partir de lo que el huésped escribió en
 * su mensaje. Ninguna función de este paquete acepta `organizationId`/`propertyId`/
 * `huespedId` derivado del texto del huésped. */
export interface ContextoBorrador {
  readonly nombreHuesped: string | null;
  readonly propiedadNombre: string;
  readonly fechaCheckIn: string | null;
  readonly fechaCheckOut: string | null;
  readonly reservaConfirmada: boolean;
  readonly canal: CanalMensajeriaCodigo;
}

export interface ResultadoBorrador {
  readonly texto: string;
  readonly necesitaEscalamiento: boolean;
  readonly senales: readonly SenalEscalamiento[];
  /** `true` cuando el borrador declaró explícitamente "no tengo esta información" en
   * vez de inventar un dato ausente del contexto (nunca "adivinar razonablemente"). */
  readonly datoFaltanteDeclarado: boolean;
}
