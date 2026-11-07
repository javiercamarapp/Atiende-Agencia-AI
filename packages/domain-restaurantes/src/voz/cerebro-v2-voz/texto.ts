// Texto del canal de VOZ del cerebro v2 (port de canal-voz.ts / voz-turno.ts del repo suelto): bloque de sistema para la llamada, frases fijas
// del servidor y redes de seguridad DETERMINISTAS sobre lo que se va a sintetizar (TTS). Todo puro: sin red, sin base, sin reloj implicito.

/** Aviso de privacidad y grabacion al contestar (texto validado por el dueno en el repo suelto; mismo que dice el worker con numero oculto). */
export const AVISO_VOZ_INICIAL =
  "Esta llamada se graba para mejorar el servicio. Su aviso de privacidad completo está en nuestro sitio web y puede pedírmelo cuando guste.";

/** Repregunta al primer `[silencio]` (sin modelo: con el silencio el modelo llego a inventar lo que el cliente decia). */
export const RESPUESTA_SILENCIO_VOZ = "¿Sigue ahí? Aquí le escucho para ayudarle.";
/** Cierre al segundo `[silencio]` seguido. */
export const TEXTO_SILENCIO_FIN = "No logro escucharle. Puede volver a llamar cuando guste. Gracias por llamar.";
/** Cierre cuando el cliente se despide sin pedido en curso. */
export const TEXTO_DESPEDIDA = "Gracias por llamar. Que tenga un excelente día.";
/** Interruptor / cerebro v2 apagado / base sin migrar: el worker lo habla y cuelga (503 con fin). */
export const TEXTO_APAGADO_VOZ = "Por ahora no podemos atenderle por teléfono. Por favor intente más tarde o escríbanos por WhatsApp. Hasta luego.";
/** Tope de turnos de la llamada. */
export const TEXTO_LIMITE_LLAMADA = "Para no hacerle perder más tiempo, una persona de la sucursal le devolverá la llamada. Gracias por llamar.";
/** Dos fallos seguidos del proveedor del modelo. */
export const TEXTO_FALLO_PERSONA = "Estamos con un problema técnico. Una persona de la sucursal le devolverá la llamada. Gracias por llamar.";
/** Texto del STT demasiado largo: no se recorta (se perdia lo que pidio), se pide por partes sin gastar modelo. */
export const TEXTO_REPETIR_POR_PARTES = "Disculpe, fue mucha información de una vez. ¿Me lo repite por partes, por favor?";
/** Lo que queda en el hilo en lugar del texto largo. */
export const MARCA_TEXTO_LARGO_VOZ = "[el cliente habló demasiado de una vez; se le pidió repetirlo por partes]";
/** Respuesta vacia del modelo tras limpiar: nunca se manda silencio al TTS. */
export const TEXTO_REPETIR = "Disculpe, ¿me lo puede repetir?";

/**
 * Bloque de sistema que se AGREGA al prompt del agente de WhatsApp de restaurantes cuando el turno es una llamada. Port de BLOQUE_CANAL_VOZ del
 * suelto, sin nombres propios del negocio (el prompt base ya trae el negocio) y con la regla de no pedir pin/ubicacion/fotos de WhatsApp.
 */
