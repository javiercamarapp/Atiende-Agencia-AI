// PAGO / TRANSFERENCIA / COBRO DOBLE (bloque 5 del port del cerebro «suelto», wt-suelto-voz e69279e). Port puro de
// whatsapp-agent-core.ts: normalizarPagoEfectivo (paga_con / pago_exacto y el candado «el cliente dijo con cuánto paga»,
// PR #19 rondas 4-7, R81-I, R85-7), huellaCobro / huellaCobroPedido (lo que se cobra: el mismo cobro en el mismo turno es
// ESE pedido, no otro), el clasificador de la transferencia YA realizada (transferencia_realizada, R75-5/R76-7/R77-3),
// el del cobro duplicado, categoriaDeRazon (R87-R: «pago», «pago_realizado» = transferencia_realizada) y
// esElMismoCobroDuplicado (revisión PR #21 ronda 4: un aviso nuevo se funde con el cobro doble abierto solo si no trae
// nada más). Sin red, sin base, sin reloj.
import { OrderValidationError } from "../../errors.ts";
import { esMarcadorSesion, normAviso, type MensajeHilo } from "./texto-plano.ts";

/** Inicio del mensaje de un aviso que el cliente pidió con urgencia (lo pone el servidor). */
export const MARCA_AVISO_URGENTE = "URGENTE: el cliente pide atención inmediata.";

// ---------------------------------------------------------------- Efectivo: con cuánto paga
const MENSAJE_PAGO_NO_DICHO =
  "El cliente aún no dijo con cuánto paga. Pregúntele «¿con cuánto paga?» y espere su respuesta ANTES de volver a llamar a crear_pedido; no invente paga_con ni pago_exacto.";
// Solo una pregunta real del asistente sobre el monto/exacto/cambio (no un resumen ni «¿efectivo o tarjeta?»).
// Revisión 81 (R81-I): también en inglés («how much will you pay with?», «exact amount?», «do you need change?»).
const PREGUNTA_DE_PAGO =
  /(?:con\s+cu[aá]nto|pag(?:a|as|ar|o)\s+exact|(?:necesit|ocup|requier)\w*\s+(?:el\s+)?cambio|de\s+cu[aá]nto[^?¿]*billete|how\s+much\s+(?:will|would|are|do)\b[^?¿]*\bpay|pay(?:ing)?\s+with\s+how\s+much|exact\s+(?:amount|change)|need\s+change|what\s+bill|(?:bill|note)\s+will\s+you)[^?¿]*\?/i;
const UNIDAD_NO_MONTO =
  "(?!\\s*(?:de\\b|a\\s+las\\b|am\\b|pm\\b|hrs?\\b|horas?\\b|min\\b|minutos?\\b|km\\b|personas?\\b|tacos?\\b|pzas?\\b|piezas?\\b|ordenes\\b|orden\\b|gracias\\b|cervezas?\\b|refrescos?\\b|aguas?\\b|gringas?\\b|quesadillas?\\b|volcanes?\\b|pastor\\b|minutes?\\b|mins?\\b|people\\b|pieces?\\b|orders?\\b|kilos?\\b|kg\\b|grams?\\b|beers?\\b|sodas?\\b))";
const MONTO_EN_LETRA = new RegExp(
  "\\b(?:veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil)\\b" +
    UNIDAD_NO_MONTO,
);
const MONTO_CON_CONTEXTO = new RegExp(
  "\\$\\s*\\d{2,}|\\b\\d{2,}(?:,\\d{3})*\\s*(?:pesos|varos|lana|mxn)\\b|\\b(?:con|de|traigo|pago|paga|pagar|pagare|pagaria|tengo|llevo|billete|billetes|cambio|un|una|with|have|pay|paying|bill|change|cash)\\s+(?:(?:un|una|el|de|a|an|the|my)\\s+)*\\$?\\s*\\d{2,}(?:,\\d{3})*" +
    UNIDAD_NO_MONTO + "|\\b\\d{2,}(?:,\\d{3})*\\s+(?:bill|note|in\\s+cash|cash)\\b|^\\s*\\$?\\s*\\d{2,}(?:,\\d{3})*(?:\\.\\d{1,2})?\\s*[.!]?\\s*$",
);
// Revisión 81 (R81-I): también en inglés («exact change», «exact amount», «no change needed», «don't need change»).
const PAGO_EXACTO_DICHO =
  /\b(?:exact(?:[oa]s?)?(?:\s+(?:change|amount))?|no\s+change(?:\s+needed)?|(?:don\W?t|do\s+not)\s+need\s+(?:any\s+)?change|justo|justa|justito|justita|cabal|completo|completa|sin\s+cambio|no\s+(?:necesito|ocupo|requiero|hace\s+falta|ocupa)\s+(?:el\s+)?cambio)\b/;

