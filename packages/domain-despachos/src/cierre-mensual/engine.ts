// Motor de checklist de cierre mensual — puerto de
// `b2b_ai/features/monthly_close/service.py::MonthlyCloseService`. Puro:
// recibe el período y las tareas ya cargados por el repositorio y devuelve
// el resultado; el repositorio es quien persiste (mismo patrón que
// `migracion-catalogo/migrador.ts`: funciones puras de decisión + repo que
// aplica el resultado).
//
// CORRECCIÓN DE FIDELIDAD (documentada, no aplicada en silencio — ver regla
// de la tarea de esta fase): el `close_period()` original NO valida el
// `period.status` actual antes de cerrar — solo revisa que las tareas
// requeridas estén DONE/SKIPPED. Eso permite volver a "cerrar" un período ya
// CLOSED, o cerrar uno OVERDUE sin pasar por ninguna transición explícita
// (confirmado leyendo el código real, no es un caso hipotético: ningún test
// del origen cubre re-cerrar, así que no hay comportamiento intencional que
// preservar). Aquí SÍ se valida: `cerrarPeriodo` lanza si `status ===
// "closed"` — se considera un bug, no una regla fiscal deliberada.
import { CierreValidacionError, PeriodoYaAbiertoError, TareaCierreEstadoInvalidoError } from "../errors.ts";
import type { CloseTemplate, ClosePeriod, ClosePeriodStatus, CloseTask, TaskStatus } from "./types.ts";

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Apertura de período
// ---------------------------------------------------------------------------

export interface NuevaTareaCierre {
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly category: CloseTask["category"];
  /** Keys (de la plantilla) de las tareas de las que depende — el
   * repositorio las resuelve a IDs concretos al insertar, igual que el
   * origen resuelve `depends_on` (keys) a IDs dentro de `open_period`. */
  readonly dependsOnKeys: readonly string[];
  readonly dueDate: string | null;
  readonly autoCheckQuery: string | null;
  readonly required: boolean;
  /** `pending` si no depende de nada, `blocked` si sí — decidido aquí (el
   * repositorio no debe re-derivarlo). */
  readonly status: TaskStatus;
}

/** `open_period` (sin la parte de "ya existe un período abierto", que
 * requiere consultar el repositorio — ver `verificarPeriodoNoDuplicado`).
 * Arma las tareas a partir de la plantilla, calculando `dueDate` desde
 * `dueOffsetDays` relativo al día 1 del período (UTC, igual que
 * `date(year, month, 1) + timedelta(days=due_offset_days)`). */
