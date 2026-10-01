// H-28 -- cliente de la vista de Recepcion (llegadas, salidas, en casa, rack, check-in/out y cambio de habitacion).
// Consume apps/api/src/routes/verticals/hoteles/recepcion.ts. `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export type ReservaEstado = "confirmada" | "check_in" | "en_estancia" | "check_out" | "cerrada";
export type HabitacionEstado = "disponible" | "ocupada" | "sucia" | "fuera_de_servicio" | "mantenimiento";
export type Ocupacion = "ocupada" | "llegada" | "libre";

export const RESERVA_ESTADO_LABELS: Record<ReservaEstado, string> = {
  confirmada: "Por llegar",
  check_in: "Check-in",
  en_estancia: "En casa",
  check_out: "Salio",
  cerrada: "Cerrada",
};

export const HABITACION_ESTADO_LABELS: Record<HabitacionEstado, string> = {
  disponible: "Disponible",
  ocupada: "Ocupada",
  sucia: "Sucia",
  fuera_de_servicio: "Fuera de servicio",
  mantenimiento: "Fuera de orden",
};

export interface Movimiento {
  readonly reservaId: string;
  readonly estado: ReservaEstado;
  readonly huesped: { readonly id: string; readonly nombre: string | null } | null;
  readonly tipoHabitacion: { readonly id: string; readonly nombre: string | null } | null;
  readonly habitacion: { readonly id: string; readonly codigo: string | null } | null;
  readonly entrada: string;
  readonly salida: string;
  readonly noches: number;
  readonly salidaVencida: boolean;
  /** null = la boveda de identidad aun no esta disponible en esta base. */
  readonly identidadRegistrada: boolean | null;
}

export interface RackHabitacion {
  readonly roomId: string;
  readonly codigo: string;
  readonly tipoHabitacionId: string | null;
  readonly tipoHabitacion: string;
  readonly estado: HabitacionEstado;
  readonly limpieza: { readonly tareaId: string; readonly tipo: string; readonly estado: string } | null;
  readonly fueraDeServicio: { readonly motivo: string; readonly regresoEstimado: string | null } | null;
  readonly ocupacion: Ocupacion;
  readonly reserva: { readonly reservaId: string; readonly huesped: string | null; readonly entrada: string; readonly salida: string } | null;
}

export interface Recepcion {
  readonly fecha: string;
  readonly tareasDisponibles: boolean;
  readonly identidadDisponible: boolean;
  readonly resumen: {
    readonly llegadas: number;
    readonly llegadasPendientes: number;
    readonly salidas: number;
    readonly salidasPendientes: number;
    readonly enCasa: number;
    readonly habitacionesLibres: number;
    readonly habitacionesSucias: number;
    readonly habitacionesFueraDeServicio: number;
  };
  readonly llegadas: readonly Movimiento[];
  readonly salidas: readonly Movimiento[];
  readonly enCasa: readonly Movimiento[];
  readonly rack: readonly RackHabitacion[];
}

export interface CheckInResultado {
  readonly id: string;
  readonly estado: string;
  readonly habitacion: { readonly id: string; readonly codigo: string };
  readonly identidadRegistrada: boolean | null;
}
export interface CheckOutResultado {
  readonly id: string;
  readonly estado: string;
  readonly habitacionMarcadaSucia: boolean;
  readonly foliosAbiertos: number;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/recepcion`;

export function fetchRecepcion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha?: string): Promise<Recepcion> {
  return fetchJson<Recepcion>(fetchImpl, `${base(apiBaseUrl, propertyId)}${fecha ? `?fecha=${encodeURIComponent(fecha)}` : ""}`, token);
}

export function checkIn(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string, roomId?: string): Promise<CheckInResultado> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/check-in`, token, "POST", roomId ? { roomId } : {});
}

export function checkOut(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string): Promise<CheckOutResultado> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/check-out`, token, "POST", {});
}

export function cambiarHabitacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  reservaId: string,
  roomId: string,
  motivo?: string,
): Promise<{ readonly roomId: string; readonly habitacionAnteriorId: string | null; readonly habitacionId: string }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/cambiar-habitacion`, token, "POST", motivo ? { roomId, motivo } : { roomId });
}

// Espejo cosmetico de los roles del servidor (domain-hoteles/src/roles.ts): solo oculta botones que el servidor rechazaria
// igual (403), nunca la unica barrera.
export const RECEPCION_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);
export const RECEPCION_OPERATE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk"]);

/** Habitaciones del rack que se pueden ofrecer para una reserva: mismo tipo, libres y listas (disponible, sin ocupante ni
 *  llegada pendiente). El servidor vuelve a validar traslape de fechas; esto solo evita ofrecer lo obvio imposible. */
export function habitacionesCandidatas(rack: readonly RackHabitacion[], tipoHabitacionId: string | null, excluirRoomId: string | null = null): readonly RackHabitacion[] {
  return rack.filter((r) => r.estado === "disponible" && r.ocupacion === "libre" && r.roomId !== excluirRoomId && (tipoHabitacionId === null || r.tipoHabitacionId === tipoHabitacionId));
}