/**
 * Revisión 85 (R85-7): el monto (en cifras, con contexto: «con 500», «billete de 500», «cash 500», «$500») que dijo el
 * cliente en sus textos, del más reciente al más viejo; null si ninguno lo trae. Pura.
 */
export function montoDichoPorElCliente(textos: string[]): number | null {
  for (let i = textos.length - 1; i >= 0; i--) {
    const t = String(textos[i] ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const m = MONTO_CON_CONTEXTO.exec(t)?.[0];
    const cifra = m ? /\d{2,}(?:,\d{3})*(?:\.\d{1,2})?/.exec(m)?.[0] : undefined;
    if (cifra) return Number(cifra.replace(/,/g, ""));
  }
  return null;
}

function clientePagoDijo(texto: string, ultimaPregunta: string, soloExacto = false): boolean {
  const t = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (MONTO_EN_LETRA.test(t) || MONTO_CON_CONTEXTO.test(t) || PAGO_EXACTO_DICHO.test(t)) return true;
  // «sí/no» solo vale como respuesta a una pregunta de «¿paga exacto?».
  // Un «no» (necesita cambio) nunca valida nada por sí solo; un «sí» solo valida pago_exacto, no un paga_con.
  return soloExacto && /exact|justo/i.test(ultimaPregunta) &&
    /^\s*(?:si|claro|asi es|aja|ok|va|yes|yeah|yep|sure)(?:\s*[.!,]?\s*(?:gracias|por favor|thanks|thank you|please))?\s*[.!]?\s*$/.test(t);
}

// Textos del cliente posteriores a la ultima pregunta del asistente sobre el pago (sesion actual) y si
// en esa sesion ya hubo un rechazo de este mismo error con una respuesta del cliente despues (valvula
// anti-bucle: nunca mas de un rechazo).
function ventanaDePago(hilo: readonly MensajeHilo[]): { textos: string[]; pregunta: string; rechazoPrevio: boolean } {
  let ini = 0;
  for (let i = hilo.length - 1; i >= 0; i--) {
    if (esMarcadorSesion(hilo[i])) {
      ini = i + 1;
      break;
    }
  }
  const ses = hilo.slice(ini).filter((m) => !esMarcadorSesion(m));
  // El texto de un mensaje (o null si no es texto).
  const texto = (m: MensajeHilo | undefined): string | null => (typeof m?.content === "string" ? m.content : null);
  const esUser = (m: MensajeHilo | undefined) => m?.role === "user" && texto(m) !== null;
  let rechazoIdx = -1;
  for (let i = ses.length - 1; i >= 0; i--) {
    const c = texto(ses[i]);
    if (ses[i]?.role !== "tool" || c === null) continue;
    // La válvula es por pedido: un crear_pedido exitoso cierra el pedido anterior y su rechazo no cuenta.
    if (/"order"\s*:\s*\{\s*"id"/.test(c)) break;
    if (c.includes("aún no dijo con cuánto paga")) {
      rechazoIdx = i;
      break;
    }
  }
  const rechazoPrevio = rechazoIdx >= 0 && ses.slice(rechazoIdx + 1).some((m) => esUser(m) && (texto(m) ?? "").trim() !== "");
  let q = -1;
  for (let i = ses.length - 1; i >= 0; i--) {
    const c = texto(ses[i]);
    if (ses[i]?.role === "assistant" && c !== null && PREGUNTA_DE_PAGO.test(c)) {
      q = i;
      break;
    }
  }
  return {
    textos: ses.slice(q + 1).filter(esUser).map((m) => texto(m) ?? ""),
    pregunta: q >= 0 ? texto(ses[q]) ?? "" : "",
    rechazoPrevio,
  };
}

/**
 * paga_con / pago_exacto que manda el modelo: acepta «500», «$500», «1,500 pesos» y «true»; un valor
 * inválido es un OrderValidationError claro (antes se descartaba en silencio). En efectivo a domicilio
 * se exige uno de los dos (el repartidor necesita saber con cuánto lleva cambio).
 */
export function normalizarPagoEfectivo(
  input: Record<string, unknown>,
  entrega: "domicilio" | "recoger",
  textosCliente?: string[],
  hilo?: readonly MensajeHilo[],
): { paga_con?: number; pago_exacto?: true } {
  const vacio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  let paga_con: number | undefined;
  if (!vacio(input.paga_con)) {
    const bruto = input.paga_con;
    const n = typeof bruto === "number"
      ? bruto
      : typeof bruto === "string" && /^\s*\$?\s*\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:pesos)?\s*$/i.test(bruto)
      ? Number(bruto.replace(/[^\d.]/g, ""))
      : NaN;
    // Revisión 85 (R85-7): el modelo mandó paga_con en otro formato («billete de 500») pero el cliente ya dijo el monto: se
    // toma el monto de lo que escribió el cliente (no se le vuelve a preguntar). Sin monto del cliente, se pregunta.
    const delCliente = Number.isFinite(n) ? null : montoDichoPorElCliente(hilo ? ventanaDePago(hilo).textos : textosCliente ?? []);
    if (!Number.isFinite(n) && delCliente === null) {
      throw new OrderValidationError(
        "paga_con debe ser el monto en pesos con el que paga el cliente (por ejemplo 500). Pregúntele con cuánto paga.",
      );
    }
    paga_con = delCliente ?? n;
  }
  let pago_exacto: true | undefined;
  if (!vacio(input.pago_exacto)) {
    const b = input.pago_exacto;
    if (b === true || (typeof b === "string" && b.trim().toLowerCase() === "true")) pago_exacto = true;
    else if (b === false || (typeof b === "string" && b.trim().toLowerCase() === "false")) pago_exacto = undefined;
    else throw new OrderValidationError("pago_exacto debe ser true (paga exacto) o se omite.");
  }
  if (
    input.payment_method === "efectivo" && entrega === "domicilio" &&
    paga_con === undefined && pago_exacto === undefined
  ) {
    throw new OrderValidationError(
      "En efectivo a domicilio falta saber con cuánto paga: pregúntele «¿con cuánto paga?» y mande paga_con (monto) o pago_exacto=true.",
    );
  }
  // El modelo no puede inventar el pago: en efectivo a domicilio, algun texto del cliente POSTERIOR a la
  // ultima pregunta sobre el pago debe traer un monto (con contexto o en letra), «exacto/justo/sin cambio»
  // o un «si/no» a «¿paga exacto?»; si no, se le manda a preguntar «¿con cuánto paga?».
  if (
    (textosCliente || hilo) && input.payment_method === "efectivo" && entrega === "domicilio" &&
    (paga_con !== undefined || pago_exacto !== undefined)
  ) {
    const v = hilo ? ventanaDePago(hilo) : { textos: textosCliente ?? [], pregunta: "", rechazoPrevio: false };
    if (!v.rechazoPrevio && !v.textos.some((t) => clientePagoDijo(t, v.pregunta, paga_con === undefined))) {
      throw new OrderValidationError(MENSAJE_PAGO_NO_DICHO);
    }
  }
  return { paga_con, pago_exacto };
}

// ---------------------------------------------------------------- Categoría del aviso y cobro doble
/** Categoría de alto riesgo de una razón: la del prefijo «alto_riesgo:x» o la inferida de un texto libre. */
export function categoriaDeRazon(razonNorm: string): string | null {
  if (razonNorm.startsWith("alto_riesgo:")) return razonNorm.slice("alto_riesgo:".length).trim() || null;
  if (/alerg/.test(razonNorm)) return "alergia";
  if (/intoxi|envenen|enferm|vomit|diarrea/.test(razonNorm)) return "salud";
  if (/cobro|cargo/.test(razonNorm) && /duplic|doble|dos veces/.test(razonNorm)) return "cobro_duplicado";
  if (/cancel/.test(razonNorm)) return "cancelacion";
  if (/urgen/.test(razonNorm)) return "urgencia";
  if (/\barco\b|privacidad|datos personales/.test(razonNorm)) return "privacidad_arco";
  // Revisión 87 (R87-R): «pago», «pago_realizado», «confirmar pago», «pago hecho» del modelo son el mismo aviso que el
  // alto_riesgo:transferencia_realizada del servidor (se deduplican con él).
  if (/transferen|deposit|comprobante|\bpag(?:o|os|ado|ada|ue|aron|o_realizado)\b|\bpago_/.test(razonNorm)) return "transferencia_realizada";
  return null;
}

// Mensaje que habla del MISMO cobro doble (cobro/cargo doble o duplicado, tarjeta cobrada dos veces).
const TEXTO_DEL_MISMO_COBRO =
  /(?:cobr\w*|cargo\w*|cargaron|cargad\w*)[^.]{0,40}(?:dos veces|2 veces|doble|duplic|otra vez|de mas)|(?:doble|duplicad\w*)\s+(?:cobro|cargo)|(?:cobro|cargo)\s+duplicad\w*|\b(?:dos|2)\s+(?:cargos|cobros)\b/;

// LISTA BLANCA (revision PR #21 ronda 4): un aviso nuevo se anexa al cobro duplicado abierto SOLO si, quitando
// las frases del mismo cobro y las palabras de cortesia/relleno, no queda NADA del mensaje ni del motivo.
// Con la lista negra anterior (factur|repartidor|envio|cancel...) cada ronda aparecian palabras nuevas que se
// tragaban un aviso (chofer, «me dieron de menos», «tardó», cambiar/quitar, entrega). Un aviso perdido es peor
// que uno repetido: lo que no se reconoce abre su propio aviso.
const FRASES_DEL_MISMO_COBRO: RegExp[] = [
  // «yo no cancelé el pedido», «no hice otro pedido»: explica el cobro doble, no es otro asunto.
  /\b(?:yo )?no (?:cancele|hice|pedi|autorice|reconozco)\b(?: (?:el|mi|ese|ningun|otro|un|los) (?:pedido|cargo|cobro|compra|pago)s?)?/g,
  // «cancelen uno», «cancelen uno de los cobros», «cancelen el cargo duplicado».
  /\bcancel\w* (?:uno de los (?:dos )?(?:cobros|cargos)|uno|una|el otro|el (?:cargo|cobro)(?: duplicado| doble| extra| de mas)?|el duplicado|el doble)\b/g,
  // «¿pueden modificar/quitar/revisar el cargo?», «devuelvan el cobro».
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
// Palabras de un MOTIVO de cobro que redacta el modelo («reclamo de cobro», «cobro_duplicado»).
const PALABRAS_DE_MOTIVO = new Set(["reclamo", "queja", "problema", "reporte", "reporta", "aviso", "cliente", "alto", "riesgo"]);

/** Lo que queda del texto (ya normalizado) sin las frases del mismo cobro ni palabras de cobro/relleno. */
function restoAjenoAlCobro(texto: string, extra: Set<string> = new Set()): string[] {
  let plano = texto.replace(/[^a-z0-9ñ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const re of FRASES_DEL_MISMO_COBRO) plano = plano.replace(re, " ");
  return plano.split(" ").filter((w) => w && !PALABRAS_DEL_COBRO.has(w) && !PALABRAS_DE_RELLENO.has(w) && !extra.has(w));
}

/** El aviso nuevo es el MISMO cobro duplicado abierto: motivo de cobro (o el fijo de post-venta) y nada mas. */
function esElMismoCobroDuplicado(nueva: string, mensajeConMarca: string): boolean {
  // La marca URGENTE la pone el servidor, no el cliente: no es «algo mas» que el mismo cobro.
  const mensaje = mensajeConMarca.split(normAviso(MARCA_AVISO_URGENTE)).join(" ");
  const motivoDeCobro = nueva === RAZON_RECLAMO_PEDIDO ||
    (/cobr|carg|reembols|devoluc/.test(nueva) && restoAjenoAlCobro(nueva, PALABRAS_DE_MOTIVO).length === 0);
  if (!motivoDeCobro) return false;
  if (!TEXTO_DEL_MISMO_COBRO.test(`${nueva === RAZON_RECLAMO_PEDIDO ? "" : nueva} ${mensaje}`)) return false;
  return restoAjenoAlCobro(mensaje).length === 0;
}
// Motivo fijo del aviso automático de post-venta (respuestas fijas): enumera «faltante» sin que el cliente lo
// haya dicho, así que no cuenta como motivo ajeno; ahí decide el mensaje.
const RAZON_RECLAMO_PEDIDO = "reclamo de pedido: faltante, producto equivocado o demora";

// ---------------------------------------------------------------- Huella de cobro (dedupe al crear)
type ItemCotizacion = { product_id?: unknown; product_name?: unknown; requested_quantity?: unknown; tortilla?: unknown; unidad?: unknown };
/**
 * Huella de lo que se cobra: sucursal, renglones (producto, cantidad, tortilla, unidad) y porciones extra de salsa
 * (sumadas por salsa). Lo que no cambia el precio (notas, complementos sin costo, omisiones) no entra. La entrega se
 * compara aparte. Pura.
 */
export function huellaCobro(args: Record<string, unknown>): string {
  const items = (Array.isArray(args.items) ? args.items as ItemCotizacion[] : [])
    .map((i) => [
      String(i?.product_id ?? "") || String(i?.product_name ?? "").trim().toLowerCase(),
      Number(i?.requested_quantity ?? 0),
      String(i?.tortilla ?? ""),
      String(i?.unidad ?? ""),
    ])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const salsas = new Map<string, number>();
  for (const e of Array.isArray(args.salsas_extra) ? args.salsas_extra as Array<{ salsa?: unknown; porciones?: unknown }> : []) {
    const k = String(e?.salsa ?? "");
    salsas.set(k, (salsas.get(k) ?? 0) + Number(e?.porciones ?? 0));
  }
  return JSON.stringify([String(args.branch_slug ?? ""), items, [...salsas.entries()].sort()]);
}


type ItemCobro = { product_id?: unknown; product_name?: unknown; requested_quantity?: unknown; tortilla?: unknown; unidad?: unknown };
/**
 * Huella de lo que se cobra: sucursal, renglones (producto, cantidad, tortilla, unidad) y porciones extra de salsa
 * (sumadas por salsa). Notas, nombre, dirección, pago y complementos sin costo no entran. Pura.
 */
export function huellaCobroPedido(args: Record<string, unknown>): string {
  const items = (Array.isArray(args.items) ? args.items as ItemCobro[] : [])
    .map((i) => [
      String(i?.product_id ?? "") || String(i?.product_name ?? "").trim().toLowerCase(),
      Number(i?.requested_quantity ?? 0),
      String(i?.tortilla ?? ""),
      String(i?.unidad ?? ""),
    ])
    .map((r) => JSON.stringify(r))
    .sort();
  const salsas = new Map<string, number>();
  for (const e of Array.isArray(args.salsas_extra) ? args.salsas_extra as Array<{ salsa?: unknown; porciones?: unknown }> : []) {
    const k = String(e?.salsa ?? "");
    salsas.set(k, (salsas.get(k) ?? 0) + Number(e?.porciones ?? 0));
  }
  return JSON.stringify([String(args.branch_slug ?? ""), items, [...salsas.entries()].sort()]);
}


/**
 * Huella de lo que se cobra (huellaCobro) de los pedidos ya creados en el turno: si un crear_pedido nuevo cobra lo mismo
 * que uno creado (sucursal, productos, cantidades, tortilla, unidad y salsas extra; notas, nombre, dirección o pago no
 * cuentan), es ESE pedido repetido por el modelo y no se crea otro (cobro doble al crear). Devuelve el id del pedido ya
 * creado o null. El núcleo lo aplica en voz (rechazoOtroPedidoEnTurnoVoz) y en WhatsApp vía cambioNoAplicadoEnTurno
 * (compararCobro «igual»). Pura.
 */
export function pedidoConElMismoCobro(creados: ReadonlyArray<{ readonly id: string; readonly args: Record<string, unknown> }>, input: Record<string, unknown>): string | null {
  const huella = huellaCobro(input);
  return creados.find((p) => huellaCobro(p.args) === huella)?.id ?? null;
}

// ---------------------------------------------------------------- Clasificadores de alto riesgo del pago

/**
 * Política de PM: NO se aceptan transferencias ni depósitos (solo efectivo o tarjeta con terminal). Solo cuando el cliente
 * dice que YA transfirió, YA pagó por la app / banca / SPEI o manda el comprobante se pasa a una persona
 * (alto_riesgo:transferencia_realizada). Revisión 75 (R75-5): «ya les mandé el pago por transferencia», «ya pagué por la app»,
 * «mandé el dinero a la cuenta». Revisión 76 (R76-7) / 77 (R77-3): no cuentan si la evidencia PEGADA al pago dice que fue al
 * repartidor, en efectivo, con tarjeta / terminal, por Uber / Rappi / DiDi, o de otra cosa (la luz, la renta…); tampoco en
 * pregunta. Sobre el texto original (con acentos), sin mayúsculas.
 */
export const PATRON_TRANSFERENCIA_REALIZADA =
  /\b(?:ya|acabo\s+de)\s+(?:te\s+|les\s+|le\s+)?(?:transfer[ií]|transferir|deposit[eé]|depositar|pagu[eé]\s+(?:por|con|mediante|v[ií]a)\s+(?:transferencia|dep[oó]sito))(?![a-záéíóúñ])|\bhice\s+(?:la|el|una|un|mi)\s+(?:transferencia|dep[oó]sito)|\b(?:te|les|le)\s+(?:mando|env[ií]o|envi[eé]|mand[eé]|paso|pas[eé]|adjunto)\s+(?:aqu[ií]\s+)?(?:el\s+|mi\s+|la\s+|un\s+)?(?:comprobante|captura\s+(?:de|del)\s+(?:pago|transferencia|dep[oó]sito))|\bya\s+(?:te\s+|les\s+|lo\s+)?(?:mand[eé]|envi[eé]|pas[eé])\s+(?:el\s+|mi\s+)?comprobante|\b(?:aqu[ií]\s+(?:est[aá]|va|tienes)|adjunto|este\s+es|ah[ií]\s+va)\s+(?:el\s+|mi\s+)?comprobante|\bya\s+(?:te\s+|les\s+|le\s+)?(?:mand[eé]|envi[eé]|hice|realic[eé]|pas[eé])\s+(?:el|mi|la|un|una)\s+(?:pago|dep[oó]sito|transferencia|dinero)\b(?!\s+(?:(?:al|a\s+(?:el|la|su|tu|un))\s+(?:repartidor|chofer|motorizado|repa)\b|(?:en|con)\s+(?:(?:la|una|mi|su)\s+)?(?:efectivo|tarjeta|terminal)\b|(?:por|en|con|desde|de|v[ií]a)\s+(?:(?:la\s+)?(?:app|aplicaci[oó]n)\s+(?:de\s+)?)?(?:uber|rappi|didi)\b|(?:de|del)\s+(?:(?:la|el|mi|los|las)\s+)?(?:luz|agua|renta|gas|tel[eé]fono|celular|internet|cable|colegiatura|predial|tenencia|recibo|tarjeta|cr[eé]dito|pr[eé]stamo)\b))(?![^?¿]*\?)|\bya\s+pagu[eé]\s+(?:por|con|en|desde|mediante|v[ií]a)\s+(?:la\s+|el\s+)?(?:app|aplicaci[oó]n|banca|banco|transferencia|spei|dep[oó]sito)\b(?!\s+(?:(?:al|a\s+(?:el|la|su|tu|un))\s+(?:repartidor|chofer|motorizado|repa)\b|(?:en|con)\s+(?:(?:la|una|mi|su)\s+)?(?:efectivo|tarjeta|terminal)\b|(?:por|en|con|desde|de|v[ií]a)\s+(?:(?:la\s+)?(?:app|aplicaci[oó]n)\s+(?:de\s+)?)?(?:uber|rappi|didi)\b|(?:de|del)\s+(?:(?:la|el|mi|los|las)\s+)?(?:luz|agua|renta|gas|tel[eé]fono|celular|internet|cable|colegiatura|predial|tenencia|recibo|tarjeta|cr[eé]dito|pr[eé]stamo)\b))(?![^?¿]*\?)|(?<![¿?][^.!]*)\b(?:ya\s+)?(?:te\s+|les\s+|le\s+)?(?:mand[eé]|envi[eé]|transfer[ií]|deposit[eé])\s+(?:el|la|mi)\s+(?:dinero|lana|pago|feria)\s+(?:a|en)\s+(?:la|su|tu)\s+cuenta\b(?!\s+(?:(?:al|a\s+(?:el|la|su|tu|un))\s+(?:repartidor|chofer|motorizado|repa)\b|(?:en|con)\s+(?:(?:la|una|mi|su)\s+)?(?:efectivo|tarjeta|terminal)\b|(?:por|en|con|desde|de|v[ií]a)\s+(?:(?:la\s+)?(?:app|aplicaci[oó]n)\s+(?:de\s+)?)?(?:uber|rappi|didi)\b|(?:de|del)\s+(?:(?:la|el|mi|los|las)\s+)?(?:luz|agua|renta|gas|tel[eé]fono|celular|internet|cable|colegiatura|predial|tenencia|recibo|tarjeta|cr[eé]dito|pr[eé]stamo)\b))(?![^?¿]*\?)/i;
export const TRANSFERENCIA_REALIZADA_REPLY =
  "Gracias por avisar. Ya le pasé su mensaje a la sucursal para que una persona revise su pago y le confirme lo antes posible.";

/** ¿El cliente dice que YA transfirió / depositó / mandó el comprobante? (transferencia_realizada del núcleo). Pura. */
export function esTransferenciaRealizada(texto: string): boolean {
  return PATRON_TRANSFERENCIA_REALIZADA.test(String(texto ?? ""));
}

/** Cobro duplicado ya ocurrido («me cobraron dos veces», «cobro duplicado»). Sobre el texto original, sin mayúsculas. */
export const PATRON_COBRO_DUPLICADO =
  /cobr(?:o|aron|é)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces/i;
export const COBRO_DUPLICADO_REPLY =
  "Lamento el problema con el cobro; ya avisé al equipo para que revise su caso directamente y lo contacte lo antes posible.";

/** ¿El cliente reclama un cobro duplicado? (cobro_duplicado del núcleo). Pura. */
export function esCobroDuplicado(texto: string): boolean {
  return PATRON_COBRO_DUPLICADO.test(String(texto ?? ""));
}

/**
 * Revisión PR #21 ronda 4 / C3 ESC-06 r5: con un aviso alto_riesgo:cobro_duplicado ABIERTO (`razonAbierta`), ¿el aviso nuevo
 * (`razonNueva`, `mensaje`) es el MISMO reclamo y se anexa a él en vez de abrir otro? Solo si el motivo nuevo no es de alto
 * riesgo, es de cobro y el mensaje no trae nada fuera del mismo cobro (esElMismoCobroDuplicado). La rama del cobro doble de
 * buscarAvisoAbierto del núcleo (la lectura de la base la hace quien llama). Pura.
 */
export function cobroDuplicadoAbiertoCubre(razonAbierta: string, razonNueva: string, mensaje: string | null): boolean {
  const previa = normAviso(razonAbierta);
  const nueva = normAviso(razonNueva);
  if (!nueva || previa !== "alto_riesgo:cobro_duplicado" || nueva.startsWith("alto_riesgo:")) return false;
  return esElMismoCobroDuplicado(nueva, normAviso(mensaje));
}
