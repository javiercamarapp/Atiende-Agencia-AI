// GUARDIA DEL TEXTO FINAL (bloque 3 del port del cerebro «suelto», wt-suelto-voz e69279e). Port puro de lo que el núcleo
// (whatsapp-agent-core.ts, runAgentTurn) hace con el texto del modelo cuando el turno termina sin herramientas:
//  - R81-G / R84-1 / R85: textoVerazSobreElPedido: sin pedido creado y con crear_pedido rechazado, el texto lo decide la CLASE
//    del último rechazo, no lo que afirma el modelo (la respuesta «armada por el servidor»: textoDelServidorTrasRechazo);
//  - R82-4: con pedido creado, el texto no puede decir que el pedido falló (FALLO_DEL_PEDIDO_AFIRMADO → providerFailureReply);
//  - R87-T / R88-4 / R89-2: con el pedido por aprobar, el texto no puede decir que ya va (afirmaPedidoPorAprobarEnMarcha);
//  - C3 1939849 ROB-10 (fc5797c, e69279e): no se promete un producto que ninguna herramienta devolvió y que no está en el menú
//    (promesaDeProductoSinBuscar; el menú lo consulta quien llama y pasa el resultado en el contexto).
// guardiaTextoFinal compone las cuatro. Sin red, sin base, sin reloj.
import { normAviso, plegarBusqueda, textosDelCliente, esMarcadorSesion, type MensajeHilo } from "./texto-plano.ts";
import {
  MARCA_CAMBIO_YA_AVISADO,
  PREGUNTA_PEDIDO_APARTE,
  PREGUNTA_PEDIDO_APARTE_OTRA_DIRECCION,
  type ClaseRechazo,
} from "./pedido-aparte.ts";

/** Marca (dentro del rechazo por alergia sin confirmar) del núcleo. */
const MARCA_RECHAZO_ALERGIA = "Por su seguridad, el pedido espera a que una persona de la sucursal le confirme lo de la alergia.";

/** Revisión 81 (R81-G): el error genérico de una herramienta (no es un rechazo de validación). */
export const ERROR_INTERNO_HERRAMIENTA = "Error interno al ejecutar la herramienta";
/** Revisión 81 (R81-G): motivo del aviso a la sucursal cuando un pedido no se pudo registrar por un error del sistema. */
export const MOTIVO_PEDIDO_NO_REGISTRADO = "operativo:pedido_no_registrado";
/**
 * Revisión 81 (R81-G): el texto dice que el pedido NO se pudo registrar (texto sin acentos y en minúsculas). Revisión 82
 * (R82-4): que el PEDIDO falló («su pedido no se pudo registrar», «no quedó su pedido»), no otra cosa («no pude registrar
 * la factura»).
 */
const FALLO_DEL_PEDIDO_AFIRMADO =
  /\bno\s+(?:se\s+)?(?:pudo|pude|pudimos|logre|se\s+logro)\s+(?:registrar|crear|levantar|tomar|procesar)(?:\s+(?:bien|correctamente))?\s+(?:su|tu|el)\s+(?:pedido|orden)|\b(?:su|tu|el)\s+(?:pedido|orden)\s+no\s+(?:se\s+)?(?:pudo|pude|pudimos|logro|quedo|registro|creo|fue\s+registrad)|\bno\s+quedo\s+(?:registrad[oa]\s+)?(?:su|tu|el)\s+(?:pedido|orden)|\b(?:could\s*n\W?t|could\s+not|was\s*n\W?t\s+able\s+to|failed\s+to|unable\s+to)\s+(?:register|place|create|process)\s+(?:your|the)\s+order|\b(?:your|the)\s+order\s+(?:could\s*n\W?t|could\s+not|was\s*n\W?t|was\s+not|did\s*n\W?t|did\s+not)\s+(?:be\s+)?(?:registered|placed|created|go\s+through)/;
/**
 * Revisión 83 (R83-1): afirmaciones PERFECTIVAS de que el pedido ya quedó («quedó registrado», «ya quedó», «se registró»,
 * «registré su pedido», «segundo pedido registrado», «su pedido llega en…», «your order is placed»). Texto sin acentos y en
 * minúsculas; cada coincidencia se revisa con su contexto en afirmaPedidoRegistradoPerfectivo.
 */
const AFIRMACIONES_PERFECTIVAS: RegExp[] = [
  /\bqued(?:o|aron)\s+(?:ya\s+)?(?:(?:su|tu|el|la)\s+(?:segundo\s+|nuevo\s+|otro\s+)?(?:pedido|orden)\s+)?(?:registrad|confirmad|levantad|programad|agendad|tomad|list[oa]\b|hech[oa]\b|en\s+cocina)/g,
  /\bya\s+qued(?:o|aron)\b/g,
  /\bqued(?:o|aron)\s+(?:su|tu|el)\s+(?:segundo\s+|nuevo\s+|otro\s+)?(?:pedido|orden)\b/g,
  /\bse\s+(?:ha\s+|han\s+)?(?:registr|confirm|levant|cre|program|agend)(?:o|aron|ado|ada)\b/g,
  /\b(?:pedido|orden)\s+(?:ya\s+)?(?:esta|fue|ha\s+sido)\s+(?:ya\s+)?(?:registrad|confirmad|levantad|programad|en\s+camino|en\s+cocina|en\s+preparacion)/g,
  /\b(?:pedido|orden)\s+(?:ya\s+)?(?:registrad|confirmad|levantad)[oa]\b/g,
  /\b(?:pedido|orden)\s+(?:ya\s+)?(?:va\s+en\s+camino|sale\s+en|llega\s+en|se\s+mando\s+a\s+cocina)/g,
  /(?:^|[.!;,:¡]\s*)(?:ya\s+)?(?:quedo\s+)?registrad[oa]\b/g,
  /(?:^|[.!;,:¡]\s*)(?:ya\s+)?(?:quedo\s+)?confirmad[oa]\s*(?:[.!]|$)/g,
  /\b(?:ya\s+)?(?:(?:se\s+)?l[oa]\s+)?(?:registre|levante|programe|agende)\s+(?:su|tu|el)\s+(?:segundo\s+|nuevo\s+|otro\s+)?(?:pedido|orden)\b/g,
  /\bya\s+l[oa]\s+(?:registre|levante|programe|agende)\b/g,
  /\b(?:order|it)\s+(?:has\s+(?:now\s+)?been|have\s+been|is(?:\s+now)?|was|'s)\s+(?:successfully\s+)?(?:placed|registered|confirmed|submitted|on\s+its\s+way|in\s+the\s+kitchen)/g,
  /\bi(?:'ve|\s+have)?\s+(?:just\s+)?(?:placed|registered|submitted)\s+(?:your|the)\s+(?:\w+\s+)?order/g,
  /\byou'?re\s+all\s+set\b/g,
];
/** Revisión 83 (R83-1): la negación pegada a la afirmación (hasta dos palabras antes, en la misma cláusula). */
const NEGACION_PEGADA = /\b(?:no|ni|nunca|tampoco|todavia|aun|not|never)(?:\s+\S+){0,2}\s*$/;
/** Revisión 83 (R83-1): lo que quedó es otra cosa o un pedido que ya existía (sujeto de la cláusula). */
const SUJETO_OTRA_COSA =
  /\b(?:aviso|solicitud|reporte|reclamo|queja|cancelacion|cambio|direccion|nota|comentario|pago|alergia|factura|anterior|previo|primer|first|previous|earlier|request|note|address|change|complaint|payment)\b/;
/** Revisión 83 (R83-1): la oración pide el dato que falta en infinitivo o condicional («para dejar registrado…», «en cuanto…»). */
const ORACION_CONDICIONAL =
  /\bpara\s+(?:dejar|que|poder|registrar|confirmar|levantar|tomar|terminar|completar)\b|\bantes\s+de\b|\ben\s+cuanto\b|\buna\s+vez\s+que\b|\bcuando\b|\b(?:puedo|podemos|podria|podriamos|pueda)\b|\bfalta\b|\bnecesit\w*|\b(?:quiere|desea|gusta)\s+que\b|\bin\s+order\s+to\b|\bto\s+(?:place|register|confirm)\b|\bonce\b|\bas\s+soon\s+as\b|\bbefore\b|\bif\b|\bcan\s+i\b/;

/**
 * Revisión 83 (R83-1): el texto afirma en perfectivo que el pedido quedó. Cada coincidencia cuenta salvo que la niegue lo que
 * va pegado antes («todavía no quedó»), su sujeto sea otra cosa («su aviso quedó registrado», «su pedido anterior») o la
 * oración sea infinitiva o condicional («para dejar registrado…», «en cuanto me confirme…», «si…»). La pregunta o el «le aviso
 * cuando salga» en otra parte del texto no la apagan. Pura.
 */
export function afirmaPedidoRegistradoPerfectivo(texto: string): boolean {
  const base = String(texto ?? "").normalize("NFC").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
  // Misma longitud que `base` (un carácter por carácter) para leer el «si» (condicional, sin acento) en el original.
  const n = base.split("").map((ch) => {
    const m = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return m.length === 1 ? m : m.length ? m[0] : " ";
  }).join("");
  for (const patron of AFIRMACIONES_PERFECTIVAS) {
    patron.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = patron.exec(n)) !== null) {
      // El inicio real de la afirmación (sin la puntuación que algunos patrones toman antes).
      const inicio = m.index + (/^[.!;,:¡\s]*/.exec(m[0])?.[0].length ?? 0);
      const antes = n.slice(0, inicio);
      const clausula = antes.slice(Math.max(...[".", ";", "!", "?", "¿", "¡", ":", ",", "\n"].map((p) => antes.lastIndexOf(p))) + 1);
      const corte = Math.max(...[".", ";", "!", "?", "¿", "¡", "\n"].map((p) => antes.lastIndexOf(p))) + 1;
      const oracion = antes.slice(corte);
      const oracionBase = base.slice(corte, inicio);
      if (NEGACION_PEGADA.test(clausula) || SUJETO_OTRA_COSA.test(clausula)) continue;
      if (ORACION_CONDICIONAL.test(oracion) || /(?:^|[^\p{L}])si(?![\p{L}])/u.test(oracionBase)) continue;
      return true;
    }
  }
  return false;
}

