// Búsqueda de producto (herramienta buscar_producto) portada del cerebro «suelto»: create-order-core.ts
// (tokenizeForProductSearch, buscarProductosConExtrasCore y su cierre: normalización, «cero cero / 0.0 / sin alcohol»,
// relajada de adjetivos, platillos vs piezas, «con X» extras, otros productos, presentaciones, erratas, ranking) y
// resultadoBuscarProducto de whatsapp-agent-core.ts (commit e69279e). Se portó TAL CUAL (93 rondas medidas); los únicos
// cambios: el SELECT de branch_products se volvió el parámetro `filas`/`catalogo` (puro), y `any` pasó a tipos.
// Se engancha ANTES del modelo, como ejecución de la herramienta buscar_producto (y de la de voz).

/** Producto del catálogo como lo trae branch_products + products + categories. */
export interface ProductoFila {
  id: string;
  name: string;
  description: string | null;
  search_keywords: string[];
  categories: { name: string | null } | null;
}

/** Fila de la sucursal (branch_products). */
export interface Fila {
  price: number;
  is_available: boolean;
  products: ProductoFila;
}

/** Entrada de la API pública: el catálogo de UNA sucursal, ya con su precio. */
/** Fila con su puntaje de relevancia (menor = más relevante) y su orden en el catálogo. */
interface Ordenado {
  r: Fila;
  orden: number;
  puntaje: number;
}

export interface ProductoCatalogo {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  price: number;
  available?: boolean;
  /** Alias de búsqueda (products.search_keywords). */
  searchKeywords?: readonly string[] | null;
}

export interface OpcionesBusqueda {
  /** true (por omisión): devuelve la forma de resultadoBuscarProducto (lista o { productos, extras_disponibles, otros_productos }). */
  conExtras?: boolean;
}

/** Catálogo de la API pública -> filas internas (las no disponibles no entran, como el `.eq("is_available", true)`). */
export function filasDeCatalogo(catalogo: readonly ProductoCatalogo[]): Fila[] {
  return catalogo
    .filter((p) => p.available !== false)
    .map((p) => ({
      price: Number(p.price),
      is_available: true,
      products: {
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        search_keywords: [...(p.searchKeywords ?? [])],
        categories: { name: p.category ?? null },
      },
    }));
}

/**
 * Lo que ve el agente de buscar_producto: sin extras ni otros productos, la lista de siempre; si el cliente pidió «con X» de
 * un extra con costo u otro producto del menú, `{ productos, extras_disponibles, otros_productos? }`.
 */
export function resultadoBuscarProducto(busqueda: BusquedaConExtras): ProductoEncontrado[] | BusquedaConExtras {
  return busqueda.extras_disponibles.length > 0 || (busqueda.otros_productos?.length ?? 0) > 0 ? busqueda : busqueda.productos;
}

/** API pública pura: resultados ordenados por relevancia para `consulta` en el catálogo de una sucursal. */
export function buscarEnCatalogo(consulta: string, catalogo: readonly ProductoCatalogo[], opciones: { conExtras: false }): ProductoEncontrado[];
export function buscarEnCatalogo(consulta: string, catalogo: readonly ProductoCatalogo[], opciones?: OpcionesBusqueda): ProductoEncontrado[] | BusquedaConExtras;
export function buscarEnCatalogo(consulta: string, catalogo: readonly ProductoCatalogo[], opciones: OpcionesBusqueda = {}): ProductoEncontrado[] | BusquedaConExtras {
  const filas = filasDeCatalogo(catalogo);
  if (opciones.conExtras === false) return buscarProductosEnFilas(filas, consulta);
  return resultadoBuscarProducto(buscarProductosConExtrasEnFilas(filas, consulta));
}


// Bug real confirmado el 3-sep-2026 (auditoría de voz, 9 agentes): "cerveza
// Sol" y "coctel Margarita" devolvían CERO resultados pese a que "Sol" y
// "Margarita" sí están disponibles — el match es AND de todos los tokens
// contra products.name, y "cerveza"/"coctel" nunca aparecen literalmente en
// el nombre real (los productos se llaman "Sol", "Indio", "Margarita", no
// "Cerveza Sol"). El agente terminó diciéndole al cliente que no había
// cervezas ni cócteles disponibles, siendo falso — se sumaron estas palabras
// de categoría a las stopwords, igual que ya se hace con conectores, para
// que solo el nombre real de la bebida entre al match.
const STOPWORDS_BUSQUEDA = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "y",
  "con",
  "para",
  // «bistec por kilo»: «por» no es palabra del producto y, como token corto, casaba con descripciones
  // («...por pieza») y dejaba fuera el «Bistec de Res — 1 kg» (ciego C3: PED-07 r3).
  "por",
  // «6 piezas de pastor» (ronda 15): «piezas» cuenta unidades, ningun nombre del menu la lleva.
  "pieza",
  "piezas",
  "pza",
  "pzas",
  "pz",
  // «un kilo de bistec por favor»: «favor» no es producto y con el Y estricto vaciaba la busqueda.
  "favor",
  "porfa",
  "porfavor",
  // «pastor gracias»: la cortesia al final vaciaba la busqueda con el Y estricto (quinta revision PR #21).
  "gracias",
  "grax",
  "plis",
  "please",
  "al",
  "quiero",
  "quisiera",
  "dame",
  "deme",
  "ponme",
  "agrega",
  "añade",
  // Saludos/verbos de relleno de un mensaje real («hola, agrégame 2 litros de coca»).
  "hola",
  // «dos tacos de pastor y también una coca» (revisión 19): «también» une partes, no es producto; dejaba la parte vacía.
  "también",
  "tambien",
  "pon",
  "agregame",
  "agrégame",
  "ocupo",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "dieciseis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  // «parrillada para 4 personas»: «personas» nunca esta en el nombre («Parrillada para 4») y con el
  // Y estricto la busqueda volvia vacia: el agente decia que no existia y se perdia un pedido de $4,180
  // (ciego C1: ESC-09).
  "persona",
  "personas",
  "comensales",
  "gente",
  "cerveza",
  "cervezas",
  // «dos chelas» (revisión 19): es «cerveza» (categoria); como palabra casaba el «Vaso de Chelada» exacto.
  "chela",
  "chelas",
  "coctel",
  "cocteles",
  "cóctel",
  "cócteles",
]);

