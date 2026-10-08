// CFO-07 · formato de cifras del CFO. Una cifra `null` es «sin dato»: se escribe «—», NUNCA «0». Todo sale de los formateadores del dominio
// (`formatoPesos`, `formatoCentavos`, `formatoPct`, ...): sin `toLocale*` (guard de formato único).
import { formatoCentavos, formatoEntero, formatoMinutos, formatoPct, formatoPesos } from "@atiende/domain-restaurantes/cfo";
import type { Cifra, Confianza, TipoValorKpi, VariacionKpi } from "@atiende/domain-restaurantes/cfo";

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
  if (!finito(v.valor)) return "sin base";
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

export const ETIQUETA_CONFIANZA: Readonly<Record<Confianza, string>> = {
  medido: "Medido",
  estimado: "Estimado",
  capturado: "Capturado",
  importado: "SoftRestaurant",
  sin_dato: "Sin dato",
};

const ETIQUETA_CANAL: Readonly<Record<string, string>> = { domicilio: "Domicilio", recoger: "Para recoger" };
const ETIQUETA_SOURCE: Readonly<Record<string, string>> = { web: "En línea", voice: "Voz", whatsapp: "WhatsApp", admin: "Equipo" };
export const etiquetaCanal = (c: string): string => ETIQUETA_CANAL[c] ?? c;
export const etiquetaSource = (s: string): string => ETIQUETA_SOURCE[s] ?? s;
export const etiquetaFormaPago = (f: string): string => (f === "efectivo" ? "Efectivo" : f === "tarjeta" ? "Tarjeta" : "Sin dato");

const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
/** «2026-10-01» o «2026-10» -> «octubre 2026». */
export function etiquetaMes(mes: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(mes);
  return m ? `${MESES_LARGOS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : mes;
}
