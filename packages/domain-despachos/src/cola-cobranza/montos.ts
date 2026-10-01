// D-11 -- aritmetica de dinero en CENTAVOS enteros MXN. Nunca se suman pesos con decimales flotantes: se
// convierte una vez (`pesosACentavos`) y todo lo demas es entero. `invoice.total` (numeric(14,2)) llega como
// numero de pesos; aqui se normaliza.
export const MAX_CENTAVOS = 99_999_999_999_999;

export function pesosACentavos(pesos: number): number {
  if (!Number.isFinite(pesos)) throw new RangeError("pesosACentavos: se esperaba un numero finito.");
  return Math.round(pesos * 100);
}

export function esCentavosValidos(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor >= 1 && valor <= MAX_CENTAVOS;
}

/** "$1,160.00 MXN" a partir de centavos enteros (division entera, sin flotantes). */
export function formatearCentavosMxn(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) throw new RangeError("formatearCentavosMxn: se esperaban centavos enteros.");
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.trunc(abs / 100);
  const resto = String(abs % 100).padStart(2, "0");
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}$${miles}.${resto} MXN`;
}