// Tokenizador compartido de buscar_producto (voz vía buscar-producto/index.ts
// y WhatsApp vía whatsapp-agent-core.ts) — antes cada canal tenía su propia
// copia duplicada de esta lógica (riesgo real de que un fix se aplicara a
// un canal y no al otro, señalado en la auditoría del 3-sep-2026).
//
// Dos gaps reales encontrados DESPUÉS de la tokenización básica, verificando
// en vivo con curl: (1) "tacos al pastor" (plural, como diría un cliente
// real) no encontraba "Taco Al Pastor (individual)" — el catálogo mezcla
// nombres en singular y en plural, y el ILIKE exacto de "tacos" no es
// substring de "Taco"; (2) "500g"/"1kg" (pegado, sin espacio, como lo
// escribiría el modelo o un cliente) no encontraba "Arrachera — 500 g" —
// el nombre real SIEMPRE lleva espacio antes de la unidad.
/** Minúsculas y sin acentos: «frances» encuentra «Francés». Los clientes casi nunca escriben tildes. */
export function plegarBusqueda(texto: string): string {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * «sin alcohol» no es palabra de ningun nombre: en el menu es la cerveza «0.0». Solo se usa como SEGUNDO
 * intento (si «sin alcohol» aparece literal en alguna descripcion, la busqueda directa gana).
 */
export function sinonimosDeBusqueda(query: string): string {
  return corregirErratasAlcohol(query).replace(/\bsin\s+alcohol\b/gi, "0.0");
}

/**
 * «cerveza/chela sin alcohol» (se habla de cerveza) es siempre la 0.0; «Margarita sin Alcohol» es otra cosa.
 * «cerveza/chela cero» tambien (antes caia al Sprite Cero); «cerveza cero cero» lo resuelve mapearCeroCero.
 */
function cervezaSinAlcohol(query: string): string {
  return query
    .replace(/\b(?:cervezas?|chelas?|cheves?)\s+sin\s+alcohol\b/gi, "0.0")
    .replace(/\b(?:cervezas?|chelas?|cheves?)\s+cero\b(?!\s+(?:punto\s+)?cero\b)/gi, "0.0")
    // «heineken cero», «una heineken y una heineken cero» (ronda 18): la marca de cerveza con «cero» es su 0.0 (antes
    // «cero» no casaba nada y la parte salia vacia). «sprite cero» no es cerveza: sigue siendo el Sprite Cero.
    .replace(new RegExp(`\\b(${MARCAS_DE_CERVEZA})\\s+cero\\b(?!\\s+(?:punto\\s+)?cero\\b)`, "gi"), "$1 0.0");
}

const MARCAS_DE_CERVEZA = "heineken|tecate|corona|modelo|victoria|sol|indio|xx|amstel|bohemia|ceiba|patito|superior|ojo rojo";

// Solo palabras de CERVEZA (marcas del menu y genericas): «coca 0 0» o «sprite cero cero» no son la Heineken 0.0.
const CONTEXTO_CERVEZA_CERO =
  /\b(?:cervezas?|chelas?|cheves?|heineken|tecate|corona|modelo|victoria|sol|indio|xx|amstel|bohemia|ceiba|patito|superior|ojo rojo|micheladas?|cheladas?|stout|lager)\b/i;

// «cero cero», «cero punto cero», «00», «0 0», «0,0» -> «0.0». «sin alcohol» de una cerveza ya llega como «0.0».
function mapearCeroCero(texto: string): string {
  return texto
    // «0 punto 0», «cero punto 0» (ronda 15): igual que «cero punto cero».
    .replace(/(?<![\p{L}\p{N}.,])(?:cero|0)\s+punto\s+(?:cero|0)(?![\p{L}\p{N}.,])/gu, "0.0")
    .replace(/\bcero\s+(?:punto\s+)?cero\b/g, "0.0")
    .replace(/(?<![\d.,])0\s?[.,]?\s?0(?![\d.,])/g, "0.0");
}

// La consulta trae «cero cero»/«00»/«0 0»/«0.0» (lo pidio «sin alcohol» en version cero).
function pideCeroCero(texto: string): boolean {
  return /(?<![\d.,])0\.0(?![\d.,])/.test(mapearCeroCero(String(texto ?? "").toLowerCase()));
}

// La consulta sin el «cero cero»: «tecate cero cero» y «tecate 0 0» buscan los dos la Tecate.
function quitarCeroCero(texto: string): string {
  return mapearCeroCero(String(texto ?? "").toLowerCase()).replace(/(?<![\d.,])0\.0(?![\d.,])/g, " ");
}

// «sin <ingrediente>» («sin cebolla», «sin cebolla ni cilantro», «sin cebolla y cilantro») es una nota de
// preparacion para la linea del pedido, no parte del nombre: se quita de la busqueda. LISTA BLANCA (revision PR
// #21 ronda 4): solo se quita si TODO lo que sigue al «sin» es un ingrediente/condimento de esta lista. Cualquier
// otro «sin X» («sin alcohol», «sin azúcar», «sin soda», «sin topo chico», una errata) se queda en la consulta:
// la exacta lo busca tal cual y, si no hay nada, la relajada lo suelta COMPLETO y marca aproximado, sin devolver
// nunca el producto que lleva lo excluido. Con la lista negra anterior cada palabra nueva era un hueco.
// «papas» queda fuera a proposito: tambien es producto.
const INGREDIENTES_DE_PREPARACION = new Set([
  "cebolla", "cebollita", "cebollin", "cilantro", "verdura", "salsa", "chile", "picante", "limon", "tomate", "jitomate",
  "repollo", "col", "lechuga", "frijol", "queso", "crema", "aguacate", "guacamole", "grasa", "sal", "pina", "hielo",
  "mayonesa", "mostaza", "catsup", "ketchup", "chicharron", "rabano", "pepino", "habanero", "ajo", "aderezo", "nada",
  // «con todo» / «con todito» (Mérida: con todo lo de siempre: cebolla, cilantro, salsa): nota, no producto.
  "todo", "todito",
]);
// Solo cuentan DESPUES de un ingrediente de la lista («sin salsa verde», «sin chile habanero»).
const MODIFICADORES_DE_INGREDIENTE = new Set([
  "verde", "verdes", "roja", "rojas", "rojo", "rojos", "morada", "morado", "blanca", "blanco", "asada", "asado", "frita",
  "frito", "extra", "mucho", "mucha", "muchos", "muchas",
]);
// Palabras que cierran lo que sigue a un «sin» (la frase excluida es lo que va del «sin» a la primera de estas).
const CIERRE_DE_FRASE_SIN = new Set(["y", "e", "ni", "o", "con", "sin", "por", "favor", "porfa", "porfavor", "para", "pero", "de", "del", "al"]);
const ARTICULOS_FRASE_SIN = new Set(["el", "la", "los", "las", "lo"]);
// Lo excluido y sus equivalentes: «limonada sin soda» tampoco es la «con Topo Chico» (las dos llevan agua mineral).
const EXCLUSIONES_EQUIVALENTES: string[][] = [["soda", "topo chico"]];

function esIngredienteDePreparacion(palabra: string): boolean {
  const w = plegarBusqueda(palabra);
  return INGREDIENTES_DE_PREPARACION.has(w) ||
    (w.endsWith("es") && INGREDIENTES_DE_PREPARACION.has(w.slice(0, -2))) ||
    (w.endsWith("s") && INGREDIENTES_DE_PREPARACION.has(w.slice(0, -1)));
}

/** «alcool», «alcol», «alcoholl», «alchol»: todas son «alcohol» (erratas reales; antes «sol sin alcool» devolvia la Sol). */
export function corregirErratasAlcohol(texto: string): string {
  return String(texto ?? "").replace(/(?<!\p{L})alc\p{L}{0,4}l(?!\p{L})/giu, "alcohol");
}

interface FraseSin {
  inicio: number;
  fin: number;
  /** true = todo lo excluido es ingrediente de preparacion (se quita de la busqueda). */
  preparacion: boolean;
  /** Cada elemento excluido (plegado: «topo chico», «soda»), su posicion y si es preparacion («sin hielo ni azúcar»: hielo si, azúcar no). */
  elementos: Array<{ inicio: number; fin: number; preparacion: boolean; texto: string }>;
}

/**
 * Frases «sin X [ni Y] [y Z]» del texto (ya en minusculas), con su posicion y si son solo preparacion. Con
 * `disparador: "con"` son las «con X [y Z]» (nota de cocina si todo X/Z es de preparacion).
 */
function frasesSin(
  texto: string,
  disparador: "sin" | "con" = "sin",
  esIngrediente: (palabra: string) => boolean = esIngredienteDePreparacion,
): FraseSin[] {
  const toks = [...texto.matchAll(/[\p{L}\p{N}]+(?:[.,]\p{N}+)?|[,;.!?()/]/gu)].map((m) => ({
    t: plegarBusqueda(m[0]),
    i: m.index ?? 0,
    f: (m.index ?? 0) + m[0].length,
  }));
  const frases: FraseSin[] = [];
  // Un elemento: palabras seguidas hasta un cierre, numero o puntuacion. Devuelve [palabras, indice siguiente, fin, inicio].
  const elemento = (j: number): [string[], number, number, number] => {
    const palabras: string[] = [];
    let fin = -1;
    let inicio = -1;
    while (j < toks.length && ARTICULOS_FRASE_SIN.has(toks[j]!.t) && palabras.length === 0) j++;
    while (j < toks.length && /^\p{L}+$/u.test(toks[j]!.t)) {
      // «sin salsa de piña», «sin crema de ajo»: el «de» une un ingrediente compuesto si lo que va antes y lo que
      // sigue son ingredientes; si no («sin salsa de pastor»), cierra la frase y el pastor es el producto.
      if (
        (toks[j]!.t === "de" || toks[j]!.t === "del") && palabras.length > 0 &&
        esIngrediente(palabras[palabras.length - 1]!) &&
        j + 1 < toks.length && esIngrediente(toks[j + 1]!.t)
      ) {
        j++;
        continue;
      }
      if (CIERRE_DE_FRASE_SIN.has(toks[j]!.t)) break;
      if (palabras.length === 0) inicio = toks[j]!.i;
      palabras.push(toks[j]!.t);
      fin = toks[j]!.f;
      j++;
    }
    return [palabras, j, fin, inicio];
  };
  const esPreparacion = (palabras: string[]) =>
    palabras.length > 0 && esIngrediente(palabras[0]!) &&
    palabras.slice(1).every((p) => esIngrediente(p) || MODIFICADORES_DE_INGREDIENTE.has(p));
  for (let k = 0; k < toks.length; k++) {
    if (toks[k]!.t !== disparador) continue;
    const [primeras, sig, fin0, ini0] = elemento(k + 1);
    if (primeras.length === 0) continue;
    const elementos = [primeras];
    const posiciones = [[ini0, fin0]];
    let fin = fin0;
    let j = sig;
    // «ni» siempre continua la lista; «y»/«e»/«,» solo si lo que sigue es otro ingrediente de preparacion y todo
    // lo anterior tambien lo era («sin hielo y una coca» no se traga la coca). Tras un «con», la «o» une igual
    // («con guacamole o queso»: los dos se ofrecen y el agente pregunta cual); tras un «sin» no cambia nada.
    while (j < toks.length) {
      const con = toks[j]!.t;
      if (con !== "ni" && con !== "y" && con !== "e" && con !== "," && !(con === "o" && disparador === "con")) break;
      const [mas, sig2, fin2, ini2] = elemento(j + 1);
      if (mas.length === 0) break;
      if (con !== "ni" && !(elementos.every(esPreparacion) && esPreparacion(mas))) break;
      elementos.push(mas);
      posiciones.push([ini2, fin2]);
      fin = fin2;
      j = sig2;
    }
    frases.push({
      inicio: toks[k]!.i,
      fin,
      preparacion: elementos.every(esPreparacion),
      elementos: elementos.map((e, n) => ({
        inicio: posiciones[n]![0]!,
        fin: posiciones[n]![1]!,
        preparacion: esPreparacion(e),
        texto: e.join(" "),
      })),
    });
    k = j - 1;
  }
  return frases;
}

// La frase se reescribe con SOLO lo que define producto: «sin hielo ni azúcar» -> «sin azúcar» (el hielo es nota),
// «sin azúcar ni gas» -> «sin azúcar sin gas» (el «ni» no queda de token). Toda de preparacion: sale completa.
function quitarNotasSin(texto: string): string {
  let salida = texto;
  for (const f of [...frasesSin(texto)].reverse()) {
    if (f.elementos.length === 1 && !f.preparacion) continue;
    const queda = f.elementos.filter((e) => !e.preparacion).map((e) => `sin ${texto.slice(e.inicio, e.fin)}`).join(" ");
    salida = `${salida.slice(0, f.inicio)} ${queda} ${salida.slice(f.fin)}`;
  }
  return salida;
}

/**
 * La consulta sin las notas «con <ingrediente de preparacion>» («tacos de pastor con cebolla», «con mucha salsa
 * verde», «con cilantro y cebolla»). Solo para el reintento de buscarProductosCore cuando la exacta con las palabras
 * tal cual no encontro nada («bistec con cebolla» si es el Encebollado). null = no habia ninguna nota «con».
 */
function quitarNotasCon(
  texto: string,
  esExtra: (palabra: string) => boolean = () => false,
): { texto: string; ingredientes: Array<{ palabras: string[]; menos: boolean }> } | null {
  // El cuantificador sale de la frase («con mucha salsa» -> «con salsa»). «poco/poca/poquito/menos» piden MENOS: lo
  // que sigue es nota de cocina, nunca un extra que ofrecer («con poco queso»). Se guarda la posicion (en el texto
  // ya sin el cuantificador) de la palabra a la que aplica. Tras un «con», tambien en «y poco guacamole». El «de» que
  // sigue al cuantificador tambien sale («con extra de queso» -> «con queso»).
  const minusculas = texto.toLowerCase();
  const primerCon = minusculas.search(/(?<![\p{L}\p{N}])con\s/u);
  // Con articulo o «muy» delante («con un poco de queso», «con muy poco queso»), diminutivos («poquitito»,
  // «tantito»), plural («con extras de queso») y tras una coma («con guacamole, poco queso»). El articulo solo cuenta
  // seguido de un cuantificador: «con un refresco» no se toca. Igual un cardinal («con dos/2/tres extras de queso»):
  // se ofrece el extra y el agente confirma cuantos.
  const cuantificador =
    /(?:(?<![\p{L}\p{N}])(con|y|e)\s+|(,)\s*)((?:(?:un[oa]?|muy|\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+)*(?:(?:poc[oa]s?|poquit\p{L}*|tantit[oa]s?|menos|much[oa]s?|extras?|doble|m[aá]s|bastante|harta?s?)\s+)+)(?:de\s+)?/gu;
  let base = "";
  let ultimo = 0;
  const posicionesMenos = new Set<number>();
  for (const m of minusculas.matchAll(cuantificador)) {
    const i = m.index ?? 0;
    const conector = m[1] ?? m[2];
    if (conector !== "con" && (primerCon < 0 || i < primerCon)) continue;
    base += `${minusculas.slice(ultimo, i)}${conector} `;
    if (/poc|poquit|tantit|menos/.test(m[3]!)) posicionesMenos.add(base.length);
    ultimo = i + m[0].length;
  }
  base += minusculas.slice(ultimo);
  // Un extra con costo del menu («con tocino», «con chorizo») tambien sale de la busqueda del producto principal,
  // pero el llamador lo devuelve como extra: nunca se queda solo como nota.
  const esIngrediente = (w: string) => esIngredienteDePreparacion(w) || esExtra(w);
  let salida = base;
  const ingredientes: Array<{ palabras: string[]; menos: boolean }> = [];
  for (const f of [...frasesSin(base, "con", esIngrediente)].reverse()) {
    if (!f.preparacion) continue;
    salida = `${salida.slice(0, f.inicio)} ${salida.slice(f.fin)}`;
    for (const e of f.elementos) {
      const palabras = e.texto.split(" ").filter((w) => !MODIFICADORES_DE_INGREDIENTE.has(w));
      if (palabras.length > 0) ingredientes.push({ palabras, menos: posicionesMenos.has(e.inicio) });
    }
  }
  return ingredientes.length > 0 ? { texto: salida, ingredientes } : null;
}

// Lo que va incluido sin costo con los tacos/platillos: «con X» de esto es nota de cocina, nunca un extra que cobrar.
// La salsa tampoco: las porciones extra de salsa van por `salsas_extra` de cotizar_pedido, no como producto.
const GUARNICIONES_SIN_COSTO = new Set([
  "cebolla", "cebollita", "cebollin", "cilantro", "verdura", "salsa", "chile", "picante", "habanero", "limon", "tomate",
  "jitomate", "repollo", "col", "lechuga", "sal", "hielo", "rabano", "pepino", "ajo", "aderezo", "mayonesa", "mostaza",
  "catsup", "ketchup", "grasa", "nada", "todo", "todito",
]);
// Categoria de complementos con costo (en el menu de PM los extras se llaman «Extra X» dentro de «Guarniciones Extra»;
// esa categoria tambien trae las ordenes de tortilla, que NO son «con X» de un taco: por eso alli cuenta el nombre).
const CATEGORIA_DE_COMPLEMENTOS = /(?:^|[^a-z0-9ñ])(?:complementos?|adicionales?|agregados?)(?![a-z0-9ñ])/;
const PREFIJO_DE_EXTRA = /^(?:extras?|porcion(?:\s+extra)?\s+de)\s+/;

/** Formas base de una palabra para cruzarla con la llave de un extra («guacamoles» -> guacamole, «champiñones» -> champinon). */
function formasBase(palabra: string): string[] {
  const w = plegarBusqueda(palabra);
  return [w, w.endsWith("s") ? w.slice(0, -1) : "", w.endsWith("es") ? w.slice(0, -2) : ""].filter(Boolean);
}

/**
 * Extras con costo del catalogo por su ingrediente: «Extra Guacamole» -> guacamole, «Extra Chile Poblano» -> «chile
 * poblano» (el nombre COMPLETO: «chile» solo va incluido sin costo), y en una categoria de complementos cualquier
 * producto por su nombre y por su primera palabra («Queso gratinado» -> «queso gratinado» y queso). Asi «tacos de
 * pastor con guacamole» devuelve los tacos y, aparte, el Extra Guacamole: el agente lo ofrece, no se pierde como nota.
 */
function extrasDelMenu(rows: Fila[]): Map<string, Fila[]> {
  const mapa = new Map<string, Fila[]>();
  for (const r of rows) {
    const nombre = plegarBusqueda(String(r.products?.name ?? "")).trim();
    const categoria = plegarBusqueda(String(r.products?.categories?.name ?? ""));
    const esExtra = PREFIJO_DE_EXTRA.test(nombre) || CATEGORIA_DE_COMPLEMENTOS.test(categoria);
    if (!esExtra) continue;
    const palabras = nombre.replace(PREFIJO_DE_EXTRA, "").split(/[^a-z0-9ñ]+/).filter(Boolean);
    if (palabras.length === 0) continue;
    const llaves = palabras.length === 1
      ? formasBase(palabras[0]!)
      : [palabras.join(" "), ...(PREFIJO_DE_EXTRA.test(nombre) ? [] : formasBase(palabras[0]!))];
    for (const f of new Set(llaves)) mapa.set(f, [...(mapa.get(f) ?? []), r]);
  }
  return mapa;
}

/** Lo excluido con «sin X» que NO es preparacion (lo que la relajada puede soltar y nunca debe devolver). */
function excluidosNoPreparacion(query: string): string[] {
  return frasesSin(corregirErratasAlcohol(String(query ?? "").toLowerCase()))
    .flatMap((f) => f.elementos.filter((e) => !e.preparacion).map((e) => e.texto));
}

/**
 * Ingredientes de cada nota «sin X» de preparacion, en su forma de la lista («sin cebollas» -> [«cebolla»],
 * «sin salsa de piña» -> [«salsa», «pina»]). «sin nada» no excluye nada.
 */
function excluidosDePreparacion(query: string): string[][] {
  const base = (w: string) =>
    INGREDIENTES_DE_PREPARACION.has(w) ? w : INGREDIENTES_DE_PREPARACION.has(w.slice(0, -2)) && w.endsWith("es") ? w.slice(0, -2) : w.slice(0, -1);
  return frasesSin(corregirErratasAlcohol(String(query ?? "").toLowerCase()))
    .flatMap((f) => f.elementos.filter((e) => e.preparacion))
    .map((e) => e.texto.split(" ").filter((w) => esIngredienteDePreparacion(w)).map((w) => base(plegarBusqueda(w))))
    .filter((ws) => ws.length > 0 && !ws.includes("nada"));
}

/**
 * ¿El NOMBRE del producto es lo que la nota excluye? «Chicharrón de Queso» con «sin queso», «Bistec Encebollado» con
 * «sin cebolla». Palabra completa (con plural y el participio «encebollado»); un «sin X» del propio nombre no cuenta.
 */
function nombreLlevaExcluido(nombre: string, ingredientes: string[]): boolean {
  const plano = plegarBusqueda(nombre).replace(/\bsin\s+[a-z0-9ñ]+/g, " ");
  return ingredientes.every((w) =>
    new RegExp(`(?:^|[^a-z0-9ñ])(?:en)?${escaparRegex(w)}(?:s|es|do|da|dos|das)?(?![a-z0-9ñ])`).test(plano)
  );
}

/**
 * `mapearCero: false` = sin la conversion a «0.0» (reintento de buscarProductosCore cuando «coca 0 0» o
 * «sprite cero cero» no son la cerveza 0.0).
 */
export function tokenizeForProductSearch(query: string, { mapearCero = true }: { mapearCero?: boolean } = {}): string[] {
  // Bug real encontrado el 3-sep-2026 (pruebas de "vida cotidiana"): un
  // cliente real dice "un kilo de bistec" o "medio kilo de arrachera" — la
  // palabra "kilo" nunca aparece en el nombre real del producto (que dice
  // "1 kg" o "500 g", nunca "kilo"), así que el token "kilo" no hacía match
  // con nada y el agente decía (falso) que el producto no existía, aunque
  // sí estaba disponible. Se normalizan las frases reales de kilos ANTES
  // de tokenizar, a la forma pegada que ya sabe resolver el bloque de abajo
  // (igual que "500g"/"1kg").
  // «con hielo» («con mucho hielo») es nota de preparacion igual que «sin hielo»: ningun nombre lo lleva. Solo el
  // hielo: «con queso», «con soda», «con topo chico» si son parte del nombre.
  // «sol sixpack», «six pack de sol», «indio caguama»: la presentacion no es parte del nombre (ninguna botella se llama
  // asi); se busca la cerveza y buscarProductosConExtrasCore la marca aproximada con presentacion_no_disponible.
  const base = quitarNotasSin(cervezaSinAlcohol(corregirErratasAlcohol(query)).replace(PRESENTACION_DE_CERVEZA, " ").toLowerCase())
    .replace(/(?<![\p{L}\p{N}])con\s+(?:(?:poco|mucho|extra|bastante)\s+)?hielos?(?![\p{L}\p{N}])/gu, " ");
  // «cero cero», «00», «0 0», «0,0» y «cero punto cero» son la Heineken 0.0 (ciego C3: PED-12 x3), pero solo si
  // la consulta habla de cerveza o no dice nada mas («una cero cero»): «calle 00», «coca 0 0», «sprite cero cero» no.
  let conCero = base;
  if (mapearCero) {
    const mapeada = mapearCeroCero(base);
    // «cocteles 0 0», «coctel cero cero»: la palabra de categoria (stopword) dice que NO es cerveza. El cero es
    // «sin alcohol» (los cocteles sin alcohol), no la Heineken 0.0 ni el «Sprite Cero» (revision PR #21 ronda 7).
    const otraCategoria = base.split(/\s+/).some((t) => {
      const c = PALABRAS_DE_CATEGORIA.get(t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
      return c !== undefined && c !== "cerveza";
    });
    const soloElCero = partirTokens(mapeada).every((t) => t === "0.0" || /^\d+$/.test(t));
    if (mapeada !== base && otraCategoria && !CONTEXTO_CERVEZA_CERO.test(query)) conCero = `${quitarCeroCero(base)} sin alcohol`;
    else conCero = mapeada === base || CONTEXTO_CERVEZA_CERO.test(query) || soloElCero ? mapeada : base;
  }
  const normalizada = normalizarPesos(conCero)
    // «media orden de nachos de pastor» (ronda 18): es el «(1/2 orden)» de lo pedido (buscarEnFilas, si no lo hay, busca
    // lo pedido y lo marca aproximado). Antes «media» no casaba nada y la busqueda volvia vacia.
    .replace(/(?<![\p{L}\p{N}])medi[oa]\s+ordene?s?\s+(?=de\s)/gu, "1/2 orden ")
    // «media de pastor», «medio de bistec» (ronda 17): el medio kilo. En ace28e8 salia exacto solo porque las erratas
    // («media» ~ «medio» de la descripcion) no marcaban aproximado. «kilo y medio de» ya es el kilo y medio. Solo si lo
    // que sigue es una carne por kilo (ronda 18): buscarEnFilas quita el «media de» de «una media de cerveza».
    // No va en normalizarPesos: cada parte del pedido conserva su «media de» para que buscarEnFilas lo resuelva.
    .replace(/(?<![\p{L}\p{N}])(?<!(?:^|\s)y\s+)medi[oa]\s+de\s+/gu, "500g de ")
    // «coca 1 l», «2 lt» (ronda 17): la «l» suelta (1 letra) se tiraba y quedaba «coca» de cualquier tamano. Pegada a
    // su numero es el tamano, como «1l».
    .replace(/(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d+)?)\s+(l|lt|lts)(?![\p{L}\p{N}])/gu, "$1$2")
    // «una coke» (turistas y jovenes) no esta en ningun nombre del menu: es la Coca-Cola.
    .replace(/\bcokes?\b/g, "coca")
    // «coca cero», «coca zero» (revisión 19): es la Coca-Cola sin Azúcar (antes «cero» no casaba nada y salia vacio).
    // «coca cero cero» no se toca (lo resuelve el «0.0»).
    .replace(/\b(cocas?)(?:\s+colas?)?\s+(?:cero|zero)\b(?!\s+(?:punto\s+)?(?:cero|0)\b)/g, "$1 sin azucar");

  const raw = partirTokens(normalizada);

  const tokens: string[] = [];
  for (const t of raw) {
    const pesoMatch = t.match(/^(\d+)(kg|gr|g)$/);
    if (pesoMatch) {
      // separa el número de la unidad — así hace match sin importar si el
      // nombre real trae espacio entre ellos o no.
      tokens.push(pesoMatch[1]!, pesoMatch[2] === "gr" ? "g" : pesoMatch[2]!);
      continue;
    }
    tokens.push(singularizarToken(t));
  }
  // Revision PR #21 ronda 18 (invariante 2): una cifra sola nunca es lo que se busca. «12 caguamas», «2 six pack»
  // dejaban «12»/«2» y casaban la Parrillada para 2, las (1/2 orden) y los 2 kg como exactos.
  // Solo quedaron stopwords (y quiza la nota «sin hielo»): «una cerveza sin hielo». Antes se buscaba la consulta CRUDA
  // como un solo token («una cerveza sin hielo») y no casaba con nada. Se usa la consulta sin la nota: la palabra de
  // categoria si la hay («cerveza» casa con la categoria «Cervezas»), si no el texto ya sin la nota.
  const deCategoria = normalizada.split(/\s+/)
    .map((t) => PALABRAS_DE_CATEGORIA.get(t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")))
    .filter((t): t is string => t !== undefined);
  // Un tamano de bebida tampoco nombra el producto (revisión 19): «dos cervezas de 355 ml», «cerveza 1 l» buscaban
  // «355 ml» / «1l» y salia vacio. Con la palabra de categoria se busca la categoria y el tamano que no hay va en
  // presentacion_no_disponible (conPresentacion).
  const esTamano = (t: string) => /^(?:\d+(?:[.,]\d+)?)?(?:ml|l|lt|lts|litros?|oz)$/.test(t);
  if (tokens.some((t) => !/^\d+$/.test(t) && !(deCategoria.length > 0 && esTamano(t)))) return tokens;
  if (deCategoria.length > 0) return [...new Set(deCategoria)];
  const sinNota = normalizada.trim().replace(/\s+/g, " ");
  // Sin la nota solo quedaron conectores/stopwords («sin cebolla y», «sin cebolla»): no hay nada que buscar. Antes
  // se buscaba el conector suelto («y») y salian productos al azar. [] = ningun producto (buscarProductosCore).
  const contenido = sinNota.split(" ")
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t && !STOPWORDS_BUSQUEDA.has(t) && !CIERRE_DE_FRASE_SIN.has(t) && !/^\d+$/.test(t));
  if (contenido.length === 0) return [];
  return [sinNota];
}

// Una bebida tras «cuarto de» («un cuarto de cerveza», «… de coca», revisión 20): no es un peso de comida. Genéricos y
// las marcas de bebida del menú; sobre texto en minúsculas, con o sin acento.
const BEBIDA_TRAS_CUARTO = "(?:cervezas?|chelas?|cheladas?|micheladas?|caguamas?|cocas?|coca-cola|refrescos?|" +
  "sodas?|aguas?|horchatas?|jamaicas?|limonadas?|naranjadas?|sueros?|bebidas?|jugos?|leche|t[eé]|caf[eé]|tequilas?|" +
  "mezcal(?:es)?|vinos?|whiske?ys?|ron|vodka|sangr[ií]as?|margaritas?|daiquiris?|congas?|pi[nñ]adas?|sol|superior|tecate|" +
  "heineken|indio|xx|amstel|bohemia|ceiba|patito|corona|modelo|victoria|sprite|fanta|sidral|topo|mineral)(?![\\p{L}\\p{N}])";
// Lo que tras «cuarto de» no es un peso de comida: un litro («cuarto de litro») o una bebida.
const NO_ES_PESO_TRAS_CUARTO = `(?:(?:litros?|l|lt)(?![\\p{L}\\p{N}])|${BEBIDA_TRAS_CUARTO})`;

/**
 * Los pesos como los dice el nombre del menu («2 kilos» -> «2kg», «1/2 kilo» -> «500g», «1 y 1/2 kilos» -> «1.5 kg»,
 * «kilo» -> «kg»), sobre texto en minusculas. Lo usan la busqueda y CADA parte de un pedido de varios productos antes
 * de quitarle su cantidad (ronda 18, invariante 3): antes «2 tacos y 2 kilos de pastor» quitaba el «2» de «2 kilos» y
 * salian todos los kilos de pastor.
 */
function normalizarPesos(texto: string): string {
  return texto
    // «500 gramos», «500 gr», «250 grs» (revisión 19): como lo dice el nombre («500 g»). Antes no casaba nada.
    .replace(/(?<![\p{L}\p{N}.,])(\d+)\s*(?:gramos?|grs?)(?![\p{L}\p{N}])/gu, "$1g")
    // «1 y 1/2 kilos», «un kilo y medio», «2 y medio kg» (ronda 15): el tamano con decimal, como lo dice el nombre.
    // «dos kilos y medio», «tres kilos y medio» (ronda 16): el numero en palabras tambien (antes «dos» no entraba y
    // quedaba «kilo y medio» -> el kilo y medio, exacto).
    .replace(
      new RegExp(`(?<![\\p{L}\\p{N}.])(\\d+|${NUMEROS_EN_PALABRAS})\\s+(?:(?:kilos?|kg)\\s+)?y\\s+(?:1\\s*\\/\\s*2|medio|media)\\s+(?:de\\s+)?(?:kilos?|kg)?`, "gu"),
      // «una y media de pastor» (ronda 17, regresion desde ace28e8): sin decir «kilo» tambien es el kilo y medio.
      (m, n) => /kilo|kg/.test(m) || /\sde\s+$/.test(m) ? `${numeroDePalabra(n)}.5 kg ` : m,
    )
    // «un kilo de pastor y medio», «1 kilo de bistec y medio» (ronda 18): el «y medio» al final (o antes de una nota) es
    // del mismo kilo; sin esto «un kilo» pegado («1kg») ya no casaba el 1.5 kg.
    .replace(
      // Sin numero («kilo de pastor y medio», revisión 19) tambien: es uno y medio.
      new RegExp(`(?<![\\p{L}\\p{N}.])(?:(\\d+|${NUMEROS_EN_PALABRAS})\\s+)?(?:kilos?|kg)\\s+(de\\s+[^,;]+?)\\s+y\\s+(?:medio|media|1\\s*\\/\\s*2)(?=\\s*$|\\s*[,;]|\\s+(?:con|sin|por|para)(?![\\p{L}\\p{N}]))`, "gu"),
      (_m, n, resto) => `${numeroDePalabra(n ?? "1")}.5 kg ${resto}`,
    )
    // «kilo y medio de bistec» sin numero delante (revisión 19): en otra parte del pedido («dos kilos de pastor y kilo y
    // medio de bistec») quedaba «kg y medio» y la parte salia vacia. Con numero ya lo resolvio lo de arriba.
    .replace(/(?<![\p{L}\p{N}.])kilos?\s+y\s+(?:medio|media|1\s*\/\s*2)(?![\p{L}\p{N}])/gu, "1.5 kg")
    // «kilo medio de pastor», «un kilo medio» (revisión 19, regresion desde ace28e8): el kilo y medio.
    .replace(/(?<![\p{L}\p{N}.])(?:(?:un|1)\s+)?kilo\s+medio(?![\p{L}\p{N}])/gu, "1.5 kg")
    // «1 1/2 kilos», «2 1/2 kg» (sin «y», ronda 16).
    .replace(/(?<![\p{L}\p{N}.])(\d+)\s+1\s*\/\s*2\s+(?:de\s+)?(?:kilos?|kg)(?![\p{L}\p{N}])/gu, (_m, n) => `${n}.5 kg `)
    // «1/2 kilo», «1/4 de kilo», «3/4 kg» (ronda 17): la fraccion en cifras es el tamano en gramos, igual que «medio
    // kilo». Antes se quedaba «1», «2» y «kg» sueltos y no casaba nada.
    .replace(
      /(?<![\p{L}\p{N}./])([13])\s*\/\s*([24])\s+(?:de\s+)?(?:kilos?|kg)(?![\p{L}\p{N}])/gu,
      (m, a, b) => ({ "1/2": "500g", "1/4": "250g", "3/4": "750g" } as Record<string, string>)[`${a}/${b}`] ?? m,
    )
    // «dos kilos», «tres kilos» (ronda 17): el numero en palabras es el tamano, igual que «2kg» («tres kilos» sin un
    // producto de 3 kg no casa ningun otro peso). «2 kilos», «2 kg» (ronda 18): la cifra tambien va pegada a su unidad
    // (suelta, la cifra de 1 caracter se tiraba y salia cualquier kilo). «un kilo» (ronda 18) es «1kg»: antes salian
    // exactos el 1 kg, el 1.5 kg y el 2 kg.
    .replace(
      /(?<![\p{L}\p{N}.,])(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:kilos?|kg)(?![\p{L}\p{N}])/gu,
      (_m, n) => `${numeroDePalabra(n)}kg`,
    )
    .replace(/tres\s+cuartos?\s+de\s+kilo/g, "750g")
    .replace(/cuarto\s+de\s+kilo/g, "250g")
    // «un cuarto de pastor», «tres cuartos de bistec» (revisión 19): sin decir «kilo» tambien es el peso. Antes quedaba
    // «cuarto» y por la descripcion salian exactos el 250 g y el 750 g. Un litro («cuarto de litro») no es peso, ni una
    // bebida (revisión 20: «un cuarto de cerveza» daba los 250 g de todas las carnes).
    // «un cuarto de cerveza»: el «cuarto» tampoco se queda (por la descripción casaba los 250 g y 750 g): solo la bebida.
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:tres\\s+)?cuartos?\\s+de\\s+(?=${BEBIDA_TRAS_CUARTO})`, "gu"), "")
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])tres\\s+cuartos?\\s+de\\s+(?!${NO_ES_PESO_TRAS_CUARTO})`, "gu"), "750g de ")
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])cuarto\\s+de\\s+(?!${NO_ES_PESO_TRAS_CUARTO})`, "gu"), "250g de ")
    // «media kilo» (ronda 18): con «a» tambien es el medio kilo (antes quedaba «media» y casaba el kilo y medio).
    .replace(/medi[oa]\s+kilo/g, "500g")
    // «kilo de pastor» sin «un» (revisión 19): es el de 1 kg, igual que «un kilo» (antes salian exactos 1, 1.5 y 2 kg).
    // «por kilo» no dice cuanto: se queda.
    .replace(/(?<![\p{L}\p{N}.,])(?<!\bpor\s+)kilo(?![\p{L}\p{N}])/gu, "1kg")
    .replace(/\bkilos?\b/g, "kg");
}

// Numeros en palabras del tamano por kilo («dos kilos y medio»).
const NUMEROS_EN_PALABRAS = "un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez";
const VALOR_EN_PALABRAS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};
function numeroDePalabra(n: string): string {
  return /^\d+$/.test(n) ? n : String(VALOR_EN_PALABRAS[n] ?? 1);
}

/**
 * Singulariza un plural regular (tacos -> taco, pastores -> pastor, chicharrones -> chicharron). De sobra para
 * encontrar más, nunca para encontrar menos: un token más corto casa al inicio de MÁS palabras. El -es solo se quita
 * con 6+ letras y tras una consonante en la que termina un singular español (l, n, r, d, z, c, j, y, s): «tres»,
 * «mes» y «res» (la carne) quedan intactos, y «leches» (-hes) o «aguacates» (-tes) pierden solo la -s (su singular
 * termina en -e: «lech» casaria con «LECHuga»). Antes «pastores» buscaba «pastore» y salía aproximado.
 */
function singularizarToken(t: string): string {
  // Sin tildes antes de quitar el plural (ronda 16): «órdenes» -> «orden» (el singular no lleva la tilde del plural;
  // antes quedaba «órden» y no era la palabra «orden»). Solo si es plural: lo demas queda tal cual.
  const f = plegarBusqueda(t);
  if (f.length > 5 && /[lnrdzcjys]es$/.test(f)) return f.slice(0, -2);
  return f.length > 4 && f.endsWith("s") ? f.slice(0, -1) : t;
}

// Palabras de categoria que son stopword (no estan en el NOMBRE de la bebida) pero, solas, son lo que se pide.
const PALABRAS_DE_CATEGORIA = new Map([
  ["cerveza", "cerveza"], ["cervezas", "cerveza"], ["chela", "cerveza"], ["chelas", "cerveza"], ["coctel", "coctel"], ["cocteles", "coctel"], ["cóctel", "coctel"],
  ["cócteles", "coctel"],
]);

function partirTokens(texto: string): string[] {
  return texto
    .split(/\s+/)
    // Puntuacion pegada («dame,» «(4)»): fuera; el punto interior («1.5») se conserva.
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 1 && !STOPWORDS_BUSQUEDA.has(t));
}

export interface ProductoEncontrado {
  id: string;
  name: string;
  price: number;
  /**
   * Cantidad fija de piezas del paquete si el producto se vende como
   * paquete indivisible (ej. 3 para "Tacos de Bistec de Res (orden de 3)"),
   * 1 si se vende por pieza individual ("... (individual)" / "Orden
   * individual" en su description), o null si no aplica esa noción de
   * "piezas por paquete" (bebidas, platillos completos, kilos, etc.).
   * Se calcula del name+description real en vez de dejar que el LLM tenga
   * que inferirlo de un paréntesis en el texto — bug real confirmado
   * 4-sep-2026: el agente de voz aceptó "un taco de bistec" sin corregir
   * al cliente pese a que el prompt ya le decía que revisara el nombre;
   * un campo estructurado explícito es más difícil de pasar por alto que
   * un patrón de texto libre.
   */
  pack_size: number | null;
  /**
   * Platillos con nombre propio (gringa, alambre, suizo, mestiza, quesadilla) que se piden POR PLATILLO
   * pero cuya descripcion dice «Orden de N tacos/quesadillas»: N. null = no aplica. Es lo que permite
   * detectar que «5 tacos de alambre» (1 platillo) y «5 alambres» (5 platillos) cuestan distinto.
   */
  piezas_por_platillo?: number | null;
  /** El agente debe obtener un sí claro de mayoría de edad antes de cotizar. */
  requires_adult_confirmation?: boolean;
  /** true = solo casa tras soltar un adjetivo que el menu no lleva («grande», «sin grasa»): NO es lo pedido literal; decir «lo mas parecido es...». */
  aproximado?: boolean;
  /**
   * La presentacion pedida que el menu no tiene («six pack», «caguama»): el producto es la cerveza suelta (va con
   * aproximado). El agente dice «no manejamos six pack; la Sol es a $80, ¿cuántas le pongo?».
   */
  presentacion_no_disponible?: string;
}

/** Extra CON COSTO del menu que el cliente nombro con «con X»: el agente PREGUNTA antes de agregarlo (nunca se cobra solo). */
export interface ExtraDisponible {
  id: string;
  nombre: string;
  precio: number;
}

/** OTRO producto del menu que el cliente pidio junto al platillo («tacos de pastor con una coca»): se confirma y agrega aparte. */
export interface OtroProductoPedido {
  /** Lo que dijo el cliente, tal cual («una coca», «3 cocas»). */
  texto: string;
  /** La busqueda de ese texto en el menu (misma forma que productos). [] = no esta en el menu: decirselo al cliente. */
  resultados: ProductoEncontrado[];
  /** true = lo pedido es un extra con costo («y queso» -> Extra Queso): se pregunta con su precio, como extras_disponibles. */
  es_extra?: true;
  /**
   * La parte es solo el relleno del platillo pedido antes («tacos de pastor y bistec» -> "tacos"): sus resultados traen
   * primero ese platillo con este relleno (Tacos de Bistec antes del Platillo o el kilo). El agente confirma «¿también
   * tacos de bistec?» en vez de agregar un platillo o un kilo.
   */
  relleno_de?: string;
}

export interface BusquedaConExtras {
  productos: ProductoEncontrado[];
  /** Extras con costo que corresponden a un «con X» de la consulta; vacio si no hay. Nunca van mezclados en productos. */
  extras_disponibles: ExtraDisponible[];
  /** Otros productos pedidos en la misma consulta («con una coca», «y 2 cocas»); ausente si no hay. */
  otros_productos?: OtroProductoPedido[];
}

function extraerPackSize(
  name: string,
  description: string | null,
): number | null {
  const texto = `${name} ${description ?? ""}`;
  // Solo el NOMBRE decide si se cuentan piezas: «Tacos de Bistec (orden de 3)» se pide en piezas.
  // Un platillo con nombre propio («Gringa de Pastor», «Suizo», «Alambre», «Quesadilla de Rajas») que
  // trae «Orden de 2 tacos» solo en la descripcion se pide por PLATILLO: «dos gringas» son 2 ordenes, no
  // 2 piezas (= 1 orden). Contarlas en piezas hacia que «una gringa» (1 pieza) fuera invalida y «dos» se
  // cobraran como una (ciego C1: PED-10/17/25/29, POL-02/05/09/10, ROB-01/04).
  const enNombre = name.match(/orden de (\d+)/i);
  if (enNombre) return parseInt(enNombre[1]!, 10);
  if (/orden de \d+/i.test(description ?? "")) return null;
  if (/individual/i.test(texto)) return 1;
  return null;
}

/** N de «Orden de N tacos/quesadillas» cuando el platillo se pide por platillo (pack_size null); si no, null. */
export function extraerPiezasPorPlatillo(
  name: string,
  description: string | null,
): number | null {
  if (/orden de \d+/i.test(name)) return null;
  const m = (description ?? "").match(/orden de (\d+)/i);
  const n = m ? parseInt(m[1]!, 10) : 0;
  return n >= 2 ? n : null;
}

/** El cliente cuenta piezas («5 tacos») pero el platillo se cobra por platillo: hay que preguntar o convertir. */


export function requiresAdultConfirmation(
  productName: string,
  categoryName: string | null | undefined,
): boolean {
  if (!/^(cervezas|licores y cocktails)$/i.test(categoryName ?? "")) {
    return false;
  }
  return !/(?:\bsin\s+alcohol\b|\b0[.,]0\b)/i.test(productName);
}


/**
 * Revisión 28 (❓ decidida): «medio kilo y medio (de pastor)» no es una cantidad real: ¿medio kilo o kilo y medio? Antes
 * salía el 1.5 kg exacto. Se toma el MEDIO kilo (lo primero que dijo, y lo más barato) marcado aproximado y el agente
 * confirma con el cliente.
 */
const MEDIO_KILO_Y_MEDIO = /(?<![\p{L}\p{N}])medi[oa]\s+(?:kilos?|kg)\s+y\s+medi[oa](?:\s+(?:kilos?|kg))?(?![\p{L}\p{N}])/giu;
export const CONFIRMAR_MEDIO_KILO_Y_MEDIO =
  "«medio kilo y medio» no es una cantidad clara: se tomó medio kilo. Confirme con el cliente si quiere medio kilo o kilo y medio antes de cotizar.";
/** ¿El texto dice «medio kilo y medio»? Pura. */
export function esMedioKiloYMedio(texto: unknown): boolean {
  MEDIO_KILO_Y_MEDIO.lastIndex = 0;
  const si = MEDIO_KILO_Y_MEDIO.test(String(texto ?? ""));
  MEDIO_KILO_Y_MEDIO.lastIndex = 0;
  return si;
}
/** Nombre de una presentación por peso («Pastor — 500 g», «Pastor — 1.5 kg»). */
const NOMBRE_DE_PESO = /—\s*\d+(?:\.\d+)?\s*(?:kg|g)\s*$/i;

/** Solo los productos (voz y llamadores que no ofrecen extras): los extras de «con X» nunca se cuelan como producto. */
export function buscarProductosEnFilas(filas: readonly Fila[], query: string): ProductoEncontrado[] {
  return buscarProductosConExtrasEnFilas(filas, query).productos;
}

/**
 * Busqueda del menu + los extras con costo que el cliente nombro con «con X» («tacos de pastor con guacamole» -> los
 * tacos, y Extra Guacamole en `extras_disponibles`). El servidor NO decide el cobro: el agente pregunta («¿le agrego
 * guacamole extra por $49?») y solo con el sí del cliente lo agrega como un producto mas. Port puro de
 * buscarProductosConExtrasCore: `filas` = branch_products disponibles de la sucursal (antes, el SELECT de 400 filas).
 */
export function buscarProductosConExtrasEnFilas(filasEntrada: readonly Fila[], queryEntrada: string): BusquedaConExtras {
  let query = queryEntrada;
  // Revisión 28: «medio kilo y medio» se busca como «medio kilo» y las presentaciones por peso salen aproximadas.
  if (esMedioKiloYMedio(query)) {
    const r = buscarProductosConExtrasEnFilas(filasEntrada, query.replace(MEDIO_KILO_Y_MEDIO, "medio kilo"));
    const marcar = (p: ProductoEncontrado): ProductoEncontrado => (NOMBRE_DE_PESO.test(p.name) ? { ...p, aproximado: true } : p);
    return {
      ...r,
      productos: r.productos.map(marcar),
      ...(r.otros_productos ? { otros_productos: r.otros_productos.map((o) => ({ ...o, resultados: o.resultados.map(marcar) })) } : {}),
    };
  }
  // «sin alcool/alcol» es «sin alcohol» en TODOS los pasos (exacta, sinonimo 0.0 y relajada).
  query = corregirErratasAlcohol(query);
  // «para llevar», «a domicilio», «con tarjeta», «gracias», «para mi esposa»: no son productos (ronda 14).
  query = quitarLogistica(query);
  // Solo la presentacion («una caguama», «un six pack», ronda 17): son las cervezas; conPresentacion las marca
  // aproximadas con presentacion_no_disponible y el agente pregunta cual (antes salia [] = «no tenemos»).
  const soloPresentacion = tokenizeForProductSearch(query).length === 0 && presentacionPedida(query) !== null;
  if (soloPresentacion) query = `cerveza ${query}`;
  // Solo la nota y conectores («sin cebolla y»): nada que buscar.
  if (tokenizeForProductSearch(query).length === 0) return { productos: [], extras_disponibles: [] };

  const filas: Fila[] = filasEntrada.filter((r) => r.is_available);
  const red = conRedDeSeguridad(filas, query, buscarEnFilas(filas, query));
  let { lista, extras } = red;
  const porPlatillo = red.porPlatillo;
  // Lo que se llama con esa presentacion («Indio Caguama») va primero aunque no entrara en las 8 cervezas.
  if (soloPresentacion) {
    const conElla = filas.filter((r) => nombreConPresentacion(String(r.products?.name ?? ""), query));
    const ids = new Set(conElla.map((r) => r.products.id));
    lista = [...conElla.map((r) => ({ r, aproximado: false })), ...lista.filter((x) => !ids.has(x.r.products.id))].slice(0, 8);
  }
  // «tacos de pastor con una coca», «orden de pastor y 2 cocas»: el otro producto no se pierde; va aparte para que el
  // agente lo confirme y lo agregue por separado.
  let otros: OtroProductoPedido[] = [];
  const partes = segmentosDeOtros(query);
  // Revision PR #21 ronda 14: con «y/e/o/,» (o una cantidad nueva: «4 pastor 2 bistec») la busqueda ya no intenta
  // resolver el pedido entero. Es una AYUDA: el platillo es lo de antes del primer separador y cada otra parte va
  // aparte en otros_productos, con su propia busqueda (vacia si no esta en el menu), aunque la consulta completa haya
  // encontrado algo exacto («tacos de pastor y una cerveza»). Solo manda la completa si UN producto se llama asi
  // completo («chile poblano y bistec» -> Tacos Suizos de Chile Poblano y Bistec).
  if (partes && !partes.porCon && !nombreDelMenuLoDiceTodo(filas, partes)) {
    otros = otrosProductosDe(filas, partes);
    if (otros.length > 0) ({ lista, extras } = conRedDeSeguridad(filas, partes.base, buscarEnFilas(filas, partes.base)));
  } else if (partes && partes.porCon && porPlatillo) {
    otros = otrosProductosDe(filas, partes);
    if (otros.length > 0 && otros.length === partes.segmentos.length) {
      // Todo lo del «con» son otros productos («pastor con cerveza sin alcohol»): el platillo es la busqueda de lo de
      // antes del «con», tal cual (lo aproximado de la completa venia de las palabras del otro producto).
      ({ lista, extras } = conRedDeSeguridad(filas, partes.base, buscarEnFilas(filas, partes.base)));
    } else if (otros.length > 0) {
      // Lo que solo salio por las palabras del otro producto ya va en otros_productos.
      const deOtros = new Set(otros.flatMap((o) => o.resultados.map((x) => x.id)));
      lista = lista.filter((x) => !(x.aproximado && deOtros.has(x.r.products.id)));
    }
  }
  // Revision PR #21 ronda 15: una parte que ya es parte del NOMBRE de un producto del platillo no es otro producto
  // («frijol con tostada y 2 cocas»: la tostada es del Frijol con Tostada; «limonada con topo chico y ...», «tacos
  // suizos de chile poblano y arrachera y ...»). Se quita de otros_productos y ese producto va primero.
  if (partes && otros.length > 0) {
    const sinCifras = (texto: string) => tokenizeForProductSearch(texto).filter((t) => !/^\d/.test(t));
    const tokensBase = sinCifras(partes.base);
    const lleva = (r: Fila, tokens: string[]) => {
      const nombre = plegarBusqueda(String(r.products?.name ?? ""));
      return tokens.every((t) => regexDeToken(t).test(nombre));
    };
    const delNombre: string[] = [];
    if (tokensBase.length > 0) {
      const deLaBase = new Set(tokensBase.map((t) => plegarBusqueda(t)));
      otros = otros.filter((o) => {
        const tokens = sinCifras(o.texto);
        // Si repite palabras de la base («una coca y una coca light») es otro producto de lo mismo (ronda 16).
        const repite = tokens.some((t) => deLaBase.has(plegarBusqueda(t)));
        // Con su propia cantidad («dos cocas y UNA light», ronda 18) es otro producto, no el resto del nombre.
        const primera = plegarBusqueda(o.texto).split(/[^a-z0-9ñ]+/).find(Boolean) ?? "";
        const conCantidad = NUMERO_DE_CANTIDAD.test(primera) || /^un[oa]?s?$/.test(primera);
        const dentro = !repite && !conCantidad && tokens.length > 0 && lista.some((x) => !x.aproximado && lleva(x.r, [...tokensBase, ...tokens]));
        if (dentro) delNombre.push(...tokens);
        return !dentro;
      });
    }
    if (delNombre.length > 0) {
      const completo = (x: { r: Fila }) => lleva(x.r, [...tokensBase, ...delNombre]);
      lista = [...lista.filter(completo), ...lista.filter((x) => !completo(x))];
    }
  }
  // Revision PR #21 ronda 17: «una heineken y una heineken 0.0», «dos cocas y una coca light». La otra parte repite
  // la marca y agrega algo («0.0», «light»): lo que la nombra con eso va en otros_productos y no tambien en productos
  // (antes la Heineken 0.0 salia primero en los dos). Si en productos no quedara nada, se deja como estaba.
  if (partes && otros.length > 0) {
    const palabras = (texto: string) => tokenizeForProductSearch(texto).map((t) => plegarBusqueda(t)).filter((t) => !/^\d+$/.test(t));
    const deLaBase = new Set(palabras(partes.base));
    const deOtraParte = new Set<string>();
    for (const o of otros) {
      const todas = palabras(o.texto);
      const propias = todas.filter((t) => !deLaBase.has(t));
      if (propias.length === 0 || propias.length === todas.length) continue;
      for (const x of o.resultados) {
        if (!x.aproximado && propias.every((t) => regexDeToken(t).test(plegarBusqueda(x.name)))) deOtraParte.add(x.id);
      }
    }
    const sinLaOtra = lista.filter((x) => !deOtraParte.has(x.r.products.id));
    if (sinLaOtra.length > 0) lista = sinLaOtra;
  }
  // Revision PR #21 ronda 18 (5): «dos cocas y una light», «2 heineken y una 0.0». La otra parte es solo la VARIANTE
  // de la marca de la base: lo que se llama «<marca de la base> ... <variante>» va primero en esa parte y sale de
  // productos (antes «una light» se leia como el resto de «coca light» y la Coca-Cola se perdia). Solo si la marca es la
  // primera palabra del nombre y la variante no: «una light y dos cocas» no vuelve Light a las cocas.
  if (partes && otros.length > 0) {
    const palabras = (texto: string) => tokenizeForProductSearch(texto).map((t) => plegarBusqueda(t)).filter((t) => !/^\d+$/.test(t));
    const deLaBase = palabras(partes.base);
    const enLaBase = new Set(lista.filter((x) => !x.aproximado).map((x) => x.r.products.id));
    const deOtraParte = new Set<string>();
    otros = otros.map((o) => {
      const propias = palabras(o.texto);
      if (o.es_extra || o.relleno_de || deLaBase.length === 0 || propias.length === 0 || propias.some((t) => deLaBase.includes(t))) return o;
      const combinada = buscarEnFilas(filas, [...deLaBase, ...propias].join(" "));
      if (combinada.aproximado) return o;
      const variantes = combinada.filas.filter((r) => {
        const nombre = plegarBusqueda(String(r.products?.name ?? ""));
        const primera = nombre.split(/[^a-z0-9ñ]+/).find(Boolean) ?? "";
        return enLaBase.has(r.products.id) && deLaBase.some((t) => regexDeToken(t).test(primera)) &&
          !propias.some((t) => regexDeToken(t).test(primera)) && propias.every((t) => regexDeToken(t).test(nombre));
      });
      if (variantes.length === 0) return o;
      const ids = new Set(variantes.map((r) => r.products.id));
      ids.forEach((id) => deOtraParte.add(id));
      return { ...o, resultados: [...variantes.map(filaAProducto), ...o.resultados.filter((x) => !ids.has(x.id))].slice(0, 8) };
    });
    const sinLaOtra = lista.filter((x) => !deOtraParte.has(x.r.products.id));
    if (sinLaOtra.length > 0) lista = sinLaOtra;
  }
  // Revision PR #21 ronda 16: «sol sixpack», «dos caguamas de sol». La botella NUNCA va como exacta por un six pack o
  // una caguama: si el menu no tiene esa presentacion, la cerveza va aproximada con presentacion_no_disponible.
  const textoBase = partes && otros.length > 0 ? partes.base : query;
  const categorias = new Map<string, string>(filas.map((r) => [String(r.products?.id), String(r.products?.categories?.name ?? "")]));
  const categoriaDe = (id: string) => categorias.get(id) ?? "";
  otros = otros.map((o) => ({ ...o, resultados: conPresentacion(o.resultados, o.texto, categoriaDe) }));
  // Invariante 1 (ronda 18): ninguna parte del pedido se pierde. Si la base se busco sola y no encontro nada («jugo de
  // naranja y 2 tacos», «xyz y 2 tacos»), va primero en otros_productos con [] (el agente dice que no la tenemos)
  // en vez de desaparecer con productos vacio.
  if (partes && otros.length > 0 && lista.length === 0 && tokenizeForProductSearch(partes.base).length > 0) {
    otros = [{ texto: partes.base.trim(), resultados: [] }, ...otros];
  }
  return {
    productos: conPresentacion(
      lista.map(({ r, aproximado }) => ({ ...filaAProducto(r), ...(aproximado ? { aproximado: true as const } : {}) })),
      textoBase,
      categoriaDe,
    ),
    // Aparte: el agente pregunta antes de agregarlo (nunca se cobra ni se anota como nota gratis sin el sí del cliente).
    extras_disponibles: lista.length > 0 ? extras.map((r: Fila) => ({ id: r.products.id, nombre: r.products.name, precio: r.price })) : [],
    ...(otros.length > 0 ? { otros_productos: otros } : {}),
  };
}

// Lo que dice COMO se entrega, se paga o a quien va, y la cortesia: no es parte de ningun producto. Antes «una coca
// para llevar» no casaba con nada y «a domicilio» casaba por la CATEGORIA «Kilos a Domicilio» (ronda 14).
// Las personas a quienes va un pedido («para mi esposa», «para el niño», «para los chavos»).
const PERSONAS_DEL_PEDIDO = "(?:espos[oa]s?|novi[oa]s?|hij[oa]s?|niñ[oa]s?|nin[oa]s?|beb[eé]s?|nenes?|nenas?|mam[aá]s?|pap[aá]s?|" +
  "herman[oa]s?|abuel[oa]s?|abuelit[oa]s?|t[ií][oa]s?|prim[oa]s?|suegr[oa]s?|cuñad[oa]s?|cunad[oa]s?|sobrin[oa]s?|niet[oa]s?|" +
  "amig[oa]s?|compas?|compañer[oa]s?|companer[oa]s?|jef[ea]s?|señor(?:a|as|es|ita|itas)?|senor(?:a|as|es|ita|itas)?|seño|" +
  "don|doña|chofer|repartidor[a]?|vecin[oa]s?|familia|mujer|marido|pareja|muchach[oa]s?|chamac[oa]s?|chav[oa]s?|morr[oa]s?|" +
  "peques?|chiquit[oa]s?|viej[oa]|chicos|chicas|invitad[oa]s?|cliente|oficina|casa|mesa)";
const LOGISTICA_DEL_PEDIDO = new RegExp(
  [
    "para\\s+(?:llevar|recoger|comer\\s+aqu[ií]|aqu[ií]|ac[aá]|ahorita|hoy|ma[nñ]ana|ya)",
    // A QUIEN va: solo personas («para mi esposa», «para el niño», «para ella»). «un taco para el pastor» no es
    // logistica (ronda 15): antes «para el <cualquier palabra>» se tiraba con el platillo.
    `para\\s+(?:(?:m[ií]s?|sus?|tus?|nuestr[oa]s?|el|la|los|las|un|una|unos|unas)\\s+)?${PERSONAS_DEL_PEDIDO}`,
    "para\\s+(?:m[ií]|[eé]l|ella|ellos|ellas|usted|ustedes|nosotr[oa]s|todos|todas)(?!\\s+(?!(?:y|e|o|con|sin|tambi[eé]n|por|porfa(?:vor)?|gracias|plis|please)(?![\\p{L}\\p{N}]))\\p{L})",
    "pa\\s+llevar",
    "a\\s+domicilio",
    "(?:paso\\s+)?a\\s+recoger",
    "(?:pag[oaué]\\s+)?(?:con|en)\\s+(?:tarjeta|efectivo|transferencia|terminal)",
    "con\\s+cambio(?:\\s+(?:de|para)\\s+\\$?\\s?\\d+(?:\\s*pesos)?)?",
    // Con cuanto paga (ronda 15): «pago con 500 pesos», «pagando con 200», «con (un) billete de 500».
    "(?:pag[oaué]|pagando|pagar[eé]?|pagaria)\\s+con\\s+(?:(?:un|1)\\s+billete\\s+de\\s+)?\\$?\\s?\\d+(?:\\s*(?:pesos|varos|mxn))?",
    "(?:con|traigo|tengo)\\s+(?:(?:un|1)\\s+)?billetes?\\s+de\\s+\\$?\\s?\\d+(?:\\s*(?:pesos|varos|mxn))?",
    // El precio que dice el cliente (revisión 20): «dos tacos de pastor por $100», «$100», «por 100 pesos». No es
    // producto ni cantidad (antes el «100» hacía que la consulta no encontrara nada); el total lo da el servidor.
    "(?:(?:por|en|a)\\s+)?\\$\\s?\\d+(?:[.,]\\d+)?(?:\\s*(?:pesos|mxn|varos))?",
    "(?:por|en|a)\\s+\\d+(?:[.,]\\d+)?\\s*(?:pesos|mxn|varos)",
    "por\\s+favor",
    "porfa(?:vor)?",
    "gracias",
    "plis",
    "please",
  ].map((p) => `(?<![\\p{L}\\p{N}])(?:${p})(?![\\p{L}\\p{N}])`).join("|"),
  "giu",
);

// La presentacion de la cerveza («heineken 6 pack», «sol sixpack», «un six pack de sol», «indio caguama»): no es otro
// producto ni parte del nombre de ninguna botella (ronda 15). Ya no se tira en silencio (ronda 16): la busqueda la
// ignora (tokenizeForProductSearch) y conPresentacion marca lo encontrado.
const PRESENTACION_DE_CERVEZA =
  /(?<![\p{L}\p{N}])(?:(?:\d+|six|seis|doce|veinticuatro)\s*-?\s*packs?|sixpacks?|caguamas?|caguamon(?:es)?)(?![\p{L}\p{N}])/giu;

/** El tamano de bebida pedido («1 l», «3 litros», «600 ml»): como se le dice al cliente («1 L») y como casa en un nombre. */
function volumenPedido(texto: string): { texto: string; re: RegExp } | null {
  const m = plegarBusqueda(String(texto ?? "")).match(/(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d+)?)\s*(ml|l|lt|lts|litros?|oz)(?![\p{L}\p{N}])/u);
  if (!m) return null;
  const unidad = m[2] === "ml" ? "ml" : m[2] === "oz" ? "oz" : "L";
  const variantes = unidad === "L" ? "(?:l|lt|lts|litros?)" : unidad;
  return {
    texto: `${m[1]} ${unidad}`,
    re: new RegExp(`(?<![0-9.,])${escaparRegex(m[1]!)}\\s*${variantes}(?![a-z0-9ñ])`),
  };
}

/** La presentacion pedida, como se le dice al cliente («six pack», «12 pack», «caguama»), o null. */
function presentacionPedida(texto: string): string | null {
  const m = plegarBusqueda(String(texto ?? "")).match(new RegExp(PRESENTACION_DE_CERVEZA.source, "iu"));
  if (!m) return null;
  if (/caguam/.test(m[0])) return "caguama";
  const n = tamanoDePack(m[0]);
  return n === null || n === 6 ? "six pack" : `${n} pack`;
}

/** Cuantas trae un pack dicho asi («6 pack», «six pack», «doce pack», «Sol 12 Pack»), o null si no lo dice. */
function tamanoDePack(texto: string): number | null {
  const m = plegarBusqueda(texto).match(/(?:^|[^a-z0-9ñ])(\d+|six|seis|doce|veinticuatro)\s*-?\s*packs?(?![a-z0-9ñ])|sixpack/);
  if (!m) return null;
  const n = m[1] ?? "six";
  return ({ six: 6, seis: 6, doce: 12, veinticuatro: 24 } as Record<string, number>)[n] ?? Number(n);
}

/** Un pack de OTRO tamano que el pedido (ronda 17): «sol 6 pack» no es el «Sol 12 Pack». */
function packDeOtroTamano(nombre: string, texto: string): boolean {
  if (presentacionPedida(texto) === "caguama") return false;
  const n = tamanoDePack(nombre);
  return n !== null && n !== (tamanoDePack(texto) ?? 6);
}

/** ¿El nombre lleva la presentacion que pide el texto («Indio Caguama», «Sol Six Pack» para «sol 6 pack»)? */
function nombreConPresentacion(nombre: string, texto: string): boolean {
  const presentacion = presentacionPedida(texto);
  if (!presentacion) return false;
  const palabra = presentacion === "caguama" ? "caguam" : "pack";
  return new RegExp(`(?:^|[^a-z0-9ñ])${palabra}`).test(plegarBusqueda(nombre)) && !packDeOtroTamano(nombre, texto);
}

/**
 * Lo encontrado para un texto que pide una presentacion: el producto que la lleva en el nombre va primero y exacto;
 * el resto (la botella) va aproximado con presentacion_no_disponible. Sin presentacion, igual que llego.
 */
function conPresentacion(
  productos: ProductoEncontrado[],
  texto: string,
  categoriaDe: (id: string) => string = () => "",
): ProductoEncontrado[] {
  const presentacion = presentacionPedida(texto);
  if (!presentacion) {
    // Un tamano de bebida que lo encontrado no tiene («agua 1 L», ronda 18): lo aproximado lleva el tamano pedido en
    // presentacion_no_disponible y el agente dice que ese tamano no lo hay. Lo exacto (con ese tamano) no se toca.
    const volumen = volumenPedido(texto);
    if (!volumen) return productos;
    return productos.map((p) =>
      p.aproximado && !volumen.re.test(plegarBusqueda(p.name)) ? { ...p, presentacion_no_disponible: volumen.texto } : p
    );
  }
  const palabra = presentacion === "caguama" ? "caguam" : "pack";
  const otroTamano = (p: ProductoEncontrado) => packDeOtroTamano(p.name, texto);
  const laLleva = (p: ProductoEncontrado) => nombreConPresentacion(p.name, texto);
  // Solo una bebida que se vende por pieza puede «no tener» esa presentacion (ronda 17): la cerveza (o lo que pide
  // mayoria de edad) y, para un pack, el refresco. «tacos 6 pack» no marca los tacos.
  const esBebida = (p: ProductoEncontrado) => {
    const categoria = plegarBusqueda(categoriaDe(p.id));
    return otroTamano(p) || p.requires_adult_confirmation === true || /^cervezas?$/.test(categoria) ||
      (palabra === "pack" && /^(?:refrescos?|bebidas?)$/.test(categoria));
  };
  return [
    ...productos.filter(laLleva),
    ...productos.filter((p) => !laLleva(p)).map((p) =>
      esBebida(p) ? { ...p, aproximado: true, presentacion_no_disponible: presentacion } : p
    ),
  ];
}

function quitarLogistica(query: string): string {
  return String(query ?? "").replace(LOGISTICA_DEL_PEDIDO, " ").replace(/\s+/g, " ").trim();
}

// Lo que va delante del otro producto y solo dice cuanto o cual («una», «3», «otra», «las»).
const CANTIDAD_O_ARTICULO =
  /^(?:\d+|un[oa]?s?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|otr[oa]s?|el|la|los|las|mi|mis|su|sus|de)$/;
// Un segmento que empieza asi modifica al platillo («con doble carne», «con poco queso»), no es otro producto.
const INTENSIDAD_DE_SEGMENTO = /^(?:poc[oa]s?|poquit[a-z]*|tantit[oa]s?|menos|much[oa]s?|extras?|doble|mas|bastante|harta?s?|muy|sin|todo|todito)$/;

// Una cantidad que empieza OTRO producto sin conector («4 pastor 2 bistec»): un numero entre una palabra y otra.
const NUMERO_DE_CANTIDAD = /^(?:[1-9]\d*|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte)$/;
// Lo que puede ir antes de un numero que es parte del mismo producto («orden de 3», «para 4», «x 2»).
const ANTES_DE_NUMERO_DEL_MISMO = new Set(["de", "del", "para", "por", "orden", "x", "con", "sin", "y", "e", "o", "el", "la", "los", "las", "mas", "menos"]);
// Lo que tras un numero dice el tamano o cuantos del mismo producto («pastor 1 kg», «coca 2 litros», «3 piezas»).
const TRAS_NUMERO_DEL_MISMO = new Set([
  "persona", "personas", "pieza", "piezas", "pza", "pzas", "pz", "orden", "ordenes", "porcion", "porciones", "pesos", "minutos", "min", "horas",
  "punto", "pack", "packs",
]);
// «dos tacos + una coca» (revisión 19): el «+» tambien separa. «un taco de pastor también una coca» (revisión 20):
// «también» sin «y» también (ya plegado, sin acento); tras un «y» deja una parte vacía que no cuenta.
const SEPARADORES_DE_PEDIDO = new Set(["y", "e", "o", ",", ";", "+", "tambien"]);
// «dos tacos de pastor una coca» (revisión 19): «un/una» tras un producto empieza otro sin conector, como una cifra.
const ARTICULO_DE_CANTIDAD = /^(?:un|una|uno)$/;

/** Lo que va justo antes de la fraccion del MISMO producto: un numero o la unidad («dos y medio», «kilo y medio»). */
function esCantidadDeKilo(t: string): boolean {
  return /^\d+$/.test(t) || new RegExp(`^(?:${NUMEROS_EN_PALABRAS})$`).test(t) || UNIDADES_DE_MEDIDA.has(t);
}

interface SegmentoDePedido {
  texto: string;
  palabras: string[];
  /** Lo que lo separa de lo anterior: «y», «e», «o», «,», «;», «con» o «num» (una cantidad nueva sin conector). */
  sep: string;
  inicio: number;
  fin: number;
}

interface PartesDelPedido {
  base: string;
  segmentos: SegmentoDePedido[];
  porCon: boolean;
  /** La consulta de donde salen los textos (con «alcohol» corregido): para unir un «con X» a su segmento. */
  fuente: string;
}

/**
 * Las partes de un pedido de varios productos. El separador es «y/e/o/,/;» fuera de una nota «sin …» («sin cebolla
 * y cilantro» es una sola nota), «con», o una cantidad nueva sin conector («4 pastor 2 bistec»). La base es lo de
 * antes del PRIMER separador. Si ese primero es «con» (porCon), lo de despues son los «con X» del platillo y solo
 * los que son otro producto del menu salen aparte («tacos de pastor con una coca»). Un «con» al inicio no es de
 * nada («con una coca y 2 tacos de pastor»). null = no hay separador.
 */
function segmentosDeOtros(query: string): PartesDelPedido | null {
  const fuente = corregirErratasAlcohol(String(query ?? ""));
  const texto = fuente.toLowerCase();
  let toks = [...texto.matchAll(/[\p{L}\p{N}]+(?:[.,]\p{N}+)?|[,;+]/gu)].map((m) => ({
    t: plegarBusqueda(m[0]), i: m.index ?? 0, f: (m.index ?? 0) + m[0].length,
  }));
  if (toks[0]?.t === "con") toks = toks.slice(1);
  if (toks.length < 2) return null;
  const notasSin = frasesSin(texto);
  const enNotaSin = (i: number) => notasSin.some((f) => i >= f.inicio && i < f.fin);
  const esPalabra = (t: string | undefined) => t !== undefined && /^\p{L}+$/u.test(t);
  // ¿Algo que nombra un producto despues de la fraccion, antes del siguiente separador? («medio de BISTEC»)
  const nombraOtroTras = (desde: number): boolean => {
    for (let j = desde; j < toks.length; j++) {
      const t = toks[j]!.t;
      if (SEPARADORES_DE_PEDIDO.has(t) || t === "con") return false;
      // La palabra de categoria tambien nombra un producto (revisión 19): «un kilo de pastor y media CERVEZA» no es el
      // kilo y medio (antes «cerveza», por stopword, no contaba y la cerveza se perdia).
      if (
        /^\p{L}+$/u.test(t) && t.length > 1 && (!STOPWORDS_BUSQUEDA.has(t) || PALABRAS_DE_CATEGORIA.has(t)) &&
        !UNIDADES_DE_MEDIDA.has(t)
      ) return true;
    }
    return false;
  };
  const separadorEn = (k: number): string | null => {
    if (k === 0) return null;
    const x = toks[k];
    // «kilo y medio», «dos y media»: la fraccion es del mismo producto.
    // «1 y 1/2 kilos», «2 y 1/2» (ronda 15): un numero seguido de «/» tambien es la fraccion.
    // Solo si va pegada a la cantidad («kilo y medio», «uno y medio», «2 y 1/2») o nada nuevo la sigue («un kilo de
    // pastor y medio»). «kilo de pastor y medio de bistec» es otro producto (ronda 17): antes se unia y no casaba nada.
    const fraccion = (/^(?:medi[oa]|cuarto)$/.test(toks[k + 1]?.t ?? "") ||
      (/^\d+$/.test(toks[k + 1]?.t ?? "") && /^\s*\/\s*\d/.test(fuente.slice(toks[k + 1]!.f)))) &&
      (esCantidadDeKilo(toks[k - 1]!.t) || !nombraOtroTras(k + 2));
    if (SEPARADORES_DE_PEDIDO.has(x!.t)) return enNotaSin(x!.i) || fraccion ? null : x!.t;
    if (x!.t === "con") return "con";
    const antes = toks[k - 1]!.t;
    const despues = toks[k + 1]?.t;
    // «un/una»: como la cifra, y tambien con su unidad u orden si sigue «de X» («una gringa de pastor un kilo de
    // bistec», «… una orden de papas»); «pastor un kilo» (sin «de») es el mismo producto.
    const deTrasUnidad = despues !== undefined && (UNIDADES_DE_MEDIDA.has(despues) || /^ordene?s?$/.test(despues)) &&
      toks[k + 2]?.t === "de" && esPalabra(toks[k + 3]?.t);
    if (
      ARTICULO_DE_CANTIDAD.test(x!.t) && esPalabra(antes) && !ANTES_DE_NUMERO_DEL_MISMO.has(antes) &&
      !STOPWORDS_BUSQUEDA.has(antes) && !RELLENO_ANTES_DE_CANTIDAD.has(antes) && !NUMERO_DE_CANTIDAD.test(antes) &&
      !UNIDADES_DE_MEDIDA.has(antes) && esPalabra(despues) &&
      (deTrasUnidad || (!UNIDADES_DE_MEDIDA.has(despues!) && !TRAS_NUMERO_DEL_MISMO.has(despues!))) &&
      tokenizeForProductSearch(fuente.slice(toks[0]!.i, x!.i)).some((t) => !/^\d/.test(t))
    ) return "num";
    if (
      NUMERO_DE_CANTIDAD.test(x!.t) && esPalabra(antes) && !ANTES_DE_NUMERO_DEL_MISMO.has(antes) &&
      !STOPWORDS_BUSQUEDA.has(antes) && !RELLENO_ANTES_DE_CANTIDAD.has(antes) &&
      !NUMERO_DE_CANTIDAD.test(antes) && !UNIDADES_DE_MEDIDA.has(antes) && esPalabra(despues) &&
      !UNIDADES_DE_MEDIDA.has(despues!) && !TRAS_NUMERO_DEL_MISMO.has(despues!) &&
      // Lo de antes ya nombra algo («quiero 4 parrilladas»: «quiero» no es un producto).
      tokenizeForProductSearch(fuente.slice(toks[0]!.i, x!.i)).some((t) => !/^\d/.test(t))
    ) return "num";
    return null;
  };
  const corte = toks.findIndex((_, k) => separadorEn(k) !== null);
  if (corte < 0) return null;
  const porCon = separadorEn(corte) === "con";
  const base = fuente.slice(toks[0]!.i, toks[corte]!.i);
  const segmentos: SegmentoDePedido[] = [];
  let actual: typeof toks = [];
  let sep = separadorEn(corte)!;
  const cerrar = (siguiente: string) => {
    if (actual.length > 0) {
      const inicio = actual[0]!.i;
      let fin = actual[actual.length - 1]!.f;
      // La puntuacion de cierre de lo que abrio el segmento se queda («papadzules (orden de 5)», ronda 15).
      const pares: Record<string, string> = { ")": "(", "]": "[", "}": "{", "»": "«", "”": "“", "’": "‘" };
      while (fin < fuente.length && pares[fuente[fin]!]) {
        const abierto = fuente.slice(inicio, fin);
        if (abierto.split(pares[fuente[fin]!]!).length <= abierto.split(fuente[fin]!).length) break;
        fin++;
      }
      segmentos.push({ texto: fuente.slice(inicio, fin).trim(), palabras: actual.map((x) => x.t), sep, inicio, fin });
    }
    actual = [];
    sep = siguiente;
  };
  if (separadorEn(corte) === "num") actual.push(toks[corte]!);
  for (let k = corte + 1; k < toks.length; k++) {
    const s = separadorEn(k);
    if (s === null) {
      actual.push(toks[k]!);
      continue;
    }
    cerrar(s);
    if (s === "num") actual.push(toks[k]!);
  }
  cerrar("");
  return segmentos.length > 0 ? { base, segmentos, porCon, fuente } : null;
}

/**
 * Las partes en que se parte un pedido de varios productos, como las ve la busqueda: la base (lo de antes del primer
 * separador) y cada otra parte, con el texto que dijo el cliente. Sin separador, la consulta entera. Es la medida del
 * invariante de la ronda 18: ninguna de estas partes se pierde en la respuesta de buscarProductosConExtrasCore.
 */
export function partesDelPedido(query: string): string[] {
  const limpia = quitarLogistica(corregirErratasAlcohol(query));
  const partes = segmentosDeOtros(limpia);
  return partes ? [partes.base.trim(), ...partes.segmentos.map((s) => s.texto)] : [limpia];
}

/** ¿Un producto se llama asi completo (palabra por palabra)? «chile poblano y bistec», «limonada con topo chico». */
function nombreDelMenuLoDiceTodo(rows: Fila[], partes: PartesDelPedido): boolean {
  // Por partes: «cerveza» sola es palabra de categoria (stopword en la consulta completa) y tambien tiene que estar.
  const porParte = [partes.base, ...partes.segmentos.map((s) => s.texto)]
    .map((t) => tokenizeForProductSearch(t).filter((t) => !/^\d/.test(t)));
  const tokens = porParte.flat();
  if (tokens.length < 2) return false;
  // Una parte que no pone ninguna palabra («y 2 caguamas», ronda 18) no es el resto de un nombre: es otra cosa.
  if (porParte.slice(1).some((p) => p.length === 0)) return false;
  // Una parte que repite una palabra de otra («una heineken y una heineken 0.0», «dos cocas y una coca light») es
  // OTRO producto de la misma marca, no el resto de un nombre (revision PR #21 ronda 16): antes «Heineken 0.0» lo
  // «decia todo» y la Heineken se perdia.
  // La misma palabra repetida tal cual («cero, cero», «una coca y una coca») no es otro producto: se queda como estaba.
  // Se compara con sus cifras («heineken» no es «heineken 0.0»), sin la cantidad suelta («2 cocas» = «una coca»).
  const textos = [partes.base, ...partes.segmentos.map((s) => s.texto)];
  // La presentacion cuenta como palabra (ronda 17): «una sol y una sol 6 pack» no es la misma cosa repetida.
  const plegadas = textos.map((t) => {
    const presentacion = presentacionPedida(t);
    return new Set([
      ...tokenizeForProductSearch(t).map((x) => plegarBusqueda(x)).filter((x) => !/^\d+$/.test(x)),
      ...(presentacion ? [`@${presentacion}`] : []),
    ]);
  });
  const iguales = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((t) => b.has(t));
  if (plegadas.some((a, i) => plegadas.some((b, j) => j > i && !iguales(a, b) && [...a].some((t) => b.has(t))))) return false;
  // Ni una parte que empieza con su propia cantidad tras una base que nombra algo («dos cocas y UNA light», ronda 18):
  // es otro producto. Lo mismo repetido («una coca y una coca») y la base de puro relleno («dame, 2 litros de coca»)
  // siguen como estaban.
  const conCantidad = (s: SegmentoDePedido) => NUMERO_DE_CANTIDAD.test(s.palabras[0] ?? "") || /^un[oa]?s?$/.test(s.palabras[0] ?? "");
  if (plegadas[0]!.size > 0 && partes.segmentos.some((s, i) => conCantidad(s) && !iguales(plegadas[0]!, plegadas[i + 1]!))) return false;
  const res = tokens.map((t) => new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(plegarBusqueda(t))}(?:s|es)?(?![a-z0-9ñ])`));
  return rows.some((r) => {
    const nombre = plegarBusqueda(String(r.products?.name ?? ""));
    return res.every((re) => re.test(nombre));
  });
}

