// Rn-P3-06 -- despacho por canal. Solo Airbnb tiene parser; Booking.com y Vrbo responden "formato no soportado todavia": sin un export
// real verificable no se inventan columnas (se agrega el parser cuando exista la fixture).
import { RentasDomainError } from "../../errors.ts";
import { parsearReporteAirbnb } from "./airbnb.ts";
import type { ResultadoParseoReporte } from "./tipos.ts";

export const CANALES_CON_REPORTE_CSV = ["airbnb"] as const;

export function parsearReportePagos(canalCodigo: string, texto: string): ResultadoParseoReporte {
  if (canalCodigo === "airbnb") return parsearReporteAirbnb(texto);
  throw new RentasDomainError(
    "formato_reporte_no_soportado",
    `El reporte de pagos del canal "${canalCodigo}" todavia no esta soportado: por ahora solo se importa el de Airbnb. Registra los pagos de ese canal a mano.`,
  );
}

export { LIMITES_REPORTE } from "./tipos.ts";
export type { ErrorFilaReporte, LineaReporteCanal, ResultadoParseoReporte } from "./tipos.ts";
