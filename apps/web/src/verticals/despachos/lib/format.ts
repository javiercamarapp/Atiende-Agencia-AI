// Helpers de formato del panel de despachos (Fase 9) — mismo criterio que
// licitaciones/lib/format.ts: funciones puras, sin estado, probadas con vitest
// aparte de cualquier componente.
import { formatMoney as formatMoneyUi } from "@atiende/ui";
import type { ClosePeriodStatus, TaskCategory, TaskStatus } from "./cierre-mensual-client.ts";
import type { EstadoVencimiento, PrioridadVencimiento } from "./vencimientos-client.ts";
import type { DiotTipoOperacion, TablaAplicadaIsr } from "./declaraciones-client.ts";
import type { EstadoMapeoMigracion, TipoMatchMigracion } from "./migracion-catalogo-client.ts";
import type { DireccionCfdi, EstadoSatCfdi } from "./cfdi-client.ts";

/** Monto en pesos (`$1,160.00`); `null` -> guion largo, nunca `$0`. El formato numérico vive en `formatMoney` de @atiende/ui. */
export function formatMoney(value: number | null): string {
  if (value === null) return "—";
  return `${value < 0 ? "-" : ""}$${formatMoneyUi(Math.abs(value))}`;
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

/** Monto en CENTAVOS enteros -> pesos (`$1,160.00`); `null` -> guion largo, nunca `$0`. Sin pasar por flotantes. */
export function formatCentavos(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) return "—";
  const abs = Math.abs(centavos);
  const pesos = Math.trunc(abs / 100);
  const resto = String(abs % 100).padStart(2, "0");
  return `${centavos < 0 ? "-" : ""}$${formatMoneyUi(pesos).replace(/\.\d+$/, "")}.${resto}`;
}

const DIRECCION_CFDI_LABELS: Record<DireccionCfdi, string> = { emitido: "Emitido", recibido: "Recibido", indeterminado: "Sin clasificar" };

export function formatDireccionCfdi(direccion: DireccionCfdi | null | undefined): string {
  return direccion ? (DIRECCION_CFDI_LABELS[direccion] ?? direccion) : "Sin clasificar";
}

const ESTADO_SAT_LABELS: Record<EstadoSatCfdi, string> = { pendiente: "Sin verificar", vigente: "Vigente", cancelado: "Cancelado", no_encontrado: "No encontrado" };

export function formatEstadoSat(estado: EstadoSatCfdi | null | undefined): string {
  return estado ? (ESTADO_SAT_LABELS[estado] ?? estado) : "Sin verificar";
}

export function tonoEstadoSat(estado: EstadoSatCfdi | null | undefined): "success" | "danger" | "warning" | "neutral" {
  if (estado === "vigente") return "success";
  if (estado === "cancelado") return "danger";
  if (estado === "no_encontrado") return "warning";
  return "neutral";
}

/** Estatus de cancelacion que devuelve el SAT -> texto y tono. «En proceso» = el receptor tiene 72 h para aceptar o rechazar. `null` = sin dato. */
export function formatEstatusCancelacion(estatus: string | null | undefined): { readonly texto: string; readonly tono: "warning" | "danger" | "neutral" | "success" } | null {
  const e = (estatus ?? "").trim();
  if (e === "") return null;
  if (/^en proceso/i.test(e)) return { texto: "Cancelación en proceso", tono: "warning" };
  if (/plazo vencido/i.test(e)) return { texto: "Plazo vencido", tono: "neutral" };
  if (/rechaz/i.test(e)) return { texto: "Cancelación rechazada", tono: "success" };
  if (/cancelado/i.test(e)) return { texto: e, tono: "danger" };
  return { texto: e, tono: "neutral" };
}

/** `ValidacionEFOS` del SAT: 200 = el emisor no figura en la lista 69-B; 100 = figura. Cualquier otro valor se muestra tal cual. */
export function formatValidacionEfos(codigo: string | null | undefined): string | null {
  const c = (codigo ?? "").trim();
  if (c === "") return null;
  if (c === "200") return "El emisor no figura en la lista 69-B";
  if (c === "100") return "El emisor figura en la lista 69-B";
  return `Código ${c}`;
}

/** Metodo de pago del CFDI (c_MetodoPago): PUE = pago en una sola exhibicion, PPD = pago en parcialidades o diferido. */
export function formatMetodoPago(codigo: string | null | undefined): string {
  if (!codigo) return "—";
  if (codigo === "PUE") return "PUE · Una sola exhibición";
  if (codigo === "PPD") return "PPD · Parcialidades o diferido";
  return codigo;
}

const FORMAS_PAGO: Record<string, string> = {
  "01": "Efectivo",
  "02": "Cheque nominativo",
  "03": "Transferencia electrónica de fondos",
  "04": "Tarjeta de crédito",
  "28": "Tarjeta de débito",
  "99": "Por definir",
};

export function formatFormaPago(codigo: string | null | undefined): string {
  if (!codigo) return "—";
  return FORMAS_PAGO[codigo] ? `${codigo} · ${FORMAS_PAGO[codigo]}` : codigo;
}

/** Tasa decimal del SAT ("0.160000") -> porcentaje ("16%"). */
export function formatTasaImpuesto(tasa: string | null | undefined): string {
  if (tasa === null || tasa === undefined) return "—";
  const n = Number(tasa);
  if (!Number.isFinite(n)) return tasa;
  return `${Number((n * 100).toFixed(4))}%`;
}
