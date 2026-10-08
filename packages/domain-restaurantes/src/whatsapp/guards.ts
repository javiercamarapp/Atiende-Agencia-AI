// Guardias DETERMINISTAS del agente de WhatsApp: logica que antes dependia solo del prompt y
// que el repo original ya habia endurecido tras bugs reales (X05, X06, X37). Se portan aqui,
// al trato de USTED que exige el dueno (P26), sin tocar el loop de tool-use.
//
//   * enforceQuotedTotal      -- el texto libre del modelo puede alucinar un total distinto al
//                                que devolvio cotizar_pedido (el cobro era correcto, el cliente
//                                leia otra cifra). Reescribe la cifra junto a la palabra "total".
//   * enforcePendingQuestion  -- un turno que termina sin herramienta ni pregunta ("voy a
//                                revisar") deja al cliente esperando; se anexa la pregunta del
//                                paso pendiente.
//   * classifyHighRiskIntent  -- cancelacion, cobro duplicado, urgencia, ARCO, transferencia,
//                                alergia, queja o "quiero hablar con una persona" NO se dejan al
//                                criterio del modelo: se intercepta ANTES del LLM, se registra el
//                                aviso al equipo y se responde un texto fijo y honesto (el
//                                agente no puede cancelar ni cobrar nada).
import type { PedidoReciente } from "../pedido-reciente.ts";
import type { BranchSummary, CustomerLookupResult } from "../types.ts";

// Numero con separadores de miles (coma, punto o espacio) y decimales con punto o coma: "1500", "1,500.00", "1.500,00", "1 500". El separador de
// miles exige grupos de EXACTAMENTE tres digitos para no devorar "$179 3 tacos".
const NUM = "(?:\\d{1,3}(?:[,.\\u00a0\\u202f ]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?![\\d])";
const DIVISA = "(?:MXN|M\\.N\\.|MN)";
const MONEY_TOKEN = `\\$\\s?${NUM}(?:\\s*${DIVISA}(?![\\p{L}]))?|${NUM}\\s*(?:pesos|${DIVISA}(?![\\p{L}]))(?![\\p{L}])`;
// "total" como palabra completa: "Subtotal" NO es un total (con la promo 2x1 el subtotal legitimo difiere del total). El tramo entre
// la palabra y la cifra no cruza el fin de la oracion: "total; el medio kilo va en $450" no reescribe el $450.
const TOTAL_WITH_MONEY = new RegExp(`((?<![\\p{L}\\p{N}])total[^$\\d.;!?\\n]{0,40})(${MONEY_TOKEN})`, "giu");
// Un "total" PARCIAL (de un renglon, "antes del descuento", "sin envio") no es lo que paga el cliente: si su cifra es una de las legitimas de la
// cotizacion se conserva. Se reconoce por el calificador entre la palabra y la cifra o porque va entre parentesis (importe del renglon).
const TOTAL_PARCIAL = /\b(?:antes|sin|previo|parcial|excluy\w*|renglon|rengl[oó]n|por\s+(?:pieza|unidad|orden))\b/i;
// Redacciones que presentan una cifra como LO QUE PAGA el cliente sin decir "total" ("le queda en $300", "$300 en total").
const AMOUNT_INTENT = "(?:(?:le\\s+)?queda(?:n)?\\s+en|saldr[ií]a(?:n)?\\s+en)\\s+(?:un\\s+total\\s+de\\s+)?";
const INTENT_WITH_MONEY = new RegExp(`(${AMOUNT_INTENT})(${MONEY_TOKEN})`, "giu");
const MONEY_WITH_TOTAL_TAIL = new RegExp(`(${MONEY_TOKEN})(\\s*(?:pesos\\s+)?(?:en\\s+total|todo|total)(?![\\p{L}\\p{N}]))`, "giu");

/** Importe de un token de dinero en cualquiera de los formatos habituales: "$1,500.00", "$1.500,00", "$1 500", "150 MXN", "150 pesos". */
export function parseMoneyToken(token: string): number {
  const num = /\d[\d,.\u00a0\u202f ]*\d|\d/.exec(token)?.[0] ?? "";
  const compact = num.replace(/[\u00a0\u202f ]/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Ambos: el ultimo es el decimal, el otro agrupa miles.
    const dec = Math.max(lastComma, lastDot);
    normalized = `${compact.slice(0, dec).replace(/[,.]/g, "")}.${compact.slice(dec + 1)}`;
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = compact.split(sep);
    // "1,500" / "1.500" / "1,500,000": grupos de tres digitos = miles; "150,5" / "150.50" = decimales.
    const esMiles = parts.length > 2 || parts[parts.length - 1]!.length === 3;
    normalized = esMiles ? parts.join("") : `${parts[0]}.${parts[1]}`;
  } else {
    normalized = compact;
  }
  return Number(normalized);
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Corrige las cifras con que el modelo presenta el total para que coincidan con el ultimo total REAL
 * (cotizar_pedido / crear_pedido): la cifra junto a la palabra "total" (no "subtotal") y, cuando se conocen
 * las cifras legitimas de la cotizacion (`knownAmounts`: precios, importes de renglon, subtotal, descuento),
 * tambien una cifra ajena presentada como lo que paga el cliente ("le queda en $300"). No toca precios
 * unitarios ni importes de la cotizacion. */
export function enforceQuotedTotal(reply: string, lastQuoteTotal: number | null, knownAmounts?: readonly number[]): string {
  if (lastQuoteTotal === null || !Number.isFinite(lastQuoteTotal)) return reply;
  const isKnown = (stated: number) => Math.abs(stated - lastQuoteTotal) < 0.01 || (knownAmounts ?? []).some((a) => Math.abs(stated - a) < 0.01);
  const porTotal = reply.replace(TOTAL_WITH_MONEY, (full: string, prefix: string, moneyToken: string, offset: number) => {
    const stated = parseMoneyToken(moneyToken);
    if (!Number.isFinite(stated) || Math.abs(stated - lastQuoteTotal) < 0.01) return full;
    // Total parcial legitimo (renglon, "antes del descuento", "sin envio"): su cifra es de la cotizacion, no se toca.
    const entreParentesis = /\(\s*$/.test(reply.slice(Math.max(0, offset - 3), offset));
    if (knownAmounts && knownAmounts.length > 0 && (entreParentesis || TOTAL_PARCIAL.test(prefix)) && isKnown(stated)) return full;
    return `${prefix}${formatMoney(lastQuoteTotal)}`;
  });
  if (!knownAmounts || knownAmounts.length === 0) return porTotal;
  const porIntencion = porTotal.replace(INTENT_WITH_MONEY, (full: string, prefix: string, moneyToken: string) => {
    const stated = parseMoneyToken(moneyToken);
    return !Number.isFinite(stated) || isKnown(stated) ? full : `${prefix}${formatMoney(lastQuoteTotal)}`;
  });
  return porIntencion.replace(MONEY_WITH_TOTAL_TAIL, (full: string, moneyToken: string, tail: string) => {
    const stated = parseMoneyToken(moneyToken);
    return !Number.isFinite(stated) || isKnown(stated) ? full : `${formatMoney(lastQuoteTotal)}${tail}`;
  });
}

/** Cifras legitimas de una cotizacion (wire o dominio): precio y importe de cada renglon, subtotal, descuento y total. */
export function knownAmountsOfQuote(quote: {
  readonly total?: unknown;
  readonly subtotal?: unknown;
  readonly descuento?: unknown;
  readonly lines?: readonly { readonly price?: unknown; readonly line_total?: unknown; readonly lineTotal?: unknown }[];
}): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  };
  push(quote.total);
  push(quote.subtotal);
  push(quote.descuento);
  for (const line of quote.lines ?? []) {
    push(line.price);
    push(line.line_total);
    push(line.lineTotal);
  }
  return [...new Set(out)];
}

