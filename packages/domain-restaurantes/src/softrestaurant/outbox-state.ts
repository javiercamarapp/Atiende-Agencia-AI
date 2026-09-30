// Maquina de estados PURA del outbox de comandas hacia SoftRestaurant.
//
//   pendiente --(reclamada)--> enviada --(POS crea)-------------> confirmada
//                                 |--(POS no responde, quedan intentos)--> fallida --(reintento)--> enviada
//                                 |--(POS no responde, sin intentos)-----> captura_manual
//                                 `--(POS rechaza: reintentar no sirve)--> captura_manual
//   captura_manual --(staff la captura a mano)--> capturada_manual
//   pendiente/fallida --(staff la captura a mano antes del reintento)--> capturada_manual (corta los reintentos)
//
// REGLA DURA: el agente NUNCA inventa un folio. El unico origen de un folio es la
// respuesta `creada` del POS (estado `confirmada`). En cualquier otro estado la
// respuesta al cliente es "pendiente de confirmar" (`respuestaAgenteComanda`).
import type { ComandaResultado } from "./types.ts";

export const ESTADOS_COMANDA = ["pendiente", "enviada", "confirmada", "fallida", "captura_manual", "capturada_manual"] as const;
export type EstadoComanda = (typeof ESTADOS_COMANDA)[number];

export function esEstadoComanda(value: unknown): value is EstadoComanda {
  return typeof value === "string" && (ESTADOS_COMANDA as readonly string[]).includes(value);
}

/** Estados terminales: nadie los vuelve a tocar. */
export const ESTADOS_TERMINALES: readonly EstadoComanda[] = ["confirmada", "capturada_manual"];

/** Estados que el staff debe atender (la comanda NO esta en el POS ni en camino de estarlo). */
export const ESTADOS_REQUIEREN_ATENCION: readonly EstadoComanda[] = ["captura_manual", "fallida"];

const TRANSICIONES: Readonly<Record<EstadoComanda, readonly EstadoComanda[]>> = {
  pendiente: ["enviada", "capturada_manual"],
  enviada: ["confirmada", "fallida", "captura_manual"],
  confirmada: [],
  fallida: ["enviada", "captura_manual", "capturada_manual"],
  captura_manual: ["capturada_manual"],
  capturada_manual: [],
};

export function puedeTransicionar(desde: EstadoComanda, hacia: EstadoComanda): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export interface PoliticaReintento {
  /** Intentos de envio (incluye el primero) antes de pasar a captura manual. */
  readonly maxIntentos: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** Tiempo tras el cual una fila `enviada` (proceso muerto a medio envio) vuelve a ser reclamable. */
  readonly leaseMs: number;
}

export const POLITICA_REINTENTO_DEFAULT: PoliticaReintento = {
  maxIntentos: 5,
  baseMs: 30_000,
  maxMs: 15 * 60_000,
  leaseMs: 120_000,
};

/** Espera antes del intento N+1 tras fallar el intento N (N >= 1): base * 2^(N-1), con tope. Sin azar: determinista. */
export function backoffMs(intentosRealizados: number, politica: PoliticaReintento = POLITICA_REINTENTO_DEFAULT): number {
  const n = Math.max(1, Math.trunc(intentosRealizados));
  return Math.min(politica.maxMs, politica.baseMs * 2 ** (n - 1));
}

export interface DecisionTransicion {
  readonly estado: EstadoComanda;
  readonly folio: string | null;
  /** Texto corto y SIN datos personales (motivo tecnico) para la columna ultimo_error. */
  readonly ultimoError: string | null;
  /** Fecha del proximo intento (solo estado `fallida`); null en los demas. */
  readonly proximoIntentoEn: Date | null;
  /** true si hay que avisar al staff para captura manual. */
  readonly alertarCapturaManual: boolean;
}

/**
 * Decide el estado al que pasa una fila `enviada` tras la respuesta del POS.
 * `intentosRealizados` ya cuenta el intento que acaba de terminar.
 */
export function decidirTransicion(
  resultado: ComandaResultado,
  intentosRealizados: number,
  ahora: Date,
  politica: PoliticaReintento = POLITICA_REINTENTO_DEFAULT,
): DecisionTransicion {
  if (resultado.status === "creada") {
    return { estado: "confirmada", folio: resultado.folio, ultimoError: null, proximoIntentoEn: null, alertarCapturaManual: false };
  }
  if (resultado.status === "rechazada") {
    // El POS respondio que no: reintentar el mismo payload da el mismo rechazo.
    return {
      estado: "captura_manual",
      folio: null,
      ultimoError: `rechazada:${resultado.motivo}`.slice(0, 200),
      proximoIntentoEn: null,
      alertarCapturaManual: true,
    };
  }
  const error = `no_disponible:${resultado.causa}`;
  if (intentosRealizados >= politica.maxIntentos) {
    return { estado: "captura_manual", folio: null, ultimoError: `${error}:intentos_agotados`, proximoIntentoEn: null, alertarCapturaManual: true };
  }
  return {
    estado: "fallida",
    folio: null,
    ultimoError: error,
    proximoIntentoEn: new Date(ahora.getTime() + backoffMs(intentosRealizados, politica)),
    alertarCapturaManual: false,
  };
}

export interface FilaReclamable {
  readonly estado: EstadoComanda;
  readonly proximoIntentoEn: Date;
  /** Cuando se reclamo por ultima vez (estado `enviada`). */
  readonly reclamadaEn: Date | null;
}

/** true si el worker puede reclamar la fila ahora (nuevo intento, reintento o lease vencido). */
export function estaReclamable(fila: FilaReclamable, ahora: Date, politica: PoliticaReintento = POLITICA_REINTENTO_DEFAULT): boolean {
  if (fila.estado === "pendiente" || fila.estado === "fallida") return fila.proximoIntentoEn.getTime() <= ahora.getTime();
  if (fila.estado === "enviada") {
    return fila.reclamadaEn !== null && fila.reclamadaEn.getTime() + politica.leaseMs <= ahora.getTime();
  }
  return false;
}

export type RespuestaAgenteComanda =
  | { readonly estado: "confirmada"; readonly folio: string; readonly mensaje: string }
  | { readonly estado: "pendiente_de_confirmar"; readonly folio: null; readonly mensaje: string };

export const MENSAJE_PENDIENTE_DE_CONFIRMAR =
  "Su pedido quedo registrado y la sucursal lo esta capturando; le llamamos si hay cualquier detalle.";

/**
 * Lo unico que el agente puede decirle al cliente sobre la comanda. Solo el estado
 * `confirmada` (con folio devuelto por el POS) produce un folio; TODO lo demas
 * (incluidos `fallida`, `captura_manual` y cualquier estado desconocido) produce
 * "pendiente de confirmar" sin folio.
 */
export function respuestaAgenteComanda(fila: { readonly estado: EstadoComanda; readonly folio: string | null } | null): RespuestaAgenteComanda {
  if (fila && fila.estado === "confirmada" && typeof fila.folio === "string" && fila.folio.trim() !== "") {
    return { estado: "confirmada", folio: fila.folio, mensaje: `Quedo registrado en la sucursal, folio ${fila.folio}.` };
  }
  return { estado: "pendiente_de_confirmar", folio: null, mensaje: MENSAJE_PENDIENTE_DE_CONFIRMAR };
}