/**
 * Cada parte del pedido que es OTRO producto, con su busqueda. Fuera: cuantificadores, notas («sin cebolla», «poco
 * queso»), lo incluido sin costo (cebolla, salsa) y, tras un «con», los extras y la preparacion (son del platillo).
 * Sin «con» (y/e/o/,): toda parte que no es nota se devuelve, aunque el menu no la tenga (resultados [] -> el agente
 * dice que no la tenemos); un extra con costo («y queso») va con el extra del menu y `es_extra`. Tras un «con» solo
 * sale lo que el menu tiene por nombre o alias; si no, se une a la parte anterior («una coca y tacos de pastor con
 * queso»).
 */
function otrosProductosDe(rows: Fila[], partes: PartesDelPedido): OtroProductoPedido[] {
  const extrasMenu = extrasDelMenu(rows);
  const palabrasDeExtras = new Set([...extrasMenu.keys()].flatMap((k) => k.split(" ")));
  const esExtra = (w: string) => formasBase(w).some((b) => extrasMenu.has(b) || palabrasDeExtras.has(b));
  // Por NOMBRE o alias. La categoria solo cuenta si la palabra ES la categoria («cerveza» -> Cervezas, «refresco» ->
  // Refrescos): «a domicilio» no es un producto por estar en «Kilos a Domicilio».
  const esDelMenu = (tokens: string[]) =>
    rows.some((r) => {
      const nombre = plegarBusqueda(String(r.products?.name ?? ""));
      const categoria = plegarBusqueda(String(r.products?.categories?.name ?? "")).split(/[^a-z0-9ñ]+/).find(Boolean) ?? "";
      const alias: string[] = (r.products?.search_keywords ?? []).map(plegarBusqueda);
      return tokens.every((t) =>
        regexDeToken(t).test(nombre) || alias.some((a) => regexDeToken(t).test(a)) ||
        (categoria !== "" && formasBase(categoria).includes(plegarBusqueda(t)))
      );
    });
  // Que se queda de un segmento: las palabras sin el cuantificador y su nucleo (antes del «sin/con»), o null si es nota.
  const analizar = (segOriginal: SegmentoDePedido, trasCon: boolean) => {
    // Invariante 3 (ronda 18): el peso se normaliza en CADA parte antes de quitarle la cantidad («y 2 kilos de pastor»
    // -> «2kg de pastor»: el «2» es el tamano, no cuantos). Las palabras salen del texto ya normalizado.
    const normalizado = normalizarPesos(segOriginal.texto.toLowerCase());
    const seg = {
      ...segOriginal,
      palabras: [...normalizado.matchAll(/[\p{L}\p{N}]+(?:[.,]\p{N}+)?|[,;]/gu)].map((m) => plegarBusqueda(m[0])),
    };
    let k = 0;
    // El numero del pack («y 6 pack de sol», «12 pack») es la presentacion, no la cantidad (ronda 17): sin el,
    // «pack de sol» no casaba nada y la Sol se perdia.
    while (k < seg.palabras.length && CANTIDAD_O_ARTICULO.test(seg.palabras[k]!) && !/^packs?$/.test(seg.palabras[k + 1] ?? "")) k++;
    let resto = seg.palabras.slice(k);
    if (resto.length === 0) return null;
    // «y 1 orden de guacamole», «y 2 ordenes de flautas»: la orden es como se pide, no parte del nombre (revision PR
    // #21 ronda 15). Se busca sin ella; `conOrden` guarda las palabras tal cual por si el nombre si la lleva.
    let conOrden: string[] | null = null;
    if (/^orden(?:es)?$/.test(resto[0]!) && resto[1] === "de") {
      let j = 2;
      while (j < resto.length && CANTIDAD_O_ARTICULO.test(resto[j]!)) j++;
      if (j < resto.length) {
        conOrden = resto;
        resto = resto.slice(j);
      }
    }
    // «y extra queso», «y doble guacamole» (sin «con»): es el extra.
    if (!trasCon && /^(?:extras?|doble|mas)$/.test(resto[0]!) && resto.length > 1 && esExtra(resto[1]!)) resto = resto.slice(1);
    if (INTENSIDAD_DE_SEGMENTO.test(resto[0]!)) return null;
    const primera = resto[0]!;
    if (formasBase(primera).some((b) => GUARNICIONES_SIN_COSTO.has(b))) return null;
    const corteNucleo = resto.findIndex((w) => w === "sin" || w === "con");
    const nucleo = (corteNucleo >= 0 ? resto.slice(0, corteNucleo) : resto).join(" ");
    // «y una caguama», «y 2 six pack» (ronda 18): solo la presentacion son las cervezas, no una parte vacia que se tira.
    const tokens = tokenizeForProductSearch(nucleo).length === 0 && presentacionPedida(nucleo) !== null
      ? tokenizeForProductSearch("cerveza")
      : tokenizeForProductSearch(nucleo);
    // Sin la orden no es nada del menu pero con ella si: se busca con ella.
    if (conOrden && !esDelMenu(tokens)) {
      const corte = conOrden.findIndex((w) => w === "sin" || w === "con");
      const nucleoOrden = (corte >= 0 ? conOrden.slice(0, corte) : conOrden).join(" ");
      const tokensOrden = tokenizeForProductSearch(nucleoOrden);
      if (esDelMenu(tokensOrden)) return { resto: conOrden, primera: conOrden[0]!, nucleo: nucleoOrden, tokens: tokensOrden, porOrden: false };
    }
    return { resto, primera, nucleo, tokens, porOrden: conOrden !== null };
  };
  // Tras un «con», un extra con costo (también a medio escribir: «con guacamol») o la preparacion es del platillo.
  const esDelPlatilloTrasCon = (primera: string) => {
    const prefijo = regexDeToken(singularizarToken(primera));
    return esIngredienteDePreparacion(primera) || esExtra(primera) || [...palabrasDeExtras].some((k) => prefijo.test(k));
  };
  // Sin «con» al inicio: un «con X» que no es otro producto se queda en su parte.
  const segmentos: SegmentoDePedido[] = [];
  for (const seg of partes.segmentos) {
    const previo = segmentos[segmentos.length - 1];
    if (!partes.porCon && seg.sep === "con" && previo) {
      const a = analizar(seg, true);
      if (!a || esDelPlatilloTrasCon(a.primera) || a.tokens.length === 0 || !esDelMenu(a.tokens)) {
        segmentos[segmentos.length - 1] = {
          ...previo,
          texto: partes.fuente.slice(previo.inicio, seg.fin).trim(),
          palabras: [...previo.palabras, "con", ...seg.palabras],
          fin: seg.fin,
        };
        continue;
      }
    }
    segmentos.push(seg);
  }
  const salida: OtroProductoPedido[] = [];
  for (const seg of segmentos) {
    const trasCon = partes.porCon || seg.sep === "con";
    const a = analizar(seg, trasCon);
    if (!a) continue;
    const { resto, primera, tokens } = a;
    if (trasCon && esDelPlatilloTrasCon(primera!)) continue;
    // «una orden de guacamole» es el platillo (el Guacamole), no el extra.
    if (!trasCon && !a.porOrden && esExtra(primera!)) {
      // «tacos de pastor y queso»: el extra del menu (y el producto que se llama asi solo, si lo hay: «Guacamole»).
      const nucleo = plegarBusqueda(a.nucleo);
      const delExtra = extrasMenu.get(nucleo) ?? formasBase(primera!).map((b) => extrasMenu.get(b)).find((l) => l && l.length > 0) ?? [];
      const solo = rows.filter((r) => !delExtra.includes(r) && plegarBusqueda(String(r.products?.name ?? "")).trim() === nucleo);
      // Antes del extra, el relleno (revision PR #21 ronda 15): «tacos de pastor y champiñones» son TACOS de
      // champiñones si el menu los tiene; el Extra Champiñón queda despues, como opcion.
      const relleno = rellenoDelPlatillo(rows, partes.base, a.nucleo);
      if (relleno) {
        const ids = new Set(relleno.filas.map((r) => r.products.id));
        salida.push({
          texto: seg.texto,
          resultados: [...relleno.filas, ...[...delExtra, ...solo].filter((r) => !ids.has(r.products.id))].slice(0, 8).map(filaAProducto),
          relleno_de: relleno.plato,
        });
        continue;
      }
      if (delExtra.length + solo.length > 0) {
        salida.push({ texto: seg.texto, resultados: [...delExtra, ...solo].map(filaAProducto), es_extra: true });
        continue;
      }
    }
    if (!trasCon && esIngredienteDePreparacion(primera!) && (tokens.length === 0 || !esDelMenu(tokens))) continue;
    if (tokens.length === 0) continue;
    const delMenu = esDelMenu(tokens);
    // Tras el «con» solo cuenta lo que el menu tiene («con lengua» es del platillo: la red de seguridad lo marca).
    if (seg.sep === "con" && !delMenu) continue;
    const encontrado = buscarEnFilas(rows, resto.join(" "));
    if (seg.sep === "con" && encontrado.filas.length === 0) continue;
    // Si sus palabras no son nombre, alias ni categoria de nada, una coincidencia exacta solo pudo salir de la
    // descripcion («carne»): no es ese producto. Lo aproximado (una errata) si se ofrece, marcado.
    const filasOtro = delMenu || encontrado.aproximado ? encontrado.filas : [];
    const resultados = filasOtro.map((r) => ({ ...filaAProducto(r), ...(encontrado.aproximado ? { aproximado: true as const } : {}) }));
    // «tacos de pastor y bistec»: el bistec son TACOS de bistec (primero), no el platillo ni el kilo.
    const relleno = filasOtro.length > 0 ? rellenoDelPlatillo(rows, partes.base, a.nucleo) : null;
    if (relleno) {
      const ids = new Set(relleno.filas.map((r) => r.products.id));
      salida.push({
        texto: seg.texto,
        resultados: [...relleno.filas.map(filaAProducto), ...resultados.filter((x) => !ids.has(x.id))].slice(0, 8),
        relleno_de: relleno.plato,
      });
      continue;
    }
    salida.push({ texto: seg.texto, resultados });
  }
  return salida;
}

