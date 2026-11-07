// Dedupe de avisos al equipo (callback_requests) + niveles de alerta, portado del cerebro «suelto»
// (supabase/functions/_shared/whatsapp-agent-core.ts, alertas-operativas.ts y alertas-ruteo.ts, commit e69279e).
//  * Puro: el suelto leía los avisos recientes del número y hacía el UPDATE dentro de avisoYaCubierto; aquí el llamador
//    lee las filas (mismo número y organización, últimas 10) y aplica el plan que devuelve `planDeAviso`.
//  * Sin reloj implícito: `ahoraMs` / `ahora` por parámetro.
//  * Los intents de alto riesgo son los del suelto (cancelacion, cobro_duplicado, alergia, salud, urgencia,
//    privacidad_arco, transferencia_realizada, reclamo_pedido); el monorrepo usa otros nombres (ver informe).
import { condicionesDeCancelacion } from "./politicas-pm.ts";

// ------------------------------------------------------------ constantes

/** Ventana del dedupe: un aviso abierto de hace 30 min o menos cubre al nuevo (29 cubre, 31 no). */
export const VENTANA_AVISO_DUPLICADO_MIN = 30;
/** R56: confirmar una cancelación contestando nuestro mensaje se anexa a la abierta aunque pasen más de 30 min. */
export const VENTANA_CONFIRMA_CANCELACION_MIN = 180;
/** Inicio del mensaje de un aviso que el cliente pidió con urgencia (callback_requests no tiene campo de prioridad). */
export const MARCA_AVISO_URGENTE = "URGENTE: el cliente pide atención inmediata.";
export const TOPE_MENSAJE_AVISO = 2000;
/** Motivo fijo del aviso automático de post-venta (cuenta como motivo de cobro al anexar al cobro duplicado). */
export const RAZON_RECLAMO_PEDIDO = "reclamo de pedido: faltante, producto equivocado o demora";
/** R33: motivo de un cambio del pedido (el mismo de registrar_contacto). */
export const RAZON_MODIFICACION_PEDIDO = "modificacion_pedido";
/** R56: aviso de BAJA prioridad («ya no lo quiero» ambiguo con pedido vivo). Ni alta prioridad ni post-venta. */
export const RAZON_POSIBLE_BAJA = "posible_baja_pedido";
export const RAZON_POSIBLE_CANCELACION_VOZ = RAZON_POSIBLE_BAJA;

// Frases de seguridad obligatorias (CR-WA-048): las respuestas fijas y la de varios avisos salen de las mismas.
export const ALERGIA_SIN_GARANTIA = "Por su seguridad no puedo garantizarle ingredientes ni que un platillo esté libre de algún alérgeno.";
export const ALERGIA_ANTES_DEL_PEDIDO = "una persona le confirme directamente antes de tomar su pedido";
export const SALUD_SIN_DIAGNOSTICO =
  "Por su seguridad no puedo diagnosticar ni garantizar nada sobre ingredientes; si se siente mal, busque atención médica.";

// --------------------------------------------------------- normalización

/** R41: «papá» (con acento) es un familiar, nunca las papas del menú: pasa a «tata» (mismo largo). */
const PAPA_CON_ACENTO_NFD = /\bpapá(?!s)/g;
/** R42: sin acento, «papa» tras posesivo con contexto de persona («mi papa dice», «lo de mi papa») también es familiar. */
const PAPA_FAMILIAR_VOZ = new RegExp(
  String.raw`\b(de\s+(?:mi|tu|su|nuestro)\s+)papa\b|\b((?:mi|tu|su|nuestro)\s+)papa\b(?=\s+(?:(?:ya|no|tambien|me|le|nos|les|se|lo|la)\s+){0,3}` +
    String.raw`(?:dice|dijo|decia|quiere|queria|quiso|pidio|pide|pedia|ordeno|encargo|va|iba|viene|vino|llama|llamo|hablo|habla|esta|estaba|anda|necesita|prefiere|paga|pago|cancela|cancelo|recoge|trajo|trae|compro|ceno|comio|hizo|manda|mando|tiene)\b)`,
  "g",
);
function sinPapaFamiliarVoz(plano: string): string {
  return plano.replace(PAPA_FAMILIAR_VOZ, (_w, dueno: string | undefined, pos: string | undefined) => `${dueno ?? pos ?? ""}tata`);
}

/** Texto de un motivo/mensaje: sin acentos, minúsculas, espacios colapsados, «papá» familiar. */
export function normAviso(t: unknown): string {
  return sinPapaFamiliarVoz(
    String(t ?? "").normalize("NFD").toLowerCase().replace(PAPA_CON_ACENTO_NFD, "tata").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(),
  );
}

/** Categoría de alto riesgo de una razón: la del prefijo «alto_riesgo:x» o la inferida de un texto libre. */
export function categoriaDeRazon(razonNorm: string): string | null {
  if (razonNorm.startsWith("alto_riesgo:")) return razonNorm.slice("alto_riesgo:".length).trim() || null;
  if (/alerg/.test(razonNorm)) return "alergia";
  if (/intoxi|envenen|enferm|vomit|diarrea/.test(razonNorm)) return "salud";
  if (/cobro|cargo/.test(razonNorm) && /duplic|doble|dos veces/.test(razonNorm)) return "cobro_duplicado";
  if (/cancel/.test(razonNorm)) return "cancelacion";
  if (/urgen/.test(razonNorm)) return "urgencia";
  if (/\barco\b|privacidad|datos personales/.test(razonNorm)) return "privacidad_arco";
  // R87-R: «pago», «pago_realizado», «confirmar pago» del modelo = el aviso de transferencia del servidor.
  if (/transferen|deposit|comprobante|\bpag(?:o|os|ado|ada|ue|aron|o_realizado)\b|\bpago_/.test(razonNorm)) return "transferencia_realizada";
  return null;
}

