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
  if (typeof reply !== "string" || !reply) return false;
  const t = normalizarParaClasificar(reply);
  const DEST = "(?:a|al|a\\s+la|a\\s+los)\\s+(?:\\w+\\s+){0,2}(?:gerente|equipo|sucursal|encargad[oa]|restaurante|personal)\\b(?![^.!?]*\\b(?:list[oa]s?|prepar\\w*|tenga\\w*)\\b)";
  // Solo afirmaciones en PASADO de haber avisado (R4-whatsapp-02/reglas-01). No cuentan el futuro ni el condicional ("le voy a avisar a la sucursal que usted pasa a las 8", "debo avisar al gerente si..."),
  // la negacion ("no tengo que avisar") ni el subjuntivo ("para que le avise"); "permitame avisar al gerente" es la promesa inmediata del aviso y si cuenta.
  const pasado = new RegExp(`(?<!\\bno\\s)(?<!\\bno\\s(?:le|les)\\s)(?<!\\bque\\s)(?<!\\bque\\s(?:le|les)\\s)\\b(?:ya\\s+)?(?:le\\s+|les\\s+)?avis(?:e|amos)\\s+(?:ya\\s+)?${DEST}`);
  const inmediata = new RegExp(`\\b(?:permitame|permitanme|dejeme)\\s+avisar(?:le|les)?\\s+(?:a|al|a\\s+la)\\s+(?:\\w+\\s+){0,2}(?:gerente|equipo|encargad[oa])\\b(?![^.!?]*\\b(?:list[oa]s?|prepar\\w*|tenga\\w*)\\b)`);
  const registrado = /\bel\s+aviso\s+(?:ya\s+)?(?:quedo|fue|se\s+registro|esta\s+registrado)\b|\b(?:ya\s+)?quedo\s+avisad[oa]\b|\b(?:gerente|gerencia|equipo|encargad[oa])\s+ya\s+(?:fue|esta|quedo)\s+(?:notificad|avisad|enterad)[oa]\b|\bya\s+(?:esta|fue)\s+(?:notificad|avisad|enterad)[oa]\s+(?:el|la)\s+(?:gerente|equipo|encargad[oa])\b/;
  // QA-PM-R6-reglas-01: el regex original decia «notificue» (typo) y nunca detectaba «notifiqué». Mismas negaciones/subjuntivo que `pasado` («que le comunique», «no le comuniqué»).
  const NO_SUBJ = "(?<!\\bno\\s)(?<!\\bno\\s(?:le|les)\\s)(?<!\\bque\\s)(?<!\\bque\\s(?:le|les)\\s)(?<!\\bpara\\s)";
  // Un aviso de preparacion («le comuniqué a la sucursal para que tenga listo su pedido») es parte del flujo normal, no un aviso al gerente.
  // Tambien es parte del flujo normal avisarle a la sucursal que el cliente pasa a recoger («que usted pasa a las 8») o consultarle si hay un producto («y si hay pastor»).
  const SIN_PREPARACION = "(?![^.!?]*\\b(?:list[oa]s?|prepar\\w*|tenga\\w*|pasa(?:r|ra|n)?|recog\\w*|hay|disponibles?)\\b)(?![^.!?]*\\ba\\s+las\\s+\\d)";
  const PERSONA_AVISO = "(?:gerente|gerencia|equipo|sucursal|encargad[oa]|restaurante|personal|duen[oa])";
  const notifique = new RegExp(
    `${NO_SUBJ}\\b(?:le\\s+|les\\s+)?(?:notifiqu(?:e)|notificamos|comuniqu(?:e)|comunicamos|escal(?:e|amos))\\s+(?:ya\\s+)?(?:su\\s+(?:caso|queja|solicitud|reclamo)\\s+)?(?:(?:al|a\\s+la|a\\s+los)\\s+(?:\\w+\\s+){0,2}${PERSONA_AVISO}\\b${SIN_PREPARACION})` +
      `|${NO_SUBJ}\\b(?:ya\\s+)?(?:le\\s+|les\\s+)?(?:pase|reporte|mande|envie|comente|dije|hice\\s+llegar)\\s+(?:ya\\s+)?(?:su\\s+(?:caso|queja|solicitud|reclamo|mensaje)|el\\s+(?:aviso|mensaje|recado)|lo\\s+que\\s+(?:me\\s+)?(?:dijo|comento|pidio))\\s+(?:al|a\\s+la|a\\s+los)\\s+(?:\\w+\\s+){0,2}${PERSONA_AVISO}\\b${SIN_PREPARACION}` +
      `|${NO_SUBJ}\\bya\\s+(?:habl(?:e|amos)|platiqu(?:e|amos))\\s+con\\s+(?:el\\s+|la\\s+|los\\s+)?(?:\\w+\\s+){0,1}${PERSONA_AVISO}\\b${SIN_PREPARACION}` +
      `|${NO_SUBJ}\\b(?:dej(?:e|amos))\\s+(?:el\\s+|un\\s+)?(?:recado|mensaje|aviso)\\s+(?:con|al|a\\s+la|para)\\s+(?:el\\s+|la\\s+)?(?:\\w+\\s+){0,1}${PERSONA_AVISO}\\b${SIN_PREPARACION}`,
  );
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
  if (typeof frase !== "string" || !frase) return false;
  const t = normalizarParaClasificar(frase);
  if (/[?¿]/.test(frase)) return false;
  // Condicional / negacion / futuro: no afirman nada. «si» se mira en el texto ORIGINAL para no confundir el «sí» afirmativo ("Sí, su pedido ya quedó registrado") con el condicional «si».
  if (/(?:^|[\s¡,;:(])si(?=[\s,])/.test(frase.toLowerCase())) return false;
  if (/\b(?:cuando|para\s+que|una\s+vez|antes\s+de|hasta\s+que|en\s+cuanto|no\s+(?:esta|queda|quedo|ha|he|hemos|se)|todavia\s+no|aun\s+no|(?:todavia|aun)\s+falta|falta|quedaria|quedarian|podria|podrian|va\s+a\s+(?:quedar|ser|estar)|pudo\s+ser|no\s+pudo|tampoco|nunca)\b/.test(t)) return false;
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
    // Defensa adicional (QA-PM-R8 A41; NO es la causa demostrada: main ya atrapa «ya quedó registrado»): el modelo describe el pedido entre sujeto y predicado («su pedido de 2 tacos ($84) en García Lavín quedó registrado»).
    // Hasta 14 palabras sin cruzar de frase, y el participio debe ser de REGISTRAR/CREAR el pedido (o ir con «quedó/está/fue»): «el precio confirmado de $126» o «el envío confirmado a Calle 60» no cuentan.
    new RegExp(`\\b${N}\\b(?:\\s+(?!${OBJETO}\\b)[^\\s.!?;]+){0,14}?\\s+(?:ya\\s+)?(?:registrad[oa]|generad[oa]|levantad[oa]|capturad[oa]|procesad[oa])\\b`),
    new RegExp(`\\b${N}\\b(?:\\s+(?!${OBJETO}\\b)[^\\s.!?;]+){0,14}?\\s+(?:ya\\s+)?(?:quedo|queda|esta|fue|ha\\s+sido|va|se\\s+(?:genero|tomo|registro|confirmo|envio|mando|paso|levanto))\\s+(?:ya\\s+)?(?:${PART}|${SALIDA})\\b`),
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
    // QA-PM-R6-reglas-05: frases cortas sin sujeto «pedido»: «ya tengo todo anotado», «quedó apartado» (el cliente las lee como pedido registrado).
    new RegExp(`^(?!.*\\b${OBJETO}\\b).*\\b(?:ya\\s+tengo\\s+todo\\s+(?:anotad[oa]|registrad[oa]|apartad[oa])|quedo\\s+(?:ya\\s+)?apartad[oa])\\b`),
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
  // Menor de #522: tambien sin sujeto, en plural impersonal ("Le atienden a partir de las 12", "le responden a partir de las 12").
  return reply.replace(
    /(?:,?\s*(?:y\s+)?)(?:(?:el\s+(?:equipo|gerente)(?:\s+de\s+la\s+sucursal)?|la\s+sucursal)\s+(?:le\s+)?(?:responde|contesta|responder[aá]n?|contestar[aá]n?|atiende|atender[aá]n?|escribe|escribir[aá]n?)|(?:le\s+)?(?:atienden|responden|contestan))\s+a\s+partir\s+de\s+las\s+12(?:\s*(?::00|h|hrs?\.?))?\s*(?:del\s+d[ií]a|del\s+mediod[ií]a|pm|p\.m\.)?/gi,
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
  // QA-PM-R6: antes bastaba que el agente dijera «guacamole» o «extra» en CUALQUIER frase (incluso «extra salsa» o «Anoto Extra Guacamole, ¿algo mas?») para dar la aclaracion por hecha; ahora debe ser una
  // PREGUNTA que ofrezca la ELECCION platillo / extra («¿el guacamole como platillo o un extra para sus tacos?»).
  // Revision de #551: tambien cuenta la eleccion con otras palabras («¿extra ($49) o completo ($142)?», «¿chico o grande?», «¿entero o para sus tacos?»): una pregunta con «o» que pone
  // al menos dos opciones distintas del guacamole. «Anoto Extra Guacamole, ¿algo mas?» no ofrece eleccion.
  const OPCIONES: readonly RegExp[] = [/\bplatillo\b|\bplato\b|\borden(?:es)?\b/, /\baparte\b/, /\bextras?\b|\bagregado\b|\bpara\s+(?:sus|los|mis)\s+tacos?\b/, /\bcompleto\b|\bentero\b/, /\bchico\b|\bpequeno\b/, /\bgrande\b/];
  const ofreceEleccion = (t: string): boolean =>
    /\?/.test(t) && /\bo\b/.test(t) && /guacamole|extra|chico|grande|entero|completo/.test(t) && OPCIONES.filter((re) => re.test(t)).length >= 2;
  const pregunto = despues.findIndex((m) => m.role === "assistant" && ofreceEleccion(m.t));
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

export type HighRiskIntent = "cancelacion_modificacion" | "modificacion_pedido" | "cobro_duplicado" | "urgencia" | "privacidad_arco" | "transferencia" | "alergia_salud" | "queja" | "cliente_lo_pide";

export interface HighRiskMatch {
  readonly intent: HighRiskIntent;
  /** Motivo tipificado para `escalar_a_humano`. Es el valor del intent salvo `modificacion_pedido`, que se avisa al equipo como `cancelacion_modificacion` (la misma bandeja y SLA). */
  readonly motivo: Exclude<HighRiskIntent, "modificacion_pedido">;
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
      `\\b(?:quiero|necesito|prefiero|busco|quisiera)\\s+(?:hablar\\s+con\\s+)?${det}(?:persona|humano|asesor(?:a)?)${fin}`,
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
  /^[^.!?\n]{0,40}?\b(?:bueno\s*,?\s*)?(?:no|ya\s+no)\s*,?\s*(?:mejor\s+(?:sigo|seguimos|continuo|continuamos|contigo|con\s+usted)|gracias(?!\s+a\s+(?:ustedes|usted|ud|uds|ti|ellos|nadie))|olvid\w+|dejalo|dejelo|sigo|seguimos)\b|\bmejor\s+(?:sigo|seguimos|continuo|continuamos|contigo|con\s+usted)\b|\bsigo\s+(?:contigo|con\s+usted|aqui)\b/;

/** ¿El mensaje, solo, retoma con el agente ("mejor sigo contigo", "no, gracias")? Sirve para no abrir la toma por una peticion que el cliente ya retiro en un mensaje POSTERIOR. */
export function retractaPeticionDePersona(text: string): boolean {
  return RETRACTACION_POSTERIOR.test(normalizarParaClasificar(text));
}

/** Pura: ¿el cliente pide hablar con una persona? (independiente de otros motivos de riesgo del mismo texto). NO cuenta: la negacion ("no quiero hablar con
 * una persona, con usted esta bien"), "pasar con alguien" como visita ("voy a pasar con alguien a recogerlo") ni una peticion mezclada con un pedido
 * (la peticion de una persona SIEMPRE escala, aunque venga con un pedido: "quiero 3 tacos y que me hable una persona"; el pedido lo retoma la persona). */
export function pideUnaPersona(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  for (const m of text.matchAll(PIDE_UNA_PERSONA_GLOBAL)) {
    const idx = m.index ?? 0;
    const antes = text.slice(Math.max(0, idx - 60), idx);
    const segmento = antes.slice(Math.max(antes.lastIndexOf("."), antes.lastIndexOf(","), antes.lastIndexOf(";"), antes.lastIndexOf("!"), antes.lastIndexOf("?")) + 1);
    if (NEGACION_AL_FINAL.test(segmento)) continue;
    // QA-PM-R3-voz-05: "que me atienda alguien en caja" / "alguien de caja" es una pregunta de pago al recoger (se paga en caja), no pedir una persona del equipo.
    if (/^\s+(?:de|en|a)\s+(?:la\s+)?(?:caja|cajero|mostrador)\b/i.test(text.slice(idx + m[0].length, idx + m[0].length + 24))) continue;
    if (/^pasar\b/i.test(m[0]) && !MARCO_DE_PETICION.test(segmento)) continue;
    // QA-PM-R5 (menor de #522): "se lo pasan a la persona que va a recoger" es entregar el pedido a OTRA persona, no pedir hablar con una: "pasan a la persona" sin "me" ni marco de peticion.
    if (/^p[aá]s(?:a|as|an|e|en|ar)\s+a\b/i.test(m[0]) && !MARCO_DE_PETICION.test(segmento)) continue;
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

const CARACTERES_INVISIBLES = /\u034f|[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** Texto comparable: minusculas y sin acentos. Asi "faltó" y "falto" son lo mismo (con `\b` y sin acentos el resultado ya no depende de si el cliente acentuó). */
export function normalizarParaClasificar(text: string): string {
  if (typeof text !== "string") return "";
  // R11-07: NFKD pliega las formas de ancho completo ("ａｌｅｒｇｉｃｏ") y las ligaduras a su forma base, y se quitan los caracteres invisibles
  // (ancho cero, guion suave, marcas de direccion, BOM) que partirian una palabra de riesgo sin cambiar lo que el cliente lee.
  return text.normalize("NFKD").replace(CARACTERES_INVISIBLES, "").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Verbo en infinitivo (con o sin clitico): "me falto pedir", "me falto pedirle", "me falto agregar". Es el habla de quien SE OLVIDO de pedir algo
// (ajuste del carrito), nunca una queja por algo que no llego.
const INFINITIVO = "[a-z]{2,}(?:ar|er|ir)(?:le|les|me|se|lo|la|los|las|selo)?";
// Cambio de opinion sobre lo que se esta armando ("mejor ponme", "en vez de", "cambialo por").
const CORRECCION_DE_CARRITO = /\bmejor\b|\ben\s+(?:vez|lugar)\s+de\b|\bponme\b|\bponmanos\b|\bcambi(?:a|ame|alo|ala)\b/;
// El mensaje habla del pedido que YA existe (no de uno que se esta armando).
const HABLA_DE_SU_PEDIDO = /\b(?:mi|su|el|ese|este)\s+pedido\b|\bmi\s+orden\b|\bya\s+(?:viene|sale|salio|llego|casi)\b|\bcuanto\s+(?:tarda|falta|se\s+tarda)\b/;
const ME_FALTO = new RegExp(`\\b(?:me|le|les|nos)\\s+falt(?:o|aron)\\b\\s*(?<resto>.*)$`);
// El mensaje describe un pedido NUEVO que se esta armando ("quiero hacer mi pedido urgente", "mi pedido: 5 tacos de pastor"): "urgente" es enfasis, no una emergencia.
const ARMA_UN_PEDIDO_NUEVO = /\bquiero\s+(?:hacer|levantar|realizar|armar|mandar)\s+(?:mi|un|el)\s+pedido\b|\b(?:hacer|levantar|realizar)\s+(?:mi|un)\s+pedido\b|\bmi\s+pedido\s*:|\bpedido\s*:\s*\d/;
const PREGUNTA_DE_CARGO_FUTURO = /\bsi\s+(?:pago|paga|pagan|pagamos|uso|usa|elijo|pido|compro)\b|\b(?:al|por)\s+pagar\b|\bcuando\s+(?:pago|paga|pagan)\b/;
const MALESTAR_CLINICO = /\bintoxic\w*|\bintoxiqu\w*|\bdiarrea\b|\bvomit\w*|\benvenen\w*|\bcomida\s+(?:\w+\s+){0,2}(?:en\s+mal\s+estado|descompuesta)\b/;
const MALESTAR_COLOQUIAL = /\bme\s+(?:enferm\w*|cayo\s+mal|hizo\s+dano|dio\s+(?:dolor|asco))\b|\bdolor\s+de\s+(?:estomago|panza)\b/;
// El malestar viene de haber comido AHI: «despues de comer», «sus tacos», «lo que comi», «la comida de ayer». Sin esto es el cliente describiendo su estado o una preferencia al pedir.
const HABLA_DE_LO_QUE_COMIO =
  /\b(?:comi|comimos|cene|cenamos|almorce|almorzamos|desayune|probe|consumi|despues\s+de\s+(?:comer|cenar|almorzar|desayunar|probar)|ayer\s+(?:en|con)\s+(?:ustedes|su)|(?:su|sus|esa|esas|esos)\s+(?:comida|alimentos?|tacos?|platillos?|pastor|bistec|guacamole|salsas?)|la\s+comida|lo\s+que\s+(?:pedi|comi|me\s+(?:mandaron|trajeron|vendieron)))\b/;
// QA-PM-R6-reglas-02: «llevo 2 horas esperando mi pedido» es una espera larga del pedido que ya existe (urgencia), con o sin la palabra «urgente».
const ESPERA_LARGA = /\bllevo\s+(?:mas\s+de\s+)?(?:(?<n>\d+|un|una|dos|tres|cuatro|cinco|media)\s+)?(?<unidad>horas?|minutos?)(?<ymedia>\s+y\s+media)?\b[^.!?\n]{0,30}\besperando\b/;
/** Una espera es «larga» (urgencia) desde este tiempo: el pedido PROMETE 60 a 75 minutos, asi que menos de eso (o la hora exacta) es lo normal, no una emergencia. */
export const ESPERA_LARGA_MINUTOS = 90;
const NUMERO_EN_PALABRAS: Readonly<Record<string, number>> = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, media: 0.5 };
/** Minutos que dice llevar esperando el cliente («llevo 2 horas esperando» = 120, «media hora» = 30); `null` si el texto no dice una espera. */
function minutosDeEspera(texto: string): number | null {
  const g = ESPERA_LARGA.exec(texto)?.groups;
  if (!g) return null;
  // «hora y media» (sin numero) = 90 minutos.
  const n = g.n === undefined ? (g.ymedia ? 1 : NaN) : (NUMERO_EN_PALABRAS[g.n] ?? Number(g.n));
  if (!Number.isFinite(n)) return null;
  return n * (/^hora/.test(g.unidad ?? "") ? 60 : 1) + (g.ymedia ? 30 : 0);
}
/** Espera larga de un pedido VIGENTE: registrado, preparando o en camino (no entregado, no cancelado, no un cliente sin pedido). Sin el dato del pedido (lectura no disponible) solo cuenta si el
 * texto habla de «mi pedido». */
function esperaLargaDelPedido(texto: string, ctx: HighRiskContext): boolean {
  const min = minutosDeEspera(texto);
  if (min === null || min < ESPERA_LARGA_MINUTOS) return false;
  const estado = ctx.pedidoReciente?.estado;
  if (ctx.pedidoReciente === undefined) return HABLA_DE_SU_PEDIDO.test(texto);
  return estado === "registrado" || estado === "preparando" || estado === "salio";
}
// Quejas de "algo no llego / llego mal" que solo son queja si se habla de un pedido ya hecho (el mismo criterio que "me falto").
const QUEJA_DE_ENTREGA = /\bno\s+me\s+(?:llego|llegaron|trajeron|mandaron|dieron)\b|\bvino\s+(?:todo\s+|muy\s+)?(?:frio|fria|incompleto|incompleta|mal|equivocado|equivocada|aguado|revuelto)\b|\bme\s+(?:llego|llegaron|trajeron|mandaron)\s+(?:todo\s+|muy\s+)?(?:frio|fria|incompleto|incompleta|mal|equivocado|equivocada)\b/;
// Pregunta de estado o de politica sobre cancelar ("¿mi pedido se cancelo?", "¿si cancelo me cobran algo?", "¿hasta que hora se puede cancelar?"): NO pide cancelar nada.
const CONSULTA_DE_CANCELACION =
  /\b(?:se|ya\s+se|me)\s+cancel(?:o|aron)\b|\bcancelaron\b|\bsi\s+cancel(?:o|amos|aron|an|ara|aran)\b|\bhasta\s+(?:que\s+)?hora\b[^.!?\n]{0,40}\bcancel|\bse\s+puede\s+cancel|\bpuedo\s+cancel|\bpodria\s+cancel(?:ar)?\s+(?:mi|el)\s+pedido\s*\?|\bcomo\s+(?:se\s+)?cancel|\b(?:cobran|cobra|cobro|cargo|penaliz\w*|politica)\b[^.!?\n]{0,40}\bcancel|\bcancel\w*[^.!?\n]{0,40}\b(?:cobran|cobra|cobro|cargo|penaliz\w*|politica)\b/;

/** Pura: el texto PREGUNTA por la cancelacion (estado, politica, horario) en vez de pedirla. Las preguntas no cancelan ni abren solicitudes. */
export function esConsultaDeCancelacion(text: string): boolean {
  return CONSULTA_DE_CANCELACION.test(normalizarParaClasificar(text));
}

// ── R11-04: alergia / cobro doble en ingles ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Los patrones corren sobre texto sin acentos. «nuts» a secas es una palabra comun («this is nuts»): solo cuenta con contexto de comida.
const ALERGIA_EN =
  /\ballerg\w*|\bcoeliac\w*|\bceliac\w*|\bpeanuts?\b|\btree\s+nuts?\b|\bnut[\s-]free\b|\b(?:contain\w*|has|have|with|without|any|free\s+of|no)\s+nuts?\b|\bshellfish\b|\bintolerant\b|\bintolerance\b|\banaphyla\w*|\bepi[\s-]?pen\b/;
const COBRO_DOBLE_EN =
  /\bcharged\s+(?:me\s+|us\s+|my\s+card\s+)?(?:twice|two\s+times|double)\b|\bbilled\s+(?:me\s+|us\s+)?twice\b|\b(?:paid|pay)\s+twice\b(?!\s+(?:the|as|what|more|that|my|your))|\b(?:double|duplicate)[\s-]+(?:charge\w*|payment|billing)\b|\b(?:charged|billed)\s+(?:me\s+)?(?:a\s+)?second\s+time\b/;
const PREGUNTA_DE_CARGO_FUTURO_EN =
  /\b(?:will|would|do|does|can|could)\s+(?:i|you|we|it|they|someone)\b[^.!?\n]{0,30}\b(?:charge|bill|pay)\b|\bif\s+i\s+(?:pay|use|choose|order)\b/;
/** Alergia dicha en broma («soy alergico a los lunes», «allergic to mornings»): no es un riesgo de salud. Solo exime cuando NO hay ademas un termino de comida/salud. */
const BROMA_DE_ALERGIA =
  /\b(?:alergic[oa]s?|allergic)\s+(?:a|to)\s+(?:the\s+|los?\s+|las?\s+|el\s+|la\s+)?(?:lunes|mondays?|madrugar|mornings?|trabajar|work|working|ejercicio|exercise|cardio|tarea|homework|gym|gimnasio|mananas?|filas?|lines|people|gente|fiestas?)\b/;
const ALERGIA_CON_COMIDA =
  /\b(?:cacahuate|mariscos?|camarones?|nueces|nuez|gluten|lacteos?|lactosa|huevo|soya|ajonjoli|pescado|peanuts?|nuts?|shellfish|shrimp|dairy|lactose|eggs?|soybeans?|sesame|fish)\b/;
export function esBromaDeAlergia(texto: string): boolean {
  return BROMA_DE_ALERGIA.test(texto) && !ALERGIA_CON_COMIDA.test(texto);
}
/** «No tengo alergias», «no soy alergico», «no allergies», «not allergic»: lo dice para tranquilizar, no para avisar. Si ademas cuenta de OTRA persona o contrasta («pero mi hija si»), escala. */
const NEGACION_DE_ALERGIA =
  /\b(?:no\s+(?:soy|tengo|somos|tenemos|hay|existe)\s+(?:\w+\s+){0,2}(?:alergic[oa]s?|alergias?|intolerancias?)|sin\s+alergias?|no\s+allergies|not\s+allergic|no\s+(?:food\s+)?allergy|(?:i|we)\s+(?:don'?t|do\s+not)\s+have\s+(?:any\s+)?(?:food\s+)?allerg\w*|(?:i'?m|i\s+am)\s+not\s+allergic)\b/;
const CONTRASTE_DE_ALERGIA =
  /\b(?:pero|aunque|excepto|menos|salvo|but|except|however|mi\s+(?:hij\w*|espos\w*|novi\w*|amig\w*|mam\w*|papa|nino\w*|bebe)|my\s+(?:daughter|son|wife|husband|friend|kid|kids|child|baby|mom|dad)|alguien|someone|one\s+of)\b/;
export function niegaTenerAlergia(texto: string): boolean {
  if (!NEGACION_DE_ALERGIA.test(texto) || CONTRASTE_DE_ALERGIA.test(texto)) return false;
  // Si tras quitar la negacion aun queda un termino de alergia afirmativo, escala.
  const resto = texto.replace(new RegExp(NEGACION_DE_ALERGIA.source, "g"), " ");
  return !/\b(?:alergic[oa]s?|alergias?|allerg\w*|celiac\w*|coeliac\w*|intolerante|intolerancia|intolerant|cacahuate|peanuts?|gluten|mariscos?|shellfish)\b/.test(resto);
}

// ── R11-06: reembolso ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REEMBOLSO =
  /\breembols\w*|\bdevoluci(?:on|ones)\s+(?:de|del)\s+(?:mi\s+|el\s+|su\s+|este\s+|todo\s+el\s+)?dinero|\bdevuel\w*\s+(?:mi|el|todo\s+mi|todo\s+el)\s+dinero|\bmi\s+dinero\s+de\s+vuelta|\bregres\w*\s+(?:mi|el)\s+dinero|\brefund\w*|\bmoney\s+back\b|\bgive\s+me\s+my\s+money\b/;
const POLITICA_SIN_DEVOLUCIONES = "Por política no hacemos devoluciones de dinero, solo cambio de producto";
export const RESPUESTA_REEMBOLSO_ESCALADO = `Lamento lo ocurrido. ${POLITICA_SIN_DEVOLUCIONES}; ya avisé al gerente para que revise su caso y lo contacte directamente. ¿Me puede decir qué faltó o qué llegó mal?`;
/** «¿Tienen política de reembolso?», «do you have a refund policy?»: pregunta por la regla, no pide el dinero. La contesta el agente (regla 6b del prompt) y la guardia posterior cuida su respuesta. */
const PREGUNTA_POLITICA_REEMBOLSO =
  /\b(?:hacen|hay|tienen|tiene|aceptan|manejan|ofrecen|existe|cual\s+es|cuales\s+son|como\s+funciona\w*|politicas?|puedo|puede|podria|podrian|duda|dudas|pregunta|solo\s+cambio|do\s+you|can\s+i|could\s+i|question|doubt|does|is\s+there|are\s+there|what\s+is|what'?s|policy|policies)\b/;
const EXIGE_EL_DINERO = /\b(?:quiero|exijo|necesito|devuelvan\w*|devuelvame|i\s+want|i\s+need|give\s+me)\b/;
/** Hechos de una queja ya ocurrida («me cobraron mal», «llego frio», «faltaron cosas»): con ellos una pregunta de dinero SI escala. */
const HECHO_DE_QUEJA = /\b(?:cobraron|cobro\s+(?:mal|doble|de\s+mas)|llego|llegaron|llegó|falto|faltaron|incompleto|frio|fria|crudo|tardaron|tardo\s+(?:mucho|horas)|nunca\s+lleg\w+|no\s+lleg\w+|equivocaron|equivocaste|mal\s+(?:hecho|preparad\w+)|pesimo|horrible|queja|reclamo|molest\w+|enojad\w+|did(?:n'?t|\s+not)\s+(?:arrive|come)|cold|missing|wrong|late|charged)\b/;
export function preguntaPorLaPoliticaDeReembolso(texto: string): boolean {
  const esPregunta = /[?¿]/.test(texto) || /\b(?:duda|dudas|pregunta|preguntas|question|doubt|wondering|curious)\b|\b(?:saber|dime|dinos|digame|avisame|informame)\s+si\b/.test(texto);
  // «¿Que pasa si quiero un reembolso?» / «if I want a refund»: el verbo de exigencia va en hipotesis, es duda de politica.
  const sinHipotesis = texto.replace(/\b(?:si|if)\s+(?:yo\s+|i\s+)?(?:quiero|necesito|want|need)\b/g, " ");
  if (!esPregunta || EXIGE_EL_DINERO.test(sinHipotesis)) return false;
  if (PREGUNTA_POLITICA_REEMBOLSO.test(texto)) return true;
  // «¿Me devuelven mi dinero?», «¿cuanto tarda el reembolso?»: pregunta (con signo) sin verbo de exigencia ni hecho de queja = duda de politica, no aviso al gerente.
  return /[?¿]/.test(texto) && !HECHO_DE_QUEJA.test(texto);
}
/** «No quiero reembolso, solo cambien el producto», «no refund needed»: lo descarta, no lo pide. */
export function niegaQuererReembolso(texto: string): boolean {
  return /\b(?:no|ni|not|never|nunca)\s+(?:\w+\s+){0,3}(?:reembols\w*|refund\w*)|\b(?:sin|without)\s+(?:\w+\s+)?(?:reembols\w*|refund\w*)|\bno\s+(?:\w+\s+){0,2}(?:quiero|necesito|pido|exijo|busco)\s+(?:que\s+me\s+)?(?:\w+\s+){0,2}(?:devoluci\w+\s+de\w*\s+dinero|mi\s+dinero)/.test(texto) &&
    !/\b(?:pero|aunque|but)\b/.test(texto);
}

// ── R11-03a / R11-03b: promesas de dinero fuera de politica ──────────────────────────────────────────────────────────────────────────────────────
// Decision vigente: NO hay devoluciones de dinero (solo cambio de producto) y el unico descuento es el que `cotizar_pedido` calcula. El modelo NO tiene herramienta para reembolsar ni
// descontar: solo puede PROMETERLO por texto. La defensa principal es el prompt + escalar a un humano; esta guardia es una red de ultimo recurso.
//
// DISENO (R12 revision 3, «precision primero»): una lista negra de frases es un juego del gato y el raton, y cada ronda abria falsos positivos en lo mas comun del negocio (dar CAMBIO en
// efectivo, confirmar un pago, reponer un platillo). Un falso positivo (borrar una frase legitima) es PEOR que un falso negativo exotico. Por eso la guardia dispara SOLO con senales de
// alta precision y respeta una exclusion general por contexto:
//   1. SENAL A (sin exclusion de contexto, solo la negacion): VERBOS DE PROMESA con reembolso/refund («reembolsamos», «haremos el reembolso», «se le reembolsara», «we will refund you»),
//      «money back», «devolucion de su dinero» o «de lo pagado», «su dinero de regreso». Nombrar la palabra sin prometer (politica, «su solicitud de reembolso», «lo decide el gerente») NO dispara.
//   2. SENAL B: devolver/regresar/reintegrar (formas del restaurante: «devolvemos», «regresaremos», «devolverle») + «su dinero», «lo pagado», «el importe de su pedido», «el pago completo» o
//      «a su tarjeta/cuenta bancaria» (y su pasiva). Mandar/enviar/transferir/depositar y los gerundios/imperativos NO cuentan (son envio de pedido o instruccion de pago al cliente).
//   3. SENAL DE DESCUENTO: «descuent*» con verbo de oferta (hacemos, damos, aplicamos, aplicara, haremos, hago, doy, aplico, podemos...) o con porcentaje dirigido a SU pedido/cuenta,
//      salvo que la cotizacion vigente traiga una promocion (`respaldaDescuento`) o sea un descuento condicional de la carta.
//   4. EXCLUSION (aplica a B y a descuentos): si la oracion trata de CAMBIO/vuelto en efectivo, de CONFIRMAR o dar seguimiento a un PAGO (acredit*, abon*, propina, terminal...) o de
//      cosas que se devuelven a mano (link, llamada, cotizacion, pedido corregido) NO se toca, aunque aparezca devolver/regresar. Una negacion («no hacemos reembolsos») tampoco.
//   5. NUNCA disparan por si solos: «cobro», «sin costo», «reposicion/reponer», «corregido», «cambio de producto», ni total/costo/importe/monto/pago sueltos.
//
// FALSOS NEGATIVOS ACEPTADOS POR DISENO (promesas que NO se reemplazan; el prompt y la escalacion a humano son la defensa):
//   - Sin la palabra dinero/reembolso: «Se le hara la devolucion.», «Procederemos con la devolucion de su pedido.», «Le bonificamos el total.», «Le compensamos con $100 de credito.»
//   - Descuento disfrazado o con otra raiz: «Le descontamos $50 de su pedido.», «Su pedido corre por nuestra cuenta.», «Su pedido sale gratis.», «Se lo regalamos.», «precio especial para usted».
//   - Choque con la exclusion de contexto (efectivo/pago/acreditar): «Le acreditamos el monto a su tarjeta.», «Le devolvemos su dinero en efectivo.», «Su pago se regresara en 3 dias.»
//   - Perifrasis sin la senal exacta: «Le pagamos de vuelta lo que cobramos», «We'll make it up to you with $50», «We will pay you back».
//   - Verbos de envio o transferencia: «Le mandamos su dinero de regreso» (solo cae por «de regreso»), «Le transferimos el importe de su pedido», «Le depositamos lo pagado».
//   - Reembolso con sujeto distinto o sin verbo de promesa: «Procesaremos su solicitud de reembolso», «El gerente autorizara el reembolso».
//   - «Su dinero de vuelta/de regreso» (modismo del VUELTO) ya NO es senal A: «Su dinero de regreso a su tarjeta en 3 dias» se reemplaza, pero con billete/cambio/efectivo/«a su mano»/«son $X»/
//     «no a su tarjeta» NO. Tampoco se reemplaza si una negacion del destino va DESPUES del objeto («Le devolvemos $15 a su mano, no a su tarjeta»).
//   - R12 revision 6: la negacion del destino es SOLO «no (es) a su tarjeta/cuenta», «no por/en tarjeta», «sin/ni tarjeta» pegado y «no es reembolso»; «sin costo/sin cargo/no se preocupe ... a su
//     tarjeta» es promesa. Un destino afirmativo (tarjeta/cuenta/banco) no se exime por el contexto de vuelto, y un plazo («en 3 dias», «lo autoriza el gerente») anula el contexto debil (repartidor/caja).
//   - R12 revision 7: en «su dinero de vuelta/de regreso» el destino afirmativo solo cuenta si va DESPUES del objeto, sin punto/«;»/«:» de por medio y sin verbo o sustantivo de COBRO entre ambos
//     («y cobra a su tarjeta», «el cargo a su tarjeta», «el voucher», «la diferencia se cobra», «el consumo se paso a su cuenta»); «a su cuenta de la mesa / quedaron $0» es la cuenta de la mesa y la
//     negacion cubre jamas/nunca/«sin pasar»/«no lo mandamos»/«no se regresa|abona»/«no por transferencia». Si la tarjeta/cuenta aparece pero como cobro o negada, es vuelto y no se toca. Se permite
//     una coma entre objeto y destino («Su dinero de vuelta, son $120, a su tarjeta en 3 dias»). FALSOS NEGATIVOS ACEPTADOS: destino antes del objeto sin verbo de devolver («A su tarjeta le damos su
//     dinero de vuelta»), destino en otra oracion, o con cobro en medio («Su dinero de vuelta, el cobro se revierte a su tarjeta»). La senal B ya no dispara con «su dinero de vuelta/de regreso»
//     (lo decide la rama del modismo), asi que «El mesero le devuelve su dinero de vuelta» es vuelto. Sigue FP conocido: «Le damos su dinero de vuelta y su cuenta queda en cero.»
//   - Observaciones menores del revisor (se mantienen): «Le puedo ofrecer el combo con descuento de la carta.» se reemplaza (verbo de oferta + descuento sin respaldo en la cotizacion) y
//     «Le damos un descuento en su proxima visita si nos sigue en Instagram.» se reemplaza (aceptable: es una promesa que el modelo no puede cumplir).
//   - Descuento ya hecho o en pasado: «Ya le aplique el descuento» (sin herramienta, no tiene efecto real; escala el prompt).
const NO_ES_COSA_DE_DINERO = /\b(?:link|liga|enlace|llamada|mensaje|cotizacion|comprobante|ticket|recibo|resumen|desglose|detalle|puntos?|reciba|recibamos|refleje|reflejen|corregid\w*|charolas?|envases?|garrafon\w*|para\s+que\s+(?:\w+\s+)?(?:confirme|revise|verifique|valide|apruebe))\b/;
const CAMBIO_O_PAGO =
  /\b(?:que\s+sobre|sobrante|sobrantes|sobra|sobren|de\s+mas|cambio|vuelto|feria|efectivo|billetes?|monedas?|propinas?|terminal|acredit\w*|abon\w*|paga\s+con|pagas\s+con|pagando\s+con|pago\s+(?:en\s+efectivo|recibido|confirmado|registrado|aprobado|exitoso)|recibimos\s+su\s+pago|change|cash|tips?|credited|payment\s+(?:received|confirmed|approved))\b/;
// «cambio de producto/platillo/pedido» es la politica, no el vuelto: se quita antes de buscar el contexto de efectivo.
const CAMBIO_DE_PRODUCTO = /\bcambios?\s+(?:de|del|por)\s+(?:producto|productos|platillo|platillos|pedido|orden|articulo)\b|\bcambiar(?:le)?\s+(?:el|su|la)\s+(?:producto|platillo|pedido|orden)\b/g;
const SOLO_CAMBIO_DE_PRODUCTO = /\b(?:solo|unicamente|nada\s+mas)\s+(?:hacemos\s+|damos\s+|ofrecemos\s+|hay\s+)?cambio|\bonly\s+(?:an?\s+|product\s+)?exchange/;
function contextoDeCambioOPago(t: string): boolean {
  return CAMBIO_O_PAGO.test(t.replace(CAMBIO_DE_PRODUCTO, " ")) || NO_ES_COSA_DE_DINERO.test(t);
}
// Solo formas conjugadas/infinitivo en las que EL RESTAURANTE devuelve («devolvemos», «regresaremos», «devolverle»). Quedan fuera mandar/enviar/transferir/depositar (instruccion de pago o
// envio de pedido al cliente: «mande el dinero exacto», «transfiera el pago completo», «le enviamos el importe») y los gerundios/imperativos («Regresando a su pedido...», «devuelvame»).
const VERBO_DEVOLVER =
  "(?:devolv(?:emos|eremos|er|erle|erles|eria|eriamos)|devuelv(?:e|en)|regres(?:amos|aremos|ar|arle|arles|aria)|reintegr(?:amos|aremos|ar|arle|arles)|retorn(?:amos|aremos|ar|arle|arles))";
// R12 revision 4: se quitaron las formas de primera persona del SINGULAR («regreso», «devuelvo», «regresare», «reintegro», «retorno»): en un chat son casi siempre «vuelvo» («Regreso con el
// importe de su pedido»), no una promesa de dinero.
const VERBO_DEVOLVER_A_TARJETA = VERBO_DEVOLVER;
// Hueco entre el verbo y el objeto: si en medio aparece el pedido/platillo, el verbo es de envio de comida («le regresamos su pedido ... el pago completo»), no de dinero.
const HUECO = "(?:(?!\\b(?:pedido|platillo|orden|comida|paquete|con|para|cuando|cuanto|hasta|despues|luego)\\b)[^.!?\\n]){0,40}";
// «el dinero» a secas NO cuenta (puede ser el sobrante del cambio): solo «su/tu/mi dinero» o «el dinero que pago / de su pedido».
const SU_DINERO = "(?:(?:su|tu|mi)\\s+dinero|todo\\s+su\\s+dinero|el\\s+dinero\\s+(?:que\\s+pag\\w+|de\\s+su\\s+(?:pedido|compra|orden)))";
const LO_PAGADO =
  "(?:lo\\s+pagado|lo\\s+que\\s+pag\\w+|(?:el\\s+)?importe\\s+(?:total\\s+)?de\\s+su\\s+(?:pedido|compra|orden)|(?:el|su)\\s+pago\\s+(?:completo|total|integro)|\\$\\s?\\d[\\d.,]*\\s+que\\s+pag\\w+)";
// Senal A: solo VERBOS DE PROMESA con reembolso («reembolsamos», «haremos el reembolso», «se le reembolsara», «we will refund you»). Mencionar la palabra (la politica, «su solicitud de reembolso»,
// «el reembolso lo decide el gerente», «los reembolsos no estan disponibles») NO dispara: cambiaria el sentido y borraria el aviso al gerente.
const PROMESA_A_SIN_CONTEXTO = new RegExp(
  [
    `\\breembols(?:amos|aremos|are|ara|aran|aria|ariamos|ar(?:le|les|lo|la)?)\\b|\\b(?:sera|seran|fue|fueron)\\s+reembolsad\\w+`,
    `\\b(?:hac(?:emos|er)|hag(?:o|amos)|har(?:emos|e|a)|dar(?:emos|e|a)|dam(?:os)?|doy|procesa(?:mos|remos|re|r)|tramita(?:mos|remos|re|r)|genera(?:mos|remos|re|r))\\s+(?:le\\s+|les\\s+)?(?:\\w+\\s+){0,2}reembolso\\b`,
    `\\bproced(?:emos|eremos|ere)\\s+(?:con|al|a)\\s+(?:el\\s+|su\\s+)?reembolso\\b`,
    `\\bse\\s+(?:le\\s+|les\\s+)?(?:reembolsara|hara|dara|procesara|tramitara|aplicara)\\w*\\s+(?:\\w+\\s+){0,2}(?:reembolso|devolucion\\s+de\\s+(?:${SU_DINERO}|${LO_PAGADO}))`,
    `\\b(?:su|tu)\\s+reembolso\\s+(?:sera|se\\s+(?:procesara|aplicara|acreditara)|llegara)\\b`,
    `\\b(?:will|'ll|can|going\\s+to|shall)\\s+(?:\\w+\\s+){0,2}(?:refund|reimburse)\\w*|\\byour\\s+(?:full\\s+)?refund\\s+(?:is|will|has)|\\bget\\s+(?:a\\s+|your\\s+)?(?:full\\s+)?refund\\b|\\bmoney[\\s-]back\\b|\\bback\\s+your\\s+money\\b`,
    `\\bdevolucion(?:es)?\\s+(?:de|del)\\s+(?:${SU_DINERO}|${LO_PAGADO})`,
  ].join("|"),
  "u",
);
// R12 revision 5: «su dinero de vuelta/de regreso» NO es senal fuerte: en Mexico es el modismo del VUELTO («Le damos su dinero de vuelta: $120 de su billete»). Pasa por la misma exclusion
// de cambio/efectivo/pago que la senal B. Solo las raices reembols*/refund*/money back y «devolucion de su dinero» siguen sin exclusion.
const PROMESA_DINERO_DE_VUELTA = new RegExp(`\\b${SU_DINERO}\\s+de\\s+(?:regreso|vuelta)\\b`, "u");
// Senales extra de vuelto en efectivo que solo aplican a este modismo (no se agregan a CAMBIO_O_PAGO para no ampliar la exclusion de B/descuentos).
// FUERTES: el efectivo/la mano/el monto exacto; no las anula nada. DEBILES: quien entrega o donde se entrega (repartidor, caja...); un plazo de reembolso («en 3 dias», «lo autoriza el gerente») las anula.
const VUELTO_FUERTE = /\b(?:billete|billetes|a\s+su\s+mano|en\s+la\s+puerta|en\s+su\s+puerta|en\s+mano|son\s+\$\s?\d|\$\s?\d[\d.,]*\s+de\s+su\s+(?:billete|pago))/;
const VUELTO_DEBIL = /\b(?:repartidor|mesero|cajero|caja|mostrador)\b/;
const PLAZO_DE_REEMBOLSO = /\ben\s+(?:\d+|un|una|dos|tres|cuatro|cinco|siete|diez)\s+(?:dias?|semanas?)\b|\bdias\s+(?:habiles|laborales)\b|\b(?:autoriza\w*|aprueba\w*)\s+(?:el\s+)?gerente\b|\bgerente\s+(?:lo\s+|la\s+)?(?:autoriza|aprueba)\w*/;
// Destino AFIRMATIVO del dinero: «a su tarjeta/cuenta/banco» que NO va negado antes («no a su tarjeta», «no es a su cuenta», «jamas/nunca a su tarjeta», «sin pasar a su tarjeta», «no lo mandamos a su
// tarjeta», «no se regresa/abona a su cuenta», «no por transferencia a su cuenta») ni es la CUENTA DE LA MESA («a su cuenta de la mesa», «a su cuenta quedaron $0»). «sin costo/sin cargo/no se
// preocupe ... a su tarjeta» NO niegan el destino: es la promesa («sin costo» describe la tarifa, no el destino).
const DESTINO_DEL_DINERO = /\ba\s+su\s+(?:tarjeta|cuenta|banco)\b/g;
const NEGADO_ANTES_DEL_DESTINO = new RegExp(
  [
    String.raw`\b(?:no|ni|jamas|nunca|tampoco)\s*,?\s+(?:(?:es|va|sera|son|se\s+hace|se\s+hara)\s+)?$`,
    String.raw`\b(?:no|nunca|jamas)\s+(?:(?:lo|la|le|se)\s+)?(?:mand|envi|regres|devolv|devuelv|abon|deposit|transfier|transfer|pas|carg|acredit|reembols)\w*\s+(?:\w+\s+)?$`,
    String.raw`\bsin\s+(?:pasar|mandar|enviar|transferir|depositar|abonar|regresar|cargar|devolver)\s+$`,
    String.raw`\bno\s+(?:por|mediante|via)\s+(?:transferencia|deposito|abono)\s+$`,
  ].join("|"),
);
const CUENTA_DE_LA_MESA = /^\s*(?:de\s+la\s+(?:mesa|casa)|de\s+mesa|del\s+restaurante|qued\w*)\b/;
function destinoNegadoOCuentaDeMesa(t: string, m: RegExpMatchArray): boolean {
  const i = m.index ?? 0;
  if (NEGADO_ANTES_DEL_DESTINO.test(t.slice(Math.max(0, i - 40), i))) return true;
  return /\s+cuenta$/.test(m[0]) && CUENTA_DE_LA_MESA.test(t.slice(i + m[0].length));
}
function hayDestinoAfirmativo(t: string): boolean {
  for (const m of t.matchAll(DESTINO_DEL_DINERO)) if (!destinoNegadoOCuentaDeMesa(t, m)) return true;
  return false;
}
// Destino de «su dinero de vuelta/de regreso»: solo cuenta si va DESPUES del objeto, sin punto/punto y coma/dos puntos de por medio y SIN verbo o sustantivo de COBRO entre el objeto y el destino
// («y cobra a su tarjeta», «el cargo a su tarjeta», «el voucher a su tarjeta», «la diferencia se cobra a su tarjeta», «el consumo se paso a su cuenta»): ahi la tarjeta/cuenta es del COBRO, no de la
// devolucion. Los rellenos «sin costo / sin cargo / no se preocupe» se ignoran: son la promesa, no un cobro.
const RELLENO_DE_PROMESA = /\b(?:sin\s+(?:costo|cargo|demora|problema|pena|falta)(?:\s+alguno)?|no\s+se\s+preocupe|de\s+inmediato|ahora\s+mismo|hoy\s+mismo)\b/g;
const COBRO_ENTRE_OBJETO_Y_DESTINO = /\b(?:cobr|carg|pag|voucher|aplic|qued|total|consumo|diferencia|resto)\w*|\bpas(?:o|a|e|an|ar)\b/;
function destinoTrasElObjeto(t: string, finObjeto: number): boolean {
  const cola = t.slice(finObjeto);
  const m = new RegExp(DESTINO_DEL_DINERO.source).exec(cola);
  if (!m) return false;
  const entre = cola.slice(0, m.index).replace(RELLENO_DE_PROMESA, " ");
  if (/[.;:!?\n]/.test(entre) || COBRO_ENTRE_OBJETO_Y_DESTINO.test(entre)) return false;
  const abs = Object.assign([m[0]], { index: finObjeto + m.index }) as unknown as RegExpMatchArray;
  return !destinoNegadoOCuentaDeMesa(t, abs);
}
// Negacion REAL del destino (solo cuenta si no hay destino afirmativo): «no a su tarjeta», «no es a su cuenta», «jamas/nunca a su tarjeta», «no por/en tarjeta», «sin tarjeta»/«ni tarjeta» pegado, «no es reembolso».
const NEGACION_DEL_DESTINO_SUELTA = /\bno\s+(?:por|en|con)\s+(?:su\s+)?tarjeta\b|\b(?:sin|ni)\s+(?:su\s+)?tarjeta\b|\bno\s+(?:es|son|seria|se\s+trata\s+de)\s+(?:un\s+|una\s+)?(?:reembolso|devolucion|refund)/;
function negaElDestino(t: string): boolean {
  for (const m of t.matchAll(DESTINO_DEL_DINERO)) {
    const i = m.index ?? 0;
    if (NEGADO_ANTES_DEL_DESTINO.test(t.slice(Math.max(0, i - 40), i))) return true;
  }
  return NEGACION_DEL_DESTINO_SUELTA.test(t);
}
// Tras «la devolucion de su dinero» / «su dinero de regreso» una negacion posterior («... no es posible», «... no esta disponible») la vuelve politica.
const NEGACION_DESPUES = /^[^.!?\n]{0,25}\bno\s+(?:es|son|esta|estan|hay|aplica\w*|procede\w*|se\s+(?:puede|permite|hace|hacen)|depende|disponible\w*|posible\w*)\b/;
const PROMESA_B = new RegExp(
  [
    // «le devolvemos su dinero», «le regresamos lo pagado», «le mandamos su dinero», «devolveremos el importe de su pedido»
    `\\b${VERBO_DEVOLVER}\\b${HUECO}(?<!\\w)(?:${SU_DINERO}(?!\\s+de\\s+(?:regreso|vuelta)\\b)|${LO_PAGADO})`,
    // «le devolvemos $500 a su tarjeta», «se devolvera a su cuenta»
    `\\b${VERBO_DEVOLVER_A_TARJETA}\\b${HUECO}\\ba\\s+su\\s+(?:tarjeta|cuenta\\s+(?:bancaria|de\\s+banco|clabe)|cuenta(?=\\s*(?:[.!?,;]|$)))`,
    // pasiva: «su dinero sera devuelto a su tarjeta», «su dinero se devolvera», «se le devolvera su dinero»
    `\\b(?:${SU_DINERO}|${LO_PAGADO})\\b[^.!?\\n]{0,30}\\b(?:sera(?:n)?\\s+(?:devuelt|regresad|reintegrad|retornad)\\w*|se\\s+(?:le\\s+)?(?:devolvera|regresara|reintegrara|retornara)\\b)`,
    `\\bse\\s+(?:le\\s+|les\\s+)?(?:devolvera|regresara|reintegrara|retornara)\\b[^.!?\\n]{0,30}\\b(?:${SU_DINERO}|${LO_PAGADO})`,
    // primera persona del singular SOLO con «le» y objeto inequivoco: «Le regreso su dinero hoy mismo» (sin «le» es «vuelvo»: «Regreso con el importe...»)
    `\\ble\\s+(?:devuelvo|regreso|reintegro|retorno|devolvere|regresare|reintegrare)\\b${HUECO}(?<!\\w)(?:(?:su|tu)\\s+dinero|lo\\s+pagado|lo\\s+que\\s+pag\\w+)`,
    // pasiva dirigida al cliente con «el dinero» a secas: «Se le devolvera el dinero en 3 dias» (el dinero sobrante del cambio queda excluido por el contexto de efectivo)
    `\\bse\\s+(?:le\\s+|les\\s+)(?:devolvera|regresara|reintegrara|retornara)\\s+el\\s+dinero\\b`,
    // ingles
    `\\b(?:return|send|give|refund)\\w*\\b[^.!?\\n]{0,15}\\byour\\s+money\\b|\\byour\\s+money\\s+(?:will|would)\\s+be\\s+(?:returned|sent|given)\\b|\\bcredit\\s+your\\s+(?:card|account)\\b`,
  ].join("|"),
  "u",
);
// Ofertas de descuento: «descuent*» con verbo de oferta, o con porcentaje dirigido a SU pedido/cuenta.
const VERBO_DE_OFERTA =
  "(?:hac(?:emos|er|e)|hag(?:o|amos)|har(?:emos|e|a)|dam(?:os)?|dar(?:emos|e|le|les)?|doy|aplic(?:amos|aremos|ar|ara|o|are|arle)|otorg(?:amos|aremos|ar|ara|o|are)|ofrec(?:emos|eremos|er|e)|ofrezco|conced(?:emos|eremos|er|o)|podemos|puedo|podria(?:mos)?|regal(?:amos|o))";
const NUMERO_DE_DESCUENTO = "\\d{1,3}\\s*%";
const PROMESA_DE_DESCUENTO = new RegExp(
  [
    `\\b${VERBO_DE_OFERTA}\\b[^.!?\\n]{0,25}\\bdescuent\\w*`,
    `\\bse\\s+(?:le\\s+|les\\s+)?(?:aplicara|otorgara|hara|dara|concedera|ofrecera)\\w*[^.!?\\n]{0,15}\\bdescuent\\w*`,
    `\\b(?:tendra|tendran|queda|quedan|llevara|llevan)\\s+(?:con\\s+|un\\s+)?${NUMERO_DE_DESCUENTO}\\s*(?:de\\s+)?descuento`,
    `\\b(?:su|tu)\\s+(?:pedido|orden|cuenta|compra|total|proxima\\s+\\w+)[^.!?\\n]{0,30}${NUMERO_DE_DESCUENTO}\\s*(?:de\\s+)?descuento`,
    `\\b(?:we|i)(?:'ll|\\s+will|\\s+can)\\s+(?:give|offer|apply)\\s+(?:you\\s+)?(?:a\\s+|an\\s+)?(?:${NUMERO_DE_DESCUENTO}\\s*)?(?:discount|off)\\b`,
  ].join("|"),
  "u",
);
const NEGACION_ANTES = /\b(?:no|nunca|jamas|tampoco|ni|not|never|cannot)\s+(?:\w+\s+){0,4}$|n't\s+(?:\w+\s+){0,4}$|\b(?:sin|without)\s+(?:\w+\s+)?$/;
const DESCUENTO_CONDICIONAL_DE_LA_CARTA =
  /\b(?:si|cuando)\s+[^.!?\n]*\b(?:recoger|recoja|recoge|domicilio|tarjeta|efectivo|pasa|pase|visita|visite|dia|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hora|despues\s+de)\b|\b(?:para|al|por|de)\s+recoger\b|\bpedido\s+(?:para\s+)?recoger\b|\b(?:total|precio|pedido)\s+con\s+descuento\b|\b(?:los|todos\s+los|cada)\s+(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b|\bpromocion(?:es)?\b|\b(?:credencial|estudiantes?|inapam|adultos?\s+mayores|maestros?|cumpleaneros?|familiares?)\b|\bdescuentos?\s+(?:en|a|para)\s+(?!(?:su|tu|el|la|esta|este|mi|usted|ustedes|ti)\b)\w+/;
function promesaSinNegar(patron: RegExp, textoNormalizado: string, ignorarNegacionDespues = false): boolean {
  const m = patron.exec(textoNormalizado);
  if (!m) return false;
  if (!ignorarNegacionDespues && NEGACION_DESPUES.test(textoNormalizado.slice(m.index + m[0].length))) return false;
  return !NEGACION_ANTES.test(textoNormalizado.slice(Math.max(0, m.index - 40), m.index));
}
/** La frase PROMETE devolver dinero («le devolvemos su dinero», «we will refund you»). Una negacion («no podemos devolver su dinero»), la politica o el CAMBIO/pago en efectivo no cuentan. */
export function prometeDevolucionDeDinero(frase: string): boolean {
  const t = normalizarParaClasificar(frase);
  if (SOLO_CAMBIO_DE_PRODUCTO.test(t)) return false;
  // Senal A (reembols*/refund*/money back/devolucion de su dinero): sin exclusion de contexto, solo la negacion.
  if (promesaSinNegar(PROMESA_A_SIN_CONTEXTO, t)) return true;
  // Senal B (verbo + dinero/lo pagado/a su tarjeta): el vuelto y la confirmacion de pagos son operacion normal.
  if (contextoDeCambioOPago(t)) return false;
  // Un destino afirmativo («a su tarjeta/cuenta/banco» sin «no» pegado) NO se exime por contexto de vuelto ni por «sin costo/sin cargo»: es la promesa. Sin destino afirmativo, una negacion real del
  // destino («no a su tarjeta», «sin tarjeta», «no es reembolso») ante la duda NO se reemplaza: precision primero.
  const destino = hayDestinoAfirmativo(t);
  if (!destino && negaElDestino(t)) return false;
  // Con destino afirmativo, un «no ...» posterior («..., no hay problema») ya no se refiere al reembolso.
  if (promesaSinNegar(PROMESA_B, t, destino)) return true;
  // «su dinero de vuelta/de regreso»: promesa si el destino va tras el objeto y sin cobro de por medio; si la tarjeta/cuenta aparece pero como cobro, cuenta de la mesa o negada, es vuelto: no se toca.
  // Sin tarjeta/cuenta, solo cuando no hay contexto de vuelto en efectivo (un plazo de reembolso anula el contexto debil: repartidor/caja).
  const mv = PROMESA_DINERO_DE_VUELTA.exec(t);
  if (!mv) return false;
  const destinoV = destinoTrasElObjeto(t, mv.index + mv[0].length);
  if (!promesaSinNegar(PROMESA_DINERO_DE_VUELTA, t, destinoV)) return false;
  if (destinoV) return true;
  if (new RegExp(DESTINO_DEL_DINERO.source).test(t)) return false;
  if (VUELTO_FUERTE.test(t)) return false;
  return !VUELTO_DEBIL.test(t) || PLAZO_DE_REEMBOLSO.test(t);
}
/** La frase PROMETE un descuento al cliente («le aplico 50% de descuento»). Un descuento condicional de la carta, el CAMBIO/pago en efectivo o una negacion no cuentan. */
export function prometeDescuento(frase: string): boolean {
  const t = normalizarParaClasificar(frase);
  if (!promesaSinNegar(PROMESA_DE_DESCUENTO, t)) return false;
  return !DESCUENTO_CONDICIONAL_DE_LA_CARTA.test(t) && !contextoDeCambioOPago(t);
}
export const RESPUESTA_POLITICA_SIN_DEVOLUCIONES = `${POLITICA_SIN_DEVOLUCIONES}. Si gusta, cuénteme qué faltó o qué llegó mal y lo revisamos.`;
export const RESPUESTA_SIN_DESCUENTOS_EXTRA = "No puedo ofrecerle descuentos adicionales a los que aparecen en su cotización.";
/**
 * Guardia posterior: reemplaza la frase que promete devolver dinero (siempre) o un descuento (salvo que la cotizacion de este turno traiga una promocion, `respaldaDescuento`) por la
 * politica vigente. El resto de la respuesta se conserva; cada sustitucion aparece una sola vez. No afirma «ya avise al gerente»: esta guardia no registra ningun aviso.
 */
export function quitarPromesaDeDinero(reply: string, opciones: { readonly respaldaDescuento?: boolean } = {}): string {
  const partes = reply.split(/((?<=[.!?])\s+|\n+)/);
  let usadaDevolucion = false;
  let usadaDescuento = false;
  let cambio = false;
  for (let i = 0; i < partes.length; i += 2) {
    const frase = partes[i]!;
    if (prometeDevolucionDeDinero(frase)) {
      partes[i] = usadaDevolucion ? "" : RESPUESTA_POLITICA_SIN_DEVOLUCIONES;
      usadaDevolucion = true;
      cambio = true;
    } else if (opciones.respaldaDescuento !== true && prometeDescuento(frase)) {
      partes[i] = usadaDescuento ? "" : RESPUESTA_SIN_DESCUENTOS_EXTRA;
      usadaDescuento = true;
      cambio = true;
    }
  }
  if (!cambio) return reply;
  return partes.join("").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

// ── R11-02: fuga del prompt de sistema ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Un cliente jamas debe leer los encabezados de las reglas internas ni el nombre de una herramienta (identificadores snake_case que solo existen en el prompt y en el contrato con el
// modelo). Los encabezados se reconocen EN MAYUSCULAS (como estan en el prompt) para no confundir «las reglas de negocio» dichas en prosa.
const ENCABEZADOS_DEL_PROMPT = /REGLAS DURAS DE|REGLAS DE NEGOCIO:|REGLAS QUE APLICAN LAS HERRAMIENTAS|FLUJO DE LA CONVERSACI[ÓO]N \(|SUCURSALES REALES \(|REGLAS ADICIONALES DEL NEGOCIO/;
const MARCADORES_DE_CHAT = /<\|im_(?:start|end)\|>|\[\/?INST\]|<\/?system>/i;
export function contieneFugaDePrompt(reply: string, nombresDeHerramientas: readonly string[] = []): boolean {
  if (typeof reply !== "string" || reply === "") return false;
  if (ENCABEZADOS_DEL_PROMPT.test(reply) || /reglas\s+duras\s+de\b/i.test(reply) || MARCADORES_DE_CHAT.test(reply)) return true;
  const bajas = reply.toLowerCase();
  return nombresDeHerramientas.some((n) => n.includes("_") && new RegExp(`(?<![a-z0-9_])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`).test(bajas));
}
export const RESPUESTA_SIN_FUGA = "Con gusto le ayudo con su pedido.";
/** Si la respuesta vuelca el prompt de sistema o nombres de herramientas, se descarta COMPLETA (no se puede limpiar a medias) y se devuelve una respuesta neutra de pedido. */
export function reemplazarFugaDePrompt(reply: string, nombresDeHerramientas: readonly string[] = []): string {
  return contieneFugaDePrompt(reply, nombresDeHerramientas) ? RESPUESTA_SIN_FUGA : reply;
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
    // QA-PM-R6-reglas-02: intoxicacion / malestar tras comer en el restaurante es riesgo legal y de salud: escala al gerente, no se contesta con ingredientes.
    // Los terminos clinicos (intoxicacion, envenenamiento, diarrea, vomito, comida en mal estado) bastan; los coloquiales («me cayo mal», «me enferme», «dolor de panza», «me hizo dano»)
    // solo cuentan si el mensaje habla de lo que COMIO (revision de #551: «me enferme y no puedo salir, mandenlo a domicilio» o «el habanero me cayo mal, sin habanero» son un pedido).
    intent: "alergia_salud",
    pattern: /\bintoxic\w*|\bintoxiqu\w*|\bdiarrea\b|\bvomit\w*|\benvenen\w*|\bcomida\s+(?:\w+\s+){0,2}(?:en\s+mal\s+estado|descompuesta)\b|\bme\s+(?:enferm\w*|cayo\s+mal|hizo\s+dano|dio\s+(?:dolor|asco))\b|\bdolor\s+de\s+(?:estomago|panza)\b/,
    cuando: (texto) => MALESTAR_CLINICO.test(texto) || (MALESTAR_COLOQUIAL.test(texto) && HABLA_DE_LO_QUE_COMIO.test(texto)),
    reply:
      "Lamento mucho lo que me cuenta. Su salud es lo primero: si sigue con malestar, busque atención médica. Ya avisé al gerente para que lo contacte de inmediato y revise lo ocurrido.",
  },
  {
    intent: "alergia_salud",
    // R11-04: tambien en ingles (turistas en Merida): allergic / allergy, celiac / coeliac, peanut(s), tree nut(s), shellfish, intolerant, anaphylaxis.
    pattern: new RegExp(
      `${/\b(?:alergic[oa]s?|alergias?|intolerante|intolerancia|celiac[oa]|cacahuate|gluten)\b/.source}|${ALERGIA_EN.source}`,
    ),
    cuando: (texto) => !esBromaDeAlergia(texto) && !niegaTenerAlergia(texto),
    reply:
      "Por su seguridad no puedo asegurarle los ingredientes de un platillo ni si es apto para una alergia. Ya avisé al equipo del restaurante para que le confirme directamente antes de hacer su pedido.",
  },
  {
    intent: "cobro_duplicado",
    pattern: new RegExp(
      `${/cobr(?:o|aron|e)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces|\bcarg(?:o|aron|aro)\s+(?:dos\s+veces|2\s+veces|doble|duplicado)|\b(?:doble|segundo)\s+cargo\b|\bcargo\s+(?:doble|duplicado)\b/.source}|${COBRO_DOBLE_EN.source}`,
    ),
    // Una PREGUNTA sobre si habra un cargo («¿me cobran cargo doble si pago con tarjeta?», «¿hay cargo doble al pagar?») no es un cobro que ya ocurrio: va al agente.
    cuando: (texto) =>
      !PREGUNTA_DE_CARGO_FUTURO.test(texto) &&
      !PREGUNTA_DE_CARGO_FUTURO_EN.test(texto) &&
      !(/[?¿]/.test(texto) && /\b(?:cobran|cobrarian|cobraran|cobraria|cobrara|van\s+a\s+cobrar)\b/.test(texto)),
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
    pattern: /\bcancel(?:ar|o|a|e|en)(?:l[oa]s?|me|nos)?\b[^.!?\n]{0,40}\bpedido\b|\bpedido\b[^.!?\n]{0,40}\bcancel(?:ar|o|a|e|en)(?:l[oa]s?|me|nos)?\b|\bcancelarme\s+(?:el|mi)\s+pedido\b/,
    // Sin pedido (el servidor ya sabe que el telefono no tiene uno reciente) no hay nada que cancelar: "olvidelo, cancele el pedido" es abandonar el carrito.
    // Una PREGUNTA sobre cancelar ("¿mi pedido se cancelo?", "¿hasta que hora se puede cancelar?") va al agente, que si puede contestarla.
    cuando: (texto, ctx) => ctx.pedidoReciente !== null && !CONSULTA_DE_CANCELACION.test(texto) && (!CORRECCION_DE_CARRITO.test(texto) || (ctx.pedidoReciente ?? null) !== null),
    reply:
      "Entendido, desea cancelar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
  },
  {
    // QA-PM-R6-reglas-03: «cámbiame el pedido a harina» sobre un pedido YA creado y todavia modificable lo decide una persona (depende de si ya se empezo a preparar). Sin pedido
    // reciente (o ya entregado) es el carrito y va al agente. Intent PROPIO: avisa al equipo igual (motivo `cancelacion_modificacion`) pero NUNCA pasa por el autopiloto de
    // cancelacion (que cancelaria el pedido o abriria una solicitud de cancelacion por un simple cambio).
    intent: "modificacion_pedido",
    pattern: /\b(?:cambi(?:a|ame|ar|arme|en)|modific(?:a|ame|ar|arme|quen?))\s+(?:el|mi|ese|este)\s+pedido\b/,
    cuando: (texto, ctx) => {
      const estado = ctx.pedidoReciente?.estado;
      return (estado === "registrado" || estado === "preparando" || estado === "programado" || estado === "por_confirmar") && !CONSULTA_DE_CANCELACION.test(texto) && !/\?/.test(texto);
    },
    reply:
      "Entendido, desea cambiar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
  },
  {
    intent: "transferencia",
    pattern: /\btransferencia\b|\bdeposito\b|\bspei\b|\bpagar\s+por\s+transfer/,
    reply:
      "Por este medio no puedo registrar pagos por transferencia. Ya avisé al equipo para que lo contacte y vea con usted esa forma de pago; si prefiere, puede pagar en efectivo o con tarjeta.",
  },
  {
    // R11-06: pedir DINERO de vuelta. Decision vigente: no hay devoluciones de dinero, solo cambio de producto. No se deja a la improvisacion del modelo: respuesta fija con la
    // politica, aviso al gerente (motivo `queja`) y la pregunta que el agente necesita para seguir. Una PREGUNTA por la politica o una negacion («no quiero reembolso») va al agente.
    intent: "queja",
    pattern: REEMBOLSO,
    cuando: (texto) => !preguntaPorLaPoliticaDeReembolso(texto) && !niegaQuererReembolso(texto),
    reply: RESPUESTA_REEMBOLSO_ESCALADO,
  },
  {
    intent: "queja",
    pattern: new RegExp(
      `${/\bqueja\b|\bllego\s+(?:todo\s+|muy\s+)?(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\b(?:me|le|les|nos)\s+falt(?:o|aron)\b|\bmal\s+armado\b/.source}|${QUEJA_DE_ENTREGA.source}`,
    ),
    // "me falto" es queja solo si habla de algo que NO llego ("me falto la bebida de mi pedido"); "me falto pedir otra coca" es el carrito.
    cuando: (texto, ctx) => {
      // Quejas inequivocas (siempre escalan).
      if (/\bqueja\b|\bllego\s+(?:todo\s+|muy\s+)?(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bmal\s+armado\b/.test(texto)) return true;
      // "no me llego la coca" / "vino frio todo": queja solo si habla de un pedido ya hecho.
      if (QUEJA_DE_ENTREGA.test(texto) && !/\b(?:me|le|les|nos)\s+falt(?:o|aron)\b/.test(texto)) {
        const estadoEntrega = ctx.pedidoReciente?.estado;
        return estadoEntrega === "entregado" || estadoEntrega === "salio" || HABLA_DE_SU_PEDIDO.test(texto);
      }
      if (!/\b(?:me|le|les|nos)\s+falt(?:o|aron)\b/.test(texto)) return true;
      const resto = ME_FALTO.exec(texto)?.groups?.resto ?? "";
      if (new RegExp(`^(?:a\\s+)?${INFINITIVO}\\b`).test(resto)) return false;
      // «le / les / nos faltó ...» sigue el MISMO criterio que «me faltó»: sin un pedido ya entregado o en camino (o sin hablar de «mi pedido») es la correccion de un resumen o del carrito
      // («le faltó la horchata al resumen», «nos faltó una coca, agrégala porfa»), no una queja (revision de #551).
      // Corregir lo que dice el RESUMEN o el carrito que se esta armando («le faltó la horchata al resumen») no es una queja de entrega.
      if (/\b(?:resumen|carrito|cotizacion)\b/.test(texto)) return false;
      const estado = ctx.pedidoReciente?.estado;
      return estado === "entregado" || estado === "salio" || HABLA_DE_SU_PEDIDO.test(texto);
    },
    reply: "Lamento mucho lo ocurrido. Ya avisé al gerente para que revise su caso y lo contacte directamente; yo no puedo prometerle una reposición ni un descuento.",
  },
  {
    // "urgente" como enfasis de un pedido nuevo ("medio kilo de pastor, lo necesito urgente") NO es una emergencia: solo escala cuando habla del pedido que ya existe.
    intent: "urgencia",
    pattern: new RegExp(`\\burgen(?:te|cia)\\b|${ESPERA_LARGA.source}`),
    cuando: (texto, ctx) => esperaLargaDelPedido(texto, ctx) || (/\burgen(?:te|cia)\b/.test(texto) && HABLA_DE_SU_PEDIDO.test(texto) && !ARMA_UN_PEDIDO_NUEVO.test(texto) && ctx.pedidoReciente !== null),
    reply: "Entendido, es urgente. Ya avisé al equipo para que lo contacte de inmediato.",
  },
  {
    intent: "cliente_lo_pide",
    pattern: PIDE_UNA_PERSONA_RE,
    cuando: (texto) => pideUnaPersona(texto),
    reply: "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
  },
];

// ── Queja en dos tiempos (decision de Javier, PM R10 P4) ─────────────────────────────────────────────────────────────────────────────────────
// Una queja SIN detalle ("quiero poner una queja") ya avisa al equipo, pero NO abre la toma de handoff: el texto fijo pregunta «¿qué faltó o qué llegó mal?» y el agente
// sigue atendiendo (paso 14 del prompt). El siguiente mensaje del cliente es el detalle: se agrega como nota al MISMO aviso abierto, se responde con texto fijo y ahi si se cede
// la conversacion a una persona (toma de handoff, R-21). Una queja que ya trae el detalle, o cualquier riesgo de salud, cede de inmediato como siempre.

/** Fragmento que identifica, en el historial, que la ultima pregunta del asistente fue la del detalle de la queja (el aviso de privacidad puede ir antepuesto). */
export const QUEJA_PREGUNTA_MARCA = "¿Qué faltó o qué llegó mal?";
export const QUEJA_PREGUNTA_DETALLE =
  `Lamento mucho lo ocurrido, disculpe el inconveniente. ${QUEJA_PREGUNTA_MARCA} Cuénteme el detalle y se lo paso de inmediato al gerente, que ya está avisado, para que revise su caso. Yo no puedo prometerle una reposición ni un descuento.`;
export const QUEJA_DETALLE_RECIBIDO =
  "Gracias por contármelo, ya quedó registrado el detalle y se lo pasé al gerente para que revise su caso y lo contacte directamente. Yo no puedo prometerle una reposición ni un descuento.";
const ACLARACION_SIN_DEVOLUCIONES = "Le aclaro que no hacemos devoluciones de dinero; lo que el gerente puede revisar es un cambio de producto.";
export const QUEJA_DETALLE_RECIBIDO_DINERO = `${QUEJA_DETALLE_RECIBIDO} ${ACLARACION_SIN_DEVOLUCIONES}`;

const PIDE_DINERO = /\b(?:mi\s+dinero|reembols\w*|rembols\w*|devoluci(?:on|ones)|devuelv\w+|devolv\w+|me\s+(?:regresen|regresan|reintegren|reembolsen)|que\s+me\s+(?:regresen|paguen))\b/;
/** Pura: ¿el texto del cliente reclama dinero de vuelta? Solo cambia el texto fijo (se aclara que no hay devoluciones de dinero, solo cambio de producto). */
export function pideDineroDeVuelta(text: string): boolean {
  return PIDE_DINERO.test(normalizarParaClasificar(text));
}
/** Texto fijo de una queja que YA trae el detalle (la respuesta de siempre) con la aclaracion de dinero si el cliente lo reclama. */
export function respuestaDeQuejaConDetalle(replyBase: string, text: string): string {
  return pideDineroDeVuelta(text) ? `${replyBase} ${ACLARACION_SIN_DEVOLUCIONES}` : replyBase;
}

/** Pura: ¿el mensaje de queja ya dice QUE paso (algo que faltó, llegó frío / incompleto / mal / tarde, vino equivocado)? Un «quiero poner una queja» a secas NO. */
export function quejaTraeDetalle(text: string): boolean {
  const t = normalizarParaClasificar(text);
  if (/\b(?:me|le|les|nos)\s+falt(?:o|aron)\s+\w+/.test(t) || /\bfalt(?:o|aron)\s+(?:un|una|unos|unas|el|la|los|las|mi|mis|\d+)\b/.test(t)) return true;
  if (/\bllego\s+(?:todo\s+|muy\s+)?(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bmal\s+armado\b/.test(t)) return true;
  return QUEJA_DE_ENTREGA.test(t);
}

/** Pura: ¿la ultima respuesta del asistente fue la pregunta del detalle de la queja? Entonces el siguiente mensaje del cliente ES ese detalle. */
export function esperaDetalleDeQueja(messages: readonly { readonly role: string; readonly content: string }[]): boolean {
  const ultimo = messages.findLast((m) => m.role === "assistant");
  return ultimo !== undefined && ultimo.content.includes(QUEJA_PREGUNTA_MARCA);
}

/** Pura: el mensaje, esperando el detalle de la queja, NO es el detalle sino que el cliente se retracta o retoma un pedido nuevo: el turno sigue por el agente. */
export function noEsDetalleDeQueja(text: string): boolean {
  const t = normalizarParaClasificar(text);
  return retractaPeticionDePersona(text) || /\b(?:ya\s+no|olvid(?:alo|elo|a)|no\s+(?:es\s+)?nada|nada\s+(?:gracias|mejor))\b/.test(t) || /\bquiero\s+(?:hacer\s+(?:un|otro)\s+pedido|pedir|ordenar)\b/.test(t);
}

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
    if (coincide(p, texto, ctx)) return { intent: p.intent, motivo: p.intent === "modificacion_pedido" ? "cancelacion_modificacion" : p.intent, reply: p.reply };
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

// ── Pin antes de crear un domicilio dificil de ubicar (QA-PM-R8 T7-014) ──────────────────────────────────────────────────────────────────────
// La regla del negocio es NO exigir el pin (perfil-pm.ts). Solo cuando el cliente describe su casa con referencias visuales («son 5 casas iguales, la unica con cochera techada»)
// la direccion escrita no basta para el repartidor: se le pide el pin UNA vez antes de registrar. Si ya se lo pidieron, o dice que no puede, el pedido se crea como siempre.

const REFERENCIA_VISUAL =
  /\bcasas?\s+(?:son\s+)?iguales\b|\bunica\s+con\b|\bcasa\s+(?:de\s+color\s+)?(?:naranja|azul|verde|blanca|amarilla|roja|gris|morada|rosa|cafe)\b|\bdificil\s+de\s+(?:encontrar|ubicar)\b/;
// Direccion verificable por el repartidor/mapa: numero de casa, calle con numero, cruzamientos o «s/n» con cruce. Una referencia visual SOLA (sin nada de esto) es la unica que pide pin.
const DIRECCION_VERIFICABLE = /#\s*\d|\bnum(?:ero)?\.?\s*\d|\b(?:calle|av|avenida|c|cll|carretera|km)\.?\s*\d|\bx\s*\d+\s*(?:y|e)\s*\d+|\bentre\s+(?:calle|c\.?|\d)|\bcruzamientos?\b|\bcalle\s+\d|\b\d{1,4}\s*[a-z]?\s*(?:x|por)\s*\d+/;
const RECHAZA_EL_PIN = /\bno\s+(?:puedo|quiero|me\s+deja|me\s+sale|tengo\s+como)\b[^.!?\n]{0,40}\b(?:ubicacion|pin|mapa|compartir|compartirla)\b|\bno\s+tengo\s+como\b|\bsin\s+(?:el\s+)?(?:pin|ubicacion)\b|\bno\s+(?:tengo|hay)\s+(?:datos|internet|gps|senal)\b/;
const PIDE_EL_PIN = /\b(?:pin|ubicacion)\b[^.!?\n]{0,60}\b(?:compart\w*|mand\w*|envi\w*)\b|\b(?:compart\w*|mand\w*|envi\w*)\w*\b[^.!?\n]{0,60}\b(?:pin|ubicacion)\b/;

/**
 * true = hay que pedir el pin antes de crear el domicilio. SOLO cuando la direccion es una referencia visual sin direccion verificable («la casa azul con portón»): ningun mensaje del cliente
 * (ni `direccionDelPedido`) trae numero de casa, calle con numero ni cruzamientos. Nunca se pide dos veces: si en cualquier momento el asistente ya pidio la ubicacion o el cliente dijo que no puede, es false.
 */
export function requierePinAntesDeCrear(conversacion: readonly { readonly role: string; readonly content: string }[] | undefined, direccionDelPedido?: string): boolean {
  if (!Array.isArray(conversacion)) return false;
  const mensajes = conversacion.filter((m) => m && typeof m.content === "string").map((m) => ({ role: m.role, t: normalizarParaClasificar(m.content) }));
  const delCliente = mensajes.filter((m) => m.role === "user");
  if (!delCliente.some((m) => REFERENCIA_VISUAL.test(m.t))) return false;
  const direccion = typeof direccionDelPedido === "string" ? normalizarParaClasificar(direccionDelPedido) : "";
  if (DIRECCION_VERIFICABLE.test(direccion) || delCliente.some((m) => DIRECCION_VERIFICABLE.test(m.t))) return false;
  if (delCliente.some((m) => RECHAZA_EL_PIN.test(m.t))) return false;
  return !mensajes.some((m) => m.role === "assistant" && PIDE_EL_PIN.test(m.t));
}
