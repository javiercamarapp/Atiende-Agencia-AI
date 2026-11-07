// Importador de menu desde TEXTO o JSON (Fase A). Determinista y puro: devuelve el menu normalizado MAS las dudas para la pantalla de
// revision (nunca inventa un precio ni lo corrige en silencio). La vision (imagen/PDF) es solo una interfaz con adaptador falso: el
// adaptador real extrae TEXTO y ese texto pasa por el mismo importador.
import type { MenuConfig, ProductoConfig } from "./tipos.ts";

export type TipoDuda = "sin_precio" | "precio_invalido" | "precio_inusual" | "sin_categoria" | "duplicado" | "linea_ilegible" | "json_invalido" | "alias_choque";

export interface DudaImportacion {
  readonly tipo: TipoDuda;
  /** Producto o linea de origen (para marcar la celda en la pantalla de revision). */
  readonly referencia: string;
  readonly detalle: string;
}

export interface ResultadoImportacion {
  readonly menu: MenuConfig;
  readonly dudas: readonly DudaImportacion[];
  /** Productos sin ninguna duda: se pueden aceptar en bloque. */
  readonly limpios: number;
}

export const CATEGORIA_SIN_CLASIFICAR = "Sin clasificar";
const PRECIO_INUSUAL = 3000;

const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const limpiar = (s: string): string => s.replace(/\s+/g, " ").replace(/[\s.·…_\-–—:]+$/u, "").trim();

/** "$65", "65.00", "1,250", "65 pesos" -> 65 / 1250; `null` si no es un monto. Los centavos distintos de cero no se redondean: devuelven NaN (duda). */
export function parsearPrecio(raw: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:pesos|mxn|MXN)?$/i.exec(raw.trim());
  if (!m) return null;
  const entero = Number(m[1]!.replace(/,/g, ""));
  const cent = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  return cent === 0 ? entero : Number.NaN;
}

interface Crudo {
  nombre: string;
  categoria: string | null;
  precio: number | null | undefined;
  precioTexto?: string;
  descripcion?: string | null;
  alias?: readonly string[];
  esAlcohol?: boolean;
  origen: string;
}

function normalizar(crudos: readonly Crudo[], categoriasDeclaradas: readonly string[], dudasPrevias: DudaImportacion[]): ResultadoImportacion {
  const dudas: DudaImportacion[] = [...dudasPrevias];
  const conDuda = new Set<string>();
  const marca = (d: DudaImportacion): void => {
    dudas.push(d);
    conDuda.add(d.referencia);
  };
  const productos: ProductoConfig[] = [];
  const vistos = new Map<string, number>();
  const aliasVisto = new Map<string, string>();
  const categorias: string[] = [];
  const addCat = (c: string): void => {
    if (!categorias.some((x) => norm(x) === norm(c))) categorias.push(c);
  };
  for (const c of categoriasDeclaradas) addCat(c);
  for (const r of crudos) {
    const nombre = limpiar(r.nombre);
    if (!nombre) {
      marca({ tipo: "linea_ilegible", referencia: r.origen, detalle: "Producto sin nombre." });
      continue;
    }
    let categoria = r.categoria ? limpiar(r.categoria) : "";
    if (!categoria) {
      categoria = CATEGORIA_SIN_CLASIFICAR;
      marca({ tipo: "sin_categoria", referencia: nombre, detalle: "No se detecto categoria; quedo en «Sin clasificar»." });
    }
    addCat(categoria);
    let precio = 0;
    if (r.precio === undefined || r.precio === null) {
      marca({ tipo: "sin_precio", referencia: nombre, detalle: r.precioTexto ? `No se entendio el precio «${r.precioTexto}».` : "Sin precio." });
    } else if (!Number.isFinite(r.precio) || !Number.isInteger(r.precio) || r.precio <= 0) {
      marca({ tipo: "precio_invalido", referencia: nombre, detalle: `Precio ${Number.isNaN(r.precio) ? `«${r.precioTexto ?? "?"}» (centavos)` : String(r.precio)} no es un entero positivo en pesos.` });
    } else {
      precio = r.precio;
      if (precio > PRECIO_INUSUAL) marca({ tipo: "precio_inusual", referencia: nombre, detalle: `Precio ${precio} inusualmente alto; confirmar.` });
    }
    const clave = `${norm(categoria)}|${norm(nombre)}`;
    if (vistos.has(clave)) {
      marca({ tipo: "duplicado", referencia: nombre, detalle: `Repetido en la categoria «${categoria}»; se conservo el primero.` });
      continue;
    }
    vistos.set(clave, productos.length);
    const alias: string[] = [];
    for (const al of r.alias ?? []) {
      const a = norm(al);
      if (!a) continue;
      const dueno = aliasVisto.get(a);
      if (dueno && dueno !== nombre) marca({ tipo: "alias_choque", referencia: nombre, detalle: `El alias «${al}» ya es de «${dueno}».` });
      else {
        aliasVisto.set(a, nombre);
        alias.push(a);
      }
    }
    productos.push({ nombre, categoria, descripcion: r.descripcion ?? null, precio, ...(alias.length ? { alias } : {}), ...(r.esAlcohol ? { esAlcohol: true } : {}) });
  }
  const limpios = productos.filter((p) => !conDuda.has(p.nombre)).length;
  return { menu: { categorias, productos }, dudas, limpios };
}

