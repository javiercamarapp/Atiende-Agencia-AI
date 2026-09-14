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