/**
 * ¿La parte es solo el RELLENO del platillo de la base? «tacos de pastor y bistec», «tacos de bistec y de pastor»,
 * «gringa de pastor y bistec»: el platillo es la primera palabra de la base y lo pedido es «<platillo> de <relleno>»;
 * «2 pastor y 3 bistec» (relleno solo con su cantidad): en Merida son tacos. Devuelve el platillo y SUS productos
 * (los que llevan el platillo y el relleno en el nombre), o null si la parte es otra cosa («una coca»).
 */
function rellenoDelPlatillo(rows: Fila[], base: string, nucleo: string): { plato: string; filas: Fila[] } | null {
  const palabrasBase = plegarBusqueda(base).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const hastaNota = palabrasBase.findIndex((w) => w === "sin" || w === "con");
  const antesDeNota = hastaNota >= 0 ? palabrasBase.slice(0, hastaNota) : palabrasBase;
  // «medio kilo de pastor y bistec»: el tamano no es un platillo.
  if (antesDeNota.some((w) => UNIDADES_DE_MEDIDA.has(w) || /^(?:medi[oa]|cuarto)$/.test(w) || /^\d+(?:kg|g)$/.test(w))) return null;
  const contenido = antesDeNota.filter((w) =>
    /^[a-zñ]+$/.test(w) && !STOPWORDS_BUSQUEDA.has(w) && !CANTIDAD_O_ARTICULO.test(w) && !RELLENO_ANTES_DE_CANTIDAD.has(w)
  );
  const relleno = tokenizeForProductSearch(nucleo).filter((t) => !/^\d/.test(t));
  if (contenido.length === 0 || relleno.length === 0) return null;
  const delPlato = (plato: string, que: string[]) => {
    const encontrado = buscarEnFilas(rows, `${plato} de ${que.join(" ")}`);
    if (encontrado.aproximado) return [];
    const rePlato = regexDeToken(singularizarToken(plato));
    return encontrado.filas.filter((r) => {
      const nombre = plegarBusqueda(String(r.products?.name ?? ""));
      return rePlato.test(nombre) && que.every((t) => regexDeToken(t).test(nombre));
    });
  };
  let plato = contenido[0] ?? "";
  if (contenido.length === 1) {
    plato = "tacos";
    if (delPlato(plato, contenido).length === 0) return null;
  }
  // La parte ya nombra su platillo («y tacos de bistec», «y una gringa»): no es un relleno.
  if (relleno.some((t) => formasBase(t).includes(singularizarToken(plato)) || formasBase(plato).includes(t))) return null;
  const filas = delPlato(plato, relleno);
  return filas.length > 0 ? { plato, filas } : null;
}