export const BLOQUE_CANAL_VOZ = `CANAL: LLAMADA TELEFÓNICA (esto reemplaza lo que arriba diga de WhatsApp, chat, mensajes, botones, fotos, enlaces, PDF, ubicación o pin compartido, o ráfagas; las reglas de negocio de arriba siguen igual). Usted es la recepcionista telefónica del restaurante: toma pedidos y atiende dudas generales.
- Lo que usted escribe se convierte en voz. Frases cortas, de una sola idea, y UNA sola pregunta por turno. Sin emojis, sin viñetas ni listas, sin negritas ni markdown, sin enlaces ni correos escritos: no se pueden leer en voz alta.
- Largo: cada turno de 30 palabras o menos, nunca más de 40. La única excepción es la confirmación final del pedido (renglones, dirección y total), que puede ser más larga.
- Precios, cantidades, teléfonos y horas se dicen como se hablan: «ciento ochenta pesos», «las ocho y media de la noche», teléfonos en grupos de dígitos. No lea listas largas del menú: ofrezca dos o tres opciones y pregunte.
- Lo que le llega es la transcripción de la voz del cliente: puede venir sin puntuación, con números en palabras o palabras mal escritas («gringua» por «gringa», «canacin» por «Kanasín»). Interprete con tolerancia: busque el producto o la colonia con lo que oyó y con variantes antes de decir que no entendió; si sigue dudoso, haga una pregunta cerrada («¿dijo pastor o bistec?»).
- Tome el nombre completo como lo oyó y confírmelo una vez. Confirme EN VOZ ALTA antes de cerrar: dirección completa, nombre y el total que devolvió la cotización. El teléfono ya lo tiene el sistema: no lo pida.
- No pida ubicación, pin, fotos ni enlaces: por teléfono no se pueden mandar. Si falta un dato de la dirección, pregunte por las calles de referencia.
- El saludo y el aviso de grabación y privacidad YA se dijeron al contestar: no los repita ni vuelva a saludar.
- No hay transferencia en vivo: nunca diga que pasa, comunica o transfiere la llamada, ni que ponga en espera. Si hace falta una persona, deje el aviso con la herramienta de escalar y diga que una persona de la sucursal le devuelve la llamada.
- Si el mensaje del cliente es «[silencio]» no invente lo que dijo.
- Despedida breve: agradezca y despídase solo cuando el pedido quedó creado o el cliente ya no necesita nada.`;

const minusSinAcentos = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const sinAcentos = (t: string): string => minusSinAcentos(t).replace(/[¡!¿?.,;:]+/g, " ").replace(/\s+/g, " ").trim();

/** `[silencio]` (marca del worker cuando el cliente no hablo). */
export function esSilencioVoz(texto: unknown): boolean {
  return typeof texto === "string" && /^\[silencio\]$/i.test(texto.trim());
}

const DESPEDIDA_CLIENTE = [
  /^(?:no )?(?:muchas )?gracias (?:es|eso es|ya es) todo$/,
  /^no gracias(?: (?:es todo|eso es todo|nada mas|adios|bye|hasta luego))?$/,
  /^(?:eso|ya|es|eso es|ya es) todo(?: gracias)?$/,
  /^nada mas(?: gracias)?$/,
  /^(?:bye|bye bye|adios|chao|ciao|hasta luego|hasta pronto|nos vemos)(?: gracias)?$/,
  /^gracias (?:adios|bye|hasta luego|chao)$/,
];

/** El cliente se despide («no gracias, es todo», «bye»). Solo la frase COMPLETA, nunca un pedido con esas palabras. */
export function esDespedidaDelCliente(texto: string): boolean {
  const t = sinAcentos(texto);
  return DESPEDIDA_CLIENTE.some((re) => re.test(t));
}

// ---- Numeros dichos para hablar ----

const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

function menosDeCien(n: number): string {
  if (n < 30) return UNIDADES[n]!;
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? DECENAS[d]! : `${DECENAS[d]} y ${UNIDADES[u]}`;
}
function menosDeMil(n: number): string {
  if (n === 100) return "cien";
  const c = Math.floor(n / 100);
  const r = n % 100;
  return [CENTENAS[c], r ? menosDeCien(r) : ""].filter(Boolean).join(" ");
}
/** Forma ante sustantivo: «veintiún pesos», «un peso», «treinta y un pesos». */
function apocopar(t: string): string {
  return t.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");
}

/** Entero 0..99,999 en palabras («ciento veintiséis», «mil doscientos cincuenta»). `apocope`: forma ante sustantivo. Fuera de rango: las cifras. */
export function numeroEnPalabras(n: number, opciones: { apocope?: boolean } = {}): string {
  if (!Number.isInteger(n) || n < 0 || n > 99_999) return String(n);
  if (n === 0) return "cero";
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const m = miles === 0 ? "" : miles === 1 ? "mil" : `${apocopar(menosDeCien(miles))} mil`;
  const r = resto ? menosDeMil(resto) : "";
  const t = [m, r].filter(Boolean).join(" ");
  return opciones.apocope && r ? apocopar(t) : t;
}

/** Monto en palabras para hablar: «ciento veintiséis pesos con cincuenta centavos». */
export function montoEnPalabras(total: number): string {
  const centavosTot = Math.round(total * 100);
  const entero = Math.floor(centavosTot / 100);
  const cent = centavosTot % 100;
  const pesos = `${numeroEnPalabras(entero, { apocope: true })} ${entero === 1 ? "peso" : "pesos"}`;
  return cent ? `${pesos} con ${numeroEnPalabras(cent, { apocope: true })} ${cent === 1 ? "centavo" : "centavos"}` : pesos;
}

