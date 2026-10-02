// Rn-07 -- solicitudes ARCO propias de rentas (migracion 028, rentas.arco_solicitud). El admin de la gestora registra
// la solicitud que el titular le hace por correo, telefono o en persona y la mueve de estado; la base calcula los plazos.
// Documentacion operativa, NO asesoria legal: 20 dias para responder y 15 mas para ejecutar (de calendario), la misma
// referencia de docs/PRIVACIDAD-PLATAFORMA.md.

export const ARCO_DERECHOS = ["acceso", "rectificacion", "cancelacion", "oposicion"] as const;
export type ArcoDerecho = (typeof ARCO_DERECHOS)[number];

export const ARCO_CANALES = ["correo", "telefono", "presencial", "otro"] as const;
export type ArcoCanal = (typeof ARCO_CANALES)[number];

export const ARCO_ESTADOS = ["recibida", "en_proceso", "bloqueada", "resuelta", "rechazada"] as const;
export type ArcoEstado = (typeof ARCO_ESTADOS)[number];

/** Estados a los que el staff puede mover una solicitud (espeja rentas.arco_cambiar_estado). */
export const ARCO_ESTADOS_DESTINO = ["en_proceso", "bloqueada", "resuelta", "rechazada"] as const;
export type ArcoEstadoDestino = (typeof ARCO_ESTADOS_DESTINO)[number];

export const ARCO_ESTADOS_ABIERTOS: readonly ArcoEstado[] = ["recibida", "en_proceso", "bloqueada"];
export const ARCO_PLAZO_RESPUESTA_DIAS = 20;
export const ARCO_PLAZO_EJECUCION_DIAS = 15;
/** La fecha de recepcion no puede ser anterior a esta cantidad de dias (la base lo vuelve a exigir). */
export const ARCO_RECEPCION_MAX_DIAS_ATRAS = 60;

export interface SolicitudArco {
  readonly id: string;
  readonly derecho: ArcoDerecho;
  readonly canal: ArcoCanal;
  readonly estado: ArcoEstado;
  readonly solicitanteNombre: string;
  readonly solicitanteContacto: string;
  readonly detalle: string | null;
  readonly recibidaEn: string;
  readonly respuestaVenceEn: string;
  readonly ejecucionVenceEn: string;
  readonly resueltaEn: string | null;
  readonly notaResolucion: string | null;
  readonly atendidaPor: string | null;
}

export interface EventoArco {
  readonly id: string;
  readonly solicitudId: string;
  readonly evento: "registrada" | "cambio_estado";
  readonly desde: string | null;
  readonly hacia: string;
  readonly nota: string | null;
  readonly actorId: string | null;
  readonly creadoEn: string;
}

export interface EntradaSolicitudArco {
  readonly derecho: ArcoDerecho;
  readonly canal: ArcoCanal;
  readonly solicitanteNombre: string;
  readonly solicitanteContacto: string;
  readonly detalle: string | null;
  /** ISO; `null` = ahora. */
  readonly recibidaEn: string | null;
}

export interface FiltroSolicitudesArco {
  readonly estado?: ArcoEstado | null;
  readonly derecho?: ArcoDerecho | null;
}

export interface PaginaSolicitudesArco {
  readonly disponible: boolean;
  readonly total: number;
  readonly items: readonly SolicitudArco[];
  readonly nextOffset: number | null;
}

export type ResultadoRegistroArco =
  | { readonly outcome: "created" | "existing"; readonly id: string }
  | { readonly outcome: "forbidden" | "invalid_input" | "unavailable" };

export type ResultadoCambioEstadoArco =
  | { readonly outcome: "updated"; readonly id: string; readonly estado: ArcoEstado }
  | { readonly outcome: "not_found" | "invalid_transition" | "invalid_input" | "forbidden" | "unavailable" };

export type PlazoArco = "en_plazo" | "por_vencer" | "vencida" | "cerrada";
const POR_VENCER_MS = 5 * 24 * 3600 * 1000;

/** Plazo relevante: sin atender -> fecha de respuesta; en proceso o bloqueada -> fecha de ejecucion. */
export function plazoArco(s: Pick<SolicitudArco, "estado" | "respuestaVenceEn" | "ejecucionVenceEn">, ahora: Date): PlazoArco {
  if (!ARCO_ESTADOS_ABIERTOS.includes(s.estado)) return "cerrada";
  const limite = Date.parse(s.estado === "recibida" ? s.respuestaVenceEn : s.ejecucionVenceEn);
  if (!Number.isFinite(limite)) return "en_plazo";
  const falta = limite - ahora.getTime();
  return falta < 0 ? "vencida" : falta <= POR_VENCER_MS ? "por_vencer" : "en_plazo";
}

/** Folio legible derivado del id (no es un secreto ni un dato personal). */
export function folioArco(id: string): string {
  return `ARCO-R-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
