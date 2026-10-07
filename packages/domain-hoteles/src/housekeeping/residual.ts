// H-26 -- housekeeping RESIDUAL: configuracion por property, fotos de inspeccion, conteo de blancos,
// opt-out de limpieza y asignacion automatica. Tipos y reglas PURAS (sin I/O). Modelo SQL en
// migrations/039_hoteles_hk_residual_canal.sql; extiende (no duplica) tareas.ts (H-04, migracion 033).
import {
  HousekeepingInvalidInputError,
  type HousekeepingPriority,
  type HousekeepingTaskType,
  HK_TASK_TYPES,
  isIsoDate,
} from "./tareas.ts";

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------

export interface HousekeepingConfig {
  readonly propertyId: string;
  readonly autoAssignEnabled: boolean;
  readonly maxTasksPerCamarista: number;
  readonly shiftMinutes: number;
  readonly minutesByType: Readonly<Record<HousekeepingTaskType, number>>;
  readonly photosRequiredOnInspection: boolean;
  readonly maxPhotosPerTask: number;
  /** H-P3-04: hora LOCAL (0..23) a la que el cron arranca el dia de housekeeping de la property (default 7). */
  readonly startHour: number;
  /** false = la base aun no tiene la migracion 045 (columna `start_hour`): se usa el default 7 y no se puede cambiar. */
  readonly startHourDisponible: boolean;
  /** false = la property aun no guardo configuracion propia: se muestran los valores por defecto. */
  readonly personalizada: boolean;
  readonly updatedAt: string | null;
}

export type HousekeepingConfigValues = Omit<HousekeepingConfig, "propertyId" | "personalizada" | "updatedAt" | "startHourDisponible">;

/** Mismos DEFAULT que la tabla (migracion 039): sin fila, la aplicacion se comporta igual que con una fila nueva. */
export const DEFAULT_HOUSEKEEPING_CONFIG: HousekeepingConfigValues = {
  autoAssignEnabled: false,
  maxTasksPerCamarista: 14,
  shiftMinutes: 480,
  minutesByType: { salida: 40, estancia: 20, profunda: 90, repaso: 10 },
  photosRequiredOnInspection: false,
  maxPhotosPerTask: 6,
  startHour: 7,
};

export interface HousekeepingConfigPatch {
  readonly autoAssignEnabled?: boolean;
  readonly maxTasksPerCamarista?: number;
  readonly shiftMinutes?: number;
  readonly minutesByType?: Partial<Record<HousekeepingTaskType, number>>;
  readonly photosRequiredOnInspection?: boolean;
  readonly maxPhotosPerTask?: number;
  readonly startHour?: number;
}

function intInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HousekeepingInvalidInputError(`${field}: entero entre ${min} y ${max}.`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HousekeepingInvalidInputError(`${field}: se esperaba true o false.`);
  return value;
}