function filaAProducto(r: Fila): ProductoEncontrado {
  return {
    id: r.products.id,
    name: r.products.name,
    price: r.price,
    pack_size: extraerPackSize(r.products.name, r.products.description),
    piezas_por_platillo: extraerPiezasPorPlatillo(r.products.name, r.products.description),
    requires_adult_confirmation: requiresAdultConfirmation(r.products.name, r.products.categories?.name),
  };
}

/** Lo que devuelve una busqueda sobre las filas del menu: filas ordenadas (con tope), si es aproximado y los extras pedidos. */
interface ResultadoFilas {
  filas: Fila[];
  /** Todos los candidatos, sin el tope de 8. */
  todas: Fila[];
  aproximado: boolean;
  extras: Fila[];
}

// Primer «con»/«sin» como palabra suelta («conga», «sincronizada» no cuentan).
const PRIMER_CON_O_SIN = /(?<![\p{L}\p{N}])(con|sin)(?![\p{L}\p{N}])/u;
// Lo que solo dice CUANTO o une («con extras», «con mas», «con 2 extras», «con queso o»): no nombra nada del menu.
const SOLO_CANTIDAD_O_CONECTOR =
  /^(?:\d+|sin|ni|e|o|un[oa]?s?|muy|poc[oa]s?|poquit\p{L}*|tantit[oa]s?|menos|much[oa]s?|extras?|doble|m[aá]s|bastante|harta?s?)$/u;

