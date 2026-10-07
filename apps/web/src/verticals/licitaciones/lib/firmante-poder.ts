// Semaforo de la vigencia del poder de un firmante (REQ-145): vigente / por vencer / vencido. Pura y con "hoy" inyectado (nunca el reloj
// dentro de la funcion). Es solo la lectura de la pantalla: el servidor decide a la FECHA DEL ACTO (fecha limite de la convocatoria), no a
// la de hoy -- por eso un poder "vigente" aqui puede quedar bloqueado en una propuesta cuya fecha limite cae despues de su vencimiento.

export type PoderEstado = "vigente" | "por_vencer" | "vencido" | "aun_no_vigente" | "sin_vigencia";

/** Ventana de "por vencer" (dias); la misma del aviso de la campana (PODERES_POR_VENCER_DIAS en la API). */
export const PODER_POR_VENCER_DIAS = 30;

export const PODER_LABEL: Readonly<Record<PoderEstado, string>> = {
  vigente: "Poder vigente",
  por_vencer: "Poder por vencer",
  vencido: "Poder vencido",
  aun_no_vigente: "Poder aún no vigente",
  sin_vigencia: "Sin vigencia capturada",
};

export const PODER_TONE: Readonly<Record<PoderEstado, "success" | "warning" | "danger" | "info" | "neutral">> = {
  vigente: "success",
  por_vencer: "warning",
  vencido: "danger",
  aun_no_vigente: "info",
  sin_vigencia: "neutral",
};

const DIA_MS = 86_400_000;
const dayNumber = (isoDate: string): number => Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10))) / DIA_MS;

/** `hoy`, `validFrom` y `validUntil` en "AAAA-MM-DD" (un timestamp se recorta a su fecha). */
export function poderEstado(validFrom: string | null | undefined, validUntil: string | null | undefined, hoy: string): PoderEstado {
  if (!validFrom && !validUntil) return "sin_vigencia";
  const h = dayNumber(hoy);
  if (validFrom && h < dayNumber(validFrom)) return "aun_no_vigente";
  if (validUntil) {
    const hasta = dayNumber(validUntil);
    if (h > hasta) return "vencido";
    if (hasta - h <= PODER_POR_VENCER_DIAS) return "por_vencer";
  }
  return "vigente";
}

/** Dias que faltan para que venza (negativo = ya vencio). `null` sin fecha de termino. */
export function diasParaVencer(validUntil: string | null | undefined, hoy: string): number | null {
  return validUntil ? dayNumber(validUntil) - dayNumber(hoy) : null;
}

/** Fecha de negocio de hoy en la zona del navegador, "AAAA-MM-DD" (sin `toLocale*`). */
export function hoyLocal(ahora: Date = new Date()): string {
  const m = String(ahora.getMonth() + 1).padStart(2, "0");
  const d = String(ahora.getDate()).padStart(2, "0");
  return `${ahora.getFullYear()}-${m}-${d}`;
}

/** "1500000.5" -> "$1,500,000.50"; centavos enteros. Sin `toLocale*String`. `null` -> "—". */
export function formatCentavos(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const negativo = cents < 0;
  const abs = Math.abs(cents);
  const pesos = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, "0");
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}$${miles}.${centavos}`;
}

/** "1500000.50" / "1,500,000" -> centavos enteros. `null` si no es un monto valido (hasta dos decimales). */
export function pesosACentavos(texto: string): number | null {
  const limpio = texto.trim().replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(limpio);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}
