// Parser determinista de colonia a partir de la direccion, con un catalogo CONFIGURABLE de colonias de Merida.
// Sin red, sin LLM, sin reloj. El catalogo base es publico (nombres de colonias) y solo un punto de partida: el dueno
// debe validarlo/ampliarlo (`crearCatalogoColonias`). Nunca inventa: si no hay coincidencia clara devuelve `colonia: null`.
import { sinAcentos } from "../product-search.ts";

export interface ColoniaDef {
  /** Nombre canonico que se guarda. */
  readonly nombre: string;
  /** Otras escrituras comunes (se comparan sin acentos ni puntuacion). */
  readonly alias?: readonly string[];
  /** true = nombre generico ("Centro", "Mexico"): solo cuenta con marcador explicito ("Col. Centro") o como segmento propio. */
  readonly debil?: boolean;
}

export const COLONIAS_MERIDA_BASE: readonly ColoniaDef[] = [
  { nombre: "Centro", alias: ["centro historico"], debil: true },
  { nombre: "García Ginerés", alias: ["garcia gineres", "garcia ginere"] },
  { nombre: "Itzimná", alias: ["itzimna"] },
  { nombre: "Montebello" },
  { nombre: "Francisco de Montejo", alias: ["fco de montejo", "fco. de montejo", "francisco montejo"] },
  { nombre: "Altabrisa" },
  { nombre: "Chuburná de Hidalgo", alias: ["chuburna", "chuburna hidalgo"] },
  { nombre: "Santa Gertrudis Copó", alias: ["santa gertrudis copo", "gertrudis copo"] },
  { nombre: "Pensiones", alias: ["col pensiones"], debil: true },
  { nombre: "México", alias: ["mexico norte"], debil: true },
  { nombre: "Jesús Carranza", alias: ["jesus carranza"] },
  { nombre: "Mayapán", alias: ["mayapan"] },
  { nombre: "Vista Alegre" },
  { nombre: "Santa Ana" },
  { nombre: "Santiago" , debil: true },
  { nombre: "San Sebastián", alias: ["san sebastian"] },
  { nombre: "La Ceiba" },
  { nombre: "Cholul" },
  { nombre: "Temozón Norte", alias: ["temozon norte", "temozon"] },
  { nombre: "Montecristo" },
  { nombre: "Ciudad Caucel", alias: ["caucel"] },
  { nombre: "Los Pinos" },
  { nombre: "Gran Santa Fe", alias: ["santa fe"] },
  { nombre: "Xcumpich" },
  { nombre: "Bojórquez", alias: ["bojorquez"] },
  { nombre: "Salvador Alvarado", alias: ["salvador alvarado sur", "salvador alvarado oriente"] },
  { nombre: "Díaz Ordaz", alias: ["diaz ordaz"] },
  { nombre: "Alemán", alias: ["aleman", "miguel aleman", "nueva aleman"] },
  { nombre: "Campestre" },
  { nombre: "Las Américas", alias: ["las americas"] },
  { nombre: "Cordemex" },
  { nombre: "San Ramón Norte", alias: ["san ramon norte", "san ramon"] },
  { nombre: "Cámara de Comercio Norte", alias: ["camara de comercio norte", "camara de comercio"] },
  { nombre: "Yucalpetén", alias: ["yucalpeten"] },
  { nombre: "Residencial Pensiones", alias: ["res pensiones"] },
  { nombre: "Dolores Otero", alias: ["dolores otero"] },
  { nombre: "Chen Ha", alias: ["chen-ha"] },
];

export interface CatalogoColonias {
  /** Texto normalizado (sin acentos/puntuacion) -> definicion. */
  readonly porClave: ReadonlyMap<string, ColoniaDef>;
  /** Claves ordenadas de mas larga a mas corta (la coincidencia mas especifica gana). */
  readonly clavesPorLargo: readonly string[];
}

