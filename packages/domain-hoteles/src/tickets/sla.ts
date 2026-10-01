// H-05 -- tickets de huesped: reglas PURAS (sin I/O, sin reloj interno: `now` SIEMPRE se recibe)
// de clasificacion, SLA, estado de SLA y transiciones. Port adaptado del repo suelto
// (atiende-hoteles/packages/domain-hotel/src/tickets/slaPolicy.ts). Modelo SQL en
// migrations/034_guest_ticket_sla_escalacion.sql, que repite las mismas reglas de transicion como
// defensa en profundidad (trigger) -- si este espejo se desincroniza, gana el trigger.
import type { HotelRole } from "../roles.ts";

export const TICKET_DEPARTMENTS = ["owner", "gm", "frontdesk", "reservations", "housekeeping", "maintenance", "fnb", "accountant"] as const satisfies readonly HotelRole[];
export type TicketDepartment = (typeof TICKET_DEPARTMENTS)[number];

export const TICKET_PRIORITIES = ["alta", "media", "baja"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ["abierto", "en_progreso", "escalado", "cerrado", "cancelado"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CHANNELS = ["staff", "qr", "whatsapp", "voz", "resena"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const TICKET_EVENT_TYPES = ["creado", "asignado", "departamento_cambiado", "en_progreso", "aviso_sla", "escalado", "cerrado", "cancelado"] as const;
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

/** Roles a los que sube un ticket al vencer su SLA (el departamento original ya tuvo su plazo). */
export const TICKET_ESCALATION_ROLES: readonly TicketDepartment[] = ["gm", "owner"];

export const TICKET_TERMINAL_STATUSES: readonly TicketStatus[] = ["cerrado", "cancelado"];

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

/** SLA por defecto (minutos) cuando el hotel no configuro una politica para (departamento,
 *  prioridad): 30 min / 2 h / 8 h para alta / media / baja. Es un valor de negocio que el hotel
 *  sobreescribe en `hoteles.ticket_sla_policy`, nunca un plazo definitivo. */
export const DEFAULT_SLA_MINUTES_BY_PRIORITY: Readonly<Record<TicketPriority, number>> = { alta: 30, media: 120, baja: 480 };

export const MIN_SLA_MINUTES = 1;
export const MAX_SLA_MINUTES = 43200;

/** Aviso temprano al 75% del SLA transcurrido (distinto de la escalacion al 100%). */
export const SLA_WARNING_THRESHOLD_RATIO = 0.75;

export function resolveSlaMinutes(configuredMinutes: number | null | undefined, priority: TicketPriority): number {
  if (configuredMinutes != null && Number.isFinite(configuredMinutes) && configuredMinutes >= MIN_SLA_MINUTES) return Math.min(Math.floor(configuredMinutes), MAX_SLA_MINUTES);
  return DEFAULT_SLA_MINUTES_BY_PRIORITY[priority];
}

export function computeSlaDueAt(createdAt: Date, slaMinutes: number): Date {
  return new Date(createdAt.getTime() + slaMinutes * 60_000);
}

export function computeSlaWarningAt(createdAt: Date, slaMinutes: number, ratio: number = SLA_WARNING_THRESHOLD_RATIO): Date {
  return new Date(createdAt.getTime() + slaMinutes * ratio * 60_000);
}

/** Vencido = ya paso `slaDueAt` (el instante exacto todavia cuenta como dentro del SLA). */
export function isSlaOverdue(now: Date, slaDueAt: Date): boolean {
  return now.getTime() > slaDueAt.getTime();
}

export type TicketSlaState = "en_tiempo" | "por_vencer" | "vencido" | "cerrado";

/** Estado de SLA para pintar el tablero: `cerrado` si el ticket ya es terminal; `vencido` si paso
 *  el limite sin cierre (aunque el barrido aun no lo escale); `por_vencer` desde el 75%. */
export function slaState(input: { readonly status: TicketStatus; readonly createdAt: string; readonly slaMinutes: number; readonly slaDueAt: string }, now: Date): TicketSlaState {
  if (TICKET_TERMINAL_STATUSES.includes(input.status)) return "cerrado";
  if (isSlaOverdue(now, new Date(input.slaDueAt))) return "vencido";
  if (now.getTime() >= computeSlaWarningAt(new Date(input.createdAt), input.slaMinutes).getTime()) return "por_vencer";
  return "en_tiempo";
}

/** Minutos que faltan (negativo = ya vencio) hasta el limite del SLA, redondeado hacia cero. */
export function minutesToSlaDue(slaDueAt: string, now: Date): number {
  return Math.trunc((new Date(slaDueAt).getTime() - now.getTime()) / 60_000);
}

// ---------------------------------------------------------------------------
// Transiciones (espejo del trigger guest_ticket_before_update)
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  abierto: ["en_progreso", "escalado", "cerrado", "cancelado"],
  en_progreso: ["escalado", "cerrado", "cancelado"],
  escalado: ["en_progreso", "cerrado", "cancelado"],
  cerrado: [],
  cancelado: [],
};

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Quien puede OPERAR (cambiar estado/asignar) un ticket: manager, el departamento del ticket o el
 *  responsable asignado -- espejo de la policy de UPDATE (la RLS manda). */
export function actorMayOperateTicket(
  actor: { readonly role: HotelRole; readonly userId: string },
  ticket: { readonly department: string; readonly assignedTo: string | null },
  manageRoles: readonly HotelRole[],
): boolean {
  return manageRoles.includes(actor.role) || actor.role === ticket.department || ticket.assignedTo === actor.userId;
}

// ---------------------------------------------------------------------------
// Clasificacion heuristica de un mensaje libre del huesped (mejor esfuerzo, determinista)
// ---------------------------------------------------------------------------

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type ClassifiableDepartment = Extract<TicketDepartment, "frontdesk" | "housekeeping" | "maintenance" | "fnb" | "reservations">;

const DEPARTMENT_KEYWORDS: Readonly<Record<ClassifiableDepartment, readonly string[]>> = {
  maintenance: [
    "aire acondicionado", "climatizacion", "minisplit", "no enfria", "fuga", "gotea", "inundacion", "no hay luz", "sin luz",
    "no prende", "no funciona", "foco fundido", "television", "control remoto", "cerradura", "no abre la puerta",
    "sin agua caliente", "regadera", "plomeria", "tuberia", "huele a gas",
  ],
  housekeeping: ["toalla", "sabana", "limpieza", "limpiar mi habitacion", "esta sucio", "esta sucia", "basura", "shampoo", "jabon", "amenidades", "papel higienico"],
  fnb: ["room service", "servicio a la habitacion", "restaurante", "desayuno", "comida", "bebida", "bar del hotel", "menu"],
  reservations: ["mi reserva", "factura", "cambiar mi fecha", "late checkout", "checkout tardio", "upgrade de habitacion"],
  frontdesk: [],
};
const DEPARTMENT_ORDER: readonly ClassifiableDepartment[] = ["maintenance", "housekeeping", "fnb", "reservations"];
const HIGH_PRIORITY = ["emergencia", "urgente", "ahora mismo", "inundacion", "huele a gas", "incendio", "no hay luz", "sin luz", "atrapado", "atrapada", "no puedo salir", "fuga de agua"];
const LOW_PRIORITY = ["cuando puedan", "no es urgente", "sin prisa", "cuando tengan tiempo"];

export interface TicketClassification {
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
}

/** Clasifica un mensaje libre en (departamento, prioridad). Un falso negativo cae en frontdesk/media
 *  y nunca bloquea la creacion: el staff reasigna a mano. */
export function classifyGuestMessage(message: string): TicketClassification {
  const text = normalizar(message);
  const department = DEPARTMENT_ORDER.find((d) => DEPARTMENT_KEYWORDS[d].some((k) => text.includes(k))) ?? "frontdesk";
  const priority: TicketPriority = HIGH_PRIORITY.some((k) => text.includes(k)) ? "alta" : LOW_PRIORITY.some((k) => text.includes(k)) ? "baja" : "media";
  return { department, priority };
}

// ---------------------------------------------------------------------------
// Ticket desde una resena (hoteles.guest_review, migracion 013)
// ---------------------------------------------------------------------------

const TOPIC_DEPARTMENT: Readonly<Record<string, TicketDepartment>> = {
  limpieza: "housekeeping",
  wifi: "maintenance",
  aire_acondicionado: "maintenance",
  alberca: "maintenance",
  desayuno: "fnb",
  precio: "reservations",
  ruido: "frontdesk",
  check_in: "frontdesk",
  ubicacion: "frontdesk",
  personal: "gm",
  seguridad: "gm",
  sargazo: "gm",
};

export const REVIEW_TICKET_SENTIMENTS = ["negativo", "muy_negativo"] as const;

export interface ReviewForTicket {
  readonly id: string;
  readonly source: string;
  readonly texto: string;
  readonly calificacion: number | null;
  readonly sentiment: string;
  readonly topics: readonly { readonly topic: string; readonly menciones: number }[];
}

export function isReviewTicketable(review: Pick<ReviewForTicket, "sentiment">): boolean {
  return (REVIEW_TICKET_SENTIMENTS as readonly string[]).includes(review.sentiment);
}

export interface TicketFromReviewDraft {
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
  readonly guestMessage: string;
}

/** Deriva departamento/prioridad/mensaje de una resena con queja. El departamento sale del tema mas
 *  mencionado que tenga un area clara (empates: el primero listado); prioridad `alta` si el
 *  sentimiento es muy_negativo o el tema es de seguridad; `media` en el resto. */
export function draftTicketFromReview(review: ReviewForTicket): TicketFromReviewDraft {
  const ranked = [...review.topics].sort((a, b) => b.menciones - a.menciones);
  const mapped = ranked.find((t) => TOPIC_DEPARTMENT[t.topic] !== undefined);
  const department = mapped ? TOPIC_DEPARTMENT[mapped.topic]! : "frontdesk";
  const priority: TicketPriority = review.sentiment === "muy_negativo" || review.topics.some((t) => t.topic === "seguridad") ? "alta" : "media";
  const rating = review.calificacion != null ? ` ${review.calificacion}/5` : "";
  const prefix = `Resena (${review.source}${rating}): `;
  const guestMessage = (prefix + review.texto.trim()).slice(0, 1000);
  return { department, priority, guestMessage };
}