/** ¿El producto es lo que la consulta EXCLUYE con «sin X» (nombre con lo excluido, o con alcohol si pidio sin alcohol)? */
function esLoExcluido(query: string): (r: Fila) => boolean {
  const notasSin = excluidosDePreparacion(query);
  const excluidos = excluidosNoPreparacion(query);
  const terminos = excluidos.flatMap((e) => EXCLUSIONES_EQUIVALENTES.find((g) => g.includes(e)) ?? [e]);
  const sinAlcohol = excluidos.some((e) => e.split(" ").includes("alcohol")) || pideCeroCero(query);
  const nombreSinNegados = (n: string) => plegarBusqueda(n).replace(/\bsin\s+[a-z0-9ñ]+/g, " ");
  return (r: Fila) =>
    notasSin.some((ws) => nombreLlevaExcluido(r.products.name, ws)) ||
    terminos.some((e) => new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(e)}`).test(nombreSinNegados(r.products.name))) ||
    (sinAlcohol && requiresAdultConfirmation(r.products.name, r.products.categories?.name));
}

/**
 * Red de seguridad de «con/sin» (revision PR #21 ronda 12). Cada ronda encontraba otra forma de «con …» que el
 * parser no entendia del todo, y la exacta casaba entonces un producto raro por alias o descripcion, sin marca
 * («tacos de pastor con guacamole o queso» -> solo el Alambre Suizo de Pastor; «pastor con dos extras de queso» ->
 * solo el Chetaco de Pastor). Ahora SIEMPRE se busca tambien el platillo, lo que va antes del primer «con/sin»
 * («tacos de pastor», «pastor»):
 *  - Si la busqueda completa encontro un producto cuyo NOMBRE lleva el platillo y lo del «con/sin» («Boyo con
 *    Queso», «Limonada con Topo Chico», «Bistec Encebollado» por «con cebolla», «Coca-Cola sin Azúcar»), manda la
 *    busqueda completa, como siempre.
 *  - Si no, con «con»: primero los del platillo (exactos, salvo que la busqueda completa ya fuera aproximada),
 *    sin lo que un «sin X» excluye; despues lo que SOLO salio por las palabras del «con/sin», marcado aproximado.
 *  - Solo «sin»: no se agrega nada (lo excluido no vuelve por la base); lo que no es del platillo va aproximado.
 *  - «con extras» / «con mas» solos: los del platillo, sin extra ofrecido.
 * Los extras con costo siguen yendo en extras_disponibles.
 */
function conRedDeSeguridad(
  rows: Fila[],
  query: string,
  principal: ResultadoFilas,
): { lista: Array<{ r: Fila; aproximado: boolean }>; extras: Fila[]; porPlatillo?: boolean } {
  const comoVino = { lista: principal.filas.map((r) => ({ r, aproximado: principal.aproximado })), extras: principal.extras };
  const minusculas = query.toLowerCase();
  const corte = PRIMER_CON_O_SIN.exec(minusculas);
  if (!corte) return comoVino;
  const textoBase = query.slice(0, corte.index);
  const tokensBase = tokenizeForProductSearch(textoBase);
  if (tokensBase.length === 0) return comoVino;
  const base = buscarEnFilas(rows, textoBase);
  const clausula = partirTokens(plegarBusqueda(minusculas.slice(corte.index))).filter((t) => !SOLO_CANTIDAD_O_CONECTOR.test(t));
  // «tacos de pastor con extras»: solo un cuantificador, nada que ofrecer.
  if (clausula.length === 0) return { lista: base.filas.map((r) => ({ r, aproximado: base.aproximado })), extras: [], porPlatillo: true };
  // Todo lo que casa con el platillo, no solo los primeros 8 que se devuelven.
  const idsBase = new Set(base.todas.map((r) => r.products.id));
  // El producto ES lo pedido completo: su nombre lleva el platillo y lo del «con/sin» («Boyo con Queso», «Bistec
  // Encebollado»), o el cliente nombro ESE platillo (su nombre empieza por una palabra del platillo) y su descripcion
  // trae lo del «con» («francés con guacamole» -> los Francés Suizos, que lo traen).
  const loEsCompleto = (r: Fila) => {
    const nombre = plegarBusqueda(String(r.products?.name ?? ""));
    if (!tokensBase.every((t) => regexDeToken(t).test(nombre))) return false;
    const lleva = (texto: string) => clausula.some((w) => regexDeToken(singularizarToken(w)).test(texto));
    if (lleva(nombre)) return true;
    const primera = nombre.split(/[^a-z0-9ñ]+/).find(Boolean) ?? "";
    const empiezaPorElPlatillo = tokensBase.some((t) => formasBase(t).includes(primera) || formasBase(primera).includes(plegarBusqueda(t)));
    return empiezaPorElPlatillo && lleva(plegarBusqueda(String(r.products?.description ?? "")));
  };
  const marcados = principal.filas.map((r) => ({
    r,
    aproximado: principal.aproximado || (!idsBase.has(r.products.id) && !loEsCompleto(r)),
  }));
  const hayCon = /(?<![\p{L}\p{N}])con(?![\p{L}\p{N}])/u.test(minusculas);
  if (!hayCon || principal.filas.some(loEsCompleto)) return { lista: marcados, extras: principal.extras };
  const enPrincipal = new Set(principal.filas.map((r) => r.products.id));
  const excluido = esLoExcluido(query);
  // La completa no encontro nada y el «con» trae una palabra que el menu no conoce (ni preparacion, ni extra, ni un
  // producto o su categoria: «con sushi», «con lengua»): el platillo va, pero aproximado (no se inventa lo que pidio).
  const extrasMenu = extrasDelMenu(rows);
  const palabrasDeExtras = new Set([...extrasMenu.keys()].flatMap((k) => k.split(" ")));
  const laConoce = (w: string) =>
    esIngredienteDePreparacion(w) || formasBase(w).some((f) => extrasMenu.has(f) || palabrasDeExtras.has(f)) ||
    // En plural tambien («con 3 cocas», «con unos refrescos»): es otro producto que el agente busca aparte.
    rows.some((r) => regexDeToken(singularizarToken(w)).test(plegarBusqueda(`${r.products?.name ?? ""} ${r.products?.categories?.name ?? ""}`)));
  const pideAlgoDesconocido = principal.filas.length === 0 && !clausula.every(laConoce);
  const aproximadoBase = base.aproximado || pideAlgoDesconocido || (principal.aproximado && principal.filas.length > 0);
  const delPlatillo = base.filas
    .filter((r) => enPrincipal.has(r.products.id) || !excluido(r))
    .map((r) => ({ r, aproximado: aproximadoBase }));
  // Lo de la completa que tambien es del platillo pero quedo fuera de sus 8 («Francés Suizo de Arrachera», que trae el
  // guacamole) va despues de los del platillo, no se tira.
  const enBase = new Set(base.filas.map((r) => r.products.id));
  const fueraDelTope = marcados.filter((x) => idsBase.has(x.r.products.id) && !enBase.has(x.r.products.id) && !excluido(x.r));
  return {
    lista: [...delPlatillo, ...fueraDelTope, ...marcados.filter((x) => !idsBase.has(x.r.products.id))],
    extras: principal.extras,
    porPlatillo: true,
  };
}

// «media de X» / «media orden de X» (ronda 18). El «media de» que no va tras un «y» («kilo y media de» es otra cosa).
const MEDIA_DE = /(?<![\p{L}\p{N}])(?<!(?:^|\s)y\s+)medi[oa]\s+de\s+/iu;
const MEDIA_ORDEN_DE = /(?<![\p{L}\p{N}])medi[oa]\s+ordene?s?\s+de\s+/iu;

/** ¿El texto nombra una carne que el menu vende por kilo («Pastor — 500 g», «Bistec de Res — 1 kg»)? */
function nombraCarnePorKilo(rows: Fila[], texto: string): boolean {
  const tokens = tokenizeForProductSearch(texto).filter((t) => !/^\d/.test(t));
  if (tokens.length === 0) return false;
  return rows.some((r) => {
    const m = /^(.*?)\s+[—–-]\s+\d+(?:[.,]\d+)?\s*(?:kg|g)$/.exec(plegarBusqueda(String(r.products?.name ?? "")).trim());
    return m !== null && tokens.every((t) => regexDeToken(t).test(m[1]!));
  });
}

/**
 * La busqueda de siempre sobre las filas ya leidas del menu, con la «media» resuelta contra el menu (ronda 18):
 *  - «media de X» es el medio kilo SOLO si X es una carne por kilo («media de pastor»). Si no («una media de cerveza»,
 *    «una media de horchata»), se busca X y va aproximado: antes salian exactos los 500 g de todas las carnes.
 *  - «media orden de X» es el «(1/2 orden)» de X; si X no tiene media orden («media orden de tacos»), X aproximado.
 */
function buscarEnFilas(rows: Fila[], query: string): ResultadoFilas {
  const media = MEDIA_DE.exec(query);
  if (media && !nombraCarnePorKilo(rows, query.slice(media.index + media[0].length).split(/\s(?:con|sin)\s/i)[0]!)) {
    const sinMedia = `${query.slice(0, media.index)} ${query.slice(media.index + media[0].length)}`.replace(/\s+/g, " ").trim();
    const r = buscarEnFilasTalCual(rows, sinMedia);
    return { ...r, aproximado: r.filas.length > 0 };
  }
  const r = buscarEnFilasTalCual(rows, query);
  // Una «media» suelta («una cerveza y media», «dos medias»): sin «de X», «kilo» ni «orden» no nombra nada; por errata
  // casaba el «kilo y medio» de las descripciones y salian los 500 g / 1.5 kg de todas las carnes. Si asi no hubo nada
  // exacto, se busca sin ella (aproximado); sin nada mas, nada.
  const mediaSuelta = /(?<![\p{L}\p{N}])medi[oa]s?(?![\p{L}\p{N}])(?!\s+(?:de|del|kilos?|kg|ordene?s?)(?![\p{L}\p{N}]))/giu;
  if ((r.filas.length === 0 || r.aproximado) && mediaSuelta.test(query)) {
    const sinMedia = query.replace(mediaSuelta, " ").replace(/\s+/g, " ").trim();
    const x = buscarEnFilasTalCual(rows, sinMedia);
    return { ...x, aproximado: x.filas.length > 0 };
  }
  const mediaOrden = MEDIA_ORDEN_DE.exec(query);
  if (r.filas.length === 0 && mediaOrden) {
    const sinMedia = `${query.slice(0, mediaOrden.index)} ${query.slice(mediaOrden.index + mediaOrden[0].length)}`.replace(/\s+/g, " ").trim();
    const x = buscarEnFilasTalCual(rows, sinMedia);
    return { ...x, aproximado: x.filas.length > 0 };
  }
  return r;
}

/** La busqueda de siempre (exacta, sinonimos, «con X», erratas, relajada) sobre las filas ya leidas del menu. */
function buscarEnFilasTalCual(rows: Fila[], query: string): ResultadoFilas {
  // La presentacion («six pack», «caguama») tampoco cuenta para el orden: «heineken 6 pack» ordena como «heineken».
  const sinPresentacion = corregirErratasAlcohol(query).replace(PRESENTACION_DE_CERVEZA, " ").replace(/\s+/g, " ").trim();
  // Solo la presentacion y su cantidad («una caguama», «2 six pack», ronda 18): son las cervezas (el llamador las marca
  // con presentacion_no_disponible). Antes una parte asi del pedido no buscaba nada y se perdia.
  query = tokenizeForProductSearch(sinPresentacion).length === 0 && presentacionPedida(query) !== null ? "cerveza" : sinPresentacion;
  let tokens = tokenizeForProductSearch(query);
  if (tokens.length === 0) return { filas: [], todas: [], aproximado: false, extras: [] };
  // Solo la palabra de categoria («una cerveza», «dos cervezas», «un coctel», ronda 18): no nombra un producto. Lo de
  // la categoria va aproximado para que el agente pregunte cual (antes eran 8 cervezas exactas).
  // «un agua», «dos aguas» (revisión 19): «agua» sola tambien es categoria (Aguas Frescas, Agua Purificada, Mineral):
  // aproximado para que el agente pregunte cual. «agua de jamaica», «agua 600ml» nombran una y siguen exactas.
  const soloCategoria = tokens.every((t) => [...PALABRAS_DE_CATEGORIA.values()].includes(t) || t === "agua");

  // «frijoles» -> «frijol», «limones» -> «limon»: el singular de un -es casa como palabra COMPLETA y solo en nombre,
  // categoria o alias. Como prefijo «limon» era la LIMONada y por descripcion «frijol» eran los Chetacos (exactos).
  const enteros = singularesDeEs(query);
  const coincide = (r: Fila) => coincideTokens(tokens, r);
  const coincideTokens = (tokens: string[], r: Fila) => {
    // Sin ningun termino no hay coincidencia (con every() vacio casaba TODO el menu).
    if (tokens.length === 0) return false;
    const producto = r.products;
    const textoPlano = [
      producto.name,
      producto.description,
      producto.categories?.name,
    ]
      .filter(Boolean)
      .join(" ");
    const planoFold = plegarBusqueda(textoPlano);
    const sinDescripcion = plegarBusqueda([producto.name, producto.categories?.name].filter(Boolean).join(" "));
    const alias: string[] = (producto.search_keywords ?? []).map(plegarBusqueda);
    // Un tamano («355ml», «600 ml», «2 litros») solo cuenta por la DESCRIPCION si otra palabra de la consulta nombra
    // el producto (revision PR #21 ronda 16): «agua 600ml» -> Agua Purificada (600ml), pero «cerveza 355ml» no es el
    // Topo Chico por su «355ml».
    const tamano = indicesDeTamano(tokens);
    const nombraElProducto = tokens.some((t, i) => {
      if (tamano.has(i)) return false;
      const re = enteros.has(plegarBusqueda(t)) ? regexDePalabraEntera(t) : regexDeToken(t);
      return re.test(plegarBusqueda(String(producto.name ?? ""))) || alias.some((a) => re.test(a));
    });
    return tokens.every((t, i) => {
      if (enteros.has(plegarBusqueda(t))) {
        const re = regexDePalabraEntera(t);
        return re.test(sinDescripcion) || alias.some((a) => re.test(a));
      }
      // «300 ml» (separado): la unidad casa pegada a su numero («300ml» de la descripcion), no como palabra suelta.
      const previo = i > 0 ? plegarBusqueda(tokens[i - 1]!) : "";
      const re = tamano.has(i) && /^\d+(?:[.,]\d+)?$/.test(previo) && !/^\d/.test(t)
        ? new RegExp(`(?:^|[^a-z0-9ñ.])${escaparRegex(previo)}\\s*${escaparRegex(plegarBusqueda(t))}(?![a-z0-9ñ])`)
        : regexDeToken(t);
      if (tamano.has(i) && !nombraElProducto) return re.test(sinDescripcion) || alias.some((a) => re.test(a));
      return re.test(planoFold) || alias.some((a) => re.test(a));
    });
  };

  let candidatos = (rows).filter(coincide);
  let tokensOriginales = tokens;
  // «cerveza sin alcohol»: el menu dice «0.0». Se reintenta con el sinonimo antes de rendirse.
  const consultaSinonimos = sinonimosDeBusqueda(query);
  if (candidatos.length === 0 && consultaSinonimos !== query) {
    tokens = tokenizeForProductSearch(consultaSinonimos);
    candidatos = (rows).filter(coincide);
  }
  // «tacos de pastor con cebolla»: con las palabras tal cual no hay nada (ningun taco de pastor «lleva» cebolla en el
  // nombre). «con <ingrediente de preparacion>» es entonces una nota para cocina, no parte del producto: se busca sin
  // ella. No es aproximado: es lo pedido, con su nota. Si la exacta encontro algo («bistec con cebolla» ->
  // Encebollado, «boyo con queso»), manda la exacta, salvo con un extra de pago que el encontrado no lleva en el
  // nombre (ver loNombra). Los pasos siguientes (erratas, relajada) usan la consulta sin la nota.
  // Antes de tirar «con X» como nota se mira si X es un EXTRA CON COSTO del menu («con guacamole» -> Extra Guacamole
  // $49): entonces el extra va aparte (extras_disponibles) para que el agente PREGUNTE. Lo incluido sin costo
  // (cebolla, cilantro, salsa, limon, la piña del pastor, «con todo») sigue siendo solo nota. Un «con X» con costo
  // que el menu no tiene como extra («frijoles con chicharrón») no se cotiza en silencio: lo encontrado va aproximado.
  const extrasPedidos: Fila[] = [];
  let conSinExtra = false;
  // Lo que ya trae el «con X» segun el catalogo: va despues de los del platillo (ver abajo).
  const trasLaBase = new Set<Fila>();
  {
    const extras = extrasDelMenu(rows);
    const filasExtra = new Set([...extras.values()].flat());
    const extraDe = (w: string) => formasBase(w).map((f) => extras.get(f)).find((l) => l && l.length > 0) ?? null;
    // Las palabras de un extra de varias («poblano» de «chile poblano») tambien forman parte del «con X».
    const deExtraCompuesto = new Set([...extras.keys()].filter((k) => k.includes(" ")).flatMap((k) => k.split(" ")));
    const sinNotaCon = quitarNotasCon(query, (w) => extraDe(w) !== null || deExtraCompuesto.has(plegarBusqueda(w)));
    const tokensSinNota = sinNotaCon === null ? [] : tokenizeForProductSearch(sinNotaCon.texto);
    if (tokensSinNota.length > 0) {
      const consultaPlegada = plegarBusqueda(query);
      const pideExtra = /(?:^|[^a-z0-9ñ])(?:extras?|doble)(?![a-z0-9ñ])/.test(consultaPlegada);
      const delPastor = /(?:^|[^a-z0-9ñ])pastor/.test(consultaPlegada);
      const porIngrediente: Array<{ bases: string[]; extra: Fila[] }> = [];
      let sinExtraDelMenu = false;
      for (const { palabras, menos } of sinNotaCon!.ingredientes) {
        // «con poco queso»: pide menos, es nota (ni extra ni aproximado).
        if (menos) continue;
        for (let i = 0; i < palabras.length;) {
          // El extra de varias palabras casa primero («chile poblano» -> Extra Chile Poblano, no el «chile» sin costo).
          let j = palabras.length;
          while (j > i + 1 && !extras.has(plegarBusqueda(palabras.slice(i, j).join(" ")))) j--;
          if (j > i + 1) {
            const frase = plegarBusqueda(palabras.slice(i, j).join(" "));
            porIngrediente.push({ bases: [frase], extra: extras.get(frase)! });
            i = j;
            continue;
          }
          const w = palabras[i++];
          const bases = formasBase(w!);
          const extra = extraDe(w!);
          const sinCosto = bases.some((b) => GUARNICIONES_SIN_COSTO.has(b)) || (delPastor && bases.includes("pina"));
          if (sinCosto && !(pideExtra && extra && !bases.includes("salsa"))) continue;
          if (extra) porIngrediente.push({ bases, extra });
          else sinExtraDelMenu = true;
        }
      }
      const palabraEn = (texto: string, bases: string[]) =>
        bases.some((b) => new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(b)}`).test(texto));
      // En el NOMBRE, la palabra completa (con su plural): «Quesobich» no «lleva» queso; «Boyo con Queso» si.
      const palabraEnteraEn = (texto: string, bases: string[]) =>
        bases.some((b) => new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(b)}(?:s|es)?(?![a-z0-9ñ])`).test(texto));
      // Con un extra de pago nombrado, la exacta con las palabras tal cual solo manda si encontro un producto que lo
      // lleva segun el CATALOGO: en el nombre («boyo con queso» -> Boyo-Hamburguesa con Queso) o en la descripcion
      // («francés con guacamole» -> los Francés Suizos, que lo traen). Si solo caso por un alias («tacos de pastor
      // con queso» -> el Alambre Suizo, por su alias «queso») o porque el encontrado es el propio extra («francés con
      // piña» -> Extra Piña, que dice «para el francés»), el «con X» sale ANTES de buscar el platillo: son los de
      // «tacos de pastor» / «francés» y el extra va aparte.
      // La descripcion solo cuenta si el cliente nombro ESE platillo: su nombre lleva las palabras del platillo y
      // empieza por una de ellas («francés con guacamole» -> Francés Suizo, que lo trae). «pastor con guacamole» no
      // nombra el francés (solo comparte la carne): el Francés Suizo de Pastor casa por su descripcion, pero no puede
      // ser la unica respuesta; se busca «pastor» y se ofrece el extra (el francés se queda en la lista).
      const nombraElPlatillo = (r: Fila) => {
        const nombre = plegarBusqueda(String(r.products.name ?? ""));
        const primera = nombre.split(/[^a-z0-9ñ]+/).find(Boolean) ?? "";
        return tokensSinNota.every((t) => regexDeToken(t).test(nombre)) &&
          tokensSinNota.some((t) => formasBase(t).includes(primera) || formasBase(primera).includes(plegarBusqueda(t)));
      };
      const loNombra = (r: Fila) =>
        !filasExtra.has(r) &&
        porIngrediente.every(({ bases }) =>
          palabraEnteraEn(plegarBusqueda(r.products.name), bases) ||
          (palabraEn(plegarBusqueda(r.products.description ?? ""), bases) && nombraElPlatillo(r))
        );
      // Los que SI lo traen segun su descripcion (aunque el cliente no los nombro): se quedan en la lista, junto a lo
      // del platillo.
      const loTraenPorDescripcion = candidatos.filter((r: Fila) =>
        !filasExtra.has(r) &&
        porIngrediente.length > 0 &&
        porIngrediente.every(({ bases }) => palabraEn(plegarBusqueda(`${r.products.name} ${r.products.description ?? ""}`), bases))
      );
      if (candidatos.length === 0 || (porIngrediente.length > 0 && !candidatos.some(loNombra))) {
        conSinExtra = sinExtraDelMenu;
        query = sinNotaCon!.texto;
        tokens = tokensSinNota;
        tokensOriginales = tokensSinNota;
        candidatos = (rows).filter(coincide);
        if (candidatos.length > 0) {
          // Los que lo traen (por nombre o descripcion: «Quesobich de Pastor», «Francés Suizo de Arrachera» con
          // guacamole) se quedan, pero DESPUES de los del platillo y sin que el tope de 8 los tire.
          for (const r of loTraenPorDescripcion) {
            trasLaBase.add(r);
            if (!candidatos.includes(r)) candidatos.push(r);
          }
        }
        // Si el CATALOGO dice que lo mas relevante de lo encontrado ya trae X (nombre, descripcion o categoria: «francés
        // suizo con guacamole» lo lleva en la descripcion), el «con X» es como lo quiere, no un extra que ofrecer.
        // «queso extra», «doble queso» si es el extra. Nada se adivina fuera del catalogo («gringa con queso»: se
        // ofrece y la pregunta del agente lo resuelve).
        const yaLoTrae = (r: Fila, bases: string[]) =>
          palabraEn(plegarBusqueda(`${r.products.name} ${r.products.description ?? ""} ${r.products.categories?.name ?? ""}`), bases);
        const bandas = candidatos.map((r: Fila) => Math.round(puntajeBusqueda(query, tokens, r.products)));
        const mejores = candidatos.filter((_: Fila, i: number) => bandas[i] === Math.min(...bandas));
        for (const { bases, extra } of porIngrediente) {
          if (!pideExtra && mejores.length > 0 && mejores.every((r: Fila) => yaLoTrae(r, bases))) continue;
          extrasPedidos.push(...extra.filter((r: Fila) => !extrasPedidos.includes(r)));
        }
      }
    }
  }
  // «orden de guacamole», «una orden de papas»: «orden» es como se pide, no parte del nombre (solo los paquetes de tacos
  // dicen «(orden de 3)» y esos ya casaron arriba: «orden de tacos», «orden de 3» no llegan aqui). Sin nada con
  // «orden», se busca sin esa palabra; es lo pedido, no aproximado.
  // Con algo que casa con «orden» pero solo por un PREFIJO del platillo («orden de papas» -> los PAPAdzules, que dicen
  // «orden de 5»), se busca igual sin «orden» si asi sale el que lo lleva como palabra completa (las Papas) (ronda 15).
  if (tokens.includes("orden")) {
    const sinOrden = tokens.filter((t) => t !== "orden");
    const filas = sinOrden.length > 0 ? (rows).filter((r: Fila) => coincideTokens(sinOrden, r)) : [];
    const loNombraCompleto = (r: Fila) => sinOrden.every((t) => palabraCompletaEnNombre(t, r));
    if (filas.length > 0 && (candidatos.length === 0 || (!candidatos.some(loNombraCompleto) && filas.some(loNombraCompleto)))) {
      tokens = sinOrden;
      tokensOriginales = sinOrden;
      candidatos = filas;
    }
  }
  let aproximado = false;
  // «papas» (un plural: la palabra completa) y en el menu solo hay PAPAdzules: el prefijo casa, pero no es lo que
  // dijo. Si TODO lo encontrado lleva esa palabra solo como inicio de otra mas larga en el nombre, va aproximado.
  const pluralesDeLaConsulta = new Set(plegarBusqueda(query).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 5 && w.endsWith("s")));
  const soloPorPrefijo = tokens.filter((t) => {
    const tf = plegarBusqueda(t);
    // Los singulares de un -es («alambres» -> «alambr») ya casan como palabra completa (singularesDeEs).
    return tf.length >= 4 && !enteros.has(tf) && (pluralesDeLaConsulta.has(`${tf}s`) || pluralesDeLaConsulta.has(`${tf}es`));
  });
  if (
    candidatos.length > 0 && soloPorPrefijo.some((t) =>
      candidatos.every((r: Fila) => !palabraCompletaEnNombre(t, r) && nombreEmpiezaPalabraCon(t, r))
    )
  ) {
    aproximado = true;
  }
  // «sol 0 0», «tecate cero cero», «coca 00»: si la 0.0 no existe en esa consulta, se busca la marca SIN el «cero
  // cero». No es lo pedido (pidio la version cero): se marca `aproximado`.
  const pideCero = pideCeroCero(query);
  if (candidatos.length === 0 && (tokens.includes("0.0") || pideCero)) {
    // Pidio la version SIN alcohol: el respaldo nunca puede ser una bebida con alcohol (antes «tecate cero cero»
    // devolvia la Tecate Light y «sol 0.0» la Sol, aproximadas). Mismo filtro que «sin alcohol» en la relajada.
    const sinAlcohol = (r: Fila) => !requiresAdultConfirmation(r.products.name, r.products.categories?.name);
    let sinCero = tokenizeForProductSearch(quitarCeroCero(query), { mapearCero: false });
    let sinCeroFilas = (rows).filter((r: Fila) => coincideTokens(sinCero, r) && sinAlcohol(r));
    // De esa marca no hay version sin alcohol: si se hablaba de cerveza, lo mas parecido es la 0.0 que si hay.
    if (sinCeroFilas.length === 0 && CONTEXTO_CERVEZA_CERO.test(query)) {
      sinCero = ["0.0"];
      sinCeroFilas = (rows).filter((r: Fila) => coincideTokens(sinCero, r) && sinAlcohol(r));
    }
    if (sinCeroFilas.length > 0) {
      tokens = sinCero;
      candidatos = sinCeroFilas;
      aproximado = true;
    }
  }
  // «coca 0 0», «fanta 0 0» sin contexto de cerveza: los «0» sueltos ya no son tokens y la marca casa directo,
  // pero tampoco es lo pedido. Solo es exacto si el cero quedo en la busqueda («Heineken 0.0», «Sprite Cero»).
  if (candidatos.length > 0 && pideCero && !tokens.some((t) => t === "0.0" || t === "00" || t === "cero")) {
    aproximado = true;
  }
  // «la 0 0», «un 0 0»: solo el cero en cifras, sin nada de cerveza. Se busca la 0.0, pero no se sabe si es lo
  // pedido: aproximado (el agente confirma). «cero cero» en palabras y «0.0» son el nombre de la cerveza: exactos.
  if (
    candidatos.length > 0 && pideCero && tokens.includes("0.0") && !CONTEXTO_CERVEZA_CERO.test(query) &&
    !/\bcero\s+(?:punto\s+)?cero\b|(?<![\d.,])0\.0(?![\d.,])/i.test(query)
  ) {
    aproximado = true;
  }
  // Sin coincidencia exacta: tolera una letra mal escrita («grinbas» -> «gringas»). Solo si no hay nada, y lo
  // asi encontrado NO es lo pedido al pie de la letra: se marca `aproximado`.
  if (candidatos.length === 0) {
    candidatos = (rows).filter((r: Fila) => coincideConErratas(tokens, r.products, enteros));
    aproximado = candidatos.length > 0;
  }
  // Relajada (ciego C3: «bistec normal por kilo»): si con TODOS los tokens no hay nada, se sueltan SOLO los
  // adjetivos de tamano/calidad que no identifican producto («normal», «grande», «helada» tras el producto) y
  // el «sin gas/sin cafeína» que la exacta conservo. Nunca se suelta un sustantivo desconocido («sushi»,
  // «lengua», «hawaiana»): sin el, se ofreceria otro producto («tacos de lengua» -> tacos).
  // Si el desconocido es el producto, la lista queda vacia: mejor «no lo tenemos» que otro platillo.
  // Lo encontrado asi se marca `aproximado` para que el agente diga «lo mas parecido es...».
  // Ni el sinonimo «0.0», ni la 0.0 de respaldo, ni las erratas encontraron nada («coca sin alcohol», «limonada sin alcohol»): se
  // vuelve a la consulta original para que la relajada suelte el «sin alcohol» (una coca nunca lleva alcohol) en
  // vez de buscar un «0.0» que no existe. La relajada nunca devuelve una bebida con alcohol.
  if (candidatos.length === 0) tokens = tokensOriginales;
  if (candidatos.length === 0 && tokens.length > 1) {
    const filas = rows;
    // El adjetivo se suelta aunque aparezca en otro producto («normal» esta en «Frijoles Charros Normal»):
    // con el AND ya vacio, no es lo que identifica al producto pedido.
    // «helado/helada» solo es adjetivo DESPUES del producto («limonada helada»); al inicio es el producto
    // («helado de vainilla»: no lo hay, no son unas Jericallas «sin helar»).
    const primero = tokens.findIndex((t) => /\p{L}/u.test(t));
    // «sin X» que no es preparacion («sin gas», «sin cafeína», «sin soda», «sin topo chico», «sin alcohol») se quedo
    // en la exacta («coca sin azúcar» -> Coca-Cola sin Azúcar). Si con el no hay nada, aqui se suelta la frase
    // COMPLETA («sin topo chico» suelta las dos palabras): lo encontrado es aproximado («no tenemos agua sin gas; lo
    // mas parecido es la Purificada») y nunca puede ser el producto que lleva lo excluido.
    const excluidos = excluidosNoPreparacion(query);
    const palabrasExcluidas = new Set(
      excluidos.flatMap((e) => e.split(" ")).map(singularizarToken),
    );
    const deFraseSin = (tf: string) => excluidos.length > 0 && (tf === "sin" || palabrasExcluidas.has(tf));
    // El tamano de bebida que el menu no tiene («agua 1 L», «coca 3 litros», ronda 18) tambien se suelta: la bebida va
    // aproximada y conPresentacion le pone presentacion_no_disponible (antes salia [] = «no tenemos agua»).
    const tamano = indicesDeTamano(tokens);
    const deVolumen = (i: number) => tamano.has(i) && !/(?:kg|kgs|g|gr|grs|gramos?)$/.test(plegarBusqueda(tokens[i]!)) &&
      !(/^\d+(?:[.,]\d+)?$/.test(tokens[i]!) && /^(?:kg|kgs|g|gr|grs|gramos?)$/.test(plegarBusqueda(tokens[i + 1] ?? "")));
    const soltar = tokens.map((t, i) => {
      const tf = plegarBusqueda(t);
      return ADJETIVOS_SUELTABLES.has(tf) || (i !== primero && ADJETIVOS_TRAS_PRODUCTO.has(tf)) || deFraseSin(tf) || deVolumen(i);
    });
    const usados = tokens.filter((_, i) => !soltar[i]);
    if (usados.length > 0 && usados.length < tokens.length && usados.every((t) => filas.some((r: Fila) => coincideTokens([t], r)))) {
      const terminos = excluidos.flatMap((e) => EXCLUSIONES_EQUIVALENTES.find((g) => g.includes(e)) ?? [e]);
      // «sin alcohol grande»: la frase excluida es «alcohol grande», pero pide sin alcohol igual.
      const pideSinAlcohol = excluidos.some((e) => e.split(" ").includes("alcohol"));
      // Un «sin X» del propio nombre («Margarita sin Alcohol») es justo lo pedido, no lo excluido.
      const nombreSinNegados = (n: string) => plegarBusqueda(n).replace(/\bsin\s+[a-z0-9ñ]+/g, " ");
      const relajados = filas.filter((r: Fila) =>
        coincideTokens(usados, r) &&
        !terminos.some((e) => new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(e)}`).test(nombreSinNegados(r.products.name))) &&
        !(pideSinAlcohol && requiresAdultConfirmation(r.products.name, r.products.categories?.name))
      );
      if (relajados.length > 0) {
        // C3 con 1939849 (PED-07): «normal», «regular», «sencillo» nombran la variante por omision; si SOLO se soltaron
        // esas, lo encontrado es lo pedido (exacto). Con 8692727 salia aproximado y el agente decia «no aparece el bistec
        // normal por kilo» de un producto que si existe.
        const soloRelleno = tokens.every((t, i) => !soltar[i] || RELLENO_DE_VARIANTE.has(plegarBusqueda(t)));
        candidatos = relajados;
        tokens = usados;
        if (!soloRelleno) aproximado = true;
      }
    }
  }

  // La nota «sin X» sale de la busqueda, pero el producto que SE LLAMA X no es lo pedido («chicharrón sin queso» no
  // es el «Chicharrón de Queso»; «boyo sin queso» no es el «Boyo con Queso»). Si quedan otros, ese se quita; si todo
  // lo encontrado se llama X, se devuelve marcado aproximado para que el agente lo aclare.
  const notasSin = excluidosDePreparacion(query);
  if (notasSin.length > 0 && candidatos.length > 0) {
    const llevaExcluido = (r: Fila) => notasSin.some((ws) => nombreLlevaExcluido(r.products.name, ws));
    const sinExcluido = candidatos.filter((r: Fila) => !llevaExcluido(r));
    if (sinExcluido.length > 0) candidatos = sinExcluido;
    else aproximado = true;
  }

  // Pidio la version cero («conga 0 0», «margarita cero cero»): la version CON alcohol nunca es respuesta, aunque
  // haya salido junto a la sin alcohol (antes solo se filtraba el respaldo vacio). Si no queda nada, nada.
  if (pideCero && candidatos.length > 0) {
    candidatos = candidatos.filter((r: Fila) => !requiresAdultConfirmation(r.products.name, r.products.categories?.name));
  }

  if (conSinExtra && candidatos.length > 0) aproximado = true;
  if (soloCategoria && candidatos.length > 0) aproximado = true;

  // El extra de «con X» no compite con los productos: se quita de los candidatos y va aparte, TODOS los nombrados.
  if (extrasPedidos.length > 0) candidatos = candidatos.filter((r: Fila) => !extrasPedidos.includes(r));
  const tope = 8;
  const ordenar = (lista: Fila[]): Ordenado[] => lista
    .map((r: Fila, orden: number) => ({ r, orden, puntaje: puntajeBusqueda(query, tokens, r.products) }))
    // Orden de relevancia (nombre exacto, luego nombre completo, luego el resto) y, a igualdad, el del
    // catalogo. Antes salian las primeras 8 filas de la BD: «guacamole» devolvia ocho «Frances Suizo» (que
    // solo lo traen en la descripcion) y ni el «Guacamole» ni el «Extra Guacamole» (ciego C1: PED-05).
    .sort((a: { puntaje: number; orden: number }, b: { puntaje: number; orden: number }) => a.puntaje - b.puntaje || a.orden - b.orden);
  const ordenados = ordenar(candidatos);
  const primeros = (consultaNombraCategoria(query, ordenados) ? ordenados.slice(0, tope) : diversificarPorCategoria(ordenados, tope))
    .map(({ r }: { r: Fila }) => r);
  // Lo que ya trae el «con X» y no entro en los 8 del platillo va despues, aunque pase de 8 (a lo mas 3 mas): no se tira.
  const despues = ordenar(candidatos.filter((r: Fila) => trasLaBase.has(r) && !primeros.includes(r))).slice(0, 3).map(({ r }: { r: Fila }) => r);
  return {
    filas: [...primeros, ...despues],
    todas: candidatos,
    aproximado,
    extras: extrasPedidos,
  };
}

