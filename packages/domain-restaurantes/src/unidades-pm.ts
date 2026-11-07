// PAQUETE A (PM): tabla de unidades por orden y desambiguación orden / kilo / pieza.
// Datos del menú vigente y de las decisiones del dueño; SIN precios. Funciones puras: no tocan la base ni el modelo.
// ENLAZADO: `avisoUnidadPorTabla` (desde buscar_producto en registry.ts) y `bloqueCantidadNoMultiplo` (llm-turn-handler.ts, R19 G4 / T7-012), que usa `analizarPiezasPedidas`.
// NO ENLAZADO todavía (lo usará un validador del flujo de pedido): piezasDeOrdenes, clasificarMedida y clasificarMedidas; hoy solo las ejercen las pruebas.
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

// Solo lo que esta en el menu vigente (web/PDF 2026) o en las decisiones del dueño (21-oct); nada mas. Patrones sobre el nombre sin acentos y en minusculas,
// anclados al inicio para no confundir "Frances Suizo" (torta) con "Suizo de Pastor" (orden de 5) ni "Ceiba Mestiza" (cerveza) con una mestiza.
export const TABLA_UNIDADES_PM: readonly FamiliaUnidadPm[] = [
  { familia: "flauta", patron: /^flautas?\b/, piezasPorOrden: 1, aproximado: false },
  { familia: "quesobich", patron: /\bquesobich\b/, piezasPorOrden: 1, aproximado: false },
  { familia: "gringa", patron: /^gringas?\b/, piezasPorOrden: 2, aproximado: false },
  { familia: "mestiza", patron: /^mestizas?\b/, piezasPorOrden: 2, aproximado: false },
  { familia: "alambre", patron: /^alambres?\b/, piezasPorOrden: 5, aproximado: false },
  { familia: "suizo", patron: /^(?:tacos? )?suizos?\b/, piezasPorOrden: 5, aproximado: false },
  { familia: "papadzules", patron: /^papadzules?\b/, piezasPorOrden: 5, aproximado: false },
  { familia: "codzitos", patron: /^codzitos?\b/, piezasPorOrden: 4, aproximado: false },
  { familia: "tacos-cochinita", patron: /^tacos? de cochinita\b/, piezasPorOrden: 4, aproximado: false },
  { familia: "alitas", patron: /\balitas?\b/, piezasPorOrden: 7, aproximado: false },
  { familia: "crujientes", patron: /^crujientes?\b/, piezasPorOrden: 12, aproximado: true },
  { familia: "tacos-3", patron: /^tacos? de (?:chorizo|bistec|pechuga|pollo|chuleta|costilla|arrachera|poc)/, piezasPorOrden: 3, aproximado: false },
  { familia: "taco-individual", patron: /^tacos? (?:al pastor|de pastor|de rajas|de champi)/, piezasPorOrden: 1, aproximado: false },
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

/**
 * R22 (R4): piezas que trae UNA orden de este renglon para MOSTRARSELAS al cliente: SOLO el `packSize` del catalogo si es > 1. Sin `packSize` la cantidad del renglon puede ser PIEZAS
 * («4 gringas» llega como 4), asi que la tabla del dueño no se usa para etiquetar (daria «4 órdenes (8 piezas)»). Tampoco se etiqueta una media orden, un cuarto, un kilo, un combo,
 * un paquete, una salsa o un extra: el nombre dice otra unidad. `null` sin dato (nunca se inventa).
 */
const NOMBRE_NO_ES_ORDEN_ENTERA = /(?:^|[^a-z0-9])(?:media|medio|1\/2|1\/4|cuarto|kilo|kilos|kg|combo|paquete|salsas?|extras?)(?:[^a-z0-9]|$)/;
export function piezasPorOrdenDe(nombreProducto: string, packSize: number | null | undefined): number | null {
  if (typeof packSize !== "number" || !Number.isInteger(packSize) || packSize <= 1) return null;
  if (NOMBRE_NO_ES_ORDEN_ENTERA.test(sinAcentos(nombreProducto).toLowerCase())) return null;
  return packSize;
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
  // «1/2 orden de nachos de pastor» o «media orden de nachos»: el platillo nombrado (nachos, frijoles charros) fija que es media ORDEN.
  const mediaOrdenPlatillo = /\b(?:media orden|1\/2 orden)(?: de)? (?:nachos|frijoles)/.test(t);
  if (mediaOrdenPlatillo) return { medida: "orden", cantidad: 0.5 };
  if (/\bmedia orden\b|\b1\/2 orden\b/.test(t)) {
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
  // «3 de pastor»: numero y carne sin unidad -> hay que aclarar (pieza, orden o peso); nunca queda mudo.
  const suelto = t.match(/^(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+de\s+(.+)/);
  if (suelto && CARNE.test(suelto[2] ?? "") ) {
    const n = cantidadDe(suelto[1]);
    return { medida: "ambigua", cantidad: n ?? undefined, pregunta: `¿Son ${n ?? "esa cantidad de"} piezas (tacos), ${n ?? "esa cantidad de"} órdenes o por peso (kilos)?` };
  }
  const piezas = t.match(/\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:tacos?|gringas?|mestizas?|quesadillas?|flautas?|alitas?|piezas?)\b/);
  if (piezas) return { medida: "pieza", cantidad: cantidadDe(piezas[1]) ?? undefined };
  return { medida: "sin_medida" };
}

/**
 * Mensajes con VARIAS medidas («2 tacos y medio kilo de pastor»): devuelve una por segmento, en orden, sin perder ninguna.
 * Los segmentos sin medida se omiten salvo que todo el mensaje no tenga ninguna (entonces devuelve [sin_medida]).
 */
export function clasificarMedidas(texto: string): MedidaClasificada[] {
  const t = sinAcentos(texto).replace(/\bkilo y medio\b/g, "kilo_y_medio").replace(/\bmedio y medio\b/g, "medio_y_medio");
  const segmentos = t.split(/\s+y\s+|,|;|\s+mas\s+|\s+con\s+/).map((x) => x.replace("kilo_y_medio", "kilo y medio").replace("medio_y_medio", "medio y medio").trim()).filter(Boolean);
  const out: MedidaClasificada[] = [];
  let ultimaCarne = "";
  for (const seg of segmentos) {
    const carne = seg.match(CARNE)?.[0];
    if (carne) ultimaCarne = carne;
    // «medio kilo de pastor y un cuarto de bistec»: el segmento sin carne hereda la anterior solo para decidir que es peso.
    const r = clasificarMedida(seg);
    if (r.medida !== "sin_medida") out.push(r);
  }
  void ultimaCarne;
  return out.length > 0 ? out : [{ medida: "sin_medida" }];
}

/**
 * Aviso de unidad para productos de la tabla cuyo pack_size NO viene en el menú de la base (packSize null) y que `unidadDeVenta` no cubre:
 * le dice al agente cuántas piezas trae la orden para que no cotice cantidades que no son órdenes completas. Con pack_size explícito manda la herramienta.
 */
export function avisoUnidadPorTabla(product: { readonly name: string; readonly packSize: number | null | undefined }): string | null {
  if (product.packSize !== null && product.packSize !== undefined) return null;
  const f = familiaUnidadPm(product.name);
  if (!f || f.aproximado || f.piezasPorOrden < 2) return null;
  return (
    `Según el menú, cada orden de este producto trae ${f.piezasPorOrden} piezas y solo se vende en órdenes completas. Como el menú no trae pack_size para este renglón, el servidor cobra UNA orden por cada unidad: requested_quantity cuenta ÓRDENES (una orden = 1, no multiplique por las piezas). ` +
    `Si el cliente pide piezas que no son múltiplo de ${f.piezasPorOrden}, no cotices: explícalo y ofrece la orden completa más cercana hacia abajo o hacia arriba.`
  );
}

// ── R19 (G4 / T7-012): cantidad que NO es multiplo de la orden ───────────────────────────────────────────────────────────────────────────────
// El modelo preguntaba «¿3 o 6?» sin explicar por que ni dar el precio de la orden, o cotizaba piezas sueltas. El servidor detecta el mensaje del cliente («4 tacos de bistec»,
// «3 gringas de pastor») con la tabla de unidades y le fija al modelo, SOLO para ese turno, lo que debe decir. Los PRECIOS no se escriben aqui: los da buscar_producto.

const NUM = "\\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez";
const PIEZAS_PEDIDAS = new RegExp(`\\b(${NUM})\\s+(tacos?|gringas?|mestizas?)(?:\\s+(?:de|al))?(?:\\s+([a-z]+(?:\\s+[a-z]+)?))?`, "g");
// «tacos de bistec 4» (la cantidad al final). Sin unidades de medida, hora ni dinero detras para no confundir «tacos de bistec 4 pesos».
const PIEZAS_AL_FINAL = new RegExp(`\\b(tacos?|gringas?|mestizas?)\\s+(?:de|al)\\s+([a-z]+)\\s+(${NUM})\\b(?!\\s*(?:pesos|kg|kilos?|min|minutos|horas?|hrs|am|pm|:|\\$))`, "g");
const CONECTORES = new Set(["con", "para", "y", "en", "por", "de", "sin", "a", "al", "mas", "que"]);
// Contexto que NO es un pedido nuevo: pasado («ordene», «pedi», «llegaron»), reclamo, cancelacion o correccion («ya no quiero», «mejor»). Esos mensajes los maneja el resto del agente.
const CONTEXTO_QUE_NO_PIDE = /\b(?:ordene|ordeno|pedi|pidio|compre|recibi|llego|llegaron|mandaron|enviaron|trajeron|hace|ayer|antes|ya no|cancel\w*|en vez|en lugar|corrig\w*|cambi\w*|equivoc\w*|mejor|quite|quita\w*|devol\w*|reembols\w*|queja)\b/;

function prefijoDeLaClausula(texto: string, indice: number): string {
  const antes = texto.slice(0, indice);
  const corte = Math.max(antes.lastIndexOf("."), antes.lastIndexOf(","), antes.lastIndexOf(";"), antes.lastIndexOf("?"), antes.lastIndexOf("!"), antes.lastIndexOf("\n"));
  return antes.slice(corte + 1);
}

export interface CantidadNoMultiplo {
  readonly piezas: number;
  readonly producto: string;
  readonly piezasPorOrden: number;
  readonly opciones: readonly number[];
}

/** Pura: renglones de un mensaje del cliente cuya cantidad en PIEZAS no es un numero exacto de ordenes (4 tacos de bistec, 3 gringas). Lo que no esta en la tabla o es multiplo, no aparece. */
export function cantidadesNoMultiplo(texto: string): CantidadNoMultiplo[] {
  const t = sinAcentos(texto).toLowerCase();
  const out: CantidadNoMultiplo[] = [];
  const agrega = (cantidad: string, unidad: string, producto: string | undefined, indice: number) => {
    if (CONTEXTO_QUE_NO_PIDE.test(prefijoDeLaClausula(t, indice))) return;
    const piezas = /^\d+$/.test(cantidad) ? parseInt(cantidad, 10) : NUMEROS[cantidad];
    if (!piezas) return;
    const resto = (producto ?? "").split(/\s+/).filter((w) => w && !CONECTORES.has(w)).slice(0, 2);
    const nombre = `${unidad}${resto.length ? ` de ${resto.join(" ")}` : ""}`;
    const a = analizarPiezasPedidas(nombre, piezas);
    if (a.tipo === "no_multiplo" && !out.some((o) => o.piezas === piezas && o.producto === nombre)) out.push({ piezas, producto: nombre, piezasPorOrden: a.piezasPorOrden, opciones: a.opciones });
  };
  for (const m of t.matchAll(PIEZAS_PEDIDAS)) agrega(m[1]!, m[2]!, m[3], m.index ?? 0);
  for (const m of t.matchAll(PIEZAS_AL_FINAL)) agrega(m[3]!, m[1]!, m[2], m.index ?? 0);
  return out;
}

/** Bloque de sistema para el turno: que explicar y preguntar. Vacio si ningun renglon es no multiplo. */
export function bloqueCantidadNoMultiplo(mensajes: readonly string[]): string {
  const vistos = new Set<string>();
  const lineas: string[] = [];
  for (const texto of mensajes) {
    for (const c of cantidadesNoMultiplo(texto)) {
      const clave = `${c.producto}:${c.piezas}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const opciones = c.opciones.map((o) => `${o} piezas (${o / c.piezasPorOrden} ${o / c.piezasPorOrden === 1 ? "orden" : "ordenes"})`).join(" o ");
      const ordenes = c.piezasPorOrden <= 2 ? ` Pregunte tambien si quiso ${c.piezas} ORDENES (${c.piezas * c.piezasPorOrden} piezas), no ${c.piezas} piezas.` : "";
      lineas.push(`- Si el cliente esta pidiendo ahora ${c.piezas} ${c.producto}, recuerde que se venden en ordenes de ${c.piezasPorOrden} piezas y ${c.piezas} no es un numero exacto de ordenes.${ordenes} Opciones validas: ${opciones}.`);
    }
  }
  if (lineas.length === 0) return "";
  return [
    "REGLA DEL SERVIDOR PARA ESTE TURNO (cantidad que no es multiplo de la orden):",
    ...lineas,
    "Aplica SOLO si el cliente esta haciendo ese pedido ahora; si reclama, corrige o cancela un pedido ya hecho, ignore esta regla y siga las demas. Si buscar_producto trae otro pack_size para ese producto, manda la herramienta (nunca cambie la cantidad que pidio el cliente). En ESTE mensaje: (1) dígale con calidez QUE se vende en ordenes de N piezas y por que esa cantidad no se puede; (2) ofrezca las opciones validas con el PRECIO de cada una tomado de buscar_producto (nunca de memoria ni calculado de cabeza: orden y dos ordenes); (3) no cotice, no cree pedido y no cambie la cantidad por su cuenta: espere a que el cliente elija. No repita esta regla ni mencione al servidor.",
  ].join("\n");
}

// ── R22 (T7-074): «2 mestizas» (sin decir «ordenes» ni «piezas») no puede cotizarse como 2 ORDENES (4 piezas) ──────────────────────────────────────────────────────
/**
 * Pura. El cliente dijo un numero N pegado al producto («2 mestizas», «dos gringas de pastor») SIN «orden(es)» ni «pieza(s)» delante, y la cotizacion trae `piezasCotizadas` = N * piezasPorOrden
 * (el modelo leyo N como ordenes). Devuelve N en ese caso, para que el servidor obligue a preguntar «¿N ordenes (X piezas) o N piezas?». `null` si no aplica: la cantidad es la dicha tal cual
 * (N = piezas cotizadas), el cliente dijo la unidad, o el producto no aparece con un numero en el mensaje. Solo mira el ULTIMO mensaje del cliente.
 */
export function ordenesInterpretadasSinPreguntar(ultimoMensaje: string, nombreProducto: string, piezasPorOrden: number | null, piezasCotizadas: number): number | null {
  if (piezasPorOrden === null || piezasPorOrden <= 1 || !Number.isInteger(piezasCotizadas) || piezasCotizadas < 1) return null;
  const palabra = sinAcentos(nombreProducto).toLowerCase().match(/[a-z]+/)?.[0];
  if (!palabra || palabra.length < 4) return null;
  const raiz = palabra.replace(/e?s$/, "");
  const t = sinAcentos(ultimoMensaje).toLowerCase();
  // Con la unidad explicita («2 ordenes de mestizas», «4 piezas de mestiza») no hay nada que preguntar.
  const conUnidad = new RegExp(`\\b(?:${NUM})\\s+(?:ordenes|orden|piezas?)\\s+(?:de\\s+)?(?:${raiz})`);
  const sinUnidad = new RegExp(`\\b(${NUM})\\s+(?:de\\s+)?${raiz}\\w*`, "g");
  if (conUnidad.test(t)) return null;
  for (const m of t.matchAll(sinUnidad)) {
    const n = /^\d+$/.test(m[1]!) ? parseInt(m[1]!, 10) : NUMEROS[m[1]!];
    if (n && n !== piezasCotizadas && n * piezasPorOrden === piezasCotizadas) return n;
  }
  return null;
}

// ── R21 (T7-008): productos que el menu NO tiene ──────────────────────────────────────────────────────────────────────────────────────────────
// El modelo rechazaba bien chistorra o salchichas pero ofrecia «tacos de chorizo» (un platillo que el cliente no pidio y que el menu no tiene) en vez de lo parecido que SI hay
// (los crujientes de pollo). El servidor detecta la palabra en el mensaje del cliente y le fija al modelo, SOLO para ese turno, que decir. No lista precios: los da buscar_producto.

/**
 * Productos que el menu de Los Taquitos de PM NO tiene: constante del PERFIL PM, no una regla del dominio.
 * DEUDA: esta lista es una foto del menu de oct-2026 escrita a mano. Lo correcto es que salga del catalogo/configuracion del tenant (un producto "no manejado" = no existe en el catalogo
 * activo) y no de una lista en codigo. Por eso el bloque de abajo NUNCA da por hecho que falte: siempre manda verificar con `buscar_producto` antes de decirle al cliente que no lo manejamos.
 * Si el menu cambia (p. ej. PM agrega chistorra), basta con que `buscar_producto` lo devuelva: el modelo lo cotiza y esta lista deja de importar.
 */
export const PM_PRODUCTOS_NO_MANEJADOS: readonly { readonly nombre: string; readonly patron: RegExp }[] = [
  { nombre: "chistorra", patron: /\bchistorra\b/ },
  { nombre: "longaniza", patron: /\blonganiza\b/ },
  { nombre: "salchichas", patron: /\bsalchichas?\b/ },
  { nombre: "dedos de queso", patron: /\bdedos?\s+de\s+queso\b/ },
  { nombre: "papas a la francesa", patron: /\bpapas?\s+(?:a\s+la\s+francesa|fritas)\b/ },
];

/** Pura: nombres (canonicos) de los productos que el menu no maneja y que el cliente menciono en el texto. */
export function productosNoManejados(texto: string): string[] {
  const t = sinAcentos(texto).toLowerCase();
  return PM_PRODUCTOS_NO_MANEJADOS.filter((p) => p.patron.test(t)).map((p) => p.nombre);
}

/** Bloque de sistema para el turno. Vacio si el cliente no menciono ningun producto no manejado. */
export function bloqueProductoNoManejado(mensajes: readonly string[]): string {
  const nombres = [...new Set(mensajes.flatMap((m) => productosNoManejados(m)))];
  if (nombres.length === 0) return "";
  return [
    "REGLA DEL SERVIDOR PARA ESTE TURNO (producto que el menú no tiene):",
    `El cliente mencionó ${nombres.join(", ")}. SIEMPRE verifique con buscar_producto antes de contestar (esta lista puede estar desactualizada: si buscar_producto SÍ lo devuelve, cotícelo normalmente). Si no aparece, diga que NO lo manejamos (sin inventarlo ni cotizarlo) y ofrezca como alternativa los CRUJIENTES DE POLLO (busque «crujientes» para dar el nombre y el precio reales). No ofrezca como sustituto tacos de chorizo ni ningún otro platillo que buscar_producto no devuelva. Los productos válidos del pedido se conservan y se cotizan normalmente.`,
  ].join("\n");
}