export function construirTareasDesdePlantilla(anio: number, mes: number, template: CloseTemplate): readonly NuevaTareaCierre[] {
  return template.tasks.map((tt) => {
    let dueDate: string | null = null;
    if (tt.dueOffsetDays) {
      const base = new Date(Date.UTC(anio, mes - 1, 1));
      const due = new Date(base.getTime() + tt.dueOffsetDays * 86_400_000);
      dueDate = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, "0")}-${String(due.getUTCDate()).padStart(2, "0")}`;
    }
    return {
      key: tt.key ?? null,
      title: tt.title,
      description: tt.description,
      category: tt.category,
      dependsOnKeys: tt.dependsOn,
      dueDate,
      autoCheckQuery: tt.autoCheckQuery,
      required: tt.required,
      status: tt.dependsOn.length > 0 ? "blocked" : "pending",
    };
  });
}

/** Puerto de la comprobación anti-duplicado de `open_period` — el
 * repositorio consulta los períodos existentes y llama esto antes de
 * insertar. */
export function verificarPeriodoNoDuplicado(periodosAbiertos: readonly ClosePeriod[], anio: number, mes: number): void {
  const yaAbierto = periodosAbiertos.some((p) => p.year === anio && p.month === mes && p.status === "open");
  if (yaAbierto) throw new PeriodoYaAbiertoError(`Ya existe un período abierto para ${anio}-${String(mes).padStart(2, "0")}`);
}

// ---------------------------------------------------------------------------
// Completar tarea + desbloqueo de dependientes
// ---------------------------------------------------------------------------

function todasDependenciasDone(tasks: ReadonlyMap<string, CloseTask>, dependsOn: readonly string[]): boolean {
  if (dependsOn.length === 0) return true;
  return dependsOn.every((d) => tasks.get(d)?.status === "done");
}

/** `complete_task` — lanza si la tarea ya terminó (`done`/`skipped`) o si
 * alguna dependencia sigue sin `done`. Retorna la lista COMPLETA de tareas
 * actualizada (la tarea marcada `done` + cualquier dependiente que quedó
 * `pending` al desbloquearse). */
export function completarTarea(tasks: readonly CloseTask[], taskId: string, userId: string, now: string): readonly CloseTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const task = byId.get(taskId);
  if (!task) throw new TareaCierreEstadoInvalidoError(`Tarea no encontrada: ${taskId}`);
  if (task.status === "done" || task.status === "skipped") throw new TareaCierreEstadoInvalidoError(`Tarea ya terminada: ${taskId}`);

  for (const depId of task.dependsOn) {
    const dep = byId.get(depId);
    if (dep && dep.status !== "done") throw new TareaCierreEstadoInvalidoError(`Tarea bloqueada: depende de '${dep.title}' sin completar`);
  }

  const actualizada: CloseTask = { ...task, status: "done", completedAt: now, completedBy: userId || null };
  byId.set(taskId, actualizada);

  for (const [id, t] of byId) {
    if (t.status === "blocked" && todasDependenciasDone(byId, t.dependsOn)) {
      byId.set(id, { ...t, status: "pending" });
    }
  }

  return tasks.map((t) => byId.get(t.id)!);
}

// ---------------------------------------------------------------------------
// Auto-check
// ---------------------------------------------------------------------------

/** `_AUTO_CHECK_PASS` — predicados EXACTOS del origen por `autoCheckQuery`. */
const AUTO_CHECK_PASS: Readonly<Record<string, (v: unknown) => boolean>> = {
  cfdi_pending_count: (v) => Number(v ?? 0) === 0,
  cfdi_validacion: (v) => v === true,
  bank_feeds_sync_status: (v) => ["ok", "synced", "completed"].includes(String(v).toLowerCase()),
  nomina_status: (v) => ["ok", "timbrada", "completed"].includes(String(v).toLowerCase()),
  diot_generada: (v) => v === true,
  declaraciones_revisadas: (v) => v === true,
  contabilidad_electronica: (v) => v === true,
  auxiliares_actualizados: (v) => v === true,
  reportes_gerenciales: (v) => v === true,
};

export interface AutoCheckResultado {
  readonly tareas: readonly CloseTask[];
  readonly completadas: readonly CloseTask[];
}

/** `auto_check_tasks` — auto-completa tareas cuyo `autoCheckQuery` tiene un
 * predicado registrado, cuya señal en `moduleState` lo satisface, y cuyas
 * dependencias ya están `done`; desbloquea dependientes en cascada. */
export function autoCheckTareas(tasks: readonly CloseTask[], moduleState: Readonly<Record<string, unknown>>, userId: string, now: string): AutoCheckResultado {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const completadas: CloseTask[] = [];

  for (const t of tasks) {
    const actual = byId.get(t.id)!;
    if (actual.status === "done" || actual.status === "skipped") continue;
    if (!actual.autoCheckQuery) continue;
    if (!todasDependenciasDone(byId, actual.dependsOn)) continue;
    const check = AUTO_CHECK_PASS[actual.autoCheckQuery];
    if (!check) continue;
    const value = moduleState[actual.autoCheckQuery];
    let pasa: boolean;
    try {
      pasa = check(value);
    } catch {
      continue;
    }
    if (!pasa) continue;

    const actualizada: CloseTask = { ...actual, status: "done", completedAt: now, completedBy: userId };
    byId.set(t.id, actualizada);
    completadas.push(actualizada);

    for (const [id, dep] of byId) {
      if (dep.status === "blocked" && todasDependenciasDone(byId, dep.dependsOn)) {
        byId.set(id, { ...dep, status: "pending" });
      }
    }
  }

  return { tareas: tasks.map((t) => byId.get(t.id)!), completadas };
}

// ---------------------------------------------------------------------------
// Overdue / estado del período
// ---------------------------------------------------------------------------

/** `_recompute_overdue` — solo transiciona `open -> overdue` (nunca toca un
 * período ya `closed`), y solo si hay una tarea REQUERIDA vencida en un
 * estado no terminal. */
export function recomputeOverdue(period: ClosePeriod, tasks: readonly CloseTask[], todayIso: string): ClosePeriod {
  const overduePendiente = tasks.some((t) => t.required && t.dueDate && t.dueDate < todayIso && (t.status === "pending" || t.status === "blocked" || t.status === "in_progress"));
  if (period.status === "open" && overduePendiente) {
    return { ...period, status: "overdue" as ClosePeriodStatus };
  }
  return period;
}

export interface EstadoPeriodoCierre {
  readonly totalTasks: number;
  readonly done: number;
  readonly skipped: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly progressPercent: number;
  readonly blocked: readonly CloseTask[];
  readonly overdue: readonly CloseTask[];
}

/** `get_period_status` (parte pura — sin la lectura del período/tareas del
 * repositorio). `progressPercent` cuenta `done+skipped` sobre el total. */
export function calcularEstadoPeriodo(tasks: readonly CloseTask[], todayIso: string): EstadoPeriodoCierre {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  const blocked = tasks.filter((t) => t.status === "blocked");
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < todayIso && (t.status === "pending" || t.status === "blocked" || t.status === "in_progress"));
  const progress = total > 0 ? Math.round(((done + skipped) / total) * 1000) / 10 : 0;
  return {
    totalTasks: total,
    done,
    skipped,
    pending: tasks.filter((t) => t.status === "pending").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    progressPercent: progress,
    blocked,
    overdue,
  };
}

// ---------------------------------------------------------------------------
// Cierre de período
// ---------------------------------------------------------------------------

export interface DecisionCierre {
  readonly puedeCerrar: boolean;
  readonly faltantes: readonly CloseTask[];
}

/** `close_period` — parte de validación: todas las tareas `required` deben
 * estar `done`/`skipped`. */
export function evaluarCierre(tasks: readonly CloseTask[]): DecisionCierre {
  const faltantes = tasks.filter((t) => t.required && t.status !== "done" && t.status !== "skipped");
  return { puedeCerrar: faltantes.length === 0, faltantes };
}

/** `close_period` completo, CON la corrección de fidelidad documentada
 * arriba (rechaza cerrar un período ya `closed`). Lanza `CierreValidacionError`
 * si hay tareas requeridas pendientes o si el período ya está cerrado. */
export function cerrarPeriodo(period: ClosePeriod, tasks: readonly CloseTask[], userId: string, now: string): ClosePeriod {
  if (period.status === "closed") {
    throw new CierreValidacionError(`El período ${period.year}-${String(period.month).padStart(2, "0")} ya está cerrado.`);
  }
  const { puedeCerrar, faltantes } = evaluarCierre(tasks);
  if (!puedeCerrar) {
    throw new CierreValidacionError(`No se puede cerrar: ${faltantes.length} tarea(s) requerida(s) sin completar. Ej: '${faltantes[0]!.title}'`);
  }
  return { ...period, status: "closed", closedAt: now, closedBy: userId || null };
}

// ---------------------------------------------------------------------------
// Reporte de cierre
// ---------------------------------------------------------------------------

export interface ReporteCierre {
  readonly totalTasks: number;
  readonly done: number;
  readonly skipped: number;
  readonly pending: number;
  readonly progressPercent: number;
  readonly doneByCategory: Readonly<Record<string, number>>;
  readonly issues: readonly { readonly taskId: string; readonly title: string; readonly reason: string }[];
  readonly estimatedHours: number;
  readonly closed: boolean;
}

/** `generate_close_report`. `estimatedHours` estima con `completedAt -
 * openedAt` de cada tarea `done` (mismo criterio del origen: usa
 * `period.opened_at` como inicio base para todas, no la hora real de inicio
 * de cada tarea individual). */
export function generarReporteCierre(period: ClosePeriod, tasks: readonly CloseTask[], todayIso: string): ReporteCierre {
  const done = tasks.filter((t) => t.status === "done");
  const skipped = tasks.filter((t) => t.status === "skipped");
  const pending = tasks.filter((t) => t.status === "pending" || t.status === "blocked" || t.status === "in_progress");

  let totalDurationHours = 0;
  const openedAtMs = Date.parse(period.openedAt);
  for (const t of done) {
    if (t.completedAt && !Number.isNaN(openedAtMs)) {
      const completedMs = Date.parse(t.completedAt);
      if (!Number.isNaN(completedMs)) totalDurationHours += Math.max(0, (completedMs - openedAtMs) / 3_600_000);
    }
  }

  const issues = pending.filter((t) => t.dueDate && t.dueDate < todayIso).map((t) => ({ taskId: t.id, title: t.title, reason: "vencida" }));

  const doneByCategory: Record<string, number> = {};
  for (const t of done) doneByCategory[t.category] = (doneByCategory[t.category] ?? 0) + 1;

  return {
    totalTasks: tasks.length,
    done: done.length,
    skipped: skipped.length,
    pending: pending.length,
    progressPercent: tasks.length > 0 ? Math.round(((done.length + skipped.length) / tasks.length) * 1000) / 10 : 0,
    doneByCategory,
    issues,
    estimatedHours: r2(totalDurationHours),
    closed: period.status === "closed",
  };
}

// ---------------------------------------------------------------------------
// Bloqueo de edición de movimientos ya cerrados — funcionalidad NUEVA (ver
// comentario de cabecera): ningún código del origen valida esto.
// ---------------------------------------------------------------------------

export function estaPeriodoCerrado(period: Pick<ClosePeriod, "status"> | null): boolean {
  return period?.status === "closed";
}
