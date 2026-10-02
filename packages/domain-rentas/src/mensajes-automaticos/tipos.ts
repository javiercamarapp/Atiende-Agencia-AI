// Rn-24 / Rn-25 -- tipos y constantes de los mensajes automaticos por evento. Funciones y
// tipos puros: la persistencia vive en ./repository.ts (migracion rentas 029).
import type { CanalMensajeriaCodigo } from "../mensajeria/tipos.ts";

/** Eventos del ciclo de la reserva que se pueden automatizar (`confirmacion` no: ya la cubre
 *  el correo transaccional de reserva-email-notifications.ts). */
export const EVENTOS_AUTOMATICOS = ["pre_llegada", "check_in", "check_out", "resena"] as const;
export type EventoAutomatico = (typeof EVENTOS_AUTOMATICOS)[number];

export function esEventoAutomatico(valor: unknown): valor is EventoAutomatico {
  return typeof valor === "string" && (EVENTOS_AUTOMATICOS as readonly string[]).includes(valor);
}

/** Ancla de cada evento: la fecha de la reserva (a las 00:00 de la zona de la propiedad) sobre la que se suma el offset. */
export const ANCLA_EVENTO: Readonly<Record<EventoAutomatico, "check_in" | "check_out">> = {
  pre_llegada: "check_in",
  check_in: "check_in",
  check_out: "check_out",
  resena: "check_out",
};

/** Sugerencia inicial que muestra la pantalla (horas respecto al ancla; negativo = antes). No se guarda hasta que el admin la confirma. */
export const OFFSET_HORAS_SUGERIDO: Readonly<Record<EventoAutomatico, number>> = {
  pre_llegada: -48,
  check_in: 10,
  check_out: 8,
  resena: 24,
};

export const OFFSET_HORAS_MIN = -720;
export const OFFSET_HORAS_MAX = 720;
/** Una reserva solo recibe el mensaje mientras `disparo <= ahora < disparo + gracia`: una reserva creada tarde no recibe un "pre-llegada" ya obsoleto. */
export const VENTANA_GRACIA_HORAS = 24;
export const MAX_MENSAJES_POR_CORRIDA = 50;

export interface ProgramacionMensaje {
  readonly propertyId: string;
  readonly evento: EventoAutomatico;
  readonly plantillaId: string;
  readonly offsetHoras: number;
  readonly activo: boolean;
  readonly actualizadoEn: string;
}

export interface EntradaProgramacion {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly evento: EventoAutomatico;
  readonly plantillaId: string;
  readonly offsetHoras: number;
  readonly activo: boolean;
  readonly actorId: string;
}

/** Reserva OTA confirmada cuyo mensaje automatico esta programado y aun no tiene marca. */
export interface CandidatoMensajeAutomatico {
  readonly ocupacionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly evento: EventoAutomatico;
  readonly offsetHoras: number;
  readonly plantillaId: string;
  readonly plantillaCuerpo: string;
  readonly plantillaAprobada: boolean;
  readonly plantillaActiva: boolean;
  readonly canal: CanalMensajeriaCodigo;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
  readonly propiedadNombre: string;
  readonly unidadNombre: string;
  readonly zonaHoraria: string;
}

/** Resultado de una operacion de staff contra una base que puede no tener aun la migracion 029. */
export type ResultadoMensajesAutomaticos<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export interface ResumenMensajesAutomaticos {
  /** `false`: la base aun no tiene la migracion 029 (la corrida no hizo nada). */
  readonly disponible: boolean;
  readonly candidatas: number;
  readonly borradoresCreados: number;
  readonly omitidasVariableFaltante: number;
  /** Otra corrida ya les dejo marca (idempotencia) o la programacion cambio entre listar y crear. */
  readonly yaProcesadas: number;
  readonly fueraDeVentana: number;
  readonly errores: number;
  readonly truncada: boolean;
}