const LINEA_PRECIO = /^(.*?)(?:\s*[.·…_\-–—:]{1,}\s*|\s+)(\$?\s*\d[\d,]*(?:[.,]\d{1,2})?)\s*(?:pesos|mxn)?\s*$/iu;

/**
 * Texto libre: una linea por renglon. Linea SIN precio y corta = encabezado de categoria; linea con precio al final = producto
 * («Taco de pastor ..... $25», «Gringa - 65», «Agua 15.00»). Una linea con numero pero ilegible va a dudas.
 */
export function importarMenuDesdeTexto(texto: string): ResultadoImportacion {
  const crudos: Crudo[] = [];
  const dudas: DudaImportacion[] = [];
  let categoria: string | null = null;
  const encabezados: string[] = [];
  const lineas = texto.split(/\r?\n/);
  lineas.forEach((linea, i) => {
    const l = linea.replace(/^[\s\-*•·]+/u, "").trim();
    if (!l) return;
    const m = LINEA_PRECIO.exec(l);
    if (m && limpiar(m[1]!)) {
      const precioTexto = m[2]!.trim();
      const p = parsearPrecio(precioTexto);
      crudos.push({ nombre: m[1]!, categoria, precio: p, precioTexto, origen: `linea ${i + 1}` });
      return;
    }
    if (/\d/.test(l) && l.length > 40) {
      dudas.push({ tipo: "linea_ilegible", referencia: `linea ${i + 1}`, detalle: `No se pudo leer: «${l.slice(0, 60)}».` });
      return;
    }
    const encabezado = l.replace(/^#+\s*/, "").replace(/[:：]\s*$/, "");
    if (encabezado.length <= 40 && !/\d/.test(encabezado)) {
      categoria = limpiar(encabezado);
      encabezados.push(categoria);
      return;
    }
    // Texto con nombre pero sin precio: producto sin precio.
    crudos.push({ nombre: l, categoria, precio: null, origen: `linea ${i + 1}` });
  });
  // Un encabezado sin ningun producto debajo puede ser un producto SIN precio mal leido como categoria: nunca se descarta en silencio.
  for (const h of encabezados) {
    if (!crudos.some((c) => c.categoria !== null && norm(c.categoria) === norm(h))) {
      dudas.push({ tipo: "sin_precio", referencia: h, detalle: `«${h}» se leyó como categoría sin productos; si es un producto, falta su precio.` });
    }
  }
  return normalizar(crudos, [], dudas);
}

interface JsonProducto {
  nombre?: unknown;
  name?: unknown;
  categoria?: unknown;
  category?: unknown;
  precio?: unknown;
  price?: unknown;
  descripcion?: unknown;
  alias?: unknown;
  esAlcohol?: unknown;
}

function aCrudo(p: JsonProducto, categoriaPadre: string | null, origen: string): Crudo {
  const nombre = typeof p.nombre === "string" ? p.nombre : typeof p.name === "string" ? p.name : "";
  const cat = typeof p.categoria === "string" ? p.categoria : typeof p.category === "string" ? p.category : categoriaPadre;
  const pr = p.precio ?? p.price;
  let precio: number | null | undefined;
  let precioTexto: string | undefined;
  if (typeof pr === "number") precio = Number.isInteger(pr) ? pr : Number.NaN;
  else if (typeof pr === "string") {
    precioTexto = pr;
    precio = parsearPrecio(pr);
  }
  return {
    nombre,
    categoria: cat,
    precio,
    ...(precioTexto !== undefined ? { precioTexto } : {}),
    descripcion: typeof p.descripcion === "string" ? p.descripcion : null,
    alias: Array.isArray(p.alias) ? p.alias.filter((x): x is string => typeof x === "string") : [],
    esAlcohol: p.esAlcohol === true,
    origen,
  };
}

/** JSON: arreglo de productos, `{productos:[...]}` o `{categorias:[{nombre, productos:[...]}]}`. Cualquier otra forma = duda `json_invalido`. */
export function importarMenuDesdeJson(texto: string): ResultadoImportacion {
  const vacio: ResultadoImportacion = { menu: { categorias: [], productos: [] }, dudas: [], limpios: 0 };
  let data: unknown;
  try {
    data = JSON.parse(texto);
  } catch {
    return { ...vacio, dudas: [{ tipo: "json_invalido", referencia: "json", detalle: "No es JSON valido." }] };
  }
  const crudos: Crudo[] = [];
  const cats: string[] = [];
  const raiz = data as { productos?: unknown; categorias?: unknown } | unknown[] | null;
  if (Array.isArray(raiz)) raiz.forEach((p, i) => crudos.push(aCrudo((p ?? {}) as JsonProducto, null, `producto ${i + 1}`)));
  else if (raiz && typeof raiz === "object" && Array.isArray(raiz.productos)) raiz.productos.forEach((p, i) => crudos.push(aCrudo((p ?? {}) as JsonProducto, null, `producto ${i + 1}`)));
  else if (raiz && typeof raiz === "object" && Array.isArray(raiz.categorias)) {
    raiz.categorias.forEach((c, ci) => {
      const cat = (c ?? {}) as { nombre?: unknown; productos?: unknown };
      const nombreCat = typeof cat.nombre === "string" ? cat.nombre : null;
      if (nombreCat) cats.push(nombreCat);
      if (Array.isArray(cat.productos)) cat.productos.forEach((p, i) => crudos.push(aCrudo((p ?? {}) as JsonProducto, nombreCat, `categoria ${ci + 1} producto ${i + 1}`)));
    });
  } else return { ...vacio, dudas: [{ tipo: "json_invalido", referencia: "json", detalle: "Forma no reconocida (arreglo, {productos} o {categorias})." }] };
  return normalizar(crudos, cats, []);
}

// --- Vision: solo interfaz ------------------------------------------------------------------------------------------------------------

export interface FuenteMenu {
  readonly tipo: "imagen" | "pdf";
  readonly nombre: string;
  readonly bytes: Uint8Array;
}

/** Adaptador de vision: devuelve el menu transcrito COMO TEXTO (el que leeria `importarMenuDesdeTexto`). El real (modelo de vision, tope de costo
 * por importacion, revision humana obligatoria) queda para A4b; aqui solo existe el falso. */
export interface AdaptadorVision {
  transcribirMenu(fuente: FuenteMenu): Promise<string>;
}

export class AdaptadorVisionFalso implements AdaptadorVision {
  readonly llamadas: string[] = [];
  constructor(private readonly respuestas: Readonly<Record<string, string>>) {}
  async transcribirMenu(fuente: FuenteMenu): Promise<string> {
    this.llamadas.push(fuente.nombre);
    const r = this.respuestas[fuente.nombre];
    if (r === undefined) throw new Error(`AdaptadorVisionFalso: sin respuesta para «${fuente.nombre}».`);
    return r;
  }
}

/** Unifica varias fuentes (fotos/PDF): cada una pasa por el adaptador y por el importador de texto; las dudas conservan la fuente. */
export async function importarMenuDesdeVision(adaptador: AdaptadorVision, fuentes: readonly FuenteMenu[]): Promise<ResultadoImportacion> {
  const partes: ResultadoImportacion[] = [];
  for (const f of fuentes) {
    const r = importarMenuDesdeTexto(await adaptador.transcribirMenu(f));
    partes.push({ ...r, dudas: r.dudas.map((d) => ({ ...d, referencia: `${f.nombre}: ${d.referencia}` })) });
  }
  return combinar(partes);
}

export function combinar(partes: readonly ResultadoImportacion[]): ResultadoImportacion {
  const crudos: Crudo[] = [];
  const dudas: DudaImportacion[] = partes.flatMap((p) => p.dudas);
  const cats: string[] = [];
  for (const p of partes) {
    cats.push(...p.menu.categorias);
    for (const x of p.menu.productos) crudos.push({ nombre: x.nombre, categoria: x.categoria, precio: x.precio > 0 ? x.precio : null, descripcion: x.descripcion ?? null, alias: x.alias ?? [], esAlcohol: x.esAlcohol === true, origen: x.nombre });
  }
  const r = normalizar(crudos, cats, []);
  // Las dudas de producto ya vinieron en cada parte; solo agrega las nuevas (duplicados entre fuentes).
  const nuevas = r.dudas.filter((d) => d.tipo === "duplicado" || d.tipo === "alias_choque");
  return { menu: r.menu, dudas: [...dudas, ...nuevas], limpios: r.limpios };
}
