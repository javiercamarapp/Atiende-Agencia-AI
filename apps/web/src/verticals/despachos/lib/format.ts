// Helpers de formato del panel de despachos (Fase 9) — mismo criterio que
// licitaciones/lib/format.ts: funciones puras, sin estado, probadas con vitest
// aparte de cualquier componente.
import type { ClosePeriodStatus, TaskCategory, TaskStatus } from "./cierre-mensual-client.ts";
import type { EstadoVencimiento, PrioridadVencimiento } from "./vencimientos-client.ts";

const MXN_FORMATTER = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

export function formatMoney(value: number | null): string {
  if (value === null) return "—";
  return MXN_FORMATTER.format(value);
}

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function formatPeriodo(year: number, month: number): string {
  return `${MESES[month] ?? month} ${year}`;
}

const PERIOD_STATUS_LABELS: Record<ClosePeriodStatus, string> = { open: "Abierto", closed: "Cerrado", overdue: "Vencido" };

export function formatPeriodStatus(status: ClosePeriodStatus): string {
  return PERIOD_STATUS_LABELS[status] ?? status;
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = { pending: "Pendiente", in_progress: "En progreso", blocked: "Bloqueada", done: "Completada", skipped: "Omitida" };

export function formatTaskStatus(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = { cfdi: "CFDI", bank: "Bancos", nomina: "Nómina", declaracion: "Declaraciones", electronica: "Contabilidad electrónica", custom: "General" };

export function formatTaskCategory(category: TaskCategory): string {
  return TASK_CATEGORY_LABELS[category] ?? category;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "numeric" });
}

const PRIORIDAD_VENCIMIENTO_LABELS: Record<PrioridadVencimiento, string> = { critica: "Crítica", alta: "Alta", media: "Media", baja: "Baja" };

export function formatPrioridadVencimiento(prioridad: PrioridadVencimiento): string {
  return PRIORIDAD_VENCIMIENTO_LABELS[prioridad] ?? prioridad;
}

const ESTADO_VENCIMIENTO_LABELS: Record<EstadoVencimiento, string> = {
  pendiente: "Pendiente",
  en_proceso: "En proceso",
  completado: "Completado",
  vencido: "Vencido",
  escalado: "Escalado",
};

export function formatEstadoVencimiento(estado: EstadoVencimiento): string {
  return ESTADO_VENCIMIENTO_LABELS[estado] ?? estado;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-MX", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