/**
 * Post-venta (faltante, queja, reposición, seguimiento, modificación): el modelo redacta el motivo distinto cada vez
 * aunque sea el MISMO reclamo; mientras haya uno abierto de la misma sucursal, otro de post-venta se anexa.
 */
export function esPostventa(razonNorm: string): boolean {
  if (razonNorm.startsWith("alto_riesgo:")) return false;
  // Cobro, alergia, intoxicación o reembolso son de alto riesgo aunque no traigan el prefijo.
  if (/cobr|cargo|alerg|intoxi|envenen|enferm|vomit|reembols|devoluc/.test(razonNorm)) return false;
  return /incomplet|faltan|falto|faltaron|reclam|queja|reposici|reponer|modificacion|seguimiento|equivocad|cortesia/.test(razonNorm);
}

/** Avisos que no esperan al cron de 10 min: alto riesgo, cancelación, modificación y confirmar peso (R21). */
export function esAvisoDeAltaPrioridad(razon: string | null | undefined): boolean {
  const norm = normAviso(razon);
  return !!norm && (categoriaDeRazon(norm) !== null || /modificacion|cancel|confirmar[_ ]peso/.test(norm));
}

export type NivelDeAviso = "urgente" | "alta" | "normal";

/**
 * Nivel de un aviso (NUEVO en el port; el suelto solo distinguía alta prioridad = alerta inmediata vs. cron):
 *  - «urgente»: riesgo a la persona (alergia, salud) o el cliente pide atención inmediata (urgencia o marca URGENTE).
 *  - «alta»: el resto de esAvisoDeAltaPrioridad (cobro duplicado, cancelación, modificación, ARCO, transferencia…).
 *  - «normal»: post-venta y lo demás (lo cubre el cron; posible_baja_pedido además avisa una sola vez).
 */
export function nivelDeAviso(motivo: string | null | undefined, opciones: { urgente?: boolean; mensaje?: string | null } = {}): NivelDeAviso {
  if (opciones.urgente || avisoCreadoUrgente(opciones.mensaje)) return "urgente";
  const norm = normAviso(motivo);
  const cat = norm ? categoriaDeRazon(norm) : null;
  if (cat === "alergia" || cat === "salud" || cat === "urgencia") return "urgente";
  return esAvisoDeAltaPrioridad(motivo) ? "alta" : "normal";
}

/** ¿El aviso lo creó un turno urgente? Su primer mensaje (antes del primer «\n---\n») empieza con la marca URGENTE. */
export function avisoCreadoUrgente(message: unknown): boolean {
  const primero = (String(message ?? "").split("\n---\n")[0] ?? "").trimStart();
  return primero.startsWith(MARCA_AVISO_URGENTE) || /^URGENTE(?::|\n)/.test(primero);
}

// ------------------------------------------------- mismo cobro duplicado

const TEXTO_DEL_MISMO_COBRO =
  /(?:cobr\w*|cargo\w*|cargaron|cargad\w*)[^.]{0,40}(?:dos veces|2 veces|doble|duplic|otra vez|de mas)|(?:doble|duplicad\w*)\s+(?:cobro|cargo)|(?:cobro|cargo)\s+duplicad\w*|\b(?:dos|2)\s+(?:cargos|cobros)\b/;

// LISTA BLANCA (PR #21 ronda 4): se anexa al cobro duplicado abierto SOLO si, sin las frases del mismo cobro y las
// palabras de cobro/relleno, no queda NADA. Un aviso perdido es peor que uno repetido.
const FRASES_DEL_MISMO_COBRO: readonly RegExp[] = [
  /\b(?:yo )?no (?:cancele|hice|pedi|autorice|reconozco)\b(?: (?:el|mi|ese|ningun|otro|un|los) (?:pedido|cargo|cobro|compra|pago)s?)?/g,
  /\bcancel\w* (?:uno de los (?:dos )?(?:cobros|cargos)|uno|una|el otro|el (?:cargo|cobro)(?: duplicado| doble| extra| de mas)?|el duplicado|el doble)\b/g,
  /\b(?:modific|corrig|quit|anul|revis|revert|devuelv|regres|reembols|cancel)\w* (?:el|ese|uno de los|un|los|mi) (?:cargo|cobro|dinero)s?\b/g,
  /\b(?:regresen|devuelvan|reembolsen|reintegren) (?:mi|el) dinero\b/g,
  /\bcobr\w* de mas\b/g,
  /\bsigue\w* sin (?:aparecer|verse|reflejarse) (?:revers|reembols|devuel)\w*/g,
];
const PALABRAS_DEL_COBRO = new Set([
  "cobraron", "cobro", "cobros", "cobrado", "cobrada", "cobrar", "cobran", "cobrando", "cargo", "cargos", "cargaron", "cargado",
  "cargada", "cargar", "doble", "duplicado", "duplicados", "duplicada", "duplicadas", "duplicaron", "dos", "2", "veces", "vez",
  "otra", "mas", "reembolso", "devolucion", "reversa", "reverso", "reversion", "tarjeta", "banco", "cuenta", "pago", "pagos",
  "compra", "mismo", "misma", "hicieron", "dinero",
]);
const PALABRAS_DE_RELLENO = new Set([
  "gracias", "por", "favor", "porfa", "porfavor", "hola", "buenas", "buenos", "dias", "tardes", "noches", "ya", "oigan", "oiga",
  "oye", "revisen", "revisan", "revisar", "revisenlo", "revisarlo", "lo", "la", "el", "los", "las", "me", "nos", "a", "en", "de",
  "que", "y", "e", "urgente", "ayuda", "ayudan", "pueden", "puede", "podrian", "se", "si", "mi", "mis", "un", "una", "uno", "al",
  "del", "con", "pero", "pues", "disculpen", "ok", "plis", "please", "le", "les", "su", "sus", "este", "esta", "ese", "esa",
  "eso", "esto", "es", "fue", "aqui", "muchas", "mil",
]);
const PALABRAS_DE_MOTIVO = new Set(["reclamo", "queja", "problema", "reporte", "reporta", "aviso", "cliente", "alto", "riesgo"]);