/** Valida un PATCH parcial de configuracion (mismos rangos que los CHECK de la tabla). Campos desconocidos = error. */
export function parseHousekeepingConfigPatch(raw: unknown): HousekeepingConfigPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HousekeepingInvalidInputError("Cuerpo invalido: se esperaba un objeto.");
  const body = raw as Record<string, unknown>;
  const known = new Set(["asignacionAutomatica", "maxTareasPorCamarista", "minutosJornada", "minutosPorTipo", "fotosObligatoriasEnInspeccion", "maxFotosPorTarea", "horaArranque"]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw new HousekeepingInvalidInputError(`Campo desconocido: ${key}.`);
  }
  const patch: {
    autoAssignEnabled?: boolean;
    maxTasksPerCamarista?: number;
    shiftMinutes?: number;
    minutesByType?: Partial<Record<HousekeepingTaskType, number>>;
    photosRequiredOnInspection?: boolean;
    maxPhotosPerTask?: number;
    startHour?: number;
  } = {};
  if (body.asignacionAutomatica !== undefined) patch.autoAssignEnabled = bool(body.asignacionAutomatica, "asignacionAutomatica");
  if (body.maxTareasPorCamarista !== undefined) patch.maxTasksPerCamarista = intInRange(body.maxTareasPorCamarista, "maxTareasPorCamarista", 1, 60);
  if (body.minutosJornada !== undefined) patch.shiftMinutes = intInRange(body.minutosJornada, "minutosJornada", 60, 720);
  if (body.fotosObligatoriasEnInspeccion !== undefined) patch.photosRequiredOnInspection = bool(body.fotosObligatoriasEnInspeccion, "fotosObligatoriasEnInspeccion");
  if (body.maxFotosPorTarea !== undefined) patch.maxPhotosPerTask = intInRange(body.maxFotosPorTarea, "maxFotosPorTarea", 1, 10);
  if (body.horaArranque !== undefined) patch.startHour = intInRange(body.horaArranque, "horaArranque", 0, 23);
  if (body.minutosPorTipo !== undefined) {
    if (!body.minutosPorTipo || typeof body.minutosPorTipo !== "object" || Array.isArray(body.minutosPorTipo)) {
      throw new HousekeepingInvalidInputError("minutosPorTipo: se esperaba un objeto por tipo de tarea.");
    }
    const minutes: Partial<Record<HousekeepingTaskType, number>> = {};
    for (const [type, value] of Object.entries(body.minutosPorTipo as Record<string, unknown>)) {
      if (!(HK_TASK_TYPES as readonly string[]).includes(type)) throw new HousekeepingInvalidInputError(`minutosPorTipo: tipo desconocido ${type}.`);
      minutes[type as HousekeepingTaskType] = intInRange(value, `minutosPorTipo.${type}`, 5, 240);
    }
    patch.minutesByType = minutes;
  }
  if (Object.keys(patch).length === 0) throw new HousekeepingInvalidInputError("Nada que actualizar: manda al menos un campo.");
  return patch;
}

export function mergeHousekeepingConfig(base: HousekeepingConfigValues, patch: HousekeepingConfigPatch): HousekeepingConfigValues {
  return {
    autoAssignEnabled: patch.autoAssignEnabled ?? base.autoAssignEnabled,
    maxTasksPerCamarista: patch.maxTasksPerCamarista ?? base.maxTasksPerCamarista,
    shiftMinutes: patch.shiftMinutes ?? base.shiftMinutes,
    minutesByType: { ...base.minutesByType, ...(patch.minutesByType ?? {}) },
    photosRequiredOnInspection: patch.photosRequiredOnInspection ?? base.photosRequiredOnInspection,
    maxPhotosPerTask: patch.maxPhotosPerTask ?? base.maxPhotosPerTask,
    startHour: patch.startHour ?? base.startHour,
  };
}

// ---------------------------------------------------------------------------
// Fotos de inspeccion
// ---------------------------------------------------------------------------

export const PHOTO_MAX_BYTES = 1_572_864;
export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

/** Tipo REAL de la imagen por su firma (magic bytes); nunca se confia en el tipo declarado por el cliente. */
export function detectImageType(bytes: Uint8Array): PhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodifica una foto en base64 (con o sin prefijo `data:...;base64,`) y valida tamano y firma real. */
export function decodePhotoBase64(input: unknown): { readonly bytes: Uint8Array; readonly contentType: PhotoContentType } {
  if (typeof input !== "string" || input.length === 0) throw new HousekeepingInvalidInputError("imagen: requerida (base64).");
  const comma = input.startsWith("data:") ? input.indexOf(",") : -1;
  const payload = (comma >= 0 ? input.slice(comma + 1) : input).trim();
  // Tope ANTES de decodificar: evita asignar memoria por una cadena enorme.
  if (payload.length > Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 4) throw new HousekeepingInvalidInputError(`imagen: maximo ${PHOTO_MAX_BYTES} bytes.`);
  if (payload.length % 4 !== 0 || !BASE64_RE.test(payload)) throw new HousekeepingInvalidInputError("imagen: base64 invalido.");
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) throw new HousekeepingInvalidInputError(`imagen: entre 1 y ${PHOTO_MAX_BYTES} bytes.`);
  const contentType = detectImageType(bytes);
  if (!contentType) throw new HousekeepingInvalidInputError("imagen: solo se aceptan JPEG, PNG o WebP.");
  return { bytes, contentType };
}