/** El texto del agente dice que YA AVISO (o avisara) al gerente/equipo/sucursal. Sirve a la guardia de honestidad: solo se puede decir si el aviso existe
 * (QA-PM-R2-whatsapp-04: 12 de 48 conversaciones del juez eran "ya avise al gerente" sin llamar a escalar_a_humano). Un aviso de preparacion
 * ("le aviso a la sucursal para que tenga listo su pedido") es parte del flujo normal del pedido, no un aviso al gerente: no cuenta. */
export function afirmaHaberAvisado(reply: string): boolean {
  const t = normalizarParaClasificar(reply);
  const DEST = "(?:a|al|a\\s+la|a\\s+los)\\s+(?:\\w+\\s+){0,2}(?:gerente|equipo|sucursal|encargad[oa]|restaurante|personal)\\b(?![^.!?]*\\b(?:list[oa]s?|prepar\\w*|tenga\\w*)\\b)";
  // Solo afirmaciones en PASADO de haber avisado (R4-whatsapp-02/reglas-01). No cuentan el futuro ni el condicional ("le voy a avisar a la sucursal que usted pasa a las 8", "debo avisar al gerente si..."),
  // la negacion ("no tengo que avisar") ni el subjuntivo ("para que le avise"); "permitame avisar al gerente" es la promesa inmediata del aviso y si cuenta.
  const pasado = new RegExp(`(?<!\\bno\\s)(?<!\\bno\\s(?:le|les)\\s)(?<!\\bque\\s)(?<!\\bque\\s(?:le|les)\\s)\\b(?:ya\\s+)?(?:le\\s+|les\\s+)?avis(?:e|amos)\\s+(?:ya\\s+)?${DEST}`);
  const inmediata = new RegExp(`\\b(?:permitame|permitanme|dejeme)\\s+avisar(?:le|les)?\\s+(?:a|al|a\\s+la)\\s+(?:\\w+\\s+){0,2}(?:gerente|equipo|encargad[oa])\\b(?![^.!?]*\\b(?:list[oa]s?|prepar\\w*|tenga\\w*)\\b)`);
  const registrado = /\bel\s+aviso\s+(?:ya\s+)?(?:quedo|fue|se\s+registro|esta\s+registrado)\b|\b(?:ya\s+)?quedo\s+avisad[oa]\b/;
  const notifique = /\bnotific(?:ue|amos)\s+(?:al|a\s+la)\s+(?:\w+\s+){0,2}(?:gerente|equipo|sucursal)\b/;
  // T7-060 (ronda 5): «Permítame verificarlo con una persona de la sucursal» (o «lo consulto con el gerente») es la promesa de que una persona lo revisa. Sin escalar_a_humano no hay nadie a
  // quien le llegue: el agente dijo que consultaria y no habia aviso. Cuenta la promesa inmediata («permitame verificarlo con...») y la primera persona («lo verifico / voy a consultarlo con...»).
  // Se mira frase por frase: no cuentan la pregunta, la negacion, el condicional («si quiere, lo consulto con el gerente») ni el subjuntivo («para que lo verifique»).
  return pasado.test(t) || inmediata.test(t) || registrado.test(t) || notifique.test(t) || reply.split(/(?<=[.!?;])\s+/).some(prometeConsultarConUnaPersona);
}

// «la sucursal» solo cuenta si no la sigue un nombre: «confirmo con la sucursal García Lavín su pedido» es el dato del pedido, no una consulta a una persona.
const PERSONA_A_CONSULTAR = "(?:una\\s+persona|un\\s+asesor|alguien|el\\s+gerente|la\\s+gerente|el\\s+equipo|el\\s+encargad[oa]|la\\s+encargada|la\\s+sucursal(?=\\s*(?:$|[,.;]|\\s(?:y|para|si|que|ya|porque)\\b)))";
const VERBO_DE_CONSULTA = "(?:verificar|consultar|confirmar|checar|revisar)";
const PROMESA_DE_CONSULTA = new RegExp(
  `\\b(?:permitame|permitanme|dejeme)\\s+${VERBO_DE_CONSULTA}(?:l[oae]s?)?\\s+con\\s+${PERSONA_A_CONSULTAR}|\\b(?:l[oae]s?\\s+)?(?:verifico|consulto|reviso|checo|verificare|consultare|revisare|checare)\\s+(?:l[oae]s?\\s+)?con\\s+${PERSONA_A_CONSULTAR}|\\bvoy\\s+a\\s+${VERBO_DE_CONSULTA}(?:l[oae]s?)?\\s+con\\s+${PERSONA_A_CONSULTAR}`,
);
function prometeConsultarConUnaPersona(frase: string): boolean {
  if (/[?¿]/.test(frase)) return false;
  // «Ayer lo consultó con el gerente» (3.a persona, pasado): sin el acento se confundiria con «consulto». Es historial, no una promesa.
  if (/\b(?:consult|verific|confirm|revis|chec)ó(?![a-záéíóúñ])/i.test(frase)) return false;
  const t = normalizarParaClasificar(frase);
  const m = PROMESA_DE_CONSULTA.exec(t);
  if (!m) return false;
  const antes = t.slice(0, m.index);
  // Condicional, ofrecimiento, subjuntivo o plazo lejano ANTES de la promesa: «si gusta, lo consulto...», «para que lo verifique...», «mañana lo consultaré...». La negacion solo cuenta pegada a la promesa
  // («no lo consulto», «no puedo ...»): «No tengo el precio; permítame verificarlo...» o «No se preocupe, lo consulto...» siguen siendo una promesa.
  if (/\b(?:cuando|podria|puedo|puede|podemos|para\s+que|en\s+caso|quiza|tal\s+vez|manana|luego|despues|mas\s+tarde|nunca|jamas)\b/.test(antes)) return false;
  if (/(?:^|[\s,;])si(?![a-z])/.test(frase.slice(0, m.index).toLowerCase())) return false;
  if (/\b(?:no|ni)\s+(?:\w+\s+){0,1}$/.test(antes)) return false;
  return true;
}

