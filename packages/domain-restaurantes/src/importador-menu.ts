// Importador de menu (alta autoservicio): de un PDF/imagen (extraccion por modelo de vision) o de un CSV a un BORRADOR estructurado
// de categorias, productos, precios y paquetes que el dueño revisa ANTES de guardar. Puro: sin base ni red.
//
// Reglas (nunca inventar ni corregir en silencio):
//   * un precio que no se pudo leer queda en null y el producto lleva la duda `sin_precio` (no se puede guardar sin precio);
//   * un precio fuera de lo comun (< $1 o > $3,000) lleva `precio_inusual`, se guarda solo si el dueño lo deja;
//   * productos repetidos (mismo nombre y categoria, sin acentos ni mayusculas) llevan `duplicado`;
//   * sin categoria va a «Sin clasificar» con `sin_categoria`.
// Paquetes/combos: el catalogo de restaurantes NO tiene tabla de paquetes (migraciones 001/023); un paquete se guarda como un producto
// normal de su categoria (por omision «Paquetes») con su precio y la descripcion «Incluye: ...», que es lo que lee el agente.
import { sinAcentos } from "./product-search.ts";

export const MAX_PRODUCTOS_IMPORTACION = 300;
export const CATEGORIA_SIN_CLASIFICAR = "Sin clasificar";
export const CATEGORIA_PAQUETES = "Paquetes";
export const PRECIO_INUSUAL = { min: 1, max: 3000 } as const;

export type DudaImportacion = "sin_precio" | "precio_inusual" | "duplicado" | "sin_categoria";

export interface BorradorProducto {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  /** Pesos con hasta 2 decimales; null = no se pudo leer. */
  readonly precio: number | null;
  readonly esPaquete: boolean;
  /** Solo paquetes: lo que incluye (texto corto por elemento). */
  readonly incluye: readonly string[];
  readonly dudas: readonly DudaImportacion[];
}

export interface BorradorMenu {
  readonly categorias: readonly string[];
  readonly productos: readonly BorradorProducto[];
  /** Filas o elementos que no se pudieron interpretar (para avisar, nunca para guardar). */
  readonly ilegibles: number;
  /** true = habia mas de MAX_PRODUCTOS_IMPORTACION y se recorto. */
  readonly recortado: boolean;
}

