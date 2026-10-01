// L-04 -- sala de guerra por convocatoria (tablero de preparacion). Dominio puro:
// tipos, validacion de entradas, semaforo de fechas limite y agregador del tablero.
// Sin I/O: el almacenamiento vive en `sala-guerra-repository.ts` y las rutas en
// `apps/api/src/routes/verticals/licitaciones/salaGuerra.ts`.
//
// Que NO hace: no decide go/no-go (esas decisiones ya existen en
// `go-no-go.ts`/`licitaciones.go_no_go_decision` y aqui solo se MUESTRAN) ni
// envia nada a ningun portal.
import type { GoNoGoDecisionRecord } from "./types.ts";

export const WAR_ROOM_ITEM_KINDS = ["requisito", "tarea", "riesgo"] as const;
export type WarRoomItemKind = (typeof WAR_ROOM_ITEM_KINDS)[number];

export const WAR_ROOM_ITEM_STATUSES = ["pendiente", "en_curso", "listo", "bloqueado", "descartado"] as const;
export type WarRoomItemStatus = (typeof WAR_ROOM_ITEM_STATUSES)[number];

export const WAR_ROOM_SEVERITIES = ["baja", "media", "alta", "critica"] as const;
export type WarRoomSeverity = (typeof WAR_ROOM_SEVERITIES)[number];

export const WAR_ROOM_ENTRY_KINDS = ["decision", "comentario", "evento"] as const;
export type WarRoomEntryKind = (typeof WAR_ROOM_ENTRY_KINDS)[number];

export interface WarRoomItemRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly kind: WarRoomItemKind;
  readonly title: string;
  readonly description: string | null;
  readonly status: WarRoomItemStatus;
  readonly severity: WarRoomSeverity | null;
  readonly responsibleUserId: string | null;
  readonly dueAt: string | null;
  readonly requirementItemId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface WarRoomEntryRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly itemId: string | null;
  readonly entryKind: WarRoomEntryKind;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface WarRoomItemCreateInput {
  readonly kind: WarRoomItemKind;
  readonly title: string;
  readonly description?: string | null;
  readonly severity?: WarRoomSeverity | null;
  readonly responsibleUserId?: string | null;
  readonly dueAt?: string | null;
  readonly requirementItemId?: string | null;
}

export interface WarRoomItemPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: WarRoomItemStatus;
  readonly severity?: WarRoomSeverity | null;
  readonly responsibleUserId?: string | null;
  readonly dueAt?: string | null;
}

/** Entrada invalida: la ruta la traduce a 400. */
export class SalaGuerraValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalaGuerraValidationError";
  }
}

