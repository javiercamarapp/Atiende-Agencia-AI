import { formatMoney } from "@atiende/ui";

/** Monto de una fila del tablero: pesos enteros sin decimales («$286», como el original) y con centavos solo cuando los hay («$345.50»). */
export function montoFila(total: number): string {
  return `$${formatMoney(total, Number.isInteger(total) ? 0 : 2)}`;
}