// Tamano de bebida o peso: «355ml», «2l», «600», «ml», «litros» (el numero cuenta si lo sigue su unidad).
const TOKEN_DE_TAMANO = /^\d+(?:[.,]\d+)?(?:ml|l|lt|lts|litros?|oz|kg|kgs|g|gr|grs|gramos?)$/;
function indicesDeTamano(tokens: string[]): Set<number> {
  const unidad = (t: string | undefined) => t !== undefined && (UNIDADES_DE_MEDIDA.has(plegarBusqueda(t)) || t === "litro" || t === "oz");
  const fuera = new Set<number>();
  tokens.forEach((t, i) => {
    const tf = plegarBusqueda(t);
    if (TOKEN_DE_TAMANO.test(tf) || unidad(tf) || (/^\d+(?:[.,]\d+)?$/.test(tf) && unidad(tokens[i + 1]))) fuera.add(i);
  });
  return fuera;
}

const TOKEN_CORTO = /^[a-zñ]{1,2}$/;
// Palabras de 3 letras que son un producto entero: palabra completa como las cortas («sol» es la Sol, no la
// «Ron Bacardí SOLera»). El resto de 3+ letras casa al inicio de palabra («bis», «pas», «arr» siguen sirviendo).
const PALABRAS_COMPLETAS = new Set(["sol"]);
const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Como casa un token contra texto ya plegado. Un token de 1-2 letras («te», «kg») y «sol» solo como palabra
 * COMPLETA (con su plural): al inicio de palabra «té» casaba con «TEcate»/«TEquila» y «sol» con «SOLera», y
 * como subcadena con «biSTEc» (ciego C1: PED-27; revision PR #21). Uno de 3+ letras, al INICIO de una palabra
 * («bis» -> «Bistec», «taco» -> «Tacos», «coca» -> «Coca-Cola»), nunca dentro de otra («mole» no es «guacaMOLE»).
 * Unica excepcion (revision PR #21 ronda 7): un token de 5+ letras tras el prefijo derivativo «en-/em-/a-» del
 * espanol («cebolla» -> «ENcebollado», como en ace28e8). «mole» (4 letras) sigue sin casar con «guacamole».
 */
function regexDeToken(t: string): RegExp {
  const tf = escaparRegex(plegarBusqueda(t));
  // Una cifra («1», «2», «1.5») es el numero ENTERO (ronda 18): «1» de «un kilo» no es el inicio de «1.5 kg».
  if (/^\d+(?:[.,]\d+)?$/.test(plegarBusqueda(t))) return new RegExp(`(?:^|[^a-z0-9ñ.,])${tf}(?![0-9]|[.,][0-9])`);
  if (TOKEN_CORTO.test(plegarBusqueda(t)) || PALABRAS_COMPLETAS.has(plegarBusqueda(t))) {
    return new RegExp(`(?:^|[^a-z0-9ñ])${tf}(?:s|es)?(?![a-z0-9ñ])`);
  }
  const prefijo = /^[a-zñ]{5,}$/.test(plegarBusqueda(t)) ? "(?:en|em|a)?" : "";
  return new RegExp(`(?:^|[^a-z0-9ñ])${prefijo}${tf}`);
}

/** El singular de un -es como palabra completa, con su plural o su -e («limon» -> limón/limones; «verd» -> verde/verdes). */
function regexDePalabraEntera(t: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(plegarBusqueda(t))}(?:e|es|s)?(?![a-z0-9ñ])`);
}

/** ¿El NOMBRE lleva el token como palabra completa (con su plural)? «papa» en «Papa Pastor», no en «Papadzules». */
function palabraCompletaEnNombre(t: string, r: Fila): boolean {
  return new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(plegarBusqueda(t))}(?:s|es)?(?![a-z0-9ñ])`).test(plegarBusqueda(String(r.products?.name ?? "")));
}

