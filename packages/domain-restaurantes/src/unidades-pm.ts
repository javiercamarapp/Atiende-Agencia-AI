// PAQUETE A (PM): tabla de unidades por orden y desambiguación orden / kilo / pieza.
// Datos confirmados por Javier (21-oct-2026) y por los chats de PM; SIN precios. Funciones puras: no tocan la base ni el modelo.
// La herramienta de cotización sigue siendo la autoridad (pack_size del menú); esto es la regla de apoyo para validar y para armar la pregunta.
import { sinAcentos } from "./product-search.ts";

export type FamiliaUnidadPm = {
  readonly familia: string;
  readonly patron: RegExp;
  /** Piezas que trae UNA orden (1 = se vende individual / una pieza por orden). */
  readonly piezasPorOrden: number;
  /** true si la cifra es aproximada: nunca se usa para convertir piezas a órdenes. */
  readonly aproximado: boolean;
};

// El orden importa: lo específico antes que el taco de pastor (la gringa de pastor, la flauta de pastor y el quesobich de pastor no son tacos sueltos).
export const TABLA_UNIDADES_PM: readonly FamiliaUnidadPm[] = [
  { familia: "flauta", patron: /\bflautas?\b/, piezasPorOrden: 1, aproximado: false },
  { familia: "quesobich", patron: /\bquesobich\b|\bpizza\b/, piezasPorOrden: 1, aproximado: false },
  { familia: "gringa", patron: /\bgringas?\b/, piezasPorOrden: 2, aproximado: false },
  { familia: "mestiza", patron: /\bmestizas?\b/, piezasPorOrden: 2, aproximado: false },
  { familia: "quesadilla", patron: /\bquesadillas?\b/, piezasPorOrden: 3, aproximado: false },
  { familia: "alitas", patron: /\balitas?\b/, piezasPorOrden: 7, aproximado: false },
  { familia: "crujientes", patron: /\bcrujientes?\b/, piezasPorOrden: 12, aproximado: true },
  { familia: "tacos-3", patron: /\btacos?\b.*\b(?:bistec|chuleta|arrachera|pollo|pechuga)\b/, piezasPorOrden: 3, aproximado: false },
  { familia: "taco-pastor", patron: /\btacos?\b.*\bpastor\b/, piezasPorOrden: 1, aproximado: false },
];

export function familiaUnidadPm(nombreProducto: string): FamiliaUnidadPm | null {
  const n = sinAcentos(nombreProducto).toLowerCase();
  return TABLA_UNIDADES_PM.find((f) => f.patron.test(n)) ?? null;
}

export type AnalisisPiezas =
  | { readonly tipo: "ok"; readonly ordenes: number; readonly piezasPorOrden: number }
  | { readonly tipo: "no_multiplo"; readonly piezasPorOrden: number; readonly opciones: readonly number[] }
  | { readonly tipo: "aproximado"; readonly piezasPorOrden: number }
  | { readonly tipo: "sin_dato" }
  | { readonly tipo: "invalida" };

/** El cliente pidió `piezas` de un producto: ¿son órdenes completas? Nunca redondea por su cuenta: devuelve las opciones para preguntar. */
export function analizarPiezasPedidas(nombreProducto: string, piezas: number): AnalisisPiezas {
  if (!Number.isInteger(piezas) || piezas < 1) return { tipo: "invalida" };
  const f = familiaUnidadPm(nombreProducto);
  if (!f) return { tipo: "sin_dato" };
  if (f.aproximado) return { tipo: "aproximado", piezasPorOrden: f.piezasPorOrden };
  const n = f.piezasPorOrden;
  if (piezas % n === 0) return { tipo: "ok", ordenes: piezas / n, piezasPorOrden: n };
  const lower = Math.floor(piezas / n) * n;
  const upper = Math.ceil(piezas / n) * n;
  return { tipo: "no_multiplo", piezasPorOrden: n, opciones: lower >= n ? [lower, upper] : [upper] };
}

