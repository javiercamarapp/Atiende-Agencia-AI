// Formato de dinero de las paginas de hoteles (PR-6 del plan de diseno-ux, F-05): las 7 copias de
// `formatMoney` locales (Dashboard, Cfdi, CfdiListado, Folio, Pl, Reservas y `fmtMoney` de Revenue)
// delegan en el unico `formatMoney` de @atiende/ui y solo conservan el prefijo "$" y el signo, para
// que la salida sea byte a byte la de antes.
import { formatMoney } from "@atiende/ui";

/** `$1,234.50` — prefijo "$" fijo, 2 decimales. Igual que el `$${n.toLocaleString("es-MX", {min/max 2})}` de Cfdi/CfdiListado/Folio/Reservas (un negativo sale `$-5.00`, como siempre). */
export function dineroMx(n: number): string {
  return `$${formatMoney(n)}`;
}

/** Moneda MXN con el signo ANTES del "$" (`-$1,234.50`), igual que `toLocaleString("es-MX", { style: "currency", currency: "MXN" })` de Dashboard/Pl/Revenue; `decimals` 0 o 2. */
export function dineroMxConSigno(n: number, decimals: 0 | 2 = 2): string {
  // Intl conserva el signo aunque el valor redondee a cero (-0.4 con 0 decimales -> "-$0"): se replica tal cual.
  return `${n < 0 ? "-" : ""}$${formatMoney(Math.abs(n), decimals)}`;
}