function restoAjenoAlCobro(texto: string, extra: ReadonlySet<string> = new Set()): string[] {
  let plano = texto.replace(/[^a-z0-9ñ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const re of FRASES_DEL_MISMO_COBRO) plano = plano.replace(re, " ");
  return plano.split(" ").filter((w) => w && !PALABRAS_DEL_COBRO.has(w) && !PALABRAS_DE_RELLENO.has(w) && !extra.has(w));
}

/** El aviso nuevo es el MISMO cobro duplicado abierto: motivo de cobro (o el fijo de post-venta) y nada más. */
function esElMismoCobroDuplicado(nueva: string, mensajeConMarca: string): boolean {
  const mensaje = mensajeConMarca.split(normAviso(MARCA_AVISO_URGENTE)).join(" ");
  const motivoDeCobro = nueva === RAZON_RECLAMO_PEDIDO ||
    (/cobr|carg|reembols|devoluc/.test(nueva) && restoAjenoAlCobro(nueva, PALABRAS_DE_MOTIVO).length === 0);
  if (!motivoDeCobro) return false;
  if (!TEXTO_DEL_MISMO_COBRO.test(`${nueva === RAZON_RECLAMO_PEDIDO ? "" : nueva} ${mensaje}`)) return false;
  return restoAjenoAlCobro(mensaje).length === 0;
}

// ---------------------------------------------------------- dedupe puro

/** Fila de callback_requests que el llamador ya leyó (mismo número y organización, la más reciente primero). */
export interface FilaAviso {
  readonly id?: string;
  readonly reason?: string | null;
  readonly message?: string | null;
  readonly branch_id?: string | null;
  readonly created_at?: string | null;
  readonly resolved?: boolean | null;
  readonly source_event_id?: string | null;
}

export interface OpcionesAviso {
  /** Sucursal del aviso nuevo (null = sin sucursal): solo se deduplica contra avisos de la misma. */
  branchId?: string | null;
  /** Mensaje del aviso nuevo, para anexarlo al abierto si aporta algo distinto. */
  message?: string | null;
  /** Voz: un aviso que NO es de alta prioridad lo cubre cualquier abierto del mismo número y sucursal. */
  cualquierAbierto?: boolean;
  /** R29-6b: ventana en minutos (por omisión 30). */
  ventanaMin?: number;
  /** R58-4: solo cubren las filas creadas desde este instante (ms). */
  desdeMs?: number | null;
  /** R32-2/R33-3: cualquier sucursal, pero solo filas escritas por ESTA llamada (source_event_id con el prefijo). */
  cualquierSucursal?: boolean;
  prefijoLlamada?: string | null;
}

/** La fila ABIERTA (≤ ventana, misma sucursal, sin resolver) que cubre al aviso nuevo, o null (= hay que registrarlo). */
export function avisoAbiertoQueCubre(
  filas: readonly FilaAviso[] | null | undefined,
  razon: string | null | undefined,
  ahoraMs: number,
  opciones: OpcionesAviso = {},
): FilaAviso | null {
  const nueva = normAviso(razon);
  if (!nueva || !Array.isArray(filas)) return null; // sin razón nunca deduplica
  const ventanaMin = opciones.ventanaMin ?? VENTANA_AVISO_DUPLICADO_MIN;
  const branchId = opciones.branchId ?? null;
  const categoriaNueva = categoriaDeRazon(nueva);
  return filas.find((fila) => {
    if (fila?.resolved === true) return false;
    if (!opciones.cualquierSucursal && (fila?.branch_id ?? null) !== branchId) return false;
    if (opciones.cualquierSucursal && !(opciones.prefijoLlamada && String(fila?.source_event_id ?? "").startsWith(opciones.prefijoLlamada))) return false;
    const creado = Date.parse(String(fila?.created_at ?? ""));
    const edadMin = (ahoraMs - creado) / 60000;
    if (!Number.isFinite(edadMin) || edadMin > ventanaMin) return false;
    if (opciones.desdeMs != null && creado < opciones.desdeMs) return false;
    const previa = normAviso(fila.reason);
    if (!previa) return false;
    if (previa === nueva) return true;
    // Voz: lo que no es de alta prioridad se anexa al abierto (R30-1: salvo al de posible cancelación).
    if (opciones.cualquierAbierto && !esAvisoDeAltaPrioridad(nueva) && previa !== RAZON_POSIBLE_CANCELACION_VOZ) return true;
    if (esPostventa(previa) && esPostventa(nueva)) return true;
    // Cobro doble abierto: solo lo cubre un motivo de cobro cuyo mensaje es el mismo cobro (lista blanca).
    if (previa === "alto_riesgo:cobro_duplicado" && !nueva.startsWith("alto_riesgo:")) {
      return esElMismoCobroDuplicado(nueva, normAviso(opciones.message));
    }
    // Un alto riesgo abierto solo cubre un contacto genérico de la MISMA categoría.
    return previa.startsWith("alto_riesgo:") && !nueva.startsWith("alto_riesgo:") && categoriaNueva !== null && categoriaNueva === categoriaDeRazon(previa);
  }) ?? null;
}

/** ¿Ya hay un aviso abierto que cubre a este? (sin anexar nada). */
export function hayAvisoAbierto(filas: readonly FilaAviso[] | null | undefined, razon: string | null | undefined, ahoraMs: number, opciones: OpcionesAviso = {}): boolean {
  return avisoAbiertoQueCubre(filas, razon, ahoraMs, opciones) !== null;
}

/**
 * Qué hacer con un aviso nuevo (al escalar):
 *  - «registrar»: insertarlo (no hay abierto que lo cubra, o lo nuevo solo no cabe en el tope de 2000).
 *  - «cubierto»: ya está y no aporta texto nuevo: no se inserta nada.
 *  - «anexar»: UPDATE callback_requests.message = `message` de `fila`; si ese UPDATE falla, registrar (falla abierto).
 */
export type PlanAviso =
  | { accion: "registrar" }
  | { accion: "cubierto"; fila: FilaAviso }
  | { accion: "anexar"; fila: FilaAviso; message: string };

export function planDeAviso(
  filas: readonly FilaAviso[] | null | undefined,
  razon: string | null | undefined,
  ahoraMs: number,
  opciones: OpcionesAviso = {},
): PlanAviso {
  const fila = avisoAbiertoQueCubre(filas, razon, ahoraMs, opciones);
  if (!fila) return { accion: "registrar" };
  let nuevo = String(opciones.message ?? "").trim();
  // La marca URGENTE va al INICIO de lo anexado, antes del motivo.
  const marca = `${MARCA_AVISO_URGENTE}\n`;
  const urgente = nuevo.startsWith(marca);
  if (urgente) nuevo = nuevo.slice(marca.length).trim();
  // Cubierto por otro motivo (post-venta): el motivo nuevo viaja en el texto anexado.
  const otroMotivo = normAviso(fila.reason) !== normAviso(razon);
  if (otroMotivo && String(razon ?? "").trim()) nuevo = nuevo ? `[${String(razon).trim()}] ${nuevo}` : String(razon).trim();
  if (urgente) nuevo = `${marca}${nuevo}`;
  if (!nuevo || normAviso(fila.message).includes(normAviso(nuevo))) return { accion: "cubierto", fila };
  const previo = String(fila.message ?? "").trim();
  // Tope de 2000: se recorta primero lo VIEJO (salvo su línea URGENTE y una cola) y luego lo de en medio de lo nuevo.
  const SEP = "\n---\n";
  if (nuevo.length > TOPE_MENSAJE_AVISO) return { accion: "registrar" };
  const cabeza = avisoCreadoUrgente(previo) ? `${(previo.split("\n")[0] ?? "").slice(0, 300)}\n[…]\n` : "";
  const COLA_MINIMA = 200;
  const minimoViejo = previo.length <= cabeza.length + COLA_MINIMA ? previo : `${cabeza}${previo.slice(previo.length - COLA_MINIMA)}`;
  const sitioNuevo = TOPE_MENSAJE_AVISO - (minimoViejo ? SEP.length + minimoViejo.length : 0);
  let anexo = nuevo;
  if (anexo.length > sitioNuevo) {
    const MEDIO = "\n[…]\n";
    const resto = sitioNuevo - MEDIO.length;
    const inicio = Math.min(resto, Math.max(Math.ceil(resto / 2), urgente ? marca.length + 80 : 0));
    anexo = `${nuevo.slice(0, inicio)}${MEDIO}${nuevo.slice(nuevo.length - (resto - inicio))}`;
  }
  const sitioViejo = TOPE_MENSAJE_AVISO - SEP.length - anexo.length;
  const viejoRecortado = !previo
    ? ""
    : previo.length <= sitioViejo
    ? previo
    : `${cabeza}${previo.slice(previo.length - (sitioViejo - cabeza.length))}`;
  return { accion: "anexar", fila, message: viejoRecortado ? `${viejoRecortado}${SEP}${anexo}` : anexo };
}

// ------------------------------------------- llaves de la ráfaga de avisos

/** Sufijo de la llave de un aviso de la ráfaga: `${llave}#${slug}`. */
export function slugDeMotivo(motivo: string): string {
  return motivo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "aviso";
}

/** `source_event_id` de cada aviso de la ráfaga: la llave del evento si es uno; `${llave}#${motivo}` si son varios. */
export function llavesDeAvisos(idempotencyKey: string | null | undefined, motivos: readonly string[]): Array<string | null> {
  if (!idempotencyKey) return motivos.map(() => null);
  if (motivos.length <= 1) return motivos.map(() => idempotencyKey);
  const vistas = new Set<string>();
  return motivos.map((motivo) => {
    const base = slugDeMotivo(motivo);
    let slug = base;
    for (let i = 2; vistas.has(slug); i++) slug = `${base}-${i}`;
    vistas.add(slug);
    return `${idempotencyKey}#${slug}`;
  });
}

/** Llaves que el llamador consulta (source_event_id IN …) para saber qué motivos de un reintento tardío ya están. */
export function llavesAConsultar(idempotencyKey: string, motivos: readonly string[]): string[] {
  return [idempotencyKey, ...motivos.map((m) => `${idempotencyKey}#${slugDeMotivo(m)}`)];
}

/** Motivos de este evento de Meta YA registrados (reintento tardío, fuera de la ventana de 30 min), dadas las filas leídas. */
export function motivosYaRegistrados(
  filas: ReadonlyArray<{ source_event_id?: string | null; reason?: string | null }> | null | undefined,
  idempotencyKey: string | null | undefined,
  motivos: readonly string[],
): Set<string> {
  const ya = new Set<string>();
  if (!idempotencyKey || motivos.length === 0 || !Array.isArray(filas)) return ya;
  for (const motivo of motivos) {
    const conSufijo = `${idempotencyKey}#${slugDeMotivo(motivo)}`;
    if (filas.some((f) => f?.source_event_id === conSufijo || (f?.source_event_id === idempotencyKey && normAviso(f?.reason) === normAviso(motivo)))) ya.add(motivo);
  }
  return ya;
}

// ------------------------------------------- respuesta de varios avisos

export type IntentAviso =
  | "transferencia_realizada"
  | "cancelacion"
  | "cobro_duplicado"
  | "alergia"
  | "salud"
  | "urgencia"
  | "privacidad_arco"
  | "reclamo_pedido";

// R79-C / R40: comida del menú que puede faltar (para nombrar «de lo que faltó»).
const COMIDA_RECLAMO =
  "kilo|kilos|carne|carnes|coca|cocas|refresco|refrescos|bebida|bebidas|agua|cerveza|taco|tacos|orden|ordenes|salsa|salsas|guacamole|queso|quesadilla|quesadillas|gringa|gringas|alambre|alambres|suizo|suizos|mestiza|mestizas|papa|papas|frijoles|tortilla|tortillas|limon|limones|cebolla|nachos|torta|tortas|postre|complemento|complementos|pastor|bistec|pollo|pechuga|chorizo|cochinita|res|" +
  "sopa|sopas|arrachera|chuleta|costilla|champinon|champinones|rajas|flauta|flautas|fajita|fajitas|alitas|papadzules|codzitos|hamburguesa|hamburguesas|chetaco|chetacos|quesobich|parrillada|ensalada|flan|jericalla|jericallas|horchata|limonada|limonadas|naranjada|naranjadas|sprite|fanta|michelada|chelada|cafe";
const ARTICULO_RECLAMO = "la|el|los|las|un|una|unos|unas|mi|mis|su|sus|\\d+|dos|tres|cuatro|cinco|seis";
// R59-1: formas de un FALTANTE (sin «orden»: «no me llegó la orden» es demora).
const COMIDA_FALTANTE = COMIDA_RECLAMO.split("|").filter((x) => !x.startsWith("orden")).join("|");
const VERBO_FALTANTE = "venia|venian|vino|vinieron|traia|traian|trajeron|trajo|llego|llegaron|mandaron|pusieron";
const FALTANTE_RECLAMO = [
  String.raw`\bfalt(?:a|an|o|aron)\b`,
  String.raw`\b(?:no|tampoco|ni)\s+(?:(?:me|nos|le)\s+)?(?:${VERBO_FALTANTE})\s+(?:(?:${ARTICULO_RECLAMO})\s+)+(?:[a-z]+\s+)?(?:${COMIDA_FALTANTE})\b`,
  String.raw`\b(?:${ARTICULO_RECLAMO})\s+(?:[a-z]+\s+)?(?:${COMIDA_FALTANTE})\s+no\s+(?:(?:me|nos|le)\s+)?(?:${VERBO_FALTANTE})\b`,
  String.raw`\bse\s+(?:les|le)\s+olvid(?:o|aron)\b`,
  String.raw`\bmissing\b`,
  String.raw`\byou\s+(?:guys\s+)?forgot\b`, // R91-5
].join("|");

/** De qué se avisó, para nombrarlo en la respuesta de varios avisos («del cobro doble», «de lo que faltó»). */
export function deQueSeAviso(intent: IntentAviso, textos: readonly string[]): string {
  const plano = normAviso(textos.join(" "));
  switch (intent) {
    case "transferencia_realizada": return "de su transferencia";
    case "cancelacion": return "de su cancelación";
    case "cobro_duplicado": return "del cobro doble";
    case "alergia": return "de su alergia";
    case "salud": return "de su malestar";
    case "privacidad_arco": return "de su solicitud sobre sus datos";
    default: break;
  }
  if (/\bfalt/.test(plano)) return "de lo que faltó";
  // R87-V: «no me llegó la coca» (con producto) es faltante, no demora.
  if (new RegExp(FALTANTE_RECLAMO).test(plano)) return "de lo que faltó";
  if (/no\s+(?:me\s+)?(?:ha\s+)?(?:llega|llego)|\btarda|\bdemora|\bno\s+ha\s+llegado/.test(plano)) return "de la demora";
  if (/equivoc|en\s+vez\s+de|\bincorrect/.test(plano)) return "del producto equivocado";
  return "de lo que pasó con su pedido";
}

/** Lo que la respuesta fija de cada riesgo NO puede perder aunque vaya con otros avisos (una sola tabla, R9-6). */
export const FRASES_OBLIGATORIAS_DE_AVISO: Readonly<Partial<Record<IntentAviso, readonly string[]>>> = {
  alergia: [ALERGIA_SIN_GARANTIA, ALERGIA_ANTES_DEL_PEDIDO],
  salud: [SALUD_SIN_DIAGNOSTICO],
  cancelacion: [condicionesDeCancelacion()],
};

/** Cómo va cada frase obligatoria en la respuesta de varios avisos (derivada de FRASES_OBLIGATORIAS_DE_AVISO). */
export function frasesDeVariosAvisos(intent: IntentAviso): string[] {
  return (FRASES_OBLIGATORIAS_DE_AVISO[intent] ?? []).map((frase) => (frase === ALERGIA_ANTES_DEL_PEDIDO ? `Le pedí a la sucursal que ${frase}.` : frase));
}

/** Respuesta fija cuando el turno registra 2+ avisos: corta, nombra cada uno y trae las frases obligatorias completas. */
export function respuestaDeVariosAvisos(riesgos: ReadonlyArray<{ match: { intent: IntentAviso }; textos: readonly string[]; urgente?: boolean }>): string {
  const partes = riesgos.map((r) => deQueSeAviso(r.match.intent, r.textos));
  const lista = partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
  const intents = [...new Set(riesgos.map((r) => r.match.intent))];
  const extras = intents.flatMap((intent) => frasesDeVariosAvisos(intent));
  return [`${riesgos.some((r) => r.urgente) ? "Entendido, es urgente. " : "Lamento lo que pasó. "}Ya avisé a la sucursal ${lista}; una persona revisará cada caso y lo contactará.`, ...extras].join(" ");
}

/** Respuesta fija de un aviso marcado urgente: «Entendido, es urgente.» sin repetir el «Entendido» de la fija (R8-4). */
export function respuestaUrgente(reply: string): string {
  const resto = reply.replace(/^Entendido[,.;:]?\s*/, "");
  return `Entendido, es urgente. ${resto.charAt(0).toUpperCase()}${resto.slice(1)}`;
}

/** Cuando no se pudo registrar el aviso: no se promete que la sucursal ya sabe. */
export const AVISO_NO_REGISTRADO_REPLY =
  "Lamento lo que pasó. En este momento no pude dejar el aviso en el sistema, así que no puedo asegurarle que la sucursal ya lo sepa. Le pido que llame directamente a la sucursal; también paso su mensaje a una persona en cuanto pueda.";

// ================================================= niveles de alerta (cron)
// alertas-operativas.ts del suelto, sin el adaptador de Supabase: el núcleo recibe un adaptador inyectable.

export const ALERTA_MINUTOS_POR_OMISION = 10;
/** Solo se avisa de lo ocurrido en esta ventana (no de historia vieja). */
export const ALERTA_VENTANA_HORAS = 24;
export const ALERTA_MAX_CORREOS_POR_OMISION = 10;
/** Repetición: un aviso cada PASO min tras el umbral; el tercero escala al dueño. */
export const ALERTA_PASO_REPETICION_MIN = 10;
export const ALERTA_NIVEL_MAX = 3;

export interface ConfigAlertas {
  porAprobarMin: number;
  chatMin: number;
  /** Piso de fecha: solo lo creado después. null = fecha de la primera ejecución. */
  desde?: Date | null;
  /** Tope de correos individuales por corrida; el exceso va en UN correo-resumen. */
  maxCorreos?: number;
}

/** Nivel que toca (1, 2 o 3) según cuánto lleva esperando; sin hora conocida solo nivel 1. Uno por corrida: el más alto vencido. */
export function nivelDebido(desde: Date | null | undefined, ahora: Date, umbralMin: number): number {
  if (!desde || !Number.isFinite(desde.getTime())) return 1;
  const edadMin = (ahora.getTime() - desde.getTime()) / 60_000;
  let nivel = 1;
  for (let n = 2; n <= ALERTA_NIVEL_MAX; n++) {
    if (edadMin >= umbralMin + (n - 1) * ALERTA_PASO_REPETICION_MIN) nivel = n;
  }
  return nivel;
}

/** Los niveles 2 y 3 llevan sufijo; el 1 conserva la llave de siempre (idempotencia retrocompatible). */
export const llaveConNivel = (base: string, nivel: number): string => (nivel <= 1 ? base : `${base}:n${nivel}`);

export interface PedidoPorAprobar {
  id: string;
  restaurant_id: string;
  branch_id?: string | null;
  /** Desde cuándo espera (created_at): da el nivel de repetición. */
  desde?: Date | null;
}

export interface ChatSinRespuesta {
  /** Estable mientras no haya actividad nueva (da la llave de idempotencia). */
  clave: string;
  restaurant_id: string;
  branch_id?: string | null;
  desde?: Date | null;
  /** R30-4: aviso de BAJA prioridad: solo el primer aviso, sin recordatorio ni escalada. */
  soloPrimerAviso?: boolean;
}

/** R30-4: motivos que el cron avisa UNA vez (nivel 1) y no escala. */
export const MOTIVOS_UN_SOLO_AVISO: ReadonlySet<string> = new Set([RAZON_POSIBLE_BAJA]);

export interface AlertaEncolable {
  restaurant_id: string;
  tipo: "por_aprobar" | "chat_sin_respuesta";
  dedupe_key: string;
  payload: Record<string, unknown>;
}

/** Puerto que conecta el líder (outbox/notificaciones del monorrepo). */
export interface AlertasAdaptador {
  pedidosPorAprobar(antesDe: Date, despuesDe: Date): Promise<PedidoPorAprobar[]>;
  chatsSinRespuestaHumana(antesDe: Date, despuesDe: Date, minutos: number): Promise<ChatSinRespuesta[]>;
  encolar(alerta: AlertaEncolable): Promise<void>;
  /** Cuáles de estas llaves ya están encoladas. */
  yaEncoladas(llaves: string[]): Promise<Set<string>>;
  /** Fecha de la primera ejecución (la registra si no existe); null si no se pudo leer. */
  activacion(ahora: Date): Promise<Date | null>;
}

/** Entero entre 1 y 1440; cualquier otra cosa cae al valor por omisión. */
export function normalizarMinutos(valor: unknown, porOmision: number = ALERTA_MINUTOS_POR_OMISION): number {
  const n = typeof valor === "string" ? Number(valor) : valor;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1440 ? n : porOmision;
}

function fechaValida(valor: unknown): Date | null {
  if (typeof valor !== "string" || !valor.trim()) return null;
  const t = Date.parse(valor);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Configuración desde el cuerpo de la petición (manda) y el entorno (respaldo), ya normalizada. */
export function configDesde(
  entrada: { por_aprobar_min?: unknown; chat_min?: unknown; desde?: unknown; max_correos?: unknown } | null | undefined,
  env: { porAprobar?: string | undefined; chat?: string | undefined; desde?: string | undefined; maxCorreos?: string | undefined } = {},
): ConfigAlertas {
  const max = Number(entrada?.max_correos ?? env.maxCorreos);
  return {
    porAprobarMin: normalizarMinutos(entrada?.por_aprobar_min ?? env.porAprobar),
    chatMin: normalizarMinutos(entrada?.chat_min ?? env.chat),
    desde: fechaValida(entrada?.desde) ?? fechaValida(env.desde),
    maxCorreos: Number.isInteger(max) && max >= 1 && max <= 100 ? max : ALERTA_MAX_CORREOS_POR_OMISION,
  };
}

/** Una corrida del cron: niveles 1/2/3 (cada 10 min tras el umbral), idempotente por llave, tope + resumen por restaurante. */
export async function correrAlertas(
  adaptador: AlertasAdaptador,
  ahora: Date,
  cfg: ConfigAlertas,
): Promise<{ por_aprobar: number; chats_sin_respuesta: number; enviadas: number; resumidas: number; piso: string }> {
  // Piso: nunca lo anterior a la activación; si no se puede leer, «ahora» (falla cerrado, sin ráfagas).
  const piso = cfg.desde ?? (await adaptador.activacion(ahora)) ?? ahora;
  const ventana = new Date(ahora.getTime() - ALERTA_VENTANA_HORAS * 3_600_000);
  const desde = piso.getTime() > ventana.getTime() ? piso : ventana;
  const candidatas: AlertaEncolable[] = [];
  const pedidos = await adaptador.pedidosPorAprobar(new Date(ahora.getTime() - cfg.porAprobarMin * 60_000), desde);
  for (const pedido of pedidos) {
    const nivel = nivelDebido(pedido.desde, ahora, cfg.porAprobarMin);
    candidatas.push({
      restaurant_id: pedido.restaurant_id,
      tipo: "por_aprobar",
      dedupe_key: llaveConNivel(`alerta:por_aprobar:${pedido.id}`, nivel),
      payload: { order_id: pedido.id, evento: "por_aprobar_vencido", minutos: cfg.porAprobarMin, nivel },
    });
  }
  const chats = await adaptador.chatsSinRespuestaHumana(new Date(ahora.getTime() - cfg.chatMin * 60_000), desde, cfg.chatMin);
  for (const chat of chats) {
    const nivel = chat.soloPrimerAviso ? 1 : nivelDebido(chat.desde, ahora, cfg.chatMin);
    candidatas.push({
      restaurant_id: chat.restaurant_id,
      tipo: "chat_sin_respuesta",
      dedupe_key: llaveConNivel(`alerta:chat:${chat.clave}`, nivel),
      payload: {
        alerta: "chat_sin_respuesta",
        restaurant_id: chat.restaurant_id,
        clave: llaveConNivel(chat.clave, nivel),
        minutos: cfg.chatMin,
        cantidad: 1,
        nivel,
        branch_id: chat.branch_id ?? null,
      },
    });
  }
  const existentes = await adaptador.yaEncoladas(candidatas.map((a) => a.dedupe_key));
  const nuevas = candidatas.filter((a) => !existentes.has(a.dedupe_key));
  const tope = cfg.maxCorreos ?? ALERTA_MAX_CORREOS_POR_OMISION;
  const aEnviar = nuevas.slice(0, tope);
  const exceso = nuevas.slice(tope);
  for (const alerta of aEnviar) await adaptador.encolar(alerta);
  const porRestaurante = new Map<string, number>();
  for (const a of exceso) porRestaurante.set(a.restaurant_id, (porRestaurante.get(a.restaurant_id) ?? 0) + 1);
  const hora = ahora.toISOString().slice(0, 13); // un resumen por hora y restaurante
  for (const [restaurantId, cantidad] of porRestaurante) {
    await adaptador.encolar({
      restaurant_id: restaurantId,
      tipo: "chat_sin_respuesta",
      dedupe_key: `alerta:resumen:${restaurantId}:${hora}`,
      payload: { alerta: "resumen", restaurant_id: restaurantId, clave: `resumen:${hora}`, minutos: cfg.chatMin, cantidad },
    });
  }
  return { por_aprobar: pedidos.length, chats_sin_respuesta: chats.length, enviadas: aEnviar.length, resumidas: exceso.length, piso: piso.toISOString() };
}

/** El correo nivel 1 de un aviso (llave `alerta:chat:cb:<id>[:<sufijo>]`): la misma del cron, así no se repite. */
export function alertaNivel1DeAviso(aviso: { id: string; restaurant_id: string; branch_id?: string | null }, sufijo?: string): AlertaEncolable {
  const clave = `cb:${aviso.id}${sufijo ? `:${sufijo}` : ""}`.slice(0, 200);
  return {
    restaurant_id: aviso.restaurant_id,
    tipo: "chat_sin_respuesta",
    dedupe_key: llaveConNivel(`alerta:chat:${clave}`, 1),
    payload: { alerta: "chat_sin_respuesta", restaurant_id: aviso.restaurant_id, clave, minutos: 1, cantidad: 1, nivel: 1, branch_id: aviso.branch_id ?? null },
  };
}

/** Encola de inmediato el nivel 1 de un aviso de alta prioridad (al escalar). Idempotente; true si encoló. */
export async function encolarAlertaInmediata(
  adaptador: Pick<AlertasAdaptador, "encolar" | "yaEncoladas">,
  aviso: { id: string; restaurant_id: string; branch_id?: string | null },
  sufijo?: string,
): Promise<boolean> {
  const alerta = alertaNivel1DeAviso(aviso, sufijo);
  if ((await adaptador.yaEncoladas([alerta.dedupe_key])).has(alerta.dedupe_key)) return false;
  await adaptador.encolar(alerta);
  return true;
}

/** v21: alerta URGENTE de un aviso abierto por un `evento` (llave `…:urgente:<evento>`), aparte del nivel 1. */
export async function encolarAlertaUrgenteDeAviso(
  adaptador: Pick<AlertasAdaptador, "encolar" | "yaEncoladas">,
  aviso: { id: string; restaurant_id: string; branch_id?: string | null },
  evento: string,
): Promise<boolean> {
  const clave = `cb:${aviso.id}`;
  const dedupe_key = `${llaveConNivel(`alerta:chat:${clave}`, 1)}:urgente:${evento}`;
  if ((await adaptador.yaEncoladas([dedupe_key])).has(dedupe_key)) return false;
  await adaptador.encolar({
    restaurant_id: aviso.restaurant_id,
    tipo: "chat_sin_respuesta",
    dedupe_key,
    payload: { alerta: "chat_sin_respuesta", restaurant_id: aviso.restaurant_id, clave, minutos: 1, cantidad: 1, nivel: 1, branch_id: aviso.branch_id ?? null },
  });
  return true;
}

// ----------------------------------------------- ruteo por sucursal (P0-9)
// Niveles 1 y 2: personal de ESA sucursal + alcance general sin ser dueño. Nivel 3: + dueño (escalada). Sin nadie en la
// sucursal: al dueño de una vez. Repartidores nunca.

export interface MiembroAlerta {
  role: string;
  branch_id?: string | null;
  /** Preferencia de aviso de la cuenta. */
  notify: boolean;
  email: string | null | undefined;
}

export interface DestinoAlerta {
  correos: string[];
  /** true si no había nadie en la sucursal y se mandó al dueño antes del tercer aviso. */
  fallbackDueno: boolean;
}

export function destinatariosAlerta(equipo: readonly MiembroAlerta[], branchId: string | null | undefined, nivel: number): DestinoAlerta {
  const validos = equipo.filter((m) => m.notify && !!m.email && m.role !== "repartidor");
  const duenos = validos.filter((m) => m.role === "owner");
  const personal = validos.filter((m) => m.role !== "owner" && (m.branch_id == null || (!!branchId && m.branch_id === branchId)));
  const unicos = (l: readonly MiembroAlerta[]) => [...new Set(l.map((m) => String(m.email).trim().toLowerCase()))];
  if (nivel >= 3) return { correos: unicos([...personal, ...duenos]), fallbackDueno: false };
  if (personal.length > 0) return { correos: unicos(personal), fallbackDueno: false };
  return { correos: unicos(duenos), fallbackDueno: duenos.length > 0 };
}

/** Texto antepuesto al asunto según el nivel. */
export function prefijoNivel(nivel: number): string {
  if (nivel >= 3) return "[ESCALADA AL DUEÑO] ";
  if (nivel === 2) return "[RECORDATORIO] ";
  return "";
}

/** Nivel recibido en el cuerpo de la alerta (1 a 3; cualquier otra cosa = 1). */
export function nivelDeAlerta(valor: unknown): number {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 1 && valor <= 3 ? valor : 1;
}