/** JSON Schema estricto (responseFormat del gateway) que debe devolver el modelo de extraccion. */
export const ESQUEMA_EXTRACCION_MENU: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["productos"],
  properties: {
    productos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nombre", "categoria", "descripcion", "precio", "esPaquete", "incluye"],
        properties: {
          nombre: { type: "string" },
          categoria: { type: "string" },
          descripcion: { type: ["string", "null"] },
          precio: { type: ["number", "null"] },
          esPaquete: { type: "boolean" },
          incluye: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const PROMPT_EXTRACCION_MENU = [
  "Eres un capturista de menus de restaurantes en Mexico. Te paso el menu (imagen o PDF).",
  "Devuelve SOLO JSON con la lista `productos` en el orden en que aparecen. Para cada platillo, bebida, extra o paquete:",
  "- nombre: tal como aparece (sin precio).",
  "- categoria: la seccion del menu donde aparece (ej. «Tacos», «Bebidas»); si no hay seccion, cadena vacia.",
  "- descripcion: el texto descriptivo si lo hay; si no, null.",
  "- precio: en pesos, como numero (ej. 125.5). Si NO se lee con certeza o no aparece, null. NUNCA lo inventes ni lo estimes.",
  "- esPaquete: true si es combo, paquete, promocion con varios elementos o menu del dia; incluye: lo que trae (si no es paquete, []).",
  "Si un platillo tiene varios tamaños con precio distinto, devuelve un producto por tamaño (ej. «Agua de horchata chica», «… grande»).",
  "Ignora telefonos, direcciones, horarios, redes sociales y avisos legales.",
].join("\n");

const CORTE = 160;

function limpiarTexto(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function clave(nombre: string, categoria: string): string {
  return `${sinAcentos(categoria.toLowerCase())}|${sinAcentos(nombre.toLowerCase())}`;
}

/** "$1,250.00", "1250", "120 pesos", "MXN 99.5", "1.250,50" -> numero; vacio o ilegible -> null. */
export function parsearPrecio(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000 ? Math.round(raw * 100) / 100 : null;
  if (typeof raw !== "string") return null;
  let t = raw.replace(/mxn|pesos?|m\.?n\.?|\$/gi, "").replace(/\s+/g, "");
  if (!t || !/^\d[\d.,]*$/.test(t)) return null;
  // Formato europeo 1.250,50 -> 1250.50; miles con coma 1,250.00 -> 1250.00; decimal con coma 99,5 -> 99.5.
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : null;
}

interface Crudo {
  nombre: string;
  categoria: string;
  descripcion: string | null;
  precio: number | null;
  esPaquete: boolean;
  incluye: string[];
}

/** Arma el borrador con las dudas, sin corregir nada. */
export function armarBorrador(crudos: readonly Crudo[], ilegibles = 0): BorradorMenu {
  const vistos = new Set<string>();
  const productos: BorradorProducto[] = [];
  let ilegiblesTotal = ilegibles;
  for (const c of crudos) {
    const nombre = limpiarTexto(c.nombre, CORTE);
    if (nombre.length < 2) {
      ilegiblesTotal += 1;
      continue;
    }
    const incluye = c.incluye.map((i) => limpiarTexto(i, 120)).filter((i) => i.length > 0).slice(0, 20);
    const esPaquete = c.esPaquete || incluye.length > 0;
    const catOriginal = limpiarTexto(c.categoria, 120);
    const categoria = catOriginal || (esPaquete ? CATEGORIA_PAQUETES : CATEGORIA_SIN_CLASIFICAR);
    const dudas: DudaImportacion[] = [];
    if (c.precio === null) dudas.push("sin_precio");
    else if (c.precio < PRECIO_INUSUAL.min || c.precio > PRECIO_INUSUAL.max) dudas.push("precio_inusual");
    if (!catOriginal && !esPaquete) dudas.push("sin_categoria");
    const k = clave(nombre, categoria);
    if (vistos.has(k)) dudas.push("duplicado");
    vistos.add(k);
    const descripcionBase = c.descripcion ? limpiarTexto(c.descripcion, 1500) : "";
    const descripcion = esPaquete && incluye.length > 0 ? [descripcionBase, `Incluye: ${incluye.join(", ")}.`].filter(Boolean).join(" ") : descripcionBase || null;
    productos.push({ nombre, categoria, descripcion, precio: c.precio, esPaquete, incluye, dudas });
  }
  const recortado = productos.length > MAX_PRODUCTOS_IMPORTACION;
  const final = productos.slice(0, MAX_PRODUCTOS_IMPORTACION);
  const categorias: string[] = [];
  for (const p of final) if (!categorias.includes(p.categoria)) categorias.push(p.categoria);
  return { categorias, productos: final, ilegibles: ilegiblesTotal, recortado };
}

/** Valida la salida del modelo (JSON del responseFormat). Nunca confia en ella: tipos, cortes y precios se revisan aqui. */
export function borradorDesdeExtraccion(salida: unknown): BorradorMenu {
  let datos: unknown = salida;
  if (typeof salida === "string") {
    try {
      datos = JSON.parse(salida.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return armarBorrador([], 1);
    }
  }
  const lista = datos && typeof datos === "object" && Array.isArray((datos as { productos?: unknown }).productos) ? ((datos as { productos: unknown[] }).productos) : [];
  let ilegibles = 0;
  const crudos: Crudo[] = [];
  for (const item of lista.slice(0, MAX_PRODUCTOS_IMPORTACION * 2)) {
    if (!item || typeof item !== "object") {
      ilegibles += 1;
      continue;
    }
    const o = item as Record<string, unknown>;
    crudos.push({
      nombre: limpiarTexto(o.nombre, CORTE),
      categoria: limpiarTexto(o.categoria, 120),
      descripcion: typeof o.descripcion === "string" ? o.descripcion : null,
      precio: parsearPrecio(o.precio),
      esPaquete: o.esPaquete === true,
      incluye: Array.isArray(o.incluye) ? o.incluye.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return armarBorrador(crudos, ilegibles);
}

/** Separa una linea CSV respetando comillas dobles ("a, b" y "" escapada). */
function separarLineaCsv(linea: string, sep: string): string[] {
  const celdas: string[] = [];
  let actual = "";
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i]!;
    if (enComillas) {
      if (ch === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (ch === '"') enComillas = false;
      else actual += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === sep) {
      celdas.push(actual);
      actual = "";
    } else actual += ch;
  }
  celdas.push(actual);
  return celdas.map((c) => c.trim());
}

const ALIAS_COLUMNAS: Readonly<Record<keyof Crudo, readonly string[]>> = {
  nombre: ["nombre", "producto", "platillo", "articulo", "item", "name"],
  categoria: ["categoria", "seccion", "grupo", "category"],
  descripcion: ["descripcion", "detalle", "description"],
  precio: ["precio", "costo", "importe", "price"],
  esPaquete: ["paquete", "combo", "es paquete"],
  incluye: ["incluye", "contenido"],
};

/** CSV/TSV con encabezado (nombre, precio obligatorios; categoria, descripcion, paquete, incluye opcionales; separador , ; o tab). */
export function borradorDesdeCsv(texto: string): BorradorMenu {
  const lineas = texto.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lineas.length === 0) return armarBorrador([], 0);
  const encabezado = lineas[0]!;
  const sep = encabezado.includes("\t") ? "\t" : (encabezado.match(/;/g)?.length ?? 0) > (encabezado.match(/,/g)?.length ?? 0) ? ";" : ",";
  const columnas = separarLineaCsv(encabezado, sep).map((c) => sinAcentos(c.toLowerCase()));
  const indice = (campo: keyof Crudo) => columnas.findIndex((c) => ALIAS_COLUMNAS[campo].includes(c));
  const iNombre = indice("nombre");
  const iPrecio = indice("precio");
  if (iNombre < 0 || iPrecio < 0) return armarBorrador([], lineas.length);
  const iCat = indice("categoria");
  const iDesc = indice("descripcion");
  const iPaq = indice("esPaquete");
  const iIncl = indice("incluye");
  const crudos: Crudo[] = [];
  for (const linea of lineas.slice(1, MAX_PRODUCTOS_IMPORTACION * 2 + 1)) {
    const celdas = separarLineaCsv(linea, sep);
    const celda = (i: number) => (i >= 0 ? (celdas[i] ?? "") : "");
    const paq = sinAcentos(celda(iPaq).toLowerCase());
    crudos.push({
      nombre: celda(iNombre),
      categoria: celda(iCat),
      descripcion: celda(iDesc) || null,
      precio: parsearPrecio(celda(iPrecio)),
      esPaquete: ["si", "s", "x", "1", "true", "yes"].includes(paq),
      incluye: celda(iIncl) ? celda(iIncl).split(/[|+;]/) : [],
    });
  }
  return armarBorrador(crudos, 0);
}

export interface ProductoAGuardar {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  readonly precio: number;
}

export class ImportacionMenuInvalida extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportacionMenuInvalida";
  }
}

/** Valida lo que el dueño aprobo en la pantalla de revision (lo que se guarda). Lanza ImportacionMenuInvalida con un mensaje legible. */
export function validarImportacionAprobada(body: unknown): ProductoAGuardar[] {
  const lista = body && typeof body === "object" && Array.isArray((body as { productos?: unknown }).productos) ? (body as { productos: unknown[] }).productos : null;
  if (!lista || lista.length === 0) throw new ImportacionMenuInvalida("No hay productos que guardar.");
  if (lista.length > MAX_PRODUCTOS_IMPORTACION) throw new ImportacionMenuInvalida(`Máximo ${MAX_PRODUCTOS_IMPORTACION} productos por importación.`);
  const salida: ProductoAGuardar[] = [];
  lista.forEach((item, i) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const nombre = limpiarTexto(o.nombre, CORTE);
    const categoria = limpiarTexto(o.categoria, 120) || CATEGORIA_SIN_CLASIFICAR;
    if (nombre.length < 2) throw new ImportacionMenuInvalida(`Fila ${i + 1}: el nombre es obligatorio.`);
    const precio = typeof o.precio === "number" ? parsearPrecio(o.precio) : null;
    if (precio === null) throw new ImportacionMenuInvalida(`Fila ${i + 1} («${nombre}»): falta un precio válido.`);
    const descripcion = typeof o.descripcion === "string" && o.descripcion.trim() ? limpiarTexto(o.descripcion, 2000) : null;
    salida.push({ nombre, categoria, descripcion, precio });
  });
  return salida;
}

/** Slug de categoria compatible con `SLUG_PATTERN` de admin-catalog (^[a-z0-9]+(-[a-z0-9]+)*$). */
export function slugCategoria(nombre: string): string {
  const s = sinAcentos(nombre.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .join("-")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s || "categoria";
}

export { clave as claveProductoImportacion };