/** Revisión 84 (R84-1): la pregunta exacta que pide un rechazo («pregúntele exactamente: «…?»»), si la trae. Pura. */
function preguntaDelRechazo(error: string | undefined): string | null {
  return /pregúntele(?: otra vez)?(?: exactamente)?:?\s*«([^»]+\?)»/i.exec(String(error ?? ""))?.[1] ?? null;
}

/**
 * Revisión 81 (R81-G) y 84 (R84-1): sin pedido creado en el turno (`orderId` null) y con crear_pedido rechazado, el texto al
 * cliente se decide por la CLASE del último rechazo, no por lo que afirme el texto del modelo:
 *  - no se creó nada (interno, nada, alergia, cotizar, aparte): lo arma el servidor (textoDelServidorTrasRechazo) y el texto
 *    del modelo no se manda;
 *  - existente: el texto del modelo se queda (lo que diga del pedido registrado es cierto); si viene vacío, la pregunta del
 *    rechazo;
 *  - otro: el texto del modelo se queda salvo que afirme que el pedido quedó (afirmaPedidoRegistradoPerfectivo).
 * `alertar`: hubo un error interno en el turno (aviso a la sucursal). null: el texto del modelo se queda. Pura.
 */
export function textoVerazSobreElPedido(
  texto: string,
  orderId: string | null,
  fallido: CrearPedidoFallido | null,
  contexto: ContextoTextoVeraz = {},
): { texto: string | null; alertar: boolean } {
  const r = textoVerazSinDisculpa(texto, orderId, fallido, contexto);
  // Revisión 85 (R85-7d): la pregunta del pago va con un inicio neutro, salvo que el modelo afirmara que el pedido quedó:
  // entonces se corrige con la disculpa.
  if (r.texto && afirmaPedidoRegistradoPerfectivo(texto)) {
    if (r.texto.startsWith(INICIO_NEUTRO)) r.texto = `Perdón, su pedido todavía no quedó registrado: ${r.texto.slice(INICIO_NEUTRO.length)}`;
    else if (r.texto.startsWith(INICIO_NEUTRO_EN)) r.texto = `Sorry, your order isn't placed yet: ${r.texto.slice(INICIO_NEUTRO_EN.length)}`;
  }
  return r;
}

const INICIO_NEUTRO = "Para registrar su pedido, ";
const INICIO_NEUTRO_EN = "To place your order, ";

function textoVerazSinDisculpa(
  texto: string,
  orderId: string | null,
  fallido: CrearPedidoFallido | null,
  contexto: ContextoTextoVeraz,
): { texto: string | null; alertar: boolean } {
  if (orderId || !fallido) return { texto: null, alertar: false };
  const alertar = fallido.interno;
  const clase = fallido.clase ?? (fallido.interno ? "interno" : "otro");
  // Revisión 85 (R85-1): el rechazo ya se resolvió en el turno (cotizó lo que pide o ubicó la zona): se queda el texto del
  // modelo si no afirma que el pedido quedó y, si hubo cotización, dice su total (el cliente tiene que ver el total antes de
  // que se cree el pedido); si no, el servidor dice el total.
  if (fallido.resuelto === true && (clase === "cotizar" || clase === "nada")) {
    const afirma = afirmaPedidoRegistradoPerfectivo(texto);
    const total = typeof fallido.totalCotizado === "number" ? fallido.totalCotizado : null;
    if (String(texto ?? "").trim() && !afirma && (total === null || mencionaMonto(texto, total))) return { texto: null, alertar };
    if (total !== null) return { texto: textoConElTotal(fallido.pide, total, afirma, contexto), alertar };
    return { texto: motivoDelRechazoParaCliente("", undefined, contexto.enIngles === true), alertar };
  }
  if (clase === "existente") {
    if (String(texto ?? "").trim()) return { texto: null, alertar };
    // Revisión 87 (R87-P): el servidor ya avisó el cambio a la sucursal.
    const avisado = String(fallido.error ?? "").split(MARCA_CAMBIO_YA_AVISADO)[1]?.split(". (El servidor")[0]?.trim();
    if (avisado) {
      return {
        texto: contexto.enIngles === true
          ? `I've passed this change on to the branch (${avisado}); they'll confirm it with you.`
          : `Ya le pasé el cambio a la sucursal (${avisado}); ahí se lo confirman.`,
        alertar,
      };
    }
    // Revisión 85 (R85-5): nunca la pregunta del pedido aparte (un «sí» la tomaría como pedido nuevo); el cambio se ofrece
    // pasar a la sucursal.
    const pregunta = preguntaDelRechazo(fallido.error);
    return {
      texto: pregunta && !/pedido aparte/i.test(pregunta)
        ? pregunta
        : contexto.enIngles === true
        ? CAMBIO_A_LA_SUCURSAL_EN
        : CAMBIO_A_LA_SUCURSAL,
      alertar,
    };
  }
  if (clase === "otro") {
    return {
      texto: afirmaPedidoRegistradoPerfectivo(texto)
        ? conAdicionalAntesDeLaPregunta(
          sinPreguntaFinalSi(
            contexto.sinPregunta === true,
            motivoDelRechazoParaCliente(fallido.error ?? "", fallido.codigo, contexto.enIngles === true),
          ),
          contexto.adicional,
        )
        : null,
      alertar,
    };
  }
  return { texto: textoDelServidorTrasRechazo({ ...fallido, clase }, contexto), alertar };
}

/** Revisión 84 (R84-1) y 85 (R85-3): lo que el texto veraz necesita saber del turno. */
export type ContextoTextoVeraz = {
  enIngles?: boolean;
  sinPregunta?: boolean;
  pedidoEnCurso?: boolean;
  /** Revisión 85 (R85-3): solo hay pedidos abiertos con la cancelación avisada por el cliente. */
  pedidoCancelandose?: boolean;
  horarioHoy?: string | null;
  /** Revisión 85 (R85-2): oraciones del modelo que contestan otra pregunta del cliente (oracionesSecundarias). */
  adicional?: string[];
};

