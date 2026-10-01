// Formato de los KPI de voz. Dinero SIEMPRE desde centavos enteros; sin dato = "—", nunca 0.
import { formatMoney } from "@atiende/ui";

export function formatoMxn(centavos: number | null): string {
  if (centavos === null || !Number.isFinite(centavos)) return "—";
  return `$${formatMoney(centavos / 100, 2)} MXN`;
}

export function formatoPct(pct: number | null): string {
  return pct === null || !Number.isFinite(pct) ? "—" : `${pct}%`;
}

export function formatoMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "2026-03-10" -> "10 mar". Se formatea en UTC a propósito: la fecha ya es el día local de la sucursal. */
export function formatoDia(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return fecha;
  return d.toLocaleDateString("es-MX", { timeZone: "UTC", day: "numeric", month: "short" });
}

/** Pesos escritos por la persona -> centavos enteros; null si vacío, `undefined` si inválido. */
export function pesosACentavos(texto: string): number | null | undefined {
  const t = texto.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const centavos = Math.round(Number(t) * 100);
  return centavos >= 1 && centavos <= 100_000_000 ? centavos : undefined;
}

export function etiquetaAlerta(tipo: "costo_dia" | "tasa_error", valor: number, umbral: number): string {
  return tipo === "costo_dia"
    ? `El costo del día (${formatoMxn(valor)}) llegó al umbral de ${formatoMxn(umbral)}.`
    : `La tasa de error de proveedor (${valor}%) llegó al umbral de ${umbral}%.`;
}