/** Piezas que suman N órdenes (3 órdenes de gringas = 6). null si la tabla no lo sabe o es aproximado. */
export function piezasDeOrdenes(nombreProducto: string, ordenes: number): number | null {
  const f = familiaUnidadPm(nombreProducto);
  if (!f || f.aproximado || !Number.isInteger(ordenes) || ordenes < 1) return null;
  return ordenes * f.piezasPorOrden;
}

export type MedidaClasificada = {
  readonly medida: "kilo" | "orden" | "pieza" | "ambigua" | "sin_medida";
  readonly kg?: number;
  readonly cantidad?: number;
  readonly pregunta?: string;
};

const NUMEROS: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const CARNE = /\b(?:pastor|bistec|arrachera|chuleta|pechuga|pollo|costilla|poc[ -]?chuc)\b/;

function cantidadDe(token: string | undefined): number | null {
  if (!token) return null;
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMEROS[token] ?? null;
}

/** Clasifica cómo mide el cliente lo que pide: kilo, orden o pieza. Lo dudoso es «ambigua» con la pregunta que debe hacer el agente. */
export function clasificarMedida(texto: string): MedidaClasificada {
  const t = sinAcentos(texto).toLowerCase().replace(/\s+/g, " ").trim();
  if (/\bmedia orden\b/.test(t)) {
    return { medida: "ambigua", pregunta: "¿Media orden del platillo (solo hay de nachos y frijoles charros) o medio kilo de carne?" };
  }
  if (/\bkilo y medio\b|\b1 ?1\/2 ?(?:kg|kilos?)\b|\b1\.5 ?(?:kg|kilos?)\b/.test(t)) return { medida: "kilo", kg: 1.5 };
  if (/\b(?:1\/4|un cuarto|cuarto)\b/.test(t) && (CARNE.test(t) || /kilo/.test(t))) return { medida: "kilo", kg: 0.25 };
  if (/\b(?:3\/4|tres cuartos)\b/.test(t) && (CARNE.test(t) || /kilo/.test(t))) return { medida: "kilo", kg: 0.75 };
  if (/\b(?:1\/2|medio|medio kilo|500 ?g)\b/.test(t) && (CARNE.test(t) || /kilo|\bkg\b/.test(t)) && !/\borden(?:es)?\b/.test(t)) return { medida: "kilo", kg: 0.5 };
  const kilos = t.match(/\b(\d+|un|una|uno|dos|tres|cuatro|cinco)\s*(?:kilos?|kgs?)\b/);
  if (kilos) return { medida: "kilo", kg: cantidadDe(kilos[1]) ?? undefined };
  const ordenes = t.match(/\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis)\s+orden(?:es)?\s+de\s+(.+)/) ?? t.match(/\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis)\s+orden(?:es)?\b/);
  if (ordenes) {
    const resto = ordenes[2] ?? "";
    // «una orden de pastor» a secas: el pastor es individual, no hay «orden» de N tacos.
    if (/^pastor\b/.test(resto) || /^tacos? (?:de |al )?pastor\b/.test(resto)) {
      return { medida: "ambigua", cantidad: cantidadDe(ordenes[1]) ?? undefined, pregunta: "El pastor se vende por taco: ¿cuántos tacos de pastor quiere?" };
    }
    return { medida: "orden", cantidad: cantidadDe(ordenes[1]) ?? undefined };
  }
  if (/\buna orden de pastor\b/.test(t)) return { medida: "ambigua", pregunta: "El pastor se vende por taco: ¿cuántos tacos de pastor quiere?" };
  const piezas = t.match(/\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:tacos?|gringas?|mestizas?|quesadillas?|flautas?|alitas?|piezas?)\b/);
  if (piezas) return { medida: "pieza", cantidad: cantidadDe(piezas[1]) ?? undefined };
  return { medida: "sin_medida" };
}