/**
 * Precios escritos con cifras («$1,250.50», «$180 MXN», «180 pesos») a palabras para el TTS. Solo toca montos de dinero (con `$` o seguidos de
 * «pesos»/«MXN»); los demas numeros (cantidades, horas, minutos) se dejan: el TTS los lee bien y cambiarlos arriesga el sentido.
 */
export function preciosEnPalabras(texto: string): string {
  const aNumero = (s: string): number => Number(s.replace(/,/g, ""));
  return texto
    .replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s*(?:MXN|m\.?n\.?|pesos))?/gi, (_m, ent: string, dec: string | undefined) =>
      montoEnPalabras(aNumero(ent) + (dec ? Number(dec.padEnd(2, "0")) / 100 : 0)))
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:MXN|pesos)\b/gi, (_m, ent: string, dec: string | undefined) =>
      montoEnPalabras(aNumero(ent) + (dec ? Number(dec.padEnd(2, "0")) / 100 : 0)));
}

// ---- Limpieza para TTS ----

/**
 * Texto para sintetizar: sin emojis, markdown, vinetas, enlaces ni saltos de linea (no se pueden leer en voz alta) y con los precios dichos.
 * Red de seguridad determinista; el bloque de voz ya pide lo mismo al modelo.
 */
export function limpiarParaVoz(texto: string): string {
  const limpio = String(texto ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[*_`#>~|]+/g, "")
    .replace(/^\s*(?:[-•·]|\d+[.)])\s+/gm, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([!?:,;])\./g, "$1")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.]+/, "")
    .trim();
  return preciosEnPalabras(limpio);
}

// ---- Sin transferencia en vivo ----

/** Devolucion de llamada en lugar de una transferencia que no existe. */
export const DEVOLUCION_OFRECIDA_VOZ = "Si gusta, dejo el aviso para que una persona de la sucursal le devuelva la llamada a este número.";

const TRANSFERENCIA = new RegExp(
  [
    // «le paso / lo comunico / la transfiero / le enlazo / le conecto» (+ con / a / su llamada), «permítame transferirle»
    String.raw`\b(?:le|lo|la|los|las|te)\s+(?:paso|pasare|comunico|comunicare|transfiero|transferire|enlazo|enlazare|conecto|conectare|comunicamos|pasamos|transferimos)\b`,
    String.raw`\b(?:transferirl[eoa]|comunicarl[eoa]|pasarl[eoa]|enlazarl[eoa]|conectarl[eoa])\b`,
    String.raw`\btransfiero\s+(?:su|la)\s+llamada\b`,
    // en espera / no cuelgue
    String.raw`\b(?:l[eoa]\s+)?(?:pongo|dejo|coloco)\s+en\s+espera\b`,
    String.raw`\bno\s+(?:me\s+|le\s+)?cuelgue\b`,
  ].join("|"),
);
/** «le paso su total», «le paso a la sucursal su pedido»: pasar algo del pedido, no la llamada. */
const PASA_EL_PEDIDO = /\b(?:le|lo|la)\s+(?:paso|pasamos)\s+(?:a\s+la\s+(?:sucursal|cocina)\s+)?(?:su|el|la|los|las)\s+(?:pedido|total|orden|cuenta|resumen|cambio|dato|nota|mensaje)/;

/** ¿Promete transferir la llamada o ponerla en espera? (no existe transferencia en vivo). Pura. */
export function prometeTransferenciaVoz(texto: string): boolean {
  const n = minusSinAcentos(String(texto ?? ""));
  if (!TRANSFERENCIA.test(n)) return false;
  return !PASA_EL_PEDIDO.test(n) || TRANSFERENCIA.test(n.replace(PASA_EL_PEDIDO, ""));
}

/** Cambia las frases que prometen transferir/esperar por la devolucion de llamada (una sola vez); conserva el resto (total, pregunta). Pura. */
export function quitarTransferenciaVoz(texto: string): string {
  // Corte lineal tras el signo (CodeQL js/polynomial-redos: la mirada atras con \s+ era polinomial en espacios largos).
  const frases = String(texto ?? "").trim().replace(/([.!?])\s+/g, "$1\u0000").split("\u0000");
  let puesta = /devuelv\w*\s+(?:la|su)\s+llamada/i.test(texto);
  const salida: string[] = [];
  for (const f of frases) {
    if (!prometeTransferenciaVoz(f)) {
      salida.push(f);
      continue;
    }
    if (!puesta) {
      salida.push(DEVOLUCION_OFRECIDA_VOZ);
      puesta = true;
    }
  }
  return salida.join(" ").trim();
}

// ---- Largo del turno ----

/** Tope duro de palabras de un turno hablado (el prompt pide 30). */
export const MAX_PALABRAS_VOZ = 45;
const contarPalabras = (t: string): number => (t.match(/[\p{L}\p{N}$]+/gu) ?? []).length;
const CON_DINERO = /\bpesos\b|\$\s?\d|\btotal\b/;
const CORTESIA_PURA =
  /^(?:(?:muy )?buen[oa]s (?:dias|tardes|noches)|hola|con (?:mucho )?gusto|claro(?: que si)?|perfecto|excelente|muy bien|de acuerdo|listo|entendido|ok|(?:muchas )?gracias(?: a usted)?(?: por (?:llamar|esperar|su paciencia))?|disculpe|lo siento(?: mucho)?)[\s,.!]*$/;

/**
 * Si la respuesta pasa de MAX_PALABRAS_VOZ, quita frases ENTERAS de pura cortesia («Perfecto.», «¡Con gusto!») hasta quedar en el tope. Una frase
 * con contenido o con dinero nunca se quita; si sigue larga, se deja (mejor largo que sin el dato). No toca la confirmacion de un pedido recien creado.
 */
export function recortarRespuestaVoz(texto: string, opciones: { pedidoCreado?: boolean } = {}): string {
  if (opciones.pedidoCreado || contarPalabras(texto) <= MAX_PALABRAS_VOZ) return texto;
  const frases = texto.trim().split(/(?<=[.!?])\s+/);
  const quitadas = new Set<number>();
  const total = (): number => contarPalabras(frases.filter((_, i) => !quitadas.has(i)).join(" "));
  for (let i = 0; i < frases.length && total() > MAX_PALABRAS_VOZ; i++) {
    const n = sinAcentos(frases[i]!);
    if (quitadas.size < frases.length - 1 && !frases[i]!.includes("?") && !CON_DINERO.test(n) && CORTESIA_PURA.test(n)) quitadas.add(i);
  }
  return quitadas.size ? frases.filter((_, i) => !quitadas.has(i)).join(" ") : texto;
}

/** Todo lo que se hace a la respuesta del modelo antes de hablarla. Nunca devuelve vacio. */
export function respuestaParaVoz(textoModelo: string, opciones: { pedidoCreado?: boolean } = {}): string {
  const t = recortarRespuestaVoz(quitarTransferenciaVoz(limpiarParaVoz(textoModelo)), opciones);
  return t.trim() === "" ? TEXTO_REPETIR : t;
}

// ---- Saludo de la apertura ----

function saludoPorHora(zonaHoraria: string, ahora: Date): string {
  let hora = 12;
  try {
    hora = Number(new Intl.DateTimeFormat("es-MX", { timeZone: zonaHoraria, hour: "numeric", hourCycle: "h23" }).format(ahora));
  } catch {
    // zona invalida: «Buenas tardes» es neutro
  }
  return hora >= 5 && hora < 12 ? "Buenos días" : hora >= 12 && hora < 19 ? "Buenas tardes" : "Buenas noches";
}

/**
 * Saludo de la apertura (seq 0), sin modelo: saludo segun la hora local + «le atiende el asistente virtual de <negocio>» + aviso de grabacion
 * + pregunta. Con `avisoDado` (el worker ya dijo preambulo y aviso: numero oculto) solo el saludo corto.
 */
export function saludoVoz(opciones: { readonly ahora: Date; readonly zonaHoraria: string; readonly nombreNegocio: string | null; readonly avisoDado?: boolean }): string {
  if (opciones.avisoDado) return "Gracias. ¿En qué le puedo ayudar?";
  const negocio = opciones.nombreNegocio?.trim() ? ` de ${opciones.nombreNegocio.trim()}` : "";
  return limpiarParaVoz(`${saludoPorHora(opciones.zonaHoraria, opciones.ahora)}, le atiende el asistente virtual${negocio}. ${AVISO_VOZ_INICIAL} ¿En qué le puedo ayudar?`);
}
