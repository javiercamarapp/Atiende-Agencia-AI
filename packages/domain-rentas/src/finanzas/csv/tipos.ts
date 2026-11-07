// Rn-P3-06 -- tipos comunes de los parsers del reporte de pagos de una OTA. Sin IO.
import { createHash } from "node:crypto";

/** Una linea del reporte ya normalizada (dinero en centavos enteros, nunca decimales). `huella` identifica la linea de forma estable:
 *  volver a subir el mismo archivo produce las mismas huellas (idempotencia). */
export interface LineaReporteCanal {
  /** Numero de fila en el archivo (1 = encabezado), solo para mostrar errores. */
  readonly fila: number;
  /** `reserva`: pago de una reserva con monto >= 0. `ajuste`: cualquier otra cosa (resolucion, impuesto, devolucion, monto negativo):
   *  nunca se convierte en movimiento solo, queda en la cola de revision. */
  readonly tipoLinea: "reserva" | "ajuste";
  readonly codigoConfirmacion: string | null;
  /** `YYYY-MM-DD` solo si la fecha del archivo es inequivoca; si no, `null` (la huella usa el texto original). */
  readonly fecha: string | null;
  readonly moneda: string;
  /** Lo que el canal deposita al anfitrion por esta linea (Airbnb: "Paid out"). */
  readonly montoNetoCentavos: number;
  /** Ingreso bruto de la reserva si el reporte lo trae ("Gross earnings"); `null` si no. */
  readonly montoBrutoCentavos: number | null;
  /** Comision del canal implicita (bruto - neto) si hay bruto >= neto; `null` si no se puede derivar. */
  readonly comisionCanalCentavos: number | null;
  readonly tipoOriginal: string;
  readonly huella: string;
}

export interface ErrorFilaReporte {
  readonly fila: number;
  readonly motivo: string;
}

export interface ResultadoParseoReporte {
  readonly lineas: readonly LineaReporteCanal[];
  /** Filas informativas que no son pagos de reserva ni ajustes (p. ej. el renglon "Payout" de la transferencia bancaria). */
  readonly ignoradas: number;
  readonly errores: readonly ErrorFilaReporte[];
}

export const LIMITES_REPORTE = { maxBytes: 2 * 1024 * 1024, maxFilas: 5000, maxColumnas: 60, maxLongitudCampo: 2000 } as const;

export function huellaLinea(canalCodigo: string, partes: readonly string[]): string {
  return createHash("sha256").update([canalCodigo, ...partes].join("\u001f")).digest("hex");
}

/** Convierte un monto de texto ("1,234.50", "-12", "99.9") a centavos. Estricto: solo digitos, separador de miles `,` bien formado y
 *  punto decimal; cualquier otra cosa (letras, simbolos, formato europeo) devuelve `null` en vez de adivinar. */
export function centavosDesdeTextoMonto(texto: string): number | null {
  const t = texto.trim();
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,6})?$/.test(t)) return null;
  const limpio = t.replace(/,/g, "");
  const negativo = limpio.startsWith("-");
  const sinSigno = negativo ? limpio.slice(1) : limpio;
  const [entera = "0", dec = ""] = sinSigno.split(".");
  const mil = BigInt(entera) * 1000n + BigInt((dec + "000").slice(0, 3));
  const cociente = mil / 10n;
  const redondeado = (mil % 10n) * 2n >= 10n ? cociente + 1n : cociente;
  const n = Number(redondeado);
  if (!Number.isSafeInteger(n)) return null;
  return negativo ? -n : n;
}
