// Formato compartido del panel de licitaciones — mismo criterio "honesto" que
// citas/lib/format.ts: nunca inventa un valor cuando el dato real no vino.

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Sin presupuesto declarado";
  try {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: currency ?? "MXN", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString("es-MX")} ${currency ?? "MXN"}`;
  }
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const DATE_FORMATTER = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric" });

export function formatDeadline(iso: string | null): string {
  if (!iso) return "Sin fecha límite declarada";
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso));
}

export const TENDER_STATUS_LABELS: Record<string, string> = {
  discovered: "Descubierta",
  in_review: "En revisión",
  go: "Go",
  no_go: "No-go",
  in_progress: "En preparación",
  submitted: "Presentada",
  won: "Ganada",
  lost: "Perdida",
  cancelled: "Cancelada",
};

export function formatTenderStatus(status: string | null): string {
  if (!status) return "Sin estatus";
  return TENDER_STATUS_LABELS[status] ?? status;
}

export const ELIGIBILITY_LABELS: Record<string, string> = {
  cumple: "Cumple",
  no_cumple: "No cumple",
  no_evaluable: "No evaluable",
};

export function formatEligibility(status: string): string {
  return ELIGIBILITY_LABELS[status] ?? status;
}

export const COMPLIANCE_RESULT_LABELS: Record<string, string> = {
  verde: "Verde",
  ambar: "Ámbar",
  rojo: "Rojo",
};

export function formatComplianceResult(result: string): string {
  return COMPLIANCE_RESULT_LABELS[result] ?? result;
}

export const REQUIREMENT_KIND_LABELS: Record<string, string> = {
  tecnico: "Técnico",
  economico: "Económico",
  legal: "Legal",
  administrativo: "Administrativo",
  anexo: "Anexo",
};

export function formatRequirementKind(kind: string): string {
  return REQUIREMENT_KIND_LABELS[kind] ?? kind;
}

export const OBLIGATORIEDAD_LABELS: Record<string, string> = {
  obligatorio: "Obligatorio",
  opcional: "Opcional",
  condicional: "Condicional",
};

export function formatObligatoriedad(value: string): string {
  return OBLIGATORIEDAD_LABELS[value] ?? value;
}

export const REQUIREMENT_STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  en_progreso: "En progreso",
  cumplido: "Cumplido",
  bloqueado: "Bloqueado",
  no_evaluable: "No evaluable",
};

export function formatRequirementStatus(status: string): string {
  return REQUIREMENT_STATUS_LABELS[status] ?? status;
}

// Fase 15 — post-adjudicación (contrato). Espejo de `CONTRACT_STATES`
// (domain-licitaciones/contract-lifecycle.ts).
export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  adjudicado: "Adjudicado",
  contrato_firmado_declarado: "Contrato firmado (declarado)",
  en_ejecucion: "En ejecución",
  entregado: "Entregado",
  facturado: "Facturado",
  pagado: "Pagado",
  cerrado: "Cerrado",
  modificado: "Modificado",
  penalizado: "Penalizado",
  rescindido: "Rescindido",
  en_inconformidad: "En inconformidad",
};

export function formatContractStatus(status: string): string {
  return CONTRACT_STATUS_LABELS[status] ?? status;
}

// Espejo de `ContractFieldKey` (domain-licitaciones/contract-extraction.ts).
export const CONTRACT_FIELD_KEY_LABELS: Record<string, string> = {
  numero_contrato: "Número de contrato",
  monto_total: "Monto total",
  plazo_entrega: "Plazo de entrega",
  garantia_cumplimiento: "Garantía de cumplimiento",
  pena_convencional: "Pena convencional",
  deductiva: "Deductiva",
  forma_pago: "Forma de pago",
  administrador_contrato: "Administrador del contrato",
  cesion_cobro: "Cesión de derechos de cobro",
};

export function formatContractFieldKey(key: string): string {
  return CONTRACT_FIELD_KEY_LABELS[key] ?? key;
}

export const CONTRACT_FIELD_STATUS_LABELS: Record<string, string> = {
  sugerido: "Sugerido",
  confirmado: "Confirmado",
  corregido: "Corregido",
};

export function formatContractFieldStatus(status: string): string {
  return CONTRACT_FIELD_STATUS_LABELS[status] ?? status;
}
