// Helpers de formato del panel de despachos (Fase 9) — mismo criterio que
// licitaciones/lib/format.ts: funciones puras, sin estado, probadas con vitest
// aparte de cualquier componente.
import type { ClosePeriodStatus, TaskCategory, TaskStatus } from "./cierre-mensual-client.ts";
import type { EstadoVencimiento, PrioridadVencimiento } from "./vencimientos-client.ts";
import type { DiotTipoOperacion, TablaAplicadaIsr } from "./declaraciones-client.ts";
import type { EstadoMapeoMigracion, TipoMatchMigracion } from "./migracion-catalogo-client.ts";

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

const TABLA_APLICADA_ISR_LABELS: Record<TablaAplicadaIsr, string> = {
  monthly: "ISR PF mensual",
  annual: "ISR PF anual",
  "pm_30%": "ISR PM (30%)",
  pm_resico: "ISR PM RESICO (30% flujo de efectivo)",
};

export function formatTablaAplicadaIsr(tabla: TablaAplicadaIsr): string {
  return TABLA_APLICADA_ISR_LABELS[tabla] ?? tabla;
}

// Catálogo REAL de "tipo de operación" DIOT (Regla 3.10.7 RMF) — NO es la tasa de
// IVA de la factura (esa se ve en las columnas IVA 16%/0%/exento de la tabla; ver
// corrección del hallazgo "DIOT con tasa mal codificada").
const DIOT_TIPO_OPERACION_LABELS: Record<DiotTipoOperacion, string> = {
  "03": "Servicios profesionales",
  "06": "Arrendamiento de inmuebles",
  "85": "Otros",
};

export function formatDiotTipoOperacion(tipo: DiotTipoOperacion): string {
  return DIOT_TIPO_OPERACION_LABELS[tipo] ?? tipo;
}

const TIPO_MATCH_MIGRACION_LABELS: Record<TipoMatchMigracion, string> = {
  exacto: "Exacto",
  alerta_riesgo: "Alerta de riesgo",
  fuzzy: "Aproximado",
  sin_match: "Sin match",
};

export function formatTipoMatchMigracion(tipo: TipoMatchMigracion): string {
  return TIPO_MATCH_MIGRACION_LABELS[tipo] ?? tipo;
}

const ESTADO_MAPEO_MIGRACION_LABELS: Record<EstadoMapeoMigracion, string> = {
  pendiente: "Pendiente",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  editado: "Editado",
};

export function formatEstadoMapeoMigracion(estado: EstadoMapeoMigracion): string {
  return ESTADO_MAPEO_MIGRACION_LABELS[estado] ?? estado;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-MX", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