export function normalizarTextoColonia(t: string): string {
  return sinAcentos(t)
    .replace(/[.,;:()\-_/#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Construye un catalogo: `base` + `extra`. Una entrada de `extra` con el mismo nombre canonico reemplaza a la base. */
export function crearCatalogoColonias(extra: readonly ColoniaDef[] = [], base: readonly ColoniaDef[] = COLONIAS_MERIDA_BASE): CatalogoColonias {
  const canon = new Map<string, ColoniaDef>();
  for (const d of [...base, ...extra]) canon.set(normalizarTextoColonia(d.nombre), d);
  const porClave = new Map<string, ColoniaDef>();
  for (const d of canon.values()) {
    for (const forma of [d.nombre, ...(d.alias ?? [])]) {
      const k = normalizarTextoColonia(forma);
      if (k !== "" && !porClave.has(k)) porClave.set(k, d);
    }
  }
  return { porClave, clavesPorLargo: [...porClave.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b)) };
}

export const CATALOGO_MERIDA: CatalogoColonias = crearCatalogoColonias();

export type ConfianzaColonia = "alta" | "media";
export interface ResultadoColonia {
  readonly colonia: string | null;
  readonly confianza: ConfianzaColonia | null;
  readonly metodo: "marcador_catalogo" | "marcador_libre" | "segmento_catalogo" | "coincidencia_catalogo" | "difusa_catalogo" | "ambigua" | "sin_coincidencia";
}

const MINUSCULAS = new Set(["de", "del", "la", "las", "los", "el", "y"]);
export function titulo(texto: string): string {
  return texto
    .split(" ")
    .filter((p) => p !== "")
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

const MARCADOR = /\b(?:col|colonia|fracc|fraccionamiento|barrio)\s+([a-z0-9 ]{3,60}?)(?=\s+(?:cp|c p|codigo postal|merida|yucatan|yuc|mer)\b|\s+\d{5}\b|$)/;
const PREFIJO_CALLE = /(?:^|\s)(?:calle|c|av|avenida|andador|diagonal|prolongacion|prol|carretera|periferico|privada|priv|circuito|cto)\s*$/;

function distancia(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Un texto que el cliente/CSV dio como "colonia": lo lleva al nombre canonico si el catalogo lo reconoce (exacto o a 1 letra de distancia, unico). */
export function normalizarColonia(texto: string | null | undefined, catalogo: CatalogoColonias = CATALOGO_MERIDA): ResultadoColonia {
  const k = normalizarTextoColonia(texto ?? "");
  if (k === "") return { colonia: null, confianza: null, metodo: "sin_coincidencia" };
  const exacta = catalogo.porClave.get(k);
  if (exacta) return { colonia: exacta.nombre, confianza: "alta", metodo: "marcador_catalogo" };
  if (k.length >= 7) {
    const cercanas = new Set<string>();
    for (const [clave, def] of catalogo.porClave) if (Math.abs(clave.length - k.length) <= 1 && clave.length >= 7 && distancia(clave, k) === 1) cercanas.add(def.nombre);
    if (cercanas.size === 1) return { colonia: [...cercanas][0]!, confianza: "media", metodo: "difusa_catalogo" };
  }
  return { colonia: titulo(k), confianza: "media", metodo: "marcador_libre" };
}

/** Coincidencias del catalogo dentro de un texto normalizado (palabra completa, no precedida de "calle"/"av"...). */
function coincidencias(texto: string, catalogo: CatalogoColonias, incluirDebiles: boolean): ColoniaDef[] {
  const halladas: Array<{ def: ColoniaDef; ini: number; fin: number }> = [];
  for (const clave of catalogo.clavesPorLargo) {
    const def = catalogo.porClave.get(clave)!;
    if (def.debil && !incluirDebiles) continue;
    let desde = 0;
    for (;;) {
      const i = texto.indexOf(clave, desde);
      if (i < 0) break;
      const fin = i + clave.length;
      const limpioIzq = i === 0 || texto[i - 1] === " ";
      const limpioDer = fin === texto.length || texto[fin] === " ";
      if (limpioIzq && limpioDer && !PREFIJO_CALLE.test(texto.slice(0, i)) && !halladas.some((h) => i >= h.ini && fin <= h.fin)) halladas.push({ def, ini: i, fin });
      desde = i + 1;
    }
  }
  const unicas = new Map<string, ColoniaDef>();
  for (const h of halladas) unicas.set(h.def.nombre, h.def);
  return [...unicas.values()];
}

/** Infiere la colonia desde una direccion libre. Determinista; `colonia: null` si no hay coincidencia clara. */
export function inferirColoniaDeDireccion(direccion: string | null | undefined, catalogo: CatalogoColonias = CATALOGO_MERIDA): ResultadoColonia {
  const crudo = direccion ?? "";
  const todo = normalizarTextoColonia(crudo);
  if (todo === "") return { colonia: null, confianza: null, metodo: "sin_coincidencia" };

  const m = MARCADOR.exec(todo);
  if (m) {
    const r = normalizarColonia(m[1], catalogo);
    if (r.colonia !== null) return { ...r, metodo: r.metodo === "marcador_libre" ? "marcador_libre" : "marcador_catalogo" };
  }

  // Segmento propio (separado por coma) que es exactamente una colonia del catalogo: confianza alta, incluso las debiles.
  for (const seg of crudo.split(/[,;|]/).reverse()) {
    const def = catalogo.porClave.get(normalizarTextoColonia(seg));
    if (def) return { colonia: def.nombre, confianza: "alta", metodo: "segmento_catalogo" };
  }

  const fuertes = coincidencias(todo, catalogo, false);
  if (fuertes.length === 1) return { colonia: fuertes[0]!.nombre, confianza: "media", metodo: "coincidencia_catalogo" };
  if (fuertes.length > 1) return { colonia: null, confianza: null, metodo: "ambigua" };
  return { colonia: null, confianza: null, metodo: "sin_coincidencia" };
}
