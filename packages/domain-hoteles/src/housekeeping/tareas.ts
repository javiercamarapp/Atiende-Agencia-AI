// H-04 (P0) -- housekeeping completo: tipos, errores y reglas PURAS (sin I/O) del tablero,
// las tareas de limpieza, la inspeccion y las habitaciones fuera de servicio.
// Modelo SQL en migrations/033_housekeeping_completo.sql; extiende (no duplica) los turnos
// LFT (turnos-lft.ts, migracion 009) y los tickets de mantenimiento (009). El estado de la
// habitacion sigue siendo UNA sola fuente de verdad: `hoteles.room.status` (migracion 001).

export const HK_TASK_TYPES = ["salida", "estancia", "profunda", "repaso"] as const;
export type HousekeepingTaskType = (typeof HK_TASK_TYPES)[number];

export const HK_TASK_STATUSES = ["pendiente", "en_progreso", "terminada", "inspeccionada", "cancelada"] as const;
export type HousekeepingTaskStatus = (typeof HK_TASK_STATUSES)[number];

export const HK_PRIORITIES = ["normal", "alta"] as const;
export type HousekeepingPriority = (typeof HK_PRIORITIES)[number];

export type HotelRoomStatus = "disponible" | "ocupada" | "sucia" | "fuera_de_servicio" | "mantenimiento";

export const OUT_OF_SERVICE_KINDS = ["fuera_de_servicio", "fuera_de_orden"] as const;
export type OutOfServiceKind = (typeof OUT_OF_SERVICE_KINDS)[number];

export type InspectionResult = "aprobada" | "rechazada";

export interface HousekeepingTaskRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomId: string;
  readonly roomCode: string;
  readonly taskType: HousekeepingTaskType;
  readonly status: HousekeepingTaskStatus;
  readonly priority: HousekeepingPriority;
  readonly workDate: string;
  readonly assignedTo: string | null;
  readonly notes: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly inspectionResult: InspectionResult | null;
  readonly inspectedBy: string | null;
  readonly inspectedAt: string | null;
  readonly inspectionNote: string | null;
  readonly rejections: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewHousekeepingTaskInput {
  readonly propertyId: string;
  readonly roomId: string;
  readonly taskType: HousekeepingTaskType;
  readonly priority: HousekeepingPriority;
  readonly workDate: string;
  readonly assignedTo: string | null;
  readonly notes: string | null;
  readonly createdBy: string;
}

export interface HousekeepingTaskFilter {
  readonly workDate: string;
  readonly status?: HousekeepingTaskStatus;
  readonly assignedTo?: string;
}

export interface OutOfServiceRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomId: string;
  readonly roomCode: string;
  readonly kind: OutOfServiceKind;
  readonly reason: string;
  readonly fromDate: string;
  readonly expectedReturnDate: string | null;
  readonly status: "activo" | "cerrado";
  readonly maintenanceTicketId: string | null;
  readonly createdBy: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

export interface NewOutOfServiceInput {
  readonly propertyId: string;
  readonly roomId: string;
  readonly kind: OutOfServiceKind;
  readonly reason: string;
  readonly fromDate: string;
  readonly expectedReturnDate: string | null;
  readonly maintenanceTicketId: string | null;
  readonly createdBy: string;
}

/** Una fila del tablero: una por habitacion, con la tarea vigente del dia y la
 *  inhabilitacion activa (si existe). */
export interface HousekeepingBoardRow {
  readonly roomId: string;
  readonly code: string;
  readonly roomType: string;
  readonly roomStatus: HotelRoomStatus;
  readonly task: {
    readonly id: string;
    readonly taskType: HousekeepingTaskType;
    readonly status: HousekeepingTaskStatus;
    readonly priority: HousekeepingPriority;
    readonly assignedTo: string | null;
    readonly rejections: number;
  } | null;
  readonly outOfService: {
    readonly id: string;
    readonly kind: OutOfServiceKind;
    readonly reason: string;
    readonly expectedReturnDate: string | null;
  } | null;
}

/** `tareasDisponibles: false` = la base aun no tiene la migracion 033: el tablero se
 *  arma solo con el estado de cada habitacion (honesto, sin tareas ni fuera de servicio). */
export interface HousekeepingBoardResult {
  readonly tareasDisponibles: boolean;
  readonly rows: readonly HousekeepingBoardRow[];
}

export interface HousekeepingAssigneeStats {
  readonly assignedTo: string | null;
  readonly total: number;
  readonly pendientes: number;
  readonly enProgreso: number;
  readonly porInspeccionar: number;
  readonly inspeccionadas: number;
  readonly rechazos: number;
  readonly minutosPromedio: number | null;
}

export interface HousekeepingDailyReport {
  readonly tareasDisponibles: boolean;
  readonly workDate: string;
  readonly totales: Omit<HousekeepingAssigneeStats, "assignedTo" | "minutosPromedio">;
  readonly porResponsable: readonly HousekeepingAssigneeStats[];
  readonly habitacionesPorEstado: Readonly<Record<HotelRoomStatus, number>>;
  readonly fueraDeServicioActivas: number;
}

// ---------------------------------------------------------------------------
// Errores de dominio (las rutas los traducen a 404/403/409/422/503, nunca un 500 crudo)
// ---------------------------------------------------------------------------