/** Las tablas de la migracion 029 aun no existen en esta base (42P01/42703/42883): se degrada a "no disponible aun", nunca a un 500. */
export class SalaGuerraNotAvailableError extends Error {
  constructor(message = "La sala de guerra y la junta de aclaraciones aun no estan disponibles en esta base de datos (falta aplicar la migracion 029).") {
    super(message);
    this.name = "SalaGuerraNotAvailableError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function parseIso(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new SalaGuerraValidationError(`${field}: se esperaba una fecha ISO 8601 valida o null.`);
  return new Date(value).toISOString();
}

function parseText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new SalaGuerraValidationError(`${field}: se esperaba texto.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new SalaGuerraValidationError(`${field}: debe tener entre ${min} y ${max} caracteres.`);
  return trimmed;
}

function parseOptionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parseText(value, field, 1, max);
}

/** Valida el cuerpo de alta de un item del tablero. La severidad solo aplica a riesgos (mismo CHECK que la base). */
export function parseWarRoomItemCreate(raw: Record<string, unknown>): WarRoomItemCreateInput {
  if (!isOneOf(WAR_ROOM_ITEM_KINDS, raw.kind)) throw new SalaGuerraValidationError('kind: se esperaba "requisito" | "tarea" | "riesgo".');
  const title = parseText(raw.title, "title", 3, 300);
  const description = parseOptionalText(raw.description, "description", 4000);
  let severity: WarRoomSeverity | null = null;
  if (raw.severity !== undefined && raw.severity !== null) {
    if (!isOneOf(WAR_ROOM_SEVERITIES, raw.severity)) throw new SalaGuerraValidationError('severity: se esperaba "baja" | "media" | "alta" | "critica".');
    severity = raw.severity;
  }
  if (raw.kind === "riesgo" && severity === null) severity = "media";
  if (raw.kind !== "riesgo" && severity !== null) throw new SalaGuerraValidationError("severity: solo los riesgos llevan severidad.");
  let responsibleUserId: string | null = null;
  if (raw.responsibleUserId !== undefined && raw.responsibleUserId !== null) {
    if (!isUuid(raw.responsibleUserId)) throw new SalaGuerraValidationError("responsibleUserId: se esperaba un UUID.");
    responsibleUserId = raw.responsibleUserId;
  }
  let requirementItemId: string | null = null;
  if (raw.requirementItemId !== undefined && raw.requirementItemId !== null) {
    if (!isUuid(raw.requirementItemId)) throw new SalaGuerraValidationError("requirementItemId: se esperaba un UUID.");
    requirementItemId = raw.requirementItemId;
  }
  return { kind: raw.kind, title, description, severity, responsibleUserId, dueAt: parseIso(raw.dueAt, "dueAt"), requirementItemId };
}

/** Valida un PATCH parcial; `kind` nunca cambia. `kindOfItem` ya viene del registro guardado. */
export function parseWarRoomItemPatch(raw: Record<string, unknown>, kindOfItem: WarRoomItemKind): WarRoomItemPatch {
  const patch: { -readonly [K in keyof WarRoomItemPatch]: WarRoomItemPatch[K] } = {};
  if (raw.title !== undefined) patch.title = parseText(raw.title, "title", 3, 300);
  if (raw.description !== undefined) patch.description = parseOptionalText(raw.description, "description", 4000);
  if (raw.status !== undefined) {
    if (!isOneOf(WAR_ROOM_ITEM_STATUSES, raw.status)) throw new SalaGuerraValidationError('status: se esperaba "pendiente" | "en_curso" | "listo" | "bloqueado" | "descartado".');
    patch.status = raw.status;
  }
  if (raw.severity !== undefined) {
    if (raw.severity === null) {
      if (kindOfItem === "riesgo") throw new SalaGuerraValidationError("severity: un riesgo siempre lleva severidad.");
      patch.severity = null;
    } else {
      if (!isOneOf(WAR_ROOM_SEVERITIES, raw.severity)) throw new SalaGuerraValidationError('severity: se esperaba "baja" | "media" | "alta" | "critica".');
      if (kindOfItem !== "riesgo") throw new SalaGuerraValidationError("severity: solo los riesgos llevan severidad.");
      patch.severity = raw.severity;
    }
  }
  if (raw.responsibleUserId !== undefined) {
    if (raw.responsibleUserId !== null && !isUuid(raw.responsibleUserId)) throw new SalaGuerraValidationError("responsibleUserId: se esperaba un UUID o null.");
    patch.responsibleUserId = raw.responsibleUserId;
  }
  if (raw.dueAt !== undefined) patch.dueAt = parseIso(raw.dueAt, "dueAt");
  if (Object.keys(patch).length === 0) throw new SalaGuerraValidationError("No hay ningun campo para actualizar.");
  return patch;
}

export function parseWarRoomEntryCreate(raw: Record<string, unknown>): { entryKind: "decision" | "comentario"; body: string; itemId: string | null } {
  if (raw.entryKind !== "decision" && raw.entryKind !== "comentario") throw new SalaGuerraValidationError('entryKind: se esperaba "decision" | "comentario" (los eventos los genera el sistema).');
  const body = parseText(raw.body, "body", 1, 4000);
  let itemId: string | null = null;
  if (raw.itemId !== undefined && raw.itemId !== null) {
    if (!isUuid(raw.itemId)) throw new SalaGuerraValidationError("itemId: se esperaba un UUID.");
    itemId = raw.itemId;
  }
  return { entryKind: raw.entryKind, body, itemId };
}

// ---------------------------------------------------------------------------
// Semaforo de fechas limite
// ---------------------------------------------------------------------------

export type SemaphoreColor = "rojo" | "amarillo" | "verde" | "gris";
export type SemaphoreState = "vencido" | "vence_hoy" | "vence_pronto" | "en_tiempo" | "sin_fecha" | "cerrado";

export interface DeadlineSemaphore {
  readonly color: SemaphoreColor;
  readonly state: SemaphoreState;
  /** Horas hasta la fecha limite (negativo = vencida); `null` sin fecha o cerrado. */
  readonly hoursRemaining: number | null;
}

/** Ventanas del semaforo (alineadas con la ventana de 3 dias del barrido de recordatorios de plazo). */
export const SEMAPHORE_RED_HOURS = 24;
export const SEMAPHORE_YELLOW_HOURS = 72;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Semaforo de una fecha limite. `closed` = el item ya no esta abierto (listo/descartado) o la
 * pregunta ya salio: se muestra gris, nunca rojo. Rojo: vencida o a menos de 24 h. Amarillo:
 * menos de 72 h. Verde: mas tiempo. Sin fecha: gris (no se inventa una urgencia).
 */
export function deadlineSemaphore(dueAtIso: string | null, nowIso: string, closed = false): DeadlineSemaphore {
  if (closed) return { color: "gris", state: "cerrado", hoursRemaining: null };
  if (!dueAtIso) return { color: "gris", state: "sin_fecha", hoursRemaining: null };
  const dueMs = Date.parse(dueAtIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(dueMs) || Number.isNaN(nowMs)) return { color: "gris", state: "sin_fecha", hoursRemaining: null };
  const hours = (dueMs - nowMs) / HOUR_MS;
  const rounded = Math.round(hours * 10) / 10;
  if (hours < 0) return { color: "rojo", state: "vencido", hoursRemaining: rounded };
  if (hours < SEMAPHORE_RED_HOURS) return { color: "rojo", state: "vence_hoy", hoursRemaining: rounded };
  if (hours < SEMAPHORE_YELLOW_HOURS) return { color: "amarillo", state: "vence_pronto", hoursRemaining: rounded };
  return { color: "verde", state: "en_tiempo", hoursRemaining: rounded };
}

const SEMAPHORE_RANK: Record<SemaphoreColor, number> = { gris: 0, verde: 1, amarillo: 2, rojo: 3 };

export function worstSemaphore(colors: readonly SemaphoreColor[]): SemaphoreColor {
  let worst: SemaphoreColor = "gris";
  for (const c of colors) if (SEMAPHORE_RANK[c] > SEMAPHORE_RANK[worst]) worst = c;
  return worst;
}

export function isItemClosed(status: WarRoomItemStatus): boolean {
  return status === "listo" || status === "descartado";
}

// ---------------------------------------------------------------------------
// Agregador del tablero
// ---------------------------------------------------------------------------

export interface WarRoomBoardItem extends WarRoomItemRecord {
  readonly semaphore: DeadlineSemaphore;
}

export interface WarRoomBoardSummary {
  readonly requisitos: { readonly total: number; readonly listos: number; readonly bloqueados: number };
  readonly tareas: { readonly total: number; readonly listas: number };
  readonly riesgosAbiertos: number;
  readonly riesgosAltos: number;
  readonly sinResponsable: number;
  /** % de requisitos+tareas vigentes ya listos (0-100), o `null` si no hay ninguno: nunca se inventa "100%". */
  readonly avancePct: number | null;
  /** Peor semaforo entre los items abiertos con fecha, riesgos criticos abiertos y la fecha limite de presentacion. */
  readonly semaforoGeneral: SemaphoreColor;
}

export interface WarRoomBoard {
  readonly items: readonly WarRoomBoardItem[];
  readonly summary: WarRoomBoardSummary;
  /** Ultima decision go/no-go YA registrada en `go_no_go_decision` (solo lectura aqui). */
  readonly goNoGo: GoNoGoDecisionRecord | null;
  readonly submissionDeadline: { readonly at: string | null; readonly semaphore: DeadlineSemaphore };
}

export interface BuildWarRoomBoardInput {
  readonly items: readonly WarRoomItemRecord[];
  readonly goNoGoDecisions: readonly GoNoGoDecisionRecord[];
  readonly submissionDeadline: string | null;
  readonly nowIso: string;
}

export function buildWarRoomBoard(input: BuildWarRoomBoardInput): WarRoomBoard {
  const items: WarRoomBoardItem[] = input.items.map((item) => ({ ...item, semaphore: deadlineSemaphore(item.dueAt, input.nowIso, isItemClosed(item.status)) }));
  const vigentes = items.filter((i) => i.status !== "descartado");
  const requisitos = vigentes.filter((i) => i.kind === "requisito");
  const tareas = vigentes.filter((i) => i.kind === "tarea");
  const riesgosAbiertos = vigentes.filter((i) => i.kind === "riesgo" && i.status !== "listo");
  const trabajo = [...requisitos, ...tareas];
  const submissionSemaphore = deadlineSemaphore(input.submissionDeadline, input.nowIso);
  const colors: SemaphoreColor[] = [
    submissionSemaphore.color,
    ...items.filter((i) => i.kind !== "riesgo").map((i) => i.semaphore.color),
    ...riesgosAbiertos.filter((r) => r.severity === "critica").map((): SemaphoreColor => "rojo"),
    ...riesgosAbiertos.filter((r) => r.severity === "alta").map((): SemaphoreColor => "amarillo"),
  ];
  const decisions = [...input.goNoGoDecisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return {
    items,
    summary: {
      requisitos: { total: requisitos.length, listos: requisitos.filter((i) => i.status === "listo").length, bloqueados: requisitos.filter((i) => i.status === "bloqueado").length },
      tareas: { total: tareas.length, listas: tareas.filter((i) => i.status === "listo").length },
      riesgosAbiertos: riesgosAbiertos.length,
      riesgosAltos: riesgosAbiertos.filter((r) => r.severity === "alta" || r.severity === "critica").length,
      sinResponsable: trabajo.filter((i) => i.status !== "listo" && i.responsibleUserId === null).length,
      avancePct: trabajo.length === 0 ? null : Math.round((trabajo.filter((i) => i.status === "listo").length / trabajo.length) * 100),
      semaforoGeneral: worstSemaphore(colors),
    },
    goNoGo: decisions[0] ?? null,
    submissionDeadline: { at: input.submissionDeadline, semaphore: submissionSemaphore },
  };
}