/** Frase que ofrece algo "de cortesia" como parte del pedido (afirmacion), no una explicacion de la regla de la promocion ("solo para recoger", "los martes", "si pide...", "no hay aguas de cortesia"). */
function afirmaCortesia(frase: string): boolean {
  const t = normalizarParaClasificar(frase);
  if (!/\bcortesia\b/.test(t)) return false;
  return !/\b(?:no|solo|unicamente|si|cuando|martes|lunes|promocion|aplica|valido|media\s+orden)\b/.test(t);
}

/** Guardia de honestidad de la promocion: "de cortesia" solo si `cotizar_pedido` devolvio `promocion_aplicada` (H13). Sin promocion en la cotizacion del turno, se quitan las frases
 * que afirman una cortesia; si no queda nada, se aclara que el total es el cotizado. */
export function quitarCortesiaNoRespaldada(reply: string): string {
  const frases = reply.split(/(?<=[.!?])\s+/);
  if (!frases.some(afirmaCortesia)) return reply;
  const resto = frases.filter((f) => !afirmaCortesia(f)).join(" ").trim();
  return resto || "Por ahora su pedido no lleva ninguna promoción aplicada; el total es el de la cotización.";
}

/**
 * La frase AFIRMA que el pedido ya esta registrado / confirmado / en cocina ("su pedido ya quedo confirmado", "ya lo registre", "ya va a cocina"). Una pregunta, un condicional
 * ("para que quede registrado", "si confirma...") o una explicacion no cuentan. Sirve a la guardia de honestidad del cierre (QA-PM-R3 T7-040, P0: "el pedido ya quedo confirmado"
 * sin pedido en la base tras un "si" y un "agregame pina").
 */