/** La migracion 033 aun no esta aplicada en esta base (42883/42P01/42703). Las rutas
 *  responden 503 honesto en escrituras; las lecturas degradan a vacio/`tareasDisponibles:false`. */
export class HousekeepingUnavailableError extends Error {
  constructor(operation: string) {
    super(`Housekeeping completo aun no esta disponible en esta base (migracion pendiente) -- operacion: ${operation}.`);
    this.name = "HousekeepingUnavailableError";
  }
}
export class HousekeepingNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrada(o) en esta property.`);
    this.name = "HousekeepingNotFoundError";
  }
}
export class HousekeepingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HousekeepingConflictError";
  }
}
export class HousekeepingInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HousekeepingInvalidInputError";
  }
}
export class HousekeepingAccessDeniedError extends Error {
  constructor(message = "Sin permiso para esta operacion de housekeeping.") {
    super(message);
    this.name = "HousekeepingAccessDeniedError";
  }
}

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

export type HousekeepingTaskAction = "iniciar" | "terminar" | "inspeccionar" | "asignar" | "cancelar";

const ALLOWED_FROM: Record<HousekeepingTaskAction, readonly HousekeepingTaskStatus[]> = {
  iniciar: ["pendiente"],
  terminar: ["en_progreso"],
  inspeccionar: ["terminada"],
  asignar: ["pendiente", "en_progreso"],
  cancelar: ["pendiente", "en_progreso", "terminada"],
};

export function canApplyTaskAction(status: HousekeepingTaskStatus, action: HousekeepingTaskAction): boolean {
  return ALLOWED_FROM[action].includes(status);
}

export function assertTaskAction(status: HousekeepingTaskStatus, action: HousekeepingTaskAction): void {
  if (!canApplyTaskAction(status, action)) {
    throw new HousekeepingConflictError(`No se puede ${action} una tarea en estado "${status}".`);
  }
}

/** El rol `housekeeping` (camarista) solo opera tareas propias o aun sin asignar;
 *  owner/gm/frontdesk operan cualquiera. Defensa en profundidad: el resto lo cierra RLS. */
export function actorMayOperateTask(role: string, actorId: string, assignedTo: string | null): boolean {
  if (role !== "housekeeping") return true;
  return assignedTo === null || assignedTo === actorId;
}

/** Separacion de funciones: quien limpio no inspecciona su propio trabajo (espejo del
 *  CHECK `housekeeping_task_inspector_not_assignee` de la migracion 033). */
export function inspectorIsAllowed(inspectorId: string, assignedTo: string | null): boolean {
  return assignedTo === null || assignedTo !== inspectorId;
}

/** Estado de la habitacion tras una inspeccion APROBADA: solo una habitacion `sucia`
 *  se libera; una `ocupada` (limpieza de estancia) o fuera de servicio no cambia. */
export function roomStatusAfterApprovedInspection(current: HotelRoomStatus): HotelRoomStatus {
  return current === "sucia" ? "disponible" : current;
}

/** Estado de la habitacion mientras dura una inhabilitacion: una falla (fuera de orden)
 *  usa `mantenimiento`; una retirada operativa usa `fuera_de_servicio`. */
export function roomStatusForOutOfService(kind: OutOfServiceKind): HotelRoomStatus {
  return kind === "fuera_de_orden" ? "mantenimiento" : "fuera_de_servicio";
}

/** Una habitacion con huesped dentro no se inhabilita (se espera al check-out). */
export function canSetOutOfService(roomStatus: HotelRoomStatus): boolean {
  return roomStatus !== "ocupada";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function emptyRoomStatusCounts(): Record<HotelRoomStatus, number> {
  return { disponible: 0, ocupada: 0, sucia: 0, fuera_de_servicio: 0, mantenimiento: 0 };
}

export function summarizeTasks(tasks: readonly Pick<HousekeepingTaskRecord, "status" | "rejections" | "startedAt" | "finishedAt" | "assignedTo">[]): {
  readonly totales: HousekeepingDailyReport["totales"];
  readonly porResponsable: readonly HousekeepingAssigneeStats[];
} {
  const groups = new Map<string | null, typeof tasks[number][]>();
  for (const t of tasks) {
    if (t.status === "cancelada") continue;
    const list = groups.get(t.assignedTo) ?? [];
    list.push(t);
    groups.set(t.assignedTo, list);
  }
  const statsOf = (list: readonly typeof tasks[number][]) => ({
    total: list.length,
    pendientes: list.filter((t) => t.status === "pendiente").length,
    enProgreso: list.filter((t) => t.status === "en_progreso").length,
    porInspeccionar: list.filter((t) => t.status === "terminada").length,
    inspeccionadas: list.filter((t) => t.status === "inspeccionada").length,
    rechazos: list.reduce((acc, t) => acc + t.rejections, 0),
  });
  const porResponsable: HousekeepingAssigneeStats[] = [];
  for (const [assignedTo, list] of groups) {
    const durations = list
      .filter((t) => t.startedAt && t.finishedAt)
      .map((t) => (Date.parse(t.finishedAt as string) - Date.parse(t.startedAt as string)) / 60000);
    porResponsable.push({
      assignedTo,
      ...statsOf(list),
      minutosPromedio: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    });
  }
  porResponsable.sort((a, b) => (a.assignedTo ?? "").localeCompare(b.assignedTo ?? ""));
  return { totales: statsOf([...groups.values()].flat()), porResponsable };
}
