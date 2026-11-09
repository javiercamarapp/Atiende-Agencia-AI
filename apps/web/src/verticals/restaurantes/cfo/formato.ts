// CFO-07 · formato de cifras del CFO. Una cifra `null` es «sin dato»: se escribe «—», NUNCA «0». Todo sale de los formateadores del dominio
// (`formatoPesos`, `formatoCentavos`, `formatoPct`, ...): sin `toLocale*` (guard de formato único).
import { formatoCentavos, formatoEntero, formatoMinutos, formatoPct, formatoPesos } from "@atiende/domain-restaurantes/cfo";
import type { Cifra, Confianza, TipoValorKpi, VariacionKpi } from "@atiende/domain-restaurantes/cfo";
import { etiquetasTraducidas, idiomaActivo, traductorActivo } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";

const tr = traductorActivo(restaurantesCfo);

export const SIN_DATO = "—";

const formatoPuntos = (p: number): string => (Number.isInteger(p) ? String(p) : p.toFixed(1));
const finito = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** Centavos -> «$1,235» (pesos enteros). */
export const pesos = (c: number | null | undefined): string => (finito(c) ? formatoPesos(c) : SIN_DATO);
/** Centavos -> «$1,234.56». */
export const pesosExactos = (c: number | null | undefined): string => (finito(c) ? formatoCentavos(c) : SIN_DATO);
export const entero = (n: number | null | undefined): string => (finito(n) ? formatoEntero(n) : SIN_DATO);
export const porcentaje = (n: number | null | undefined): string => (finito(n) ? formatoPct(n) : SIN_DATO);
export const minutos = (n: number | null | undefined): string => (finito(n) ? formatoMinutos(n) : SIN_DATO);

export function textoValor(tipo: TipoValorKpi, valor: number | null | undefined): string {
  switch (tipo) {
    case "centavos": return pesos(valor);
    case "pct": return porcentaje(valor);
    case "minutos": return minutos(valor);
    case "entero": return entero(valor);
  }
}

export const textoCifra = (c: Cifra | null | undefined, tipo: TipoValorKpi): string => (c ? textoValor(tipo, c.valor) : SIN_DATO);

/** «+12.3 %», «−2.1 pp», «+3 min»; null = «sin base». */
export function textoVariacion(v: VariacionKpi): string {
  if (!finito(v.valor)) return tr("restaurantes.cfo.sinBase");
  const signo = v.valor > 0 ? "+" : v.valor < 0 ? "−" : "";
  const abs = Math.abs(v.valor);
  switch (v.tipo) {
    case "pct": return `${signo}${formatoPct(abs)}`;
    case "pp": return `${signo}${formatoPuntos(abs)} pp`;
    case "minutos": return `${signo}${formatoMinutos(abs)}`;
  }
}

export type TonoVariacion = "bueno" | "malo" | "neutro";

export function tonoVariacion(v: VariacionKpi, mejorSi: "mayor" | "menor" | "neutral"): TonoVariacion {
  if (!finito(v.valor) || v.valor === 0 || mejorSi === "neutral") return "neutro";
  const sube = v.valor > 0;
  return sube === (mejorSi === "mayor") ? "bueno" : "malo";
}

/** Etiquetas en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre. */
export const ETIQUETA_CONFIANZA: Readonly<Record<Confianza, string>> = etiquetasTraducidas<Confianza>(
  ["medido", "estimado", "capturado", "importado", "sin_dato"],
  (c) => `restaurantes.cfo.confianza.${c}` as const,
  restaurantesCfo,
);

const ETIQUETA_CANAL = etiquetasTraducidas<"domicilio" | "recoger">(["domicilio", "recoger"], (c) => `restaurantes.cfo.canal.${c}` as const, restaurantesCfo);
const ETIQUETA_SOURCE = etiquetasTraducidas<"web" | "voice" | "whatsapp" | "admin">(["web", "voice", "whatsapp", "admin"], (s) => `restaurantes.cfo.source.${s}` as const, restaurantesCfo);
export const etiquetaCanal = (c: string): string => (Object.hasOwn(ETIQUETA_CANAL, c) ? ETIQUETA_CANAL[c as "domicilio"] : c);
export const etiquetaSource = (s: string): string => (Object.hasOwn(ETIQUETA_SOURCE, s) ? ETIQUETA_SOURCE[s as "web"] : s);
export const etiquetaFormaPago = (f: string): string => tr(f === "efectivo" ? "restaurantes.cfo.pago.efectivo" : f === "tarjeta" ? "restaurantes.cfo.pago.tarjeta" : "restaurantes.cfo.pago.sinDato");

const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
const MESES_LARGOS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** «2026-10-01» o «2026-10» -> «octubre 2026» («October 2026» en ingles). */
export function etiquetaMes(mes: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(mes);
  if (!m) return mes;
  return idiomaActivo() === "en" ? `${MESES_LARGOS_EN[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : `${MESES_LARGOS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;

}