export function afirmaPedidoRegistrado(frase: string): boolean {
  const t = normalizarParaClasificar(frase);
  if (/[?¿]/.test(frase)) return false;
  // Condicional / negacion / futuro: no afirman nada. «si» se mira en el texto ORIGINAL para no confundir el «sí» afirmativo ("Sí, su pedido ya quedó registrado") con el condicional «si».
  if (/(?:^|[\s¡,;:(])si(?=[\s,])/.test(frase.toLowerCase())) return false;
  if (/\b(?:cuando|para\s+que|una\s+vez|antes\s+de|hasta\s+que|en\s+cuanto|no\s+(?:esta|queda|quedo|ha|he|hemos|se)|todavia\s+no|aun\s+no|(?:todavia|aun)\s+falta|falta)\b/.test(t)) return false;
  // Sujeto PEDIDO (pedido / orden / comanda) con un predicado de "ya existe": registrado, confirmado, tomado, enviado, en camino, en cocina... Entre el sujeto y el predicado no puede
  // haber otro objeto ("su pedido ... su direccion quedo registrada"): la direccion, el nombre, el cambio o el pago anotados NO son el pedido registrado.
  const N = "(?:pedido|orden|comanda)";
  const OBJETO = "(?:direccion|domicilio|nombre|cambio|pago|tarjeta|telefono|datos|correo|referencia|ubicacion|propina|nota|notas|factura)";
  const PART = "(?:registrad[oa]|confirmad[oa]|anotad[oa]|tomad[oa]|levantad[oa]|apartad[oa]|generad[oa]|enviad[oa]|mandad[oa]|capturad[oa]|procesad[oa]|recibid[oa])";
  const SALIDA = "(?:en\\s+camino|en\\s+cocina|en\\s+preparacion|en\\s+proceso|en\\s+marcha|preparandose|se\\s+esta\\s+preparando)";
  const VERBO = "(?:(?:quedo|queda|esta|fue|ha\\s+sido|va|se\\s+(?:genero|tomo|registro|confirmo|envio|mando|paso|levanto))\\s+(?:ya\\s+)?)";
  const UNO = "(?:registre|registramos|confirme|confirmamos|anote|anotamos|tome|tomamos|mande|mandamos|pase|pasamos|envie|enviamos|genere|generamos|capture|levante|aparte|procese)";
  const patrones: RegExp[] = [
    // «su pedido (ya) quedó registrado / está confirmado / va en camino / ya está en cocina», «Pedido confirmado ✅»
    new RegExp(`\\b${N}\\b(?:\\s+(?!${OBJETO}\\b)[a-z0-9]+){0,4}?\\s+(?:ya\\s+)?${VERBO}?(?:${PART}|${SALIDA})\\b`),
    // «ya quedó apartado su pedido», «ya está su pedido», «ya se generó su orden»
    new RegExp(`\\b(?:ya\\s+)?(?:quedo|esta|fue|se\\s+(?:genero|tomo|registro|confirmo|envio|mando|paso|levanto))\\s+(?:ya\\s+)?(?:${PART}\\s+)?(?:su|el)\\s+${N}\\b`),
    // «ya tomé su pedido», «ya mandé su comanda», «registré su orden»
    new RegExp(`\\b${UNO}\\s+(?:ya\\s+)?(?:su|el|la|lo)\\s+(?:\\w+\\s+)?${N}\\b`),
    // «ya lo registré / confirmamos / mandé / pasé a cocina», «ya lo dejé registrado»
    /\bya\s+(?:lo|la)\s+(?:\w+\s+){0,2}?(?:registre|registramos|confirme|confirmamos|mande|mandamos|pase|pasamos|envie|enviamos|tome|tomamos|deje\s+registrad[oa]|dejamos\s+registrad[oa])\b/,
    /\bya\s+(?:lo|la)\s+tenemos\s+(?:ya\s+)?(?:registrad|anotad|confirmad)[oa]\b/,
    /\b(?:lo|la)\s+(?:mande|mandamos|pase|pasamos|envie|enviamos)\s+a\s+(?:la\s+)?cocina\b/,
    // «ya entró / llegó a cocina», «ya salió a reparto», «ya va para allá», «se está cocinando»
    new RegExp(`\\b${N}\\b(?:\\s+(?!${OBJETO}\\b)[a-z0-9]+){0,3}?\\s+(?:ya\\s+)?(?:entro|llego|paso|salio|va)\\s+(?:ya\\s+)?(?:a|para)\\s+(?:la\\s+)?(?:cocina|reparto|alla|su\\s+casa)\\b`),
    new RegExp(`\\b${N}\\b(?:\\s+[a-z0-9]+){0,3}?\\s+(?:ya\\s+)?se\\s+esta\\s+(?:cocinando|armando|haciendo)\\b`),
    // «ya tenemos su pedido», «su orden ya fue aceptada», «ya dimos de alta su pedido», «su pedido quedó en el sistema», «su pedido está listo»
    new RegExp(`\\b(?:ya\\s+)?(?:tenemos|recibimos|aceptamos|dimos\\s+de\\s+alta)\\s+(?:ya\\s+)?(?:su|el)\\s+${N}\\b`),
    new RegExp(`\\b${N}\\b(?:\\s+[a-z0-9]+){0,3}?\\s+(?:ya\\s+)?(?:fue\\s+aceptad[oa]|quedo\\s+en\\s+el\\s+sistema|esta\\s+(?:ya\\s+)?list[oa](?:\\s+para\\s+(?:recoger|entregar|salir))?)\\b`),
    // Sin sujeto: «Ya quedó registrado, lo esperamos» (solo si la frase no habla de otra cosa: direccion, nombre, pago...)
    new RegExp(`^(?!.*\\b${OBJETO}\\b).*\\bya\\s+quedo\\s+(?:registrado|confirmado|anotado)\\b`),
    // «va / pasó / se mandó (ya) a cocina»
    /\b(?:esta|va|paso|se\s+mando|se\s+envio)\s+(?:ya\s+)?(?:en|a)\s+(?:la\s+)?(?:cocina|preparacion)\b/,
  ];
  return patrones.some((r) => r.test(t));
}

/** La frase habla del ESTADO de un pedido (va en camino, en preparacion, en cocina, listo, salio a reparto...), no solo de su registro. */
export function hablaDelEstadoDelPedido(frase: string): boolean {
  return /\b(?:en\s+(?:camino|cocina|preparacion|proceso|marcha)|preparandose|se\s+esta\s+(?:preparando|cocinando|armando|haciendo)|(?:entro|llego|salio|paso)\s+(?:ya\s+)?a\s+(?:la\s+)?(?:cocina|reparto)|va\s+para\s+alla|list[oa]\s+para)\b/.test(normalizarParaClasificar(frase));
}

/** Solo REGISTRO / CONFIRMACION del pedido (no su estado): lo unico que se quita cuando el cliente ya tiene un pedido activo y el turno esta armando otro. */
export function afirmaSoloRegistroDePedido(frase: string): boolean {
  return afirmaPedidoRegistrado(frase) && !hablaDelEstadoDelPedido(frase);
}

/** Quita las frases que afirman un pedido registrado cuando NO existe; si no queda nada, pide el "si" al resumen. */
export function quitarAfirmacionDePedidoRegistrado(reply: string, sustituto?: string, afirma: (frase: string) => boolean = afirmaPedidoRegistrado): string {
  const frases = reply.split(/(?<=[.!?])\s+/);
  if (!frases.some(afirma)) return reply;
  const resto = frases.filter((f) => !afirma(f)).join(" ").trim();
  return resto || sustituto || "Todavía no queda registrado su pedido. ¿Me confirma con un «sí» el resumen para registrarlo?";
}

/**
 * QA-PM-R4-whatsapp-05: la frase "el equipo le responde a partir de las 12 del dia" solo es verdad entre la 1 am y las 12 pm (nadie del equipo contesta en ese rango). El modelo la
 * aplicaba a las 13:00 y 14:00 con la sucursal abierta. `hora` es la hora local (0-23) del turno: de 12 a 23 la frase se reemplaza por "le contestan en cuanto puedan".
 */
export function corregirPromesaDeHorarioNocturno(reply: string, hora: number): string {
  if (hora < 12 && hora >= 1) return reply;
  // Solo la promesa de RESPUESTA del equipo/gerente ("el equipo le responde a partir de las 12 del dia"); "mañana abrimos a partir de las 12" o "el 2x1 aplica a partir de las 12 pm" no se tocan.
  return reply.replace(
    /(?:,?\s*(?:y\s+)?)(?:el\s+(?:equipo|gerente)(?:\s+de\s+la\s+sucursal)?|la\s+sucursal)\s+(?:le\s+)?(?:responde|contesta|responder[aá]n?|contestar[aá]n?|atiende|atender[aá]n?|escribe|escribir[aá]n?)\s+a\s+partir\s+de\s+las\s+12(?:\s*(?::00|h|hrs?\.?))?\s*(?:del\s+d[ií]a|del\s+mediod[ií]a|pm|p\.m\.)?/gi,
    (m) => {
      const prefijo = /^,?\s*(?:y\s+)?/i.exec(m)?.[0] ?? "";
      return /[,y]/i.test(prefijo) ? ", el equipo le contesta en cuanto puedan" : `${prefijo}El equipo le contesta en cuanto puedan`;
    },
  );
}

/**
 * QA-PM-R4-whatsapp-03: el cliente dijo "de propina 10%" y el modelo creaba el pedido sin `propina` (la propina del 10 % se perdia y el resumen decia "mas la propina" sin monto).
 * Pura: el porcentaje de propina que el CLIENTE dijo en sus mensajes (el ultimo que lo menciona), o `null`. Solo cuenta si el mensaje habla de propina junto a un porcentaje de 1 a 100.
 */
export function porcentajePropinaDichoPorElCliente(mensajeDelCliente: string | undefined): number | null {
  if (!mensajeDelCliente) return null;
  const texto = normalizarParaClasificar(mensajeDelCliente);
  // Una pregunta ("¿se acostumbra dejar 10% de propina?") no es una aceptacion.
  if (/[?¿]/.test(mensajeDelCliente)) return null;
  for (const clausula of texto.split(/[.,;!\n](?!\d)|\s+y\s+|\s+pero\s+/)) {
    if (!/\bpropina\b/.test(clausula)) continue;
    if (/\b(?:no|sin|nunca|jamas|tampoco|ni|nada)\b/.test(clausula)) continue;
    if (/\b(?:deje|dejaron|dejamos|ayer|anterior|otra\s+vez|pasada|antes|acostumbra|normalmente)\b/.test(clausula)) continue;
    const match = /(?<![\d.,-])(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|por\s*ciento)/.exec(clausula);
    if (!match) continue;
    const n = Number(match[1]!.replace(",", "."));
    if (n > 0 && n <= PROPINA_PORCENTAJE_MAX) return n;
  }
  return null;
}
/** Tope razonable de una propina en porcentaje (validacion de entrada y relleno del servidor). */
export const PROPINA_PORCENTAJE_MAX = 30;

/**
 * T7-044 (ronda 5): el cliente pidio «1 guacamole» (el platillo) y la cotizacion llevaba «Extra Guacamole», tomado de «lo de siempre»: el total salio $93 por debajo del real. Los dos
 * productos existen a proposito (T-AM06/X26: el cliente elige), asi que el servidor no adivina: si la cotizacion trae Extra Guacamole sin el platillo y el cliente dijo «guacamole» a secas
 * (sin extra / doble / adicional / otro / mas) y TODAVIA NO LE PREGUNTARON, devuelve el texto que el agente debe aclarar; si no, `null`. Pura.
 *
 * Sin bucle: la aclaracion se da por contestada en cuanto, despues de la ultima mencion a secas, el agente hablo del guacamole y el cliente respondio (cualquier cosa: «el extra, para mis
 * tacos», «2 extras», «el platillo»); o si el cliente dice «extra» despues de mencionarlo. Sin conversacion (voz, camino legado) no opina. «guacamolera» (la salsa incluida) no cuenta.
 */
export function aclararGuacamoleExtra(nombresDeRenglones: readonly string[], conversacion: readonly { readonly role: string; readonly content: string }[] | undefined): string | null {
  if (!conversacion || conversacion.length === 0) return null;
  const nombres = nombresDeRenglones.map((n) => normalizarParaClasificar(n).trim());
  if (!nombres.some((n) => n === "extra guacamole") || nombres.some((n) => n === "guacamole")) return null;
  const textos = conversacion.map((m) => ({ role: m.role, t: normalizarParaClasificar(String(m.content ?? "")) }));
  const MENCION = /\bguacamoles?\b/;
  const EXTRA_DE_GUACAMOLE = /\b(?:extras?|dobles?|adicional(?:es)?|otro|otra|mas|segundo)\s+(?:de\s+)?(?:un\s+|una\s+|el\s+|la\s+)?guacamoles?\b|\bguacamoles?\s+(?:extras?|dobles?|adicional(?:es)?|de\s+mas)\b/;
  let ultima = -1;
  textos.forEach((m, idx) => {
    if (m.role === "user" && MENCION.test(m.t) && !EXTRA_DE_GUACAMOLE.test(m.t)) ultima = idx;
  });
  if (ultima < 0) return null;
  const despues = textos.slice(ultima + 1);
  // El cliente dijo «extra» (o «doble», «adicional») despues de mencionarlo: ya eligio.
  if (despues.some((m) => m.role === "user" && (/\bextras?\b|\bdobles?\b|\badicional(?:es)?\b|\bde\s+mas\b|\bpara\s+(?:mis|los|el)\s+tacos?\b/.test(m.t) || EXTRA_DE_GUACAMOLE.test(m.t)))) return null;
  // El agente ya le pregunto por el guacamole y el cliente contesto.
  const pregunto = despues.findIndex((m) => m.role === "assistant" && /guacamole|extra/.test(m.t));
  if (pregunto >= 0 && despues.slice(pregunto + 1).some((m) => m.role === "user")) return null;
  return "El cliente dijo «guacamole» sin decir «extra»: el platillo Guacamole y el Extra Guacamole (agregado para los tacos) son productos distintos y de distinto precio. No cotice Extra Guacamole por su cuenta ni por «lo de siempre»: pregúntele cuál quiere («¿el guacamole como platillo o un extra para sus tacos?»), espere su respuesta y vuelva a cotizar con el que elija.";
}

/** Quita la afirmacion de aviso cuando no se pudo dejar el aviso. */
export function quitarAfirmacionDeAviso(reply: string): string {
  const sinFrase = reply
    .split(/(?<=[.!?])\s+/)
    .filter((frase) => !afirmaHaberAvisado(frase))
    .join(" ")
    .trim();
  return `${sinFrase} Por ahora no pude dejar el aviso al equipo; si lo necesita, inténtelo de nuevo en unos minutos.`.trim();
}

export function pendingQuestionForMissingData(branchKnown: boolean, orderId: string | null): string | null {
  if (orderId) return null;
  if (!branchKnown) return "¿Me comparte su colonia o una referencia cercana para ubicar la sucursal más cercana?";
  return "¿Qué le gustaría pedir, o hay algo más en lo que le pueda ayudar?";
}

/**
 * T7-010 / T7-013 (ronda 5): el cliente ya se despidio («solo queria confirmar el horario, gracias», "nada mas, gracias", "hasta luego") y el servidor le anexaba «¿Qué le gustaría pedir?»
 * a CADA turno, en bucle (8 veces seguidas), como si no hubiera terminado. Pura: el mensaje es SOLO una despedida/agradecimiento de cierre. Cuenta un mensaje corto, sin pregunta ni cifras,
 * hecho unicamente de palabras de cierre y con al menos una de ellas inequivoca (gracias, nada mas, hasta luego, adios, es todo...). No cuenta: un saludo ("buenas tardes"), un «si,
 * gracias» / «claro, gracias» (acepta una oferta), ni un mensaje que ademas pide, pregunta o dice una cantidad ("gracias, quiero 3 tacos", "no gracias, y el total?").
 */
export function esDespedidaDelCliente(mensaje: string | undefined): boolean {
  if (!mensaje) return false;
  if (/[?¿\d]/.test(mensaje)) return false;
  const t = normalizarParaClasificar(mensaje).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (t === "" || t.split(" ").length > 12) return false;
  // Acepta una oferta o responde una pregunta: no es el cierre de la conversacion.
  if (/(?:^|[,.;!¡]\s*)(?:ah\s+)?s[ií](?![a-záéíóúñ])/i.test(mensaje.trim())) return false;
  if (/\b(?:claro|dale|va|ok|okay|por\s+favor|porfa|quiero|quisiera|necesito|ponme|pon|agrega|agregame|manda|mandame|envia|tambien|ademas|pero|cuanto|cuando|donde|como)\b/.test(t)) return false;
  const CIERRE = new Set(["gracias", "muchas", "muchisimas", "mil", "no", "nada", "mas", "es", "eso", "todo", "ya", "por", "ahora", "igualmente", "igual", "hasta", "luego", "pronto", "adios", "bye", "chao", "fin", "buen", "buena", "buenas", "buenos", "dia", "dias", "tarde", "tardes", "noche", "noches", "que", "tenga", "tengas", "excelente", "usted", "ustedes", "saludos", "nos", "vemos", "solo", "queria", "confirmar", "saber", "si", "verificar", "estaban", "estan", "abiertos", "horario", "el", "la", "de", "lo", "se", "les", "le", "a", "ah", "oh", "bueno", "pues", "muy", "amable", "su", "atencion", "perfecto", "listo", "entendido", "excelentes", "fue", "todo", "eso", "era", "seria", "hoy", "gusto"]);
  const palabras = t.split(" ");
  if (!palabras.every((w) => CIERRE.has(w))) return false;
  return /\b(?:gracias|nada\s+mas|es\s+todo|eso\s+es\s+todo|hasta\s+luego|hasta\s+pronto|adios|bye|chao|nos\s+vemos|igualmente|fin)\b/.test(t);
}

export function enforcePendingQuestion(reply: string, branchKnown: boolean, orderId: string | null, ultimoMensajeDelCliente?: string): string {
  const trimmed = reply.trim();
  if (/[?¿]/.test(trimmed)) return reply;
  // El cliente cerro la conversacion: no se le vuelve a preguntar que quiere pedir (T7-010/T7-013).
  if (esDespedidaDelCliente(ultimoMensajeDelCliente)) return reply;
  const pending = pendingQuestionForMissingData(branchKnown, orderId);
  if (!pending) return reply;
  return trimmed ? `${trimmed} ${pending}` : pending;
}

/** La sucursal ya quedo resuelta en la conversacion si entro por el numero de una sucursal o si algun
 * mensaje previo del asistente la nombra (el historial persistido solo guarda texto). */
export function branchAlreadyKnown(entryBranchName: string | null, assistantTexts: readonly string[], branches: readonly BranchSummary[]): boolean {
  if (entryBranchName) return true;
  const names = branches.map((b) => b.name.toLowerCase());
  return assistantTexts.some((text) => names.some((name) => text.toLowerCase().includes(name)));
}

export type HighRiskIntent = "cancelacion_modificacion" | "cobro_duplicado" | "urgencia" | "privacidad_arco" | "transferencia" | "alergia_salud" | "queja" | "cliente_lo_pide";

export interface HighRiskMatch {
  readonly intent: HighRiskIntent;
  /** Motivo tipificado para `escalar_a_humano` (mismo valor que el intent). */
  readonly motivo: HighRiskIntent;
  readonly reply: string;
}

/** El cliente pide a una persona: infinitivo, imperativo con o sin acento ("comuníqueme", "pásame", "páseme") y "quiero una persona". Sirve a WhatsApp y a voz. */
export const PIDE_UNA_PERSONA_RE = (() => {
  // A quien se pide (con "ñ" y sin ella: el clasificador de WhatsApp corre sobre texto sin acentos).
  const quien =
    "(?:persona|humano|gerente|encargad[oa]|alguien|asesor|agente|supervisor(?:a)?|due(?:ñ|n)[oa]|jefe|jefa|operador(?:a)?|representante|responsable|administrador(?:a)?|recepcionista)";
  const det = "(?:una?\\s+|el\\s+|la\\s+|su\\s+|mi\\s+|alg[uú]n(?:a)?\\s+)?";
  const verbo =
    "(?:pasas(?:me)?|pasan(?:me)?|p[aá]sen(?:me)?|comunicas|comunican|comun[ií]quen(?:me)?|conectas|conectan|con[eé]ctenme|transfieres|transfieren|hablar|comunicar(?:me)?|comun[ií]que(?:me|se)?|comun[ií]came|pasar(?:me)?|p[aá]sa(?:me)?|p[aá]se(?:me)?|conectar(?:me)?|con[eé]cta(?:me)?|con[eé]cte(?:me)?|transferir(?:me)?|transf[ií]er[ea]?(?:me)?)";
  const fin = "(?![a-záéíóúñ])";
  return new RegExp(
    [
      // "hablar / comuníqueme / páseme con (su) supervisor"
      `\\b${verbo}\\s+(?:con|a)\\s+${det}${quien}${fin}`,
      // "quiero / necesito / prefiero una persona" y "¿me puede atender una persona?"
      `\\b(?:quiero|necesito|prefiero|busco|quisiera)\\s+(?:hablar\\s+con\\s+)?${det}(?:persona|humano)${fin}`,
      `\\b(?:puede|pueden|podr[ií]a|podr[ií]an|puedes)\\s+(?:atender(?:me)?|ayudar(?:me)?)\\s+${det}${quien}${fin}`,
      // "un humano por favor", "una persona, por favor"
      `(?<!\\bpara\\s)\\b(?:una?)\\s+(?:persona|humano)\\s*,?\\s+por\\s+favor${fin}`,
      // "que me hable / llame / atienda una persona" (main)
      `\\bque\\s+(?:me\\s+)?(?:hable|habl[eé]|llame|llam[eé]|contacte|atienda|marque|responda|conteste|escriba)\\s+${det}${quien}${fin}`,
      // ingles: "talk to a human"
      `\\b(?:talk|speak)\\s+(?:to|with)\\s+(?:a|an|the|someone|somebody)?\\s*(?:real\\s+)?(?:human|person|manager|agent|someone|somebody)\\b`,
      // "no quiero hablar con el bot" (main)
      `\\bno\\s+quiero\\s+(?:hablar\\s+con\\s+)?(?:con\\s+)?(?:el\\s+|un\\s+|la\\s+|una\\s+)?(?:bot|robot|m[aá]quina|inteligencia\\s+artificial)${fin}`,
    ].join("|"),
    "i",
  );
})();

const PIDE_UNA_PERSONA_GLOBAL = new RegExp(PIDE_UNA_PERSONA_RE.source, "gi");
/** Marco de peticion que hace de "pasar con X" un pedido de transferencia ("quiero pasar con el gerente") y no un "voy a pasar con alguien a recogerlo". */
const MARCO_DE_PETICION = /\b(?:quiero|quisiera|necesito|puedes|puede|podr[ií]as?|podr[ií]an|favor|por\s+favor|me\s+puede|me\s+pueden|le\s+pido|les\s+pido)\b/i;
/** Negacion pegada al verbo de la peticion ("no quiero", "no necesito", "no hace falta", "no es necesario", "no voy a"): solo cuenta si el "no" va JUSTO antes de
 * "hablar con...". Un "no" lejano ("no se si quiero hablar con alguien", "no quiero el bot, pasame con alguien") ya no anula una peticion real. */
const NEGACION_AL_FINAL =
  /\b(?:no|ni|nunca|jam[aá]s|tampoco)\s+(?:(?:es\s+necesario|hace\s+falta|hay\s+que|quiero|quisiera|necesito|ocupo|requiero|deseo|tengo\s+que|voy\s+a|vayas?\s+a|me\s+interesa|pienso)\s*(?:que\s+)?(?:me\s+|se\s+)?)?$/i;
/** Retractacion DESPUES de la peticion ("quiero una persona... bueno no, mejor sigo contigo", "mejor sigo aqui", "ya no, gracias"): el cliente retoma con el agente
 * y no hay nadie a quien pasarlo (QA-PM-R4-whatsapp-01: la toma callaba al agente y el pedido en curso se perdia). */
const RETRACTACION_POSTERIOR =
  /^[^.!?\n]{0,40}?\b(?:bueno\s*,?\s*)?(?:no|ya\s+no)\s*,?\s*(?:mejor\s+(?:sigo|seguimos|continuo|continuamos|contigo|con\s+usted)|gracias|olvid\w+|dejalo|dejelo|sigo|seguimos)\b|\bmejor\s+(?:sigo|seguimos|continuo|continuamos|contigo|con\s+usted)\b|\bsigo\s+(?:contigo|con\s+usted|aqui)\b/;

/** Pura: ¿el cliente pide hablar con una persona? (independiente de otros motivos de riesgo del mismo texto). NO cuenta: la negacion ("no quiero hablar con
 * una persona, con usted esta bien"), "pasar con alguien" como visita ("voy a pasar con alguien a recogerlo") ni una peticion mezclada con un pedido
 * (la peticion de una persona SIEMPRE escala, aunque venga con un pedido: "quiero 3 tacos y que me hable una persona"; el pedido lo retoma la persona). */
export function pideUnaPersona(text: string): boolean {
  for (const m of text.matchAll(PIDE_UNA_PERSONA_GLOBAL)) {
    const idx = m.index ?? 0;
    const antes = text.slice(Math.max(0, idx - 60), idx);
    const segmento = antes.slice(Math.max(antes.lastIndexOf("."), antes.lastIndexOf(","), antes.lastIndexOf(";"), antes.lastIndexOf("!"), antes.lastIndexOf("?")) + 1);
    if (NEGACION_AL_FINAL.test(segmento)) continue;
    // QA-PM-R3-voz-05: "que me atienda alguien en caja" / "alguien de caja" es una pregunta de pago al recoger (se paga en caja), no pedir una persona del equipo.
    if (/^\s+(?:de|en|a)\s+(?:la\s+)?(?:caja|cajero|mostrador)\b/i.test(text.slice(idx + m[0].length, idx + m[0].length + 24))) continue;
    if (/^pasar\b/i.test(m[0]) && !MARCO_DE_PETICION.test(segmento)) continue;
    // Retractacion posterior en el mismo mensaje: "quiero hablar con una persona... bueno no, mejor sigo contigo".
    if (RETRACTACION_POSTERIOR.test(normalizarParaClasificar(text.slice(idx + m[0].length, idx + m[0].length + 60)))) continue;
    return true;
  }
  return false;
}

/** Lo que el clasificador necesita saber del cliente para NO confundir un ajuste del carrito con una cancelacion o una queja. */
export interface HighRiskContext {
  /** Pedido de las ultimas 12 h de este telefono: `null` = no hay; ausente = desconocido (cliente nuevo o lectura no disponible). */
  readonly pedidoReciente?: PedidoReciente | null;
}

/** Texto comparable: minusculas y sin acentos. Asi "faltó" y "falto" son lo mismo (con `\b` y sin acentos el resultado ya no depende de si el cliente acentuó). */
export function normalizarParaClasificar(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Verbo en infinitivo (con o sin clitico): "me falto pedir", "me falto pedirle", "me falto agregar". Es el habla de quien SE OLVIDO de pedir algo
// (ajuste del carrito), nunca una queja por algo que no llego.
const INFINITIVO = "[a-z]{2,}(?:ar|er|ir)(?:le|les|me|se|lo|la|los|las|selo)?";
// Cambio de opinion sobre lo que se esta armando ("mejor ponme", "en vez de", "cambialo por").
const CORRECCION_DE_CARRITO = /\bmejor\b|\ben\s+(?:vez|lugar)\s+de\b|\bponme\b|\bponmanos\b|\bcambi(?:a|ame|alo|ala)\b/;
// El mensaje habla del pedido que YA existe (no de uno que se esta armando).
const HABLA_DE_SU_PEDIDO = /\b(?:mi|su|el|ese|este)\s+pedido\b|\bmi\s+orden\b|\bya\s+(?:viene|sale|salio|llego|casi)\b|\bcuanto\s+(?:tarda|falta|se\s+tarda)\b/;
const ME_FALTO = new RegExp(`\\bme\\s+falt(?:o|aron)\\b\\s*(?<resto>.*)$`);
// El mensaje describe un pedido NUEVO que se esta armando ("quiero hacer mi pedido urgente", "mi pedido: 5 tacos de pastor"): "urgente" es enfasis, no una emergencia.
const ARMA_UN_PEDIDO_NUEVO = /\bquiero\s+(?:hacer|levantar|realizar|armar|mandar)\s+(?:mi|un|el)\s+pedido\b|\b(?:hacer|levantar|realizar)\s+(?:mi|un)\s+pedido\b|\bmi\s+pedido\s*:|\bpedido\s*:\s*\d/;
// Quejas de "algo no llego / llego mal" que solo son queja si se habla de un pedido ya hecho (el mismo criterio que "me falto").
const QUEJA_DE_ENTREGA = /\bno\s+me\s+(?:llego|llegaron|trajeron|mandaron|dieron)\b|\bvino\s+(?:todo\s+|muy\s+)?(?:frio|fria|incompleto|incompleta|mal|equivocado|equivocada|aguado|revuelto)\b|\bme\s+(?:llego|llegaron|trajeron|mandaron)\s+(?:todo\s+|muy\s+)?(?:frio|fria|incompleto|incompleta|mal|equivocado|equivocada)\b/;
// Pregunta de estado o de politica sobre cancelar ("¿mi pedido se cancelo?", "¿si cancelo me cobran algo?", "¿hasta que hora se puede cancelar?"): NO pide cancelar nada.
const CONSULTA_DE_CANCELACION =
  /\b(?:se|ya\s+se|me)\s+cancel(?:o|aron)\b|\bcancelaron\b|\bsi\s+cancel(?:o|amos|aron|an|ara|aran)\b|\bhasta\s+(?:que\s+)?hora\b[^.!?\n]{0,40}\bcancel|\bse\s+puede\s+cancel|\bpuedo\s+cancel|\bpodria\s+cancel(?:ar)?\s+(?:mi|el)\s+pedido\s*\?|\bcomo\s+(?:se\s+)?cancel|\b(?:cobran|cobra|cobro|cargo|penaliz\w*|politica)\b[^.!?\n]{0,40}\bcancel|\bcancel\w*[^.!?\n]{0,40}\b(?:cobran|cobra|cobro|cargo|penaliz\w*|politica)\b/;

/** Pura: el texto PREGUNTA por la cancelacion (estado, politica, horario) en vez de pedirla. Las preguntas no cancelan ni abren solicitudes. */
export function esConsultaDeCancelacion(text: string): boolean {
  return CONSULTA_DE_CANCELACION.test(normalizarParaClasificar(text));
}

interface Patron {
  readonly intent: HighRiskIntent;
  readonly pattern: RegExp;
  readonly reply: string;
  /** Condicion adicional sobre el texto normalizado y el contexto del cliente (ausente = basta el patron). */
  readonly cuando?: (texto: string, ctx: HighRiskContext) => boolean;
}

// El orden importa: lo mas delicado primero (alergia / cobro / privacidad) para que un mensaje que
// mezcla varios motivos se atienda por el de mayor riesgo. Los patrones corren sobre texto SIN acentos.
const HIGH_RISK_PATTERNS: readonly Patron[] = [
  {
    intent: "alergia_salud",
    pattern: /\b(?:alergic[oa]s?|alergias?|intolerante|intolerancia|celiac[oa]|cacahuate|gluten)\b/,
    reply:
      "Por su seguridad no puedo asegurarle los ingredientes de un platillo ni si es apto para una alergia. Ya avisé al equipo del restaurante para que le confirme directamente antes de hacer su pedido.",
  },
  {
    intent: "cobro_duplicado",
    pattern: /cobr(?:o|aron|e)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces/,
    reply: "Lamento el problema con el cobro. Ya avisé al equipo para que revise su caso directamente y lo contacte lo antes posible.",
  },
  {
    intent: "privacidad_arco",
    pattern:
      /\b(?:borr(?:ar|en|e|a|ame)|elimin(?:ar|en|e|a|ame))\s+(?:todos\s+)?(?:mis|los)\s+datos\b|\bderechos?\s+arco\b|\barco\b.{0,20}\bdatos\b|\bmis\s+datos\s+personales\b.{0,30}\b(?:borrar|eliminar|acceder|rectificar|corregir)\b/,
    reply:
      "Recibido. Para ejercer sus derechos ARCO (acceso, rectificación, cancelación u oposición) sobre sus datos, ya avisé al equipo para que lo contacte y gestione su solicitud directamente.",
  },
  {
    // Solo "pedido": "orden" y "comanda" son UNIDADES del menu ("cancela la orden de bistec" corrige el carrito). Si ademas es un cambio de
    // opinion y el telefono no tiene un pedido ya creado, es el carrito y va al agente; un pedido ya creado SI justifica el aviso al equipo.
    intent: "cancelacion_modificacion",
    pattern: /\bcancel(?:ar|o|a|e|en)\b[^.!?\n]{0,40}\bpedido\b|\bpedido\b[^.!?\n]{0,40}\bcancel(?:ar|o|a|e|en)\b|\bcancelarme\s+(?:el|mi)\s+pedido\b/,
    // Sin pedido (el servidor ya sabe que el telefono no tiene uno reciente) no hay nada que cancelar: "olvidelo, cancele el pedido" es abandonar el carrito.
    // Una PREGUNTA sobre cancelar ("¿mi pedido se cancelo?", "¿hasta que hora se puede cancelar?") va al agente, que si puede contestarla.
    cuando: (texto, ctx) => ctx.pedidoReciente !== null && !CONSULTA_DE_CANCELACION.test(texto) && (!CORRECCION_DE_CARRITO.test(texto) || (ctx.pedidoReciente ?? null) !== null),
    reply:
      "Entendido, desea cancelar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
  },
  {
    intent: "transferencia",
    pattern: /\btransferencia\b|\bdeposito\b|\bspei\b|\bpagar\s+por\s+transfer/,
    reply:
      "Por este medio no puedo registrar pagos por transferencia. Ya avisé al equipo para que lo contacte y vea con usted esa forma de pago; si prefiere, puede pagar en efectivo o con tarjeta.",
  },
  {
    intent: "queja",
    pattern: new RegExp(
      `${/\bqueja\b|\bllego\s+(?:todo\s+|muy\s+)?(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bme\s+falt(?:o|aron)\b|\bmal\s+armado\b/.source}|${QUEJA_DE_ENTREGA.source}`,
    ),
    // "me falto" es queja solo si habla de algo que NO llego ("me falto la bebida de mi pedido"); "me falto pedir otra coca" es el carrito.
    cuando: (texto, ctx) => {
      // Quejas inequivocas (siempre escalan).
      if (/\bqueja\b|\bllego\s+(?:todo\s+|muy\s+)?(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bmal\s+armado\b/.test(texto)) return true;
      // "no me llego la coca" / "vino frio todo": queja solo si habla de un pedido ya hecho.
      if (QUEJA_DE_ENTREGA.test(texto) && !/\bme\s+falt(?:o|aron)\b/.test(texto)) {
        const estadoEntrega = ctx.pedidoReciente?.estado;
        return estadoEntrega === "entregado" || estadoEntrega === "salio" || HABLA_DE_SU_PEDIDO.test(texto);
      }
      if (!/\bme\s+falt(?:o|aron)\b/.test(texto)) return true;
      const resto = ME_FALTO.exec(texto)?.groups?.resto ?? "";
      if (new RegExp(`^(?:a\\s+)?${INFINITIVO}\\b`).test(resto)) return false;
      const estado = ctx.pedidoReciente?.estado;
      return estado === "entregado" || estado === "salio" || HABLA_DE_SU_PEDIDO.test(texto);
    },
    reply: "Lamento mucho lo ocurrido. Ya avisé al gerente para que revise su caso y lo contacte directamente; yo no puedo prometerle una reposición ni un descuento.",
  },
  {
    // "urgente" como enfasis de un pedido nuevo ("medio kilo de pastor, lo necesito urgente") NO es una emergencia: solo escala cuando habla del pedido que ya existe.
    intent: "urgencia",
    pattern: /\burgen(?:te|cia)\b/,
    cuando: (texto, ctx) => HABLA_DE_SU_PEDIDO.test(texto) && !ARMA_UN_PEDIDO_NUEVO.test(texto) && ctx.pedidoReciente !== null,
    reply: "Entendido, es urgente. Ya avisé al equipo para que lo contacte de inmediato.",
  },
  {
    intent: "cliente_lo_pide",
    pattern: PIDE_UNA_PERSONA_RE,
    cuando: (texto) => pideUnaPersona(texto),
    reply: "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
  },
];

/** Contexto de riesgo a partir de la ficha del cliente (la que ya trae el turno). */
export function contextoDeCliente(customer: CustomerLookupResult): HighRiskContext {
  return customer.isNew ? {} : { pedidoReciente: customer.pedidoReciente };
}

function coincide(p: Patron, texto: string, ctx: HighRiskContext): boolean {
  return p.pattern.test(texto) && (p.cuando ? p.cuando(texto, ctx) : true);
}

/** Pura: que motivo de alto riesgo detecta el texto entrante del cliente, si alguno. */
export function classifyHighRiskIntent(text: string, ctx: HighRiskContext = {}): HighRiskMatch | null {
  const texto = normalizarParaClasificar(text);
  for (const p of HIGH_RISK_PATTERNS) {
    if (coincide(p, texto, ctx)) return { intent: p.intent, motivo: p.intent, reply: p.reply };
  }
  return null;
}

/** Pura: el motivo de MAYOR prioridad (orden de `HIGH_RISK_PATTERNS`) entre varios mensajes del cliente, con el texto que lo disparo. En una
 * rafaga (espera de mensajes) el riesgo puede venir en cualquiera de los mensajes pendientes, no solo en el ultimo ("me cobraron dos veces" + "hola??"). */
export function classifyHighRiskIntentInMessages(texts: readonly string[], ctx: HighRiskContext = {}): (HighRiskMatch & { readonly text: string }) | null {
  let mejor: { rank: number; match: HighRiskMatch; text: string } | null = null;
  for (const text of texts) {
    const match = classifyHighRiskIntent(text, ctx);
    if (!match) continue;
    const rank = HIGH_RISK_PATTERNS.findIndex((p) => p.intent === match.intent);
    if (!mejor || rank < mejor.rank) mejor = { rank, match, text };
  }
  return mejor ? { ...mejor.match, text: mejor.text } : null;
}

/** Pura: ¿el texto dispara algun motivo de alto riesgo DISTINTO de `excepto`? (aunque otro de mayor
 * prioridad en el orden de arriba tambien coincida). */
export function matchesHighRiskOtherThan(text: string, excepto: HighRiskIntent, ctx: HighRiskContext = {}): boolean {
  const texto = normalizarParaClasificar(text);
  return HIGH_RISK_PATTERNS.some((p) => p.intent !== excepto && coincide(p, texto, ctx));
}