export interface TaskPhotoRecord {
  readonly id: string;
  readonly taskId: string;
  readonly contentType: PhotoContentType;
  readonly byteSize: number;
  readonly caption: string | null;
  readonly takenBy: string | null;
  readonly createdAt: string;
}

export interface NewTaskPhotoInput {
  readonly propertyId: string;
  readonly taskId: string;
  readonly contentType: PhotoContentType;
  readonly bytes: Uint8Array;
  readonly caption: string | null;
  readonly takenBy: string;
}

/** Analisis automatico de las fotos con un modelo de vision: NO esta construido (necesita la llave LLM de H-23).
 *  El tablero lo declara de forma honesta en vez de simular un resultado. */
export const PHOTO_VISION_STATUS = { disponible: false, requiere: "llave de un modelo con vision (H-23)" } as const;

// ---------------------------------------------------------------------------
// Conteo de blancos
// ---------------------------------------------------------------------------

export const LINEN_ITEMS = ["sabanas", "fundas", "toallas_bano", "toallas_mano", "toallas_piso", "cobertores", "albornoces"] as const;
export type LinenItem = (typeof LINEN_ITEMS)[number];

export interface LinenCountRecord {
  readonly item: LinenItem;
  readonly countDate: string;
  readonly qtyClean: number;
  readonly qtyDirty: number;
  readonly qtyLaundry: number;
  readonly qtyDamaged: number;
  readonly countedBy: string | null;
  readonly updatedAt: string;
}

export interface LinenCountInput {
  readonly propertyId: string;
  readonly countDate: string;
  readonly item: LinenItem;
  readonly qtyClean: number;
  readonly qtyDirty: number;
  readonly qtyLaundry: number;
  readonly qtyDamaged: number;
  readonly countedBy: string;
}

export function linenTotal(r: Pick<LinenCountRecord, "qtyClean" | "qtyDirty" | "qtyLaundry" | "qtyDamaged">): number {
  return r.qtyClean + r.qtyDirty + r.qtyLaundry + r.qtyDamaged;
}

export interface LinenReportRow {
  readonly item: LinenItem;
  readonly actual: LinenCountRecord | null;
  readonly totalActual: number | null;
  /** Ultimo conteo ANTERIOR a la fecha consultada (para detectar faltantes), o null si no hay. */
  readonly anterior: { readonly countDate: string; readonly total: number } | null;
  /** totalActual - total anterior; negativo = faltan piezas. null si falta alguno de los dos conteos. */
  readonly diferencia: number | null;
}

/** Une los conteos del dia con el ultimo conteo previo por articulo. Un renglon por articulo de la lista cerrada. */
export function buildLinenReport(current: readonly LinenCountRecord[], previous: readonly LinenCountRecord[]): readonly LinenReportRow[] {
  return LINEN_ITEMS.map((item) => {
    const actual = current.find((c) => c.item === item) ?? null;
    const prev = previous.filter((p) => p.item === item).sort((a, b) => b.countDate.localeCompare(a.countDate))[0] ?? null;
    const totalActual = actual ? linenTotal(actual) : null;
    const anterior = prev ? { countDate: prev.countDate, total: linenTotal(prev) } : null;
    return { item, actual, totalActual, anterior, diferencia: totalActual !== null && anterior ? totalActual - anterior.total : null };
  });
}

export function parseLinenInput(raw: unknown): Omit<LinenCountInput, "propertyId" | "countedBy"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HousekeepingInvalidInputError("Cuerpo invalido: se esperaba un objeto.");
  const body = raw as Record<string, unknown>;
  if (!(LINEN_ITEMS as readonly unknown[]).includes(body.articulo)) throw new HousekeepingInvalidInputError(`articulo: se esperaba ${LINEN_ITEMS.join("|")}.`);
  if (!isIsoDate(body.fecha)) throw new HousekeepingInvalidInputError("fecha: formato esperado YYYY-MM-DD.");
  const qty = (value: unknown, field: string) => intInRange(value ?? 0, field, 0, 100000);
  return {
    countDate: body.fecha,
    item: body.articulo as LinenItem,
    qtyClean: qty(body.limpias, "limpias"),
    qtyDirty: qty(body.sucias, "sucias"),
    qtyLaundry: qty(body.enLavanderia, "enLavanderia"),
    qtyDamaged: qty(body.danadas, "danadas"),
  };
}

