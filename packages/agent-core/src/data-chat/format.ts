// Formato es-MX de los valores que ve el usuario. Montos SIEMPRE en MXN.
export type ColumnKind = "text" | "integer" | "mxn" | "percent" | "decimal";

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const int = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** Redondeo a centavos sin errores de punto flotante visibles. */
export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatMxn(n: number): string {
  return `${mxn.format(roundMoney(n))} MXN`;
}

export function formatCell(kind: ColumnKind, value: string | number | null): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  switch (kind) {
    case "mxn":
      return formatMxn(value);
    case "integer":
      return int.format(value);
    case "percent":
      return `${dec.format(value)}%`;
    case "decimal":
      return dec.format(value);
    default:
      return String(value);
  }
}