/** ¿Alguna palabra del NOMBRE empieza con el token? */
function nombreEmpiezaPalabraCon(t: string, r: Fila): boolean {
  return new RegExp(`(?:^|[^a-z0-9ñ])${escaparRegex(plegarBusqueda(t))}`).test(plegarBusqueda(String(r.products?.name ?? "")));
}

/**
 * Tokens de la consulta que salieron de quitar un -es («frijoles» -> frijol, «limones» -> limon). Casan solo como
 * palabra completa y nunca por la descripcion: un token recortado no es lo que el cliente escribio, y como prefijo o
 * en la descripcion daba exactos falsos (Limonada por «limones», los Chetacos «con frijol» por «frijoles»).
 */
function singularesDeEs(query: string): Set<string> {
  const salida = new Set<string>();
  for (const w of plegarBusqueda(String(query ?? "")).split(/[^a-z0-9ñ]+/)) {
    const s = singularizarToken(w);
    // «ordenes/órdenes de pastor» es como se pide, igual que «orden de pastor» (revision PR #21 ronda 15): como palabra
    // completa solo casaba el nombre «Nachos de Pastor (1/2 orden)» y el respaldo sin «orden» ya no corria.
    if (s === "orden") continue;
    if (s.length === w.length - 2) salida.add(s);
  }
  return salida;
}

// Adjetivos de tamano/calidad que un cliente agrega y ningun nombre de producto lleva: se pueden soltar sin cambiar QUE producto es.
const ADJETIVOS_SUELTABLES = new Set([
  "grande", "grandes", "chico", "chica", "chicos", "chicas", "mediano", "mediana", "pequeno", "pequena", "chiquito", "chiquita",
  "gigante", "jumbo", "familiar", "personal", "normal", "regular", "sencillo", "sencilla", "simple", "natural", "frio", "fria",
  "caliente", "bien", "tamano",
]);
// De esos, los que nombran la variante por omision: soltarlos no cambia lo pedido (no marcan aproximado).
const RELLENO_DE_VARIANTE = new Set(["normal", "regular", "sencillo", "sencilla", "simple"]);
// Adjetivos que tambien son producto: solo se sueltan si NO son la primera palabra («limonada helada» si,
// «helado de vainilla» no).
const ADJETIVOS_TRAS_PRODUCTO = new Set(["helado", "helada"]);

const soloLetrasYNumeros = (t: string) => plegarBusqueda(t).replace(/[^a-z0-9ñ]+/g, "");

const RELLENO_ANTES_DE_CANTIDAD = new Set([
  "quiero", "quisiera", "queria", "dame", "damela", "ponme", "pon", "me", "das", "mandame", "necesito", "pido", "pedir", "un", "una", "unos", "unas", "por", "favor", "y", "tambien", "ahora", "otra", "otro",
  "hola", "buenas", "buenos", "dias", "tardes", "noches", "agregame", "agrega", "agregar", "ocupo", "regalame",
]);

// Un digito seguido de una unidad de MEDIDA es el tamano del producto («2 litros de coca» -> Coca 2 Litros,
// «1 kg de arrachera» -> Arrachera 1 kg), no una cantidad. «piezas» NO es medida: cuenta unidades
// («2 piezas de gringa» = dos gringas) y ningun producto del catalogo se llama «... 2 piezas».
const UNIDADES_DE_MEDIDA = new Set(["l", "lt", "lts", "litro", "litros", "ml", "kg", "kgs", "kilo", "kilos", "g", "gr", "grs", "gramo", "gramos"]);
const CONECTORES_DE_CANTIDAD = new Set(["y", "e", "ademas", "tambien"]);

/** Digitos sueltos de la consulta SIN los que actuan de cantidad (el primero y los que siguen a «y»/«ademas», salvo que los siga una unidad de medida). */
export function digitosDeDesempate(query: string): string[] {
  // Puntuacion pegada a los tokens («dame,» «(4)») fuera; el punto interior («1.5») se conserva.
  const tokens = plegarBusqueda(query).split(/\s+/).map((t) => t.replace(/^[^a-z0-9ñ]+|[^a-z0-9ñ]+$/g, "")).filter(Boolean);
  const esMedida = (i: number) => i + 1 < tokens.length && UNIDADES_DE_MEDIDA.has(tokens[i + 1]!);
  let i = 0;
  while (i < tokens.length && RELLENO_ANTES_DE_CANTIDAD.has(tokens[i]!)) i++;
  const cantidades = new Set<number>();
  if (i < tokens.length && /^\d$/.test(tokens[i]!) && i + 1 < tokens.length && !esMedida(i)) cantidades.add(i);
  for (let k = i + 1; k + 1 < tokens.length; k++) {
    if (/^\d$/.test(tokens[k]!) && CONECTORES_DE_CANTIDAD.has(tokens[k - 1]!) && !esMedida(k)) cantidades.add(k);
  }
  return tokens.filter((_, k) => !cantidades.has(k)).join(" ").match(/(?<![a-z0-9ñ.])\d(?![a-z0-9ñ.])/g) ?? [];
}

/** 0 = el nombre ES lo que pidio; 1 = todas sus palabras estan en el nombre; 2 = en el nombre como subcadena; 3 = solo en descripcion/categoria/alias. */
function puntajeBusqueda(query: string, tokens: string[], producto: ProductoFila): number {
  const nombre = String(producto.name ?? "");
  const nombreSinParentesis = nombre.replace(/\([^)]*\)/g, "");
  const q = soloLetrasYNumeros(query);
  if (q && (soloLetrasYNumeros(nombre) === q || soloLetrasYNumeros(nombreSinParentesis) === q)) return 0;
  const nombreFold = plegarBusqueda(nombre);
  const palabras = nombreFold.split(/[^a-z0-9ñ]+/).filter(Boolean);
  const entero = (tf: string) => palabras.some((p) => p === tf || p === `${tf}s` || `${p}s` === tf);
  // El tokenizador descarta los tokens de 1 caracter, asi que «parrillada para 4» y «para 2» empataban
  // y salia primero la de 2 (ciego C1: ESC-09). Un digito suelto de la consulta que SI esta en el nombre
  // desempata a favor de ese producto (sin cambiar el orden entre las categorias de coincidencia).
  // El digito que actua como CANTIDAD («2 parrilladas de 4 personas»: el 2) no desempata; se puntua por
  // los digitos que coinciden con una palabra del nombre (basta uno).
  const digitos = digitosDeDesempate(query);
  const bonoDigito = digitos.some((d) => palabras.includes(d)) ? -0.5 : 0;
  // El platillo de la casa (categoria «Platillos…» / «Comida Regional») es el plato fuerte que el cliente
  // pide por su nombre: a igualdad de banda sale antes que la gringa/el taco/el kilo de lo mismo
  // (ciego C2: «poc chuc» y «arrachera» dejaban fuera «Platillo de Poc-Chuc/Arrachera»). Si la consulta
  // dice «platillo» y el producto es de esa categoria o lo lleva en el nombre, pesa un poco mas.
  const categoria = plegarBusqueda(String(producto.categories?.name ?? ""));
  const esPlatillo = /^(?:platillos?\b|comida regional)/.test(categoria);
  const pideSoloPlatillo = tokens.some((t) => plegarBusqueda(t).startsWith("platillo"));
  // «Platillo de X» (el nombre lo dice) pasa por delante de otros platos de la misma categoria («Fajitas de X»).
  const llevaPlatilloEnElNombre = /\bplatillos?\b/.test(nombreFold);
  const bonoPlatillo = (esPlatillo ? (pideSoloPlatillo ? -0.4 : -0.25) : 0) + (llevaPlatilloEnElNombre ? -0.1 : 0);
  // «Pastor» sin tamano: el kilo que representa a su categoria es el de 1 kg, no el de 750 g (desempate minimo,
  // no cambia de banda). Si la consulta trae medida o digitos se respeta lo que pidio.
  const pideMedida = /\d|\b(?:kilos?|kg|medio|cuarto|gramos?|litros?)\b/.test(plegarBusqueda(query));
  const bonoKiloBase = !pideMedida && /\b1\s*kg\b/.test(nombreFold) ? -0.05 : 0;
  // «una heineken»: la Heineken antes que la Heineken 0.0 (ronda 17). La version cero/sin alcohol va despues de la
  // normal de su banda, salvo que la consulta la pida («0.0», «cero», «sin alcohol»).
  const pideLaCero = tokens.some((t) => t === "0.0") ||
    /(?:^|[^a-z0-9ñ])(?:cero|0\s*[.,]?\s*0|sin\s+alcoh?o?l)(?![a-z0-9ñ])/.test(plegarBusqueda(query));
  const esLaCero = /(?:^|[^a-z0-9ñ])(?:0[.,]0|cero|sin alcohol)(?![a-z0-9ñ])/.test(nombreFold);
  // Solo si la consulta nombra la marca («heineken»): por categoria («una cerveza», «refresco») no hay «la normal»
  // con quien desempatar y el castigo sacaba la 0.0 / el Sprite Cero de los 8.
  const nombraLaMarca = tokens.some((t) => regexDeToken(t).test(nombreFold));
  const castigoCero = esLaCero && !pideLaCero && nombraLaMarca ? 0.1 : 0;
  const bono = bonoDigito + bonoPlatillo + bonoKiloBase + castigoCero;
  const todosEnteros = tokens.every((t) => entero(plegarBusqueda(t)));
  if (todosEnteros) return 1 + bono;
  if (tokens.every((t) => nombreFold.includes(plegarBusqueda(t)))) return 2 + bono;
  return 3 + bono;
}

/**
 * Filtro para una lista YA ordenada por relevancia: se queda con `tope` elementos. Solo se diversifica la
 * BANDA de puntaje (puntaje redondeado) que no cabe entera: las bandas mas relevantes entran completas y,
 * en la que desborda, cada categoria aparece una vez (la mejor de cada una) y se completa con el resto por
 * relevancia. Asi seis «Poc-Chuc — N g» de Kilos no tapan al platillo, la gringa o el taco de lo mismo, pero
 * un resultado mas relevante nunca cede su lugar a uno menos relevante de otra categoria. El orden de salida
 * sigue siendo el de relevancia.
 */
function diversificarPorCategoria(lista: Ordenado[], tope: number): Ordenado[] {
  if (lista.length <= tope) return lista;
  const elegidos = new Set<number>();
  const bandas = new Map<number, number[]>();
  lista.forEach((x, j) => {
    const b = Math.round(x.puntaje);
    bandas.set(b, [...(bandas.get(b) ?? []), j]);
  });
  for (const b of [...bandas.keys()].sort((x, y) => x - y)) {
    const idx = bandas.get(b)!;
    const libres = tope - elegidos.size;
    if (libres <= 0) break;
    if (idx.length <= libres) {
      idx.forEach((j) => elegidos.add(j));
      continue;
    }
    const vistas = new Set<string>();
    const sel = new Set<number>();
    for (const j of idx) {
      const cat = String(lista[j]!.r.products.categories?.name ?? `#${j}`);
      if (sel.size < libres && !vistas.has(cat)) {
        vistas.add(cat);
        sel.add(j);
      }
    }
    for (const j of idx) if (sel.size < libres) sel.add(j);
    sel.forEach((j) => elegidos.add(j));
  }
  return lista.filter((_x, j) => elegidos.has(j));
}

/** La consulta ya nombra una categoria («tacos», «gringa», «kilo», «papas»): el cliente eligio el tipo de platillo. */
function consultaNombraCategoria(query: string, lista: Ordenado[]): boolean {
  const sing = (t: string) => t.replace(/s$/, "");
  const palabrasQuery = plegarBusqueda(query).split(/[^a-z0-9ñ]+/).filter((t) => t.length >= 4).map(sing);
  if (palabrasQuery.length === 0) return false;
  const palabrasCategoria = new Set<string>(["kilo", "kg", "gramo"]);
  for (const x of lista) {
    for (const w of plegarBusqueda(String(x.r.products.categories?.name ?? "")).split(/[^a-z0-9ñ]+/)) {
      if (w.length >= 4) palabrasCategoria.add(sing(w));
    }
  }
  return palabrasQuery.some((t) => palabrasCategoria.has(t));
}

/** Distancia de edicion <= 1 entre un token (>= 5 letras) y alguna palabra del nombre. */
function coincideConErratas(tokens: string[], producto: ProductoFila, enteros: Set<string> = new Set()): boolean {
  const palabras = plegarBusqueda(`${producto.name ?? ""} ${producto.description ?? ""}`)
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);
  const texto = palabras.join(" ");
  const palabrasNombre = plegarBusqueda(String(producto.name ?? "")).split(/[^a-z0-9ñ]+/).filter(Boolean);
  // Un tamano solo cuenta por la descripcion si otra palabra nombra el producto (ver buscarEnFilas, ronda 16).
  const tamano = indicesDeTamano(tokens);
  const nombre = palabrasNombre.join(" ");
  const nombraElProducto = tokens.some((t, i) => {
    const tf = plegarBusqueda(t);
    return !tamano.has(i) && (regexDeToken(t).test(nombre) || (tf.length >= 5 && palabrasNombre.some((p) => distanciaMaxima1(tf, p))));
  });
  return tokens.every((t, i) => {
    const tf = plegarBusqueda(t);
    if (tamano.has(i) && !nombraElProducto) return regexDeToken(t).test(nombre);
    // El singular de un -es: palabra completa y solo en el nombre (ver singularesDeEs).
    if (enteros.has(tf)) {
      return regexDePalabraEntera(tf).test(palabrasNombre.join(" ")) ||
        (tf.length >= 5 && palabrasNombre.some((p) => distanciaMaxima1(tf, p)));
    }
    // Lo literal casa igual que en la busqueda exacta (palabra completa o inicio de palabra): como subcadena,
    // «te» de «té verde» casaba con «biSTEc» y devolvia ocho bistecs (revision PR #21).
    if (regexDeToken(t).test(texto)) return true;
    if (tf.length < 5) return false;
    return palabras.some((p) => distanciaMaxima1(tf, p) || distanciaMaxima1(tf.replace(/s$/, ""), p));
  });
}

function distanciaMaxima1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