/**
 * Revisión 85 (R85-2): cuando el servidor arma el texto tras un rechazo, las oraciones del modelo que contestan OTRA pregunta
 * del cliente en el turno (cuánto tardan, si aceptan tarjeta, estacionamiento…): solo si el cliente preguntó algo; se quitan
 * las que hablan del pedido, el total, montos, el registro o la confirmación (pueden contradecir el rechazo) y las preguntas
 * (la pregunta la pone el servidor). A lo más dos. Revisión 88 (R88-5): ni las de la entrega (llega, minutos, cocina, comida,
 * repartidor, salió). Pura.
 */
export function oracionesSecundarias(textoModelo: string, textosCliente: string[]): string[] {
  const pregunto = textosCliente.some((t) =>
    /[?¿]/.test(t) ||
    /\b(?:aceptan|tienen|hay|cuanto\s+tardan|a\s+que\s+hora|donde|do\s+you|can\s+i|is\s+there|how\s+long)\b/.test(normAviso(t))
  );
  if (!pregunto) return [];
  return String(textoModelo ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((o) => o.trim())
    .filter((o) =>
      o.split(" ").length >= 3 && !/[?¿]/.test(o) && !/\$|\d+\s*(?:pesos|mxn)/.test(o) &&
      !/pedido|orden\b|order|total|registr|confirm|listo|ready|quedo|placed|minimo|minimum|camino|on its way|cancel/.test(normAviso(o)) &&
      // Revisión 88 (R88-5): tampoco cuándo llega, la cocina, la comida o el repartidor (contradicen un pedido no registrado).
      !/\b(?:llega\w*|lleg[ao]r?|minutos?|min|preparand\w*|cocina|comida|salio|repartidor\w*|arrives?|minutes?|kitchen|preparing|driver)\b/
        .test(normAviso(o))
    )
    .slice(0, 2);
}

/** Revisión 85 (R85-2): agrega oraciones antes de la pregunta final del texto (o al final si no termina en pregunta). Pura. */
function conAdicionalAntesDeLaPregunta(texto: string, adicional: string[] | undefined): string {
  if (!adicional?.length) return texto;
  const extra = adicional.join(" ");
  const m = /\s*(¿[^¿]*\?|[A-Z][^.!?¿]*\?)\s*$/.exec(texto);
  if (!m || m.index === 0) return `${texto} ${extra}`;
  return `${texto.slice(0, m.index)} ${extra} ${m[1]}`;
}

/** Revisión 85 (R85-1): ¿el texto dice el monto («$240», «240.00», «$1,240»)? Pura. */
export function mencionaMonto(texto: string, monto: number): boolean {
  const plano = String(texto ?? "").replace(/(\d),(\d{3})/g, "$1$2");
  const cifra = Number.isInteger(monto) ? String(monto) : monto.toFixed(2);
  return new RegExp(`(?<![\\d.])${cifra.replace(".", "\\.")}(?:\\.0{1,2})?(?!\\d)`).test(plano);
}

/** Revisión 85 (R85-1): el total cotizado dicho por el servidor, con la pregunta para confirmarlo. Pura. */
function textoConElTotal(
  pide: string | undefined,
  total: number,
  afirmaba: boolean,
  contexto: { enIngles?: boolean; pedidoEnCurso?: boolean },
): string {
  const en = contexto.enIngles === true;
  const cifra = `$${Number.isInteger(total) ? total : total.toFixed(2)}`;
  const lo = String(pide ?? "").trim();
  if (en) {
    const que = lo ? `${contexto.pedidoEnCurso ? "What you just asked for" : "What you asked for"} (${lo})` : "Your order";
    return `${afirmaba ? "Sorry, your order isn't placed yet. " : ""}${que} comes to ${cifra} in total. Shall I place it?`;
  }
  const que = lo ? `${contexto.pedidoEnCurso ? "Lo nuevo que me pide" : "Lo que me pide"} (${lo})` : "Su pedido";
  return `${afirmaba ? "Perdón, su pedido todavía no quedó registrado. " : ""}${que} suma ${cifra} en total. ¿Le confirmo su pedido?`;
}

/** Revisión 85 (R85-5): lo pedido toca un pedido registrado y el modelo no dijo nada: se ofrece pasar el cambio. */
export const CAMBIO_A_LA_SUCURSAL = "Su pedido sigue registrado tal como se hizo. ¿Quiere que le pase este cambio a la sucursal?";
export const CAMBIO_A_LA_SUCURSAL_EN = "Your order is still placed as it was. Would you like me to pass this change on to the branch?";

/** Revisión 84 (R84-1): con un pedido en curso del número, lo que no se registró es lo nuevo; el pedido en curso no cambia. */
export const PEDIDO_EN_CURSO_SIGUE = "Su pedido en curso sigue igual.";
export const PEDIDO_EN_CURSO_SIGUE_EN = "Your current order stays the same.";

/** Revisión 85 (R85-4): con la alergia en espera y un pedido en curso, la nota de la alergia ya va en ese pedido. */
export const ALERGIA_EN_PEDIDO_EN_CURSO =
  "A su pedido en curso le agregamos la nota de su alergia y la sucursal se la confirma.";
export const ALERGIA_EN_PEDIDO_EN_CURSO_EN =
  "We added your allergy note to your current order and the branch will confirm it with you.";

/** Revisión 84 (R84-1): la pregunta del pedido aparte en inglés (con la exacta en español, que busca el camino rápido). */
function preguntaAparteParaCliente(pregunta: string, enIngles: boolean): string {
  if (!enIngles) return pregunta;
  const en = pregunta === PREGUNTA_PEDIDO_APARTE_OTRA_DIRECCION ? "Is this a separate order for another address?" : "Would you like a separate order?";
  return `${en} (${pregunta})`;
}

/**
 * Revisión 84 (R84-1): el texto al cliente tras un rechazo de «no se creó nada», armado del rechazo: el motivo cierto y la
 * pregunta que pide (sin la pregunta si al final va la de cancelar). Con un pedido en curso del número (`pedidoEnCurso`) no
 * dice que «su pedido» no quedó: habla de lo nuevo («Lo nuevo que me pide (…) todavía no lo pude registrar: <motivo>. Su
 * pedido en curso sigue igual.»). La pregunta del pedido aparte va exacta (el camino rápido del «sí» la busca). Pura.
 */
export function textoDelServidorTrasRechazo(
  f: CrearPedidoFallido,
  contexto: ContextoTextoVeraz = {},
): string {
  const en = contexto.enIngles === true;
  const sinPregunta = contexto.sinPregunta === true;
  const pide = String(f.pide ?? "").trim();
  const loNuevo = en ? `What you just asked for${pide ? ` (${pide})` : ""}` : `Lo nuevo que me pide${pide ? ` (${pide})` : ""}`;
  const arma = (motivo: string, pregunta: string, cola = "", enCurso = en ? PEDIDO_EN_CURSO_SIGUE_EN : PEDIDO_EN_CURSO_SIGUE) => {
    // El horario de hoy si el cliente lo preguntó en el turno (el texto del modelo que lo contestaba no se manda).
    const horario = contexto.horarioHoy && !/horario|hours/.test(motivo)
      ? en ? `Today's hours are ${horarioEnIngles(contexto.horarioHoy)}.` : `Nuestro horario de hoy es de ${contexto.horarioHoy}.`
      : "";
    const resto = [cola, horario, ...(contexto.adicional ?? []), sinPregunta ? "" : pregunta].filter(Boolean).join(" ");
    const fin = resto ? ` ${resto}` : "";
    if (contexto.pedidoCancelandose && !contexto.pedidoEnCurso) {
      const deLoNuevo = motivo.replace(" y el suyo suma ", " y lo nuevo suma ").replace(" and yours comes to ", " and the new items come to ");
      return en ? `${loNuevo} isn't placed yet: ${deLoNuevo}.${fin}` : `${loNuevo} todavía no lo pude registrar: ${deLoNuevo}.${fin}`;
    }
    if (contexto.pedidoEnCurso) {
      // Lo que suma es lo nuevo, no «el suyo» (su pedido en curso).
      const deLoNuevo = motivo.replace(" y el suyo suma ", " y lo nuevo suma ").replace(" and yours comes to ", " and the new items come to ");
      return en
        ? `${loNuevo} isn't placed yet: ${deLoNuevo}. ${enCurso}${fin}`
        : `${loNuevo} todavía no lo pude registrar: ${deLoNuevo}. ${enCurso}${fin}`;
    }
    return conMotivoDelRechazo(en, motivo, resto);
  };
  switch (f.clase) {
    case "interno":
      if (!contexto.pedidoEnCurso) {
        return conAdicionalAntesDeLaPregunta(en ? PEDIDO_NO_REGISTRADO_INTERNO_EN : PEDIDO_NO_REGISTRADO_INTERNO, contexto.adicional);
      }
      return arma(
        en
          ? "because of a technical problem; I've already notified the branch so they can contact you"
          : "por un problema técnico; ya avisé a la sucursal para que le contacte",
        "",
      );
    case "alergia": {
      const tel = String(f.sucursal?.phone ?? "").trim();
      const nombre = String(f.sucursal?.name ?? "").trim();
      const llamar = !tel
        ? ""
        : en
        ? ` If you'd rather not wait, you can call the${nombre ? ` ${nombre}` : ""} branch at ${tel}.`
        : ` Si prefiere no esperar, puede llamar a la sucursal${nombre ? ` ${nombre}` : ""} al ${tel}.`;
      return arma(
        en
          ? "for your safety, the order waits until a person from the branch confirms your allergy with you"
          : `${MARCA_RECHAZO_ALERGIA.charAt(0).toLowerCase()}${MARCA_RECHAZO_ALERGIA.slice(1).replace(/\.$/, "")}`,
        "",
        (en
          ? "The branch already has your notice; as soon as they confirm, we'll take your order."
          : "La sucursal ya tiene su aviso; en cuanto le confirme, tomamos su pedido.") + llamar,
        // Revisión 85 (R85-4): al pedido en curso se le agregó la nota de la alergia (no «sigue igual»).
        en ? ALERGIA_EN_PEDIDO_EN_CURSO_EN : ALERGIA_EN_PEDIDO_EN_CURSO,
      );
    }
    case "cotizar":
      return arma(
        en ? "I first need to confirm its total with you" : "antes de registrarlo tengo que confirmarle el total",
        en ? "Shall I give you the total so you can confirm it?" : "¿Le paso el total para que me lo confirme?",
      );
    case "aparte":
      if (sinPregunta) return en ? `${loNuevo} isn't placed yet.` : `${loNuevo} todavía no lo registro.`;
      return [...(contexto.adicional ?? []), preguntaAparteParaCliente(f.pregunta ?? PREGUNTA_PEDIDO_APARTE, en)].join(" ");
    default: {
      const r = razonDelRechazo(f.error ?? "", f.codigo, en, { abreMasTardeHoy: f.abreMasTardeHoy === true });
      return r
        ? arma(r.motivo, r.pregunta)
        : conAdicionalAntesDeLaPregunta(sinPreguntaFinalSi(sinPregunta, motivoDelRechazoParaCliente(f.error ?? "", f.codigo, en)), contexto.adicional);
    }
  }
}

/** Índice del primer mensaje de la sesión actual (después del último marcador). Pura. */
function inicioDeLaSesion(messages: readonly MensajeHilo[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (esMarcadorSesion(messages[i])) return i + 1;
  return 0;
}

/** Revisión 84 (R84-1): el cliente pregunta en el turno a qué hora abren o cierran (o el horario). Pura. */
function preguntaPorElHorario(textos: string[]): boolean {
  const n = normAviso(textos.join(" "));
  return /\b(?:a\s+que\s+hora\s+(?:cierr|abr)\w*|hasta\s+que\s+hora|horarios?\b|what\s+time\s+(?:do|does|are)\s+(?:you|they|it)\s+(?:close|open)|opening\s+hours|(?:when|what\s+time)\s+do\s+you\s+close)/.test(n);
}

/** Revisión 84 (R84-1): el horario de hoy de la sucursal que devolvió la última herramienta de la sesión que lo trae. Pura. */
function horarioDeHoyEnLaSesion(messages: readonly MensajeHilo[]): string | null {
  for (let i = messages.length - 1; i >= inicioDeLaSesion(messages); i--) {
    const m = messages[i];
    if (m?.role !== "tool" || typeof m.content !== "string" || !m.content.includes("horario_hoy")) continue;
    try {
      const h = JSON.parse(m.content)?.politica?.horario_hoy;
      if (typeof h === "string" && h.trim()) return h.trim();
    } catch { /* contenido ilegible */ }
  }
  return null;
}

/** Revisión 87 (R87-T): el texto afirma que el pedido ya va (confirmado, aprobado, en cocina, en camino, llega en …). */
const AFIRMA_PEDIDO_EN_MARCHA =
  /\b(?:confirmad[oa]|aprobad[oa]|en\s+cocina|a\s+cocina|ya\s+(?:lo\s+)?(?:estan\s+)?preparand\w*|en\s+preparacion|en\s+camino|ya\s+salio|llega(?:ra|n)?\s+en|en\s+\d+\s*(?:a\s+\d+\s*)?min\w*|confirmed|approved|on\s+its\s+way|arrives?\s+in)\b/;
/**
 * Revisión 88 (R88-4) / 89 (R89-2): ¿el texto afirma que el pedido por aprobar ya va (AFIRMA_PEDIDO_EN_MARCHA)? Se ve por
 * cláusula (se corta en «.», «;», «?», «¿» y en «y» antes de un verbo): una cláusula que lo afirma cuenta aunque otra pregunte
 * o acuse un cambio. No cuentan la cláusula que acusa el cambio («ya avisé…»), la negada o futura («aún no está confirmado»,
 * «quedará confirmado cuando la sucursal lo apruebe»), la de una cotización que no nombra el pedido («Son $60… Lo tiene listo
 * en 15 min. ¿Le confirmo?») ni, solo si en el turno se creó otro pedido (`otroPedidoCreado`), la que habla de ese otro. Pura.
 */
export function afirmaPedidoPorAprobarEnMarcha(texto: string, opciones: { otroPedidoCreado?: boolean } = {}): boolean {
  const plano = normAviso(texto);
  const cotizacion = /\$\s*\d/.test(plano) && /¿[^?]*\bconfirm|\b(?:shall|should)\s+i\s+confirm/.test(plano);
  const NOMBRA_EL_PEDIDO = /\b(?:su|el|tu|este|ese)\s+(?:pedido|orden)\b|\byour\s+order\b/;
  const OTRO_PEDIDO = /\b(?:otro|segundo|nuevo)\s+pedido\b|\bpedido\s+(?:aparte|nuevo)\b|\b(?:other|second|new)\s+order\b/;
  return plano.split(/[.;!?¿¡\n]+/).some((oracion) =>
    !(opciones.otroPedidoCreado && OTRO_PEDIDO.test(oracion)) &&
    oracion.split(/\s+y\s+(?=(?:su|el|tu|ya|lo|la|le|se|llega\w*|esta\w*|va|van|sale|salio|quedo|queda)\b)/).some((o) =>
      AFIRMA_PEDIDO_EN_MARCHA.test(o) &&
      !/\bya\s+(?:le\s+)?(?:avise|pase|notifique|comunique)\b|\bi(?:'ve|\s+have)\s+(?:notified|let|told)\b/.test(o) &&
      !/\b(?:no|aun\s+no|todavia\s+no|sin|hasta\s+que|cuando|en\s+cuanto|una\s+vez\s+que|apenas|not|once|until)\b/.test(o) &&
      !/\b(?:quedara|sera|estara|will\s+be)\b/.test(o) &&
      !(cotizacion && !NOMBRA_EL_PEDIDO.test(o))
    )
  );
}
/**
 * Revisión 89 (R89-2): del texto que se reemplaza por el de por aprobar, las oraciones que solo acusan un cambio («Ya avisé a
 * la sucursal;») se conservan delante, para que el cliente sepa que su cambio se avisó. Pura.
 */
export function acuseAntesDePorAprobar(texto: string): string {
  const ACUSE = /\bya\s+(?:le\s+)?(?:avise|pase|notifique|comunique)\b|\bi(?:'ve|\s+have)\s+(?:notified|let|told)\b/;
  return String(texto ?? "").split(/(?<=[.;!?])\s+/)
    .filter((o) => ACUSE.test(normAviso(o)) && !AFIRMA_PEDIDO_EN_MARCHA.test(normAviso(o)) && !/[¿?]/.test(o))
    .map((o) => o.trim().replace(/[;,:]$/, "."))
    .map((o) => (/[.!]$/.test(o) ? o : `${o}.`))
    .join(" ");
}
/** Revisión 87 (R87-T): lo que se dice de un pedido grande que la sucursal aún no aprueba. */
export const PEDIDO_POR_APROBAR_REPLY =
  "Su pedido quedó registrado; por ser un pedido grande, la sucursal lo revisa y se lo confirma enseguida. Todavía no tiene tiempo de entrega.";
export const PEDIDO_POR_APROBAR_REPLY_EN =
  "Your order is placed; since it's a large order, the branch reviews it and will confirm it shortly. There's no delivery time yet.";

/** Revisión 82 (R82-2): quita la pregunta final del texto veraz cuando otra pregunta (la de cancelar) va al final. Pura. */
function sinPreguntaFinalSi(quitar: boolean, texto: string): string {
  if (!quitar) return texto;
  const sin = texto.replace(/\s*(?:¿[^¿?]*\?|[A-Z][^.!?¿]*\?)\s*$/, "").trim();
  return /[.!:;]$/.test(sin) ? sin.replace(/:$/, ".") : `${sin}.`;
}
/**
 * Revisión 82 (R82-2): crear_pedido que falló o se rechazó en el turno, con el último motivo (y su código) del rechazo.
 * Revisión 84 (R84-1): con la clase del ÚLTIMO rechazo (ClaseRechazo) y lo que pedía esa llamada.
 */
export type CrearPedidoFallido = {
  /** Hubo un error interno en algún crear_pedido del turno (se avisa a la sucursal). */
  interno: boolean;
  error?: string;
  codigo?: string;
  /** Revisión 84 (R84-1): qué dice el último rechazo. */
  clase?: ClaseRechazo;
  /** Revisión 84 (R84-1): lo que pedía el crear_pedido rechazado («1 × Coca-Cola 600 ml»). */
  pide?: string;
  /** Revisión 84 (R84-1): la pregunta exacta del pedido aparte (clase "aparte"). */
  pregunta?: string;
  /** Revisión 84 (R84-1): la sucursal (nombre y teléfono) para la alergia en espera. */
  sucursal?: { name?: string | null; phone?: string | null } | null;
  /** Revisión 83 (R83-2): huella (huellaPedido) del último crear_pedido con error interno, para el aviso a la sucursal. */
  huella?: string;
  /** Revisión 83 (R83-6): la sucursal está cerrada y hoy abre más tarde (se puede ofrecer programar). */
  abreMasTardeHoy?: boolean;
  /**
   * Revisión 85 (R85-1): la herramienta que resuelve este rechazo dentro del mismo turno (cotizar antes: cotizar_pedido;
   * falta ubicar la zona: buscar_sucursal_cercana). null: solo otro crear_pedido.
   */
  resuelveCon?: "cotizar_pedido" | "buscar_sucursal_cercana" | null;
  /** Revisión 85 (R85-1): después del rechazo, el modelo llamó con éxito a la herramienta que lo resuelve. */
  resuelto?: boolean;
  /** Revisión 85 (R85-1): el total de la última cotizar_pedido exitosa después del rechazo. */
  totalCotizado?: number | null;
};
/** Revisión 82 (R82-2): el pedido no se registró por un error del sistema (ya se avisó a la sucursal). */
export const PEDIDO_NO_REGISTRADO_INTERNO =
  "No pude registrar su pedido por un problema técnico; ya avisé a la sucursal para que le contacte.";
export const PEDIDO_NO_REGISTRADO_INTERNO_EN =
  "I couldn't place your order because of a technical problem; I've already notified the branch so they can contact you.";

/** Revisión 84 (R84-5): un horario («8:00 am a 11:00 pm y …») dicho en inglés («8:00 am to 11:00 pm and …»). Pura. */
function horarioEnIngles(horario: string): string {
  return horario.replace(/\s+a\s+/g, " to ").replace(/\s+y\s+/g, " and ");
}

/** Revisión 85 (R85-7): el motivo «falta saber con cuánto paga» (lleva un inicio neutro, no «Perdón…»). */
const MOTIVO_FALTA_PAGO = "me falta saber con cuánto va a pagar";
const MOTIVO_FALTA_PAGO_EN = "I still need to know how much cash you'll pay with";

/** Revisión 84 (R84-1): «Perdón, su pedido todavía no quedó registrado: <motivo>. <resto>» (o en inglés). Pura. */
function conMotivoDelRechazo(enIngles: boolean, motivo: string, resto: string): string {
  const fin = resto ? ` ${resto}` : "";
  // Revisión 85 (R85-7): la pregunta normal del pago no es una disculpa: «Para registrar su pedido, me falta saber…».
  if (motivo === MOTIVO_FALTA_PAGO) return `${INICIO_NEUTRO}${motivo}.${fin}`;
  if (motivo === MOTIVO_FALTA_PAGO_EN) return `${INICIO_NEUTRO_EN}${motivo}.${fin}`;
  return enIngles ? `Sorry, your order isn't placed yet: ${motivo}.${fin}` : `Perdón, su pedido todavía no quedó registrado: ${motivo}.${fin}`;
}

/**
 * Revisión 82 (R82-2) y 84 (R84-1): la razón real de un rechazo de «no se creó nada» de crear_pedido (mínimo, zona, alcohol,
 * sucursal cerrada, hora programada o de recoger, sin domicilio, pago, billete, alergia), separada en el motivo y la pregunta
 * (o la frase) que sigue. Se lee el texto del rechazo, que escribe el servidor (un conjunto cerrado). null: no se reconoce.
 * En inglés si el cliente escribe en inglés. Pura.
 */
export function razonDelRechazo(
  error: string,
  codigo: string | undefined,
  enIngles: boolean,
  extra: { abreMasTardeHoy?: boolean } = {},
): { motivo: string; pregunta: string } | null {
  const n = normAviso(error);
  const r = (motivoEn: string, preguntaEn: string, motivoEs: string, preguntaEs: string) =>
    enIngles ? { motivo: motivoEn, pregunta: preguntaEn } : { motivo: motivoEs, pregunta: preguntaEs };
  const temprano = /lo mas temprano es ([0-9:]+\s*(?:am|pm)?)/.exec(n)?.[1];
  const minimo = /pedido minimo a domicilio es de \$?([\d.,]*\d)(?: y este suma \$?([\d.,]*\d))?/.exec(n);
  if (minimo) {
    const [, m, suma] = minimo;
    return r(
      `the minimum for delivery is $${m}${suma ? ` and yours comes to $${suma}` : ""}`,
      "Would you like to add something else or pick it up at the branch?",
      `el pedido mínimo a domicilio es de $${m}${suma ? ` y el suyo suma $${suma}` : ""}`,
      "¿Desea agregar algo más o prefiere pasar a recoger?",
    );
  }
  if (codigo === "fuera_de_zona" || /^fuera de zona/.test(n)) {
    // Revisión 85 (R85-2): con la otra opción que pide el rechazo (otra sucursal que le quede dentro de la zona).
    return r(
      "your address is outside the branch's delivery area",
      "Would you like to pick it up at the nearest branch, or order from another branch whose delivery area covers your address?",
      "su dirección queda fuera de la zona de entrega a domicilio",
      "¿Prefiere pasar a recoger a la sucursal más cercana o pedirlo a otra sucursal que sí le quede dentro de la zona de entrega?",
    );
  }
  if (/no se puede comprobar que esa direccion quede dentro/.test(n)) {
    // Revisión 85 (R85-2): con el nombre de la sucursal más cercana a su colonia, que el rechazo pide ofrecer.
    const cercana = /la más cercana a su colonia es «([^»]+)»/.exec(error)?.[1]?.trim();
    const nombre = cercana ? cercana.replace(/[-_]+/g, " ").replace(/(^|\s)(\p{L})/gu, (_m, e, l) => `${e}${l.toUpperCase()}`) : "";
    return r(
      "I couldn't confirm that your address is within the branch's delivery area",
      nombre
        ? `Would you like to order from the ${nombre} branch, the nearest to your neighborhood, or pick it up?`
        : "Would you like to pick it up at the branch instead?",
      "no pude comprobar que su dirección quede dentro de la zona de entrega",
      nombre
        ? `¿Prefiere pedirlo a la sucursal ${nombre}, la más cercana a su colonia, o pasar a recoger?`
        : "¿Prefiere pasar a recoger a la sucursal?",
    );
  }
  if (/aun no se ha ubicado la zona/.test(n)) {
    return r(
      "I still need to locate your neighborhood",
      "Which neighborhood (colonia) is the delivery to?",
      "me falta ubicar su colonia",
      "¿En qué colonia es la entrega?",
    );
  }
  if (codigo === "alcohol_domicilio" || /alcohol no se vende a domicilio/.test(n)) {
    return r(
      "alcohol is not sold for delivery, only for pickup at the branch",
      "Should I remove it, or would you like to pick up the whole order?",
      "el alcohol no se vende a domicilio, solo para recoger en la sucursal",
      "¿Lo quitamos del pedido o prefiere pasar a recoger?",
    );
  }
  if (/sucursal esta cerrada/.test(n)) {
    const horario = /\(horario de hoy: ([^)]*)\)/.exec(error)?.[1];
    // Revisión 83 (R83-6): programar solo si hoy abre más tarde; si ya cerró por hoy, que escriba cuando esté abierta.
    if (!extra.abreMasTardeHoy) {
      return r(
        `the branch is closed and won't open again today${horario ? ` (today's hours: ${horarioEnIngles(horario)})` : ""}`,
        "We'll gladly take your order when it's open.",
        `la sucursal está cerrada y hoy ya no abre${horario ? ` (horario de hoy: ${horario})` : ""}`,
        "Con gusto le atendemos cuando esté abierta.",
      );
    }
    return r(
      `the branch is closed right now${horario ? ` (today's hours: ${horarioEnIngles(horario)})` : ""}`,
      "Would you like to schedule it for later?",
      `la sucursal está cerrada en este momento${horario ? ` (horario de hoy: ${horario})` : ""}`,
      "¿Desea dejarlo programado para más tarde?",
    );
  }
  // Revisión 83 (R83-6): la hora programada no se puede; se dice la más temprana.
  if (/^esa hora no es posible/.test(n)) {
    // Revisión 85 (R85-7): con la más tarde de hoy si el rechazo la trae.
    const tarde = /para hoy lo mas tarde es ([0-9:]+\s*(?:am|pm)?)/.exec(n)?.[1];
    return r(
      `that time isn't possible today${temprano ? `; the earliest is ${temprano}` : ""}${tarde ? ` and the latest today is ${tarde}` : ""}`,
      tarde ? "What time in that range works for you?" : "Would that time or a later one work for you?",
      `esa hora no se puede para hoy${temprano ? `; lo más temprano es ${temprano}` : ""}${tarde ? ` y para hoy lo más tarde es ${tarde}` : ""}`,
      tarde ? "¿Qué hora en ese rango le acomoda?" : "¿Le acomoda esa hora u otra más tarde?",
    );
  }
  // Revisión 85 (R85-6): hoy ya no queda hora para recoger (la espera mínima llega al cierre).
  if (/^ya no es posible recoger hoy/.test(n)) {
    const cierre = /(?:cierra|cerro) a las ([0-9:]+\s*(?:am|pm)?)/.exec(n);
    const yaCerro = /cerro a las/.test(n);
    return r(
      `pickup is no longer possible today${cierre ? `; the branch ${yaCerro ? "closed" : "closes"} at ${cierre[1]}` : ""}`,
      "We'll gladly take your order when it's open.",
      `ya no es posible recoger hoy${cierre ? `: la sucursal ${yaCerro ? "cerró" : "cierra"} a las ${cierre[1]}` : ""}`,
      "Con gusto le atendemos cuando esté abierta.",
    );
  }
  // Revisión 85 (R85-7): abierta, pero sin tiempo para programarlo más tarde: para ahora sí se toma.
  if (/^ya no alcanza para programar/.test(n)) {
    const cierre = /cierra a las ([0-9:]+\s*(?:am|pm)?)/.exec(n)?.[1];
    return r(
      `there's no longer time to schedule it for later today${cierre ? `; the branch closes at ${cierre}` : ""}`,
      "Would you like it delivered now instead?",
      `ya no alcanza para programarlo más tarde hoy${cierre ? `: la sucursal cierra a las ${cierre}` : ""}`,
      "¿Se lo mandamos para ahora?",
    );
  }
  // Revisión 84 (R84-1): la hora de recoger que no se puede (muy pronto, ya pasó o muy lejos), con la más temprana.
  if (/^esa hora (?:es muy pronto|ya paso)/.test(n)) {
    return r(
      `that pickup time isn't possible${temprano ? `; the earliest is ${temprano}` : ""}`,
      "Would that time or a later one work for you?",
      `esa hora para recoger no se puede${temprano ? `; lo más temprano es ${temprano}` : ""}`,
      "¿Le acomoda esa hora u otra más tarde?",
    );
  }
  if (/^la sucursal no esta abierta a esa hora/.test(n)) {
    const horario = /\(horario de ese día: ([^)]*)\)/.exec(error)?.[1];
    return r(
      `the branch isn't open at that time${horario ? ` (hours that day: ${horarioEnIngles(horario)})` : ""}`,
      "What other time within those hours works for you?",
      `la sucursal no está abierta a esa hora${horario ? ` (horario de ese día: ${horario})` : ""}`,
      "¿A qué otra hora dentro del horario le acomoda?",
    );
  }
  if (/^ya no se puede programar un pedido para hoy/.test(n)) {
    const manana = /manana abrimos a las ([0-9:]+\s*(?:am|pm)?)/.exec(n)?.[1];
    return r(
      `it's no longer possible to schedule an order for today at this branch${manana ? `; tomorrow we open at ${manana}` : ""}`,
      "We'll gladly take your order when it's open.",
      `ya no se puede programar un pedido para hoy en esta sucursal${manana ? `; mañana abrimos a las ${manana}` : ""}`,
      "Con gusto le atendemos cuando esté abierta.",
    );
  }
  if (/no hace entregas a domicilio/.test(n)) {
    return r(
      "this branch does not deliver",
      "Would you like to pick it up at the branch?",
      "esta sucursal no hace entregas a domicilio",
      "¿Prefiere pasar a recoger?",
    );
  }
  const billete = /el billete de (\$[\d.,]*\d) no alcanza para un total de (\$[\d.,]*\d)/.exec(n);
  if (billete) {
    return r(
      `a ${billete[1]} bill doesn't cover the ${billete[2]} total`,
      "How much will you pay with?",
      `el billete de ${billete[1]} no alcanza para el total de ${billete[2]}`,
      "¿Con cuánto paga?",
    );
  }
  if (/con cuanto paga/.test(n)) {
    return r(
      MOTIVO_FALTA_PAGO_EN,
      "How much will you pay with?",
      MOTIVO_FALTA_PAGO,
      "¿Con cuánto paga?",
    );
  }
  if (/alergia o restriccion de salud/.test(n)) {
    return r(
      "a person from the branch first has to confirm your allergy with you",
      "As soon as they do, we'll take your order.",
      "una persona de la sucursal primero tiene que confirmarle lo de su alergia",
      "En cuanto lo haga, tomamos su pedido.",
    );
  }
  return null;
}

/**
 * Revisión 82 (R82-2): la razón real de un rechazo de crear_pedido dicha al cliente (razonDelRechazo), con la pregunta
 * pendiente; si no se reconoce, la pregunta exacta que pide el rechazo o «todavía no pude registrar su pedido» y una pregunta
 * para seguir. En inglés si el cliente escribió en inglés. Pura.
 */
export function motivoDelRechazoParaCliente(
  error: string,
  codigo: string | undefined,
  enIngles: boolean,
  extra: { abreMasTardeHoy?: boolean } = {},
): string {
  const razon = razonDelRechazo(error, codigo, enIngles, extra);
  if (razon) return conMotivoDelRechazo(enIngles, razon.motivo, razon.pregunta);
  const pregunta = /pregúntele(?: exactamente)?:?\s*«([^»]+\?)»/i.exec(error)?.[1];
  if (pregunta && !enIngles) return `Perdón, su pedido todavía no quedó registrado. ${pregunta}`;
  return enIngles
    ? "Sorry, I couldn't place your order yet. Could you confirm your order details so I can place it?"
    : "Perdón, todavía no pude registrar su pedido. ¿Me confirma los datos de su pedido para registrarlo?";
}

/**
 * Revisión 82 (R82-2): lo que escribió el cliente en este turno (los mensajes del cliente desde la última respuesta de texto
 * del asistente), aunque el turno ya tenga llamadas a herramientas. Pura.
 */
function textosDelClienteAntesDeLaRespuesta(messages: readonly MensajeHilo[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") out.unshift(m.content);
    else if (m?.role === "assistant" && !(Array.isArray(m.tool_calls) && m.tool_calls.length) && out.length) break;
  }
  return out;
}

/**
 * C3 con 1939849 (ROB-10 r4/r5): «Con gusto le preparo sus tacos de camarón» en el turno 1, sin sucursal (buscar_producto
 * aún no se puede llamar) y de un producto que no existe; después nadie dijo «no tenemos». Una promesa («le preparo / le
 * anoto / le agrego … sus X») de algo que el cliente nombró y que ninguna herramienta de la sesión devolvió no sale tal
 * cual: la corrige corregirPromesaSinBuscar. Pura: devuelve la oración y lo prometido, o null.
 */
const PROMESA_DE_PRODUCTO =
  /(?:^|[^a-záéíóúñ])(?:con\s+gusto,?\s+)?(?:(?:le|les)\s+)?(?:preparo|preparamos|anoto|anotamos|agrego|agregamos|pongo|ponemos|apunto|apuntamos|llevo|llevamos|mando|mandamos)\s+(?:sus?|el|la|los|las|unos?|unas?)\s+([^.,;:!?¿¡\n]{3,60})/i;
// Lo que no es un producto: «le preparo su pedido», «le anoto su nombre», «le mando la ubicación».
// Tampoco lo incluido sin costo que va en notas (tortilla, salsas, cebolla…): no se busca ni se cobra.
const NO_ES_PRODUCTO =
  /^(?:pedido|orden|nombre|direcci[oó]n|domicilio|datos?|total|cuenta|resumen|comentarios?|notas?|instrucci|ubicaci[oó]n|informaci[oó]n|men[uú]|opciones|precios?|cambio|cotizaci[oó]n|folio|ticket|recibo|terminal|link|enlace|n[uú]mero|tortillas?|salsas?|cebolla|cilantro|lim[oó]n(?:es)?|verduras?|chiles?|picante|hielo|servilletas?|cubiertos?|desechables?|propina)\b/i;
const PALABRA_VACIA_PRODUCTO = new Set(["de", "del", "con", "sin", "y", "e", "a", "al", "el", "la", "los", "las", "un", "una", "unos", "unas", "su", "sus", "por", "para", "orden", "ordenes"]);
const palabrasDeProducto = (t: string) =>
  plegarBusqueda(t).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w) && !PALABRA_VACIA_PRODUCTO.has(w));
// La raíz de una palabra para comparar sin plural («tacos» ~ «taco», «camarones» ~ «camaron»).
const raizDePalabra = (w: string) => w.replace(/(?:es|s)$/, "");

export function promesaDeProductoSinBuscar(texto: string, messages: readonly MensajeHilo[]): { oracion: string; producto: string } | null {
  const oraciones = String(texto ?? "").match(/[^.!?]+[.!?]*/g) ?? [];
  // Lo que devolvieron las herramientas en la sesión (buscar_producto, cotizar_pedido, crear_pedido…).
  const deHerramientas = new Set(
    messages.filter((m) => m?.role === "tool" && typeof m.content === "string").flatMap((m) => palabrasDeProducto(String(m.content))).map(raizDePalabra),
  );
  const delCliente = new Set(textosDelCliente(messages).flatMap(palabrasDeProducto).map(raizDePalabra));
  for (const cruda of oraciones) {
    const m = PROMESA_DE_PRODUCTO.exec(cruda);
    if (!m) continue;
    const producto = (m[1] ?? "").trim().replace(/\s+(?:por\s+favor|enseguida|ahorita|de\s+inmediato)$/i, "");
    if (NO_ES_PRODUCTO.test(producto)) continue;
    const palabras = palabrasDeProducto(producto).map(raizDePalabra);
    // Solo lo que el cliente nombró (eco de su pedido) y que ninguna herramienta devolvió.
    if (palabras.length === 0 || !palabras.some((w) => delCliente.has(w))) continue;
    if (palabras.every((w) => deHerramientas.has(w))) continue;
    return { oracion: cruda.trim(), producto };
  }
  return null;
}


export const FALLO_TECNICO_REPLY = "Ahorita tenemos un problema técnico, por favor intente de nuevo en un momento.";

export function providerFailureReply(
  orderId: string | null,
  tiempoEstimado?: string | null,
  requiereAprobacion?: boolean,
  horaRecoger?: string | null,
  horaProgramada?: string | null,
): string {
  if (orderId && requiereAprobacion) {
    return "¡Listo! Su pedido ya quedó registrado. Por ser un pedido grande, la sucursal lo confirma enseguida.";
  }
  if (orderId && horaProgramada) {
    return `¡Listo! Su pedido ya quedó registrado y programado para entregarse a las ${horaProgramada}.`;
  }
  if (orderId && horaRecoger) {
    return `¡Listo! Su pedido ya quedó registrado y puede pasar a recogerlo a las ${horaRecoger}.`;
  }
  return orderId
    ? `¡Listo! Su pedido ya quedó registrado y se mandó a cocina.${
      tiempoEstimado ? ` Tiempo estimado: ${tiempoEstimado}.` : ""
    }`
    : FALLO_TECNICO_REPLY;
}

/**
 * Lo que la guardia del texto final necesita saber del turno (lo que runAgentTurn del núcleo tenía a mano).
 *  - pedidoCreadoEnTurno / orderId: crear_pedido creó un pedido en ESTE turno (orderId del núcleo).
 *  - pedidoPorAprobar: el pedido creado en el turno requiere aprobación o, sin pedido creado, el último pedido abierto del
 *    número está «por_aprobar» (ultimoPedidoAbiertoPorAprobar: la consulta la hace quien llama).
 *  - crearFallido: el último crear_pedido rechazado o fallido del turno con su clase (CrearPedidoFallido), o null.
 *  - productosDevueltosPorHerramientas: el contenido (texto/JSON) de los resultados de herramientas de la sesión
 *    (buscar_producto, cotizar_pedido, crear_pedido…): lo que se puede prometer.
 *  - mensajes: el hilo (para lo que el cliente nombró, sus textos del turno y el horario que devolvió una herramienta).
 *  - productoPrometidoEnMenu: resultado de buscar en el menú REAL de las sucursales activas lo que devuelve
 *    promesaDeProductoSinBuscar (consultasDeMenuParaPromesa): false = no está en ninguna; true o null (lectura fallida o no
 *    consultada) = no se toca el texto (e69279e).
 */
export interface ContextoGuardiaTextoFinal {
  readonly pedidoCreadoEnTurno: boolean;
  readonly orderId?: string | null;
  readonly pedidoPorAprobar: boolean;
  readonly productosDevueltosPorHerramientas: readonly string[];
  readonly mensajes?: readonly MensajeHilo[];
  readonly crearFallido?: CrearPedidoFallido | null;
  readonly enIngles?: boolean;
  /** Revisión 85 (R85-3): estado del pedido en curso del número (estadoPedidoEnCurso del núcleo). */
  readonly pedidoEnCurso?: "abierto" | "cancelandose" | null;
  /** Revisión 68 (R68-6): al final va la pregunta de cancelar: el texto del servidor no agrega otra pregunta. */
  readonly sinPregunta?: boolean;
  readonly productoPrometidoEnMenu?: boolean | null;
  /** El número ya tiene un pedido registrado (de otro turno): «su pedido quedó registrado» puede ser cierto y no se quita. */
  readonly pedidoPrevioRegistrado?: boolean;
  /** Para providerFailureReply (R82-4) con el pedido creado. */
  readonly tiempoEstimado?: string | null;
  readonly horaRecoger?: string | null;
  readonly horaProgramada?: string | null;
}

/**
 * Las consultas al menú para confirmar una promesa (corregirPromesaSinBuscar del núcleo): lo prometido y, si cambia, lo mismo
 * sin «tacos / orden de / platillo» (como el reintento de buscar_producto). Pura.
 */
export function consultasDeMenuParaPromesa(producto: string): string[] {
  const consultas = [producto];
  const sinPlatillo = producto.replace(/\b(?:tacos?|[oó]rden(?:es)?|platillos?)\b(?:\s+de)?/gi, " ").replace(/\s+/g, " ").trim();
  if (sinPlatillo && sinPlatillo !== producto) consultas.push(sinPlatillo);
  return consultas;
}

/**
 * C3 con 1939849 (ROB-10, fc5797c + e69279e): con el resultado del menú, la promesa de un producto que no está en ninguna
 * sucursal pasa a «Por el momento no tenemos X en el menú.»; lo que sí está (o si el menú no se pudo leer) no se toca. null:
 * nada que corregir. Pura (el menú lo consulta quien llama).
 */
export function corregirPromesaSinBuscar(texto: string, messages: readonly MensajeHilo[], enElMenu: boolean | null | undefined): string | null {
  const promesa = promesaDeProductoSinBuscar(texto, messages);
  if (!promesa || enElMenu !== false) return null;
  return texto.replace(promesa.oracion, `Por el momento no tenemos ${promesa.producto} en el menú.`);
}

/**
 * La guardia del texto final del turno de WhatsApp (runAgentTurn del núcleo, rama «sin tool_calls»), en el mismo orden:
 *  1. promesa de un producto que no está en el menú → «no tenemos» (C3 ROB-10);
 *  2. sin pedido creado y con crear_pedido rechazado: el texto lo arma el servidor según la clase del rechazo (R81-G/R84-1);
 *  3. pedido por aprobar y el texto dice que ya va: acuse del cambio + PEDIDO_POR_APROBAR_REPLY (R87-T/R88-4/R89-2);
 *  4. con pedido creado (sin rechazo en el turno) y el texto dice que el pedido NO se pudo: la confirmación (R82-4).
 * Además, sin pedido creado en el turno, sin rechazo de crear_pedido y sin pedido previo del número, una afirmación de que el pedido quedó
 * (afirmaPedidoRegistradoPerfectivo) se quita (como quitarAfirmacionDePedidoRegistrado del monorrepo) y queda la pregunta
 * para confirmarlo. `alertar`: hubo un error interno al crear (el núcleo deja el aviso MOTIVO_PEDIDO_NO_REGISTRADO). Pura.
 */
export function guardiaTextoFinal(
  texto: string,
  ctx: ContextoGuardiaTextoFinal,
): { texto: string; reemplazado: boolean; motivo: string | null; alertar: boolean } {
  const original = String(texto ?? "");
  const mensajes = ctx.mensajes ?? [];
  let actual = original;
  let motivo: string | null = null;
  // 1. C3 ROB-10: la promesa de lo que ninguna herramienta devolvió y no está en el menú.
  const deHerramientas: MensajeHilo[] = ctx.productosDevueltosPorHerramientas.map((content) => ({ role: "tool", content }));
  const hilo = [...mensajes.filter((m) => m?.role !== "tool"), ...deHerramientas];
  const sinPromesa = corregirPromesaSinBuscar(actual, hilo, ctx.productoPrometidoEnMenu);
  if (sinPromesa !== null) {
    actual = sinPromesa;
    motivo = "promesa_producto_sin_buscar";
  }
  const orderId = ctx.pedidoCreadoEnTurno ? (ctx.orderId ?? "creado") : null;
  const fallido = ctx.crearFallido ?? null;
  // 2. R81-G / R84-1: sin pedido creado, la clase del último rechazo decide.
  const veraz = textoVerazSobreElPedido(actual, orderId, fallido, {
    pedidoEnCurso: ctx.pedidoEnCurso === "abierto",
    pedidoCancelandose: ctx.pedidoEnCurso === "cancelandose",
    adicional: oracionesSecundarias(actual, textosDelClienteAntesDeLaRespuesta(mensajes)),
    horarioHoy: preguntaPorElHorario(textosDelClienteAntesDeLaRespuesta(mensajes)) ? horarioDeHoyEnLaSesion(mensajes) : null,
    enIngles: ctx.enIngles === true,
    sinPregunta: ctx.sinPregunta === true,
  });
  if (veraz.texto !== null) return { texto: veraz.texto, reemplazado: true, motivo: "armada_por_el_servidor_tras_rechazo", alertar: veraz.alertar };
  // 3. R87-T: el pedido por aprobar no está confirmado ni en camino.
  if (ctx.pedidoPorAprobar && afirmaPedidoPorAprobarEnMarcha(actual, { otroPedidoCreado: ctx.pedidoCreadoEnTurno && !ctx.pedidoPorAprobar })) {
    const t = [acuseAntesDePorAprobar(actual), ctx.enIngles === true ? PEDIDO_POR_APROBAR_REPLY_EN : PEDIDO_POR_APROBAR_REPLY].filter(Boolean).join(" ");
    return { texto: t, reemplazado: true, motivo: "pedido_por_aprobar_afirmado_en_marcha", alertar: veraz.alertar };
  }
  // 4. R82-4: con el pedido creado, el texto no dice que falló.
  if (orderId && !fallido && FALLO_DEL_PEDIDO_AFIRMADO.test(normAviso(actual))) {
    return {
      texto: providerFailureReply(orderId, ctx.tiempoEstimado, ctx.pedidoPorAprobar, ctx.horaRecoger, ctx.horaProgramada),
      reemplazado: true,
      motivo: "fallo_afirmado_con_pedido_creado",
      alertar: veraz.alertar,
    };
  }
  // Sin pedido creado ni rechazo: «ya quedó registrado» es falso (núcleo: lo cubre la regla del prompt; aquí, red de seguridad).
  if (!orderId && !fallido && ctx.pedidoPrevioRegistrado !== true && afirmaPedidoRegistradoPerfectivo(actual)) {
    const oraciones = actual.split(/(?<=[.!?])\s+/);
    const resto = oraciones.filter((o) => !afirmaPedidoRegistradoPerfectivo(o)).join(" ").trim();
    const sustituto = ctx.enIngles === true
      ? "Your order isn't placed yet. Shall I confirm it?"
      : "Todavía no queda registrado su pedido. ¿Me confirma con un «sí» el resumen para registrarlo?";
    return { texto: resto || sustituto, reemplazado: true, motivo: "afirma_pedido_registrado_sin_pedido", alertar: false };
  }
  return { texto: actual, reemplazado: actual !== original, motivo, alertar: veraz.alertar };
}

// ── Default del dueño (7-nov): «¿algo más?» UNA sola vez por pedido ─────────────────────────────────────────────────────────────────────────────
// El prompt base lo pedía en el resumen y otra vez al cerrar; v2 lo prohibía tras el pago. Regla única: una vez por pedido, justo antes del resumen. Si en ESTE pedido (desde el
// último «quedó registrado») el asistente ya lo preguntó, la segunda pregunta se quita de la respuesta. No toca preguntas con alternativa («¿… algo más o prefiere recoger?»).
const PREGUNTA_ALGO_MAS = /¿[^¿?]*\balgo m[aá]s(?![a-záéíóúñ])[^¿?]*\?/gi;
const ALTERNATIVA = /\b(?:o prefiere|recoger|sucursal)\b/i;
const PEDIDO_REGISTRADO = /qued[oó] registrado|pedido (?:ya )?(?:qued[oó]|est[aá]) (?:registrado|confirmado)|n[uú]mero de pedido/i;

/** Respuesta sin un segundo «¿algo más?» en el mismo pedido. Pura. */
export function quitarAlgoMasRepetido(reply: string, historial: readonly { readonly role: string; readonly content: unknown }[]): string {
  let yaPreguntado = false;
  for (const m of historial) {
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    if (PEDIDO_REGISTRADO.test(m.content)) yaPreguntado = false;
    else if (Array.from(m.content.matchAll(PREGUNTA_ALGO_MAS)).some((p) => !ALTERNATIVA.test(p[0]))) yaPreguntado = true;
  }
  if (!yaPreguntado) return reply;
  const limpio = reply.replace(PREGUNTA_ALGO_MAS, (p) => (ALTERNATIVA.test(p) ? p : /correct|confirm/i.test(p) ? "¿Es correcto?" : "")).replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  return limpio === "" ? reply : limpio;
}