// ---------------------------------------------------------------------------
// Opt-out de limpieza
// ---------------------------------------------------------------------------

export const OPT_OUT_SOURCES = ["huesped", "recepcion", "whatsapp"] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

/** Solo la limpieza de ESTANCIA y el repaso se omiten con un opt-out: la de salida y la profunda siempre se hacen. */
export const OPT_OUT_SKIPPABLE_TASK_TYPES: readonly HousekeepingTaskType[] = ["estancia", "repaso"];

export function optOutSkipsTaskType(type: HousekeepingTaskType): boolean {
  return OPT_OUT_SKIPPABLE_TASK_TYPES.includes(type);
}

export interface CleaningOptOutRecord {
  readonly id: string;
  readonly roomId: string;
  readonly roomCode: string;
  readonly optOutDate: string;
  readonly source: OptOutSource;
  readonly note: string | null;
  readonly status: "activo" | "revertido";
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly revertedAt: string | null;
}

export interface NewCleaningOptOutInput {
  readonly propertyId: string;
  readonly roomId: string;
  readonly optOutDate: string;
  readonly source: OptOutSource;
  readonly note: string | null;
  readonly createdBy: string;
}

// ---------------------------------------------------------------------------
// Asignacion automatica (determinista, sin optimizador externo)
// ---------------------------------------------------------------------------

export interface AutoAssignTask {
  readonly id: string;
  readonly roomCode: string;
  readonly taskType: HousekeepingTaskType;
  readonly priority: HousekeepingPriority;
}

export interface AutoAssignLoad {
  readonly camaristaId: string;
  readonly tasks: number;
  readonly minutes: number;
}

export interface AutoAssignPlan {
  readonly assignments: readonly { readonly taskId: string; readonly camaristaId: string }[];
  /** Tareas que NO caben en ninguna jornada (sin camaristas o todas al tope): quedan sin asignar. */
  readonly unassigned: readonly string[];
}

/**
 * Reparte las tareas sin responsable entre las camaristas: primero las de prioridad alta, luego las mas largas
 * (LPT), cada una a la camarista con menos minutos acumulados que aun tenga cupo (tareas y minutos de jornada).
 * Desempate estable: menos tareas, luego id. Funcion pura: la misma entrada da siempre el mismo plan.
 */
export function planAutoAssignment(
  tasks: readonly AutoAssignTask[],
  loads: readonly AutoAssignLoad[],
  config: Pick<HousekeepingConfigValues, "maxTasksPerCamarista" | "shiftMinutes" | "minutesByType">,
): AutoAssignPlan {
  const state = new Map<string, { tasks: number; minutes: number }>(loads.map((l) => [l.camaristaId, { tasks: l.tasks, minutes: l.minutes }]));
  const ordered = [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "alta" ? -1 : 1;
    const byMinutes = config.minutesByType[b.taskType] - config.minutesByType[a.taskType];
    if (byMinutes !== 0) return byMinutes;
    return a.roomCode.localeCompare(b.roomCode, "es", { numeric: true }) || a.id.localeCompare(b.id);
  });
  const assignments: { taskId: string; camaristaId: string }[] = [];
  const unassigned: string[] = [];
  for (const task of ordered) {
    const cost = config.minutesByType[task.taskType];
    let best: string | null = null;
    for (const [id, s] of state) {
      if (s.tasks >= config.maxTasksPerCamarista || s.minutes + cost > config.shiftMinutes) continue;
      const current = best === null ? null : state.get(best)!;
      if (current === null || s.minutes < current.minutes || (s.minutes === current.minutes && (s.tasks < current.tasks || (s.tasks === current.tasks && id < best!)))) {
        best = id;
      }
    }
    if (best === null) {
      unassigned.push(task.id);
      continue;
    }
    const s = state.get(best)!;
    s.tasks += 1;
    s.minutes += cost;
    assignments.push({ taskId: task.id, camaristaId: best });
  }
  return { assignments, unassigned };
}
