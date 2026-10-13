// PM PR-9 (restaurantes) -- deteccion DETERMINISTA y PURA de derechos ARCO (acceso, rectificacion, cancelacion, oposicion) y de la
// revocacion de contacto/publicidad. Sin base de datos, sin red, sin reloj: la usan el webhook de WhatsApp, el endpoint de voz y el
// preview del agente, asi que los tres comparten UN solo detector.
//
// DISENO (por que no es "una regex grande"):
//   Un falso negativo es incumplimiento legal (LFPDPPP, plazo de 20 dias); un falso positivo arruina un pedido. Por eso la deteccion es
//   por RAICES etiquetadas (`RAICES_ARCO`), cada una con su derecho, su FUERZA y su corpus en las pruebas:
//     - fuerte: la persona pide ejercer un derecho sobre SUS datos o frenar el contacto (objeto = datos del titular o pronombre "me" pegado al
//       verbo). Se registra la solicitud (con su confirmacion CONFIRMO) y la respuesta sustituye el turno.
//     - debil: suena a ARCO pero tambien es habla normal de restaurante ("borra mi cuenta", "no me llamen"). NO se registra nada ni se descarta
//       el mensaje: el agente sigue atendiendo el pedido y al final de su respuesta se AGREGA la oferta de derechos.
//   La regla de oro anti falsos positivos es el OBJETO: "borra el refresco", "olvidalo", "cancela mi pedido" o "mis datos son Juan Perez"
//   no tienen como objeto los datos del titular (los pronombres lo/los/la/las del imperativo nunca cuentan).
//   Un menu (`ARCO_MENU_REPLY`) deja una MARCA en el historial; la siguiente respuesta del cliente se interpreta con `detectarEleccionDeMenu`
//   (nombres del derecho, sinonimos coloquiales y numeros 1-4), asi nunca hay bucle: si no se entiende, se registra la mejor conjetura y se
//   escala a una persona (ver arco-intent.ts).
import { detectarOptOut } from "@atiende/whatsapp-gateway";
import { ARCO_MENU_MARCA_NOMBRES, ARCO_MENU_MARCA_NUMERADO, type DataRightType } from "./data-rights.ts";

/** Minusculas y sin acentos/diacriticos, espacios colapsados: la deteccion compara contra texto normalizado, asi que "Rectificación" == "rectificacion". */
export function normalizeArcoText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalizacion de la deteccion: ademas de `normalizeArcoText`, jerga de chat ("q", "k", "kiero", "xq") y letras repetidas ("porfaaaa"). */
export function normalizarParaArco(texto: string): string {
  if (typeof texto !== "string") return "";
  return normalizeArcoText(texto)
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\b(?:xq|pq|porq|porke)\b/g, "por que")
    .replace(/\b(?:q|k|ke)\b/g, "que")
    .replace(/\bk(?=[eiou])/g, "qu")
    .replace(/\bporfavor\b/g, "por favor")
    .replace(/\s+/g, " ")
    .trim();
}

export type FuerzaArco = "fuerte" | "debil";

export interface RaizArco {
  readonly id: string;
  /** Derecho que ejerce. */
  readonly right: DataRightType;
  readonly fuerza: FuerzaArco;
  /** `true` = la raiz frena el contacto/publicidad: ademas de la solicitud ARCO, el webhook revoca el marketing de ese telefono. */
  readonly contacto?: boolean;
  readonly re: RegExp;
  /** Que hacer si lo que sigue al objeto es "del pedido / de la cuenta / de la factura...": `anula` (no es ARCO: "borra mi nombre del pedido") o
   * `debilita` (queda en debil: "borren mis datos de mi pedido"). */
  readonly colaDePedido?: "anula" | "debilita";
}

// --- Fragmentos ---------------------------------------------------------------------------------------------------------------------------------
const POSS = "(?:mi|mis|mio|mia|mios|mias)";
/** Datos "en general" del titular. */
const DATO_GENERAL = "(?:datos(?: personales)?|informacion(?: personal)?|info|historial|registro|perfil|expediente)";
/** Datos de contacto/identidad concretos. */
const DATO_CONCRETO = "(?:numero|telefono|celular|cel|whatsapp|correo|email|mail|nombre|apellidos?|direccion|domicilio)";
const DATO = `(?:${DATO_GENERAL}|${DATO_CONCRETO})`;
/** Verbos de suprimir: borrar, eliminar, suprimir, destruir (con o sin pronombre pegado: borrame, eliminenlos). */
const SUPRIMIR = "(?:borr|elimin|suprim|destru)\\w*";
/** Verbos de sacar de una lista (sin "olvidar"/"cancelar", que tienen su raiz propia). */
const SACAR = "(?:borr|elimin|suprim|saqu|sac|quit|baj|excluy|destru|retir)\\w*";
const FILL = "(?:\\w+ ){0,3}?";
const NO_ES_PEDIDO = "(?! (?:pedido|orden|ordenes|cuenta|comanda|reserva|entrega|mesa|factura|carrito|compra|ticket)\\b)";
const DESTINO_LISTA = "(?:su|sus|la|las|todas? (?:su|sus|las|la))(?: \\w+)? (?:base|bases|lista|listas|sistema|sistemas|registro|registros|contactos|directorio|padron|agenda|difusion)\\b";
const CIERRE_DE_PERSONA = "(?=\\s*$|\\s+(?:por favor|porfa|pf|x favor|pls|ya|ahora|gracias|tambien|de\\b))";
const CONTACTO_SUSTANTIVO =
  "(?:mensaj\\w*|msjs?|whats(?:app)?s?|publicidad|promociones|promos?|ofertas|avisos|notificaciones|correos|emails?|mails|llamadas|spam|propaganda|mercadotecnia|marketing|boletines|newsletters?|cupones|informacion comercial)";
const CONTACTO_VERBO = "(?:escrib|llam|contact|molest|textee|mensajee)\\w*";
const ENVIAR = "(?:mand|envi)\\w*";

const re = (fuente: string): RegExp => new RegExp(fuente);

// --- Raices ---------------------------------------------------------------------------------------------------------------------------------------
export const RAICES_ARCO: readonly RaizArco[] = [
  // ===== CANCELACION / SUPRESION =====
  { id: "cancelacion.suprimir-mis-datos", right: "cancelacion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\b${SUPRIMIR} ${FILL}${POSS} ${DATO_CONCRETO}\\b`) },
  { id: "cancelacion.suprimir-mis-datos-generales", right: "cancelacion", fuerza: "fuerte", colaDePedido: "debilita", re: re(`\\b${SUPRIMIR} ${FILL}${POSS} ${DATO_GENERAL}\\b`) },
  { id: "cancelacion.mis-datos-y-luego-borren", right: "cancelacion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\b${POSS} ${DATO}\\b(?: (?:de su sistema|de su base de datos|de sus registros|por favor|porfa|ya|tambien|y ${POSS} ${DATO}))*(?: que(?: los| lo| las| la)?)? ${SUPRIMIR}\\b`) },
  { id: "cancelacion.suprimir-el-dato-que-tienen", right: "cancelacion", fuerza: "fuerte", re: re(`\\b${SUPRIMIR} (?:el|la|los|las) ${DATO} que (?:tienen|tengan|guardan|guarden|registraron|registren)\\b`) },
  { id: "cancelacion.suprimir-lo-que-tengan-de-mi", right: "cancelacion", fuerza: "fuerte", re: re(`\\b${SUPRIMIR}(?: \\w+){0,4}? que (?:tengan|tienen|guardan|guardaron|hayan guardado|han guardado|saben|sepan|conserven|almacenan)\\b(?: \\w+){0,4}? (?:de mi\\b${NO_ES_PEDIDO}|mio|mia|mios|mias|sobre mi\\b)`) },
  { id: "cancelacion.suprimir-mi-cuenta", right: "cancelacion", fuerza: "fuerte", re: re(`\\b(?:elimin|suprim|destru)\\w* ${FILL}mi cuenta\\b`) },
  { id: "cancelacion.borrar-mi-cuenta-ambiguo", right: "cancelacion", fuerza: "debil", re: re(`\\b(?:borr|cancel)\\w* ${FILL}mi cuenta\\b`) },
  { id: "cancelacion.cancelar-mi-registro", right: "cancelacion", fuerza: "fuerte", re: re(`\\bcancel\\w* ${FILL}mi (?:registro|suscripcion|perfil|inscripcion|membresia|cuenta de cliente)\\b`) },
  { id: "cancelacion.sacarme-yo", right: "cancelacion", fuerza: "fuerte", contacto: true, colaDePedido: "anula", re: re(`\\b(?:${SACAR}me|olvid\\w*me)\\b${CIERRE_DE_PERSONA}`) },
  { id: "cancelacion.que-me-borren", right: "cancelacion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\bque me (?:${SACAR}|olvid\\w*)\\b${CIERRE_DE_PERSONA}`) },
  { id: "cancelacion.me-pueden-borrar", right: "cancelacion", fuerza: "fuerte", re: re(`\\bme (?:pueden|puede|podrian|podria)(?: \\w+)? (?:borrar|eliminar|sacar|quitar|suprimir|dar de baja)\\b${CIERRE_DE_PERSONA}`) },
  { id: "cancelacion.sacarme-de-la-lista", right: "cancelacion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:${SACAR}me|me ${SACAR})\\b ${FILL}(?:de|en) ${DESTINO_LISTA}`) },
  { id: "cancelacion.no-quiero-estar-en-su-sistema", right: "cancelacion", fuerza: "fuerte", re: re(`\\b(?:no|ya no) (?:quiero|deseo|quisiera|pienso) (?:seguir |continuar )?(?:(?:estar|aparecer|figurar|salir|seguir|permanecer|quedar)\\w*|que me (?:tengan|sigan|mantengan|dejen))\\b(?: \\w+){0,4}? (?:en|de) (?:su|sus|la|las) (?:base|bases|lista|listas|sistema|sistemas|registro|registros|contactos|padron)\\b`) },
  { id: "cancelacion.darme-de-baja", right: "cancelacion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:darme|darse|denme|dame|dar me|me den|me dan|me da|bajame|bajenme) de baja\\b(?! (?:la|el|las|los|un|una|esa|ese|esta|este|mi pedido)\\b)|\\bquiero (?:la|mi) baja\\b`) },
  { id: "cancelacion.olvidense-de-mi", right: "cancelacion", fuerza: "fuerte", contacto: true, re: re(`\\bolvid\\w* (?:se |nse )?de mi\\b${NO_ES_PEDIDO}`) },
  { id: "cancelacion.no-guarden-mis-datos", right: "cancelacion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\b(?:no|ya no|nunca) (?:(?:quiero|deseo|quisiera|autorizo|permito) que )?(?:guarden|tengan|conserven|almacenen|registren|conozcan|archiven|sigan (?:teniendo|guardando|conservando))\\b(?: \\w+){0,2}? ${POSS} ${DATO}\\b`) },
  { id: "cancelacion.derecho-por-nombre", right: "cancelacion", fuerza: "fuerte", re: re(`\\bderecho (?:de |a la |al |a )?(?:cancelacion|supresion|olvido)\\b|\\b(?:supresion|cancelacion|suprimir) (?:de |a |sobre )?(?:mis |mi |los |la )?(?:datos|informacion|info)\\b|\\bcancelar mis datos\\b`) },

  // ===== OPOSICION / REVOCACION =====
  { id: "oposicion.frase-legal-con-objeto", right: "oposicion", fuerza: "fuerte", re: re(`(?=.*\\b(?:datos|informacion|info|numero|telefono|tratamiento|uso|publicidad|promociones|mensajes|consentimiento|contacto|mercadotecnia)\\b)\\b(?:me opongo|oponerme|opongo|oposicion|revoco|revocar|revocacion|retiro (?:mi )?(?:consentimiento|autorizacion|permiso)|retirar (?:mi )?(?:consentimiento|autorizacion|permiso)|no consiento que (?:usen|utilicen|traten|compartan|guarden|tengan))\\b`) },
  { id: "oposicion.frase-legal-sin-objeto", right: "oposicion", fuerza: "debil", re: re(`^(?:(?:\\w+ ){0,2})?(?:me opongo|oponerme|oposicion|revoco|revocar|revocacion|retiro mi consentimiento)(?: \\w+){0,1}$`) },
  { id: "oposicion.no-autorizo-uso", right: "oposicion", fuerza: "fuerte", re: re(`\\bno (?:les )?(?:autorizo|permito|consiento|doy|di|otorgo)\\b(?: \\w+){0,2}? (?:permiso|autorizacion|consentimiento|que)\\b(?: \\w+){0,4}? (?:${POSS} ${DATO}|mis datos)\\b|\\bno autorizo\\b(?: \\w+){0,4}? ${POSS} ${DATO}\\b`) },
  { id: "oposicion.no-usen-mis-datos", right: "oposicion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\bno (?:\\w+ ){0,2}?(?:usen|utilicen|traten|compartan|vendan|cedan|transfieran|difundan|publiquen|ocupen|manejen)\\b(?: \\w+){0,3}? ${POSS} ${DATO}\\b`) },
  { id: "oposicion.dejen-de-usar-mis-datos", right: "oposicion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\bdejen de (?:usar|utilizar|tratar|compartir|guardar|ocupar|vender|tener|manejar)\\b(?: \\w+){0,3}? ${POSS} ${DATO}\\b`) },
  { id: "oposicion.derecho-por-nombre", right: "oposicion", fuerza: "fuerte", re: re(`\\bderecho (?:de |a la |al |a )?(?:oposicion|revocacion)\\b|\\b(?:oposicion|revocacion) (?:de |a |sobre |al )?(?:mis |mi |los |la )?(?:datos|informacion|info|tratamiento)\\b`) },
  { id: "oposicion.no-escribir-mas", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\bno me ${CONTACTO_VERBO} (?:mas(?! (?:tarde|temprano|rato|despues|adelante|fuerte|bajo|bajito|alto|noche|luego))|nunca|jamas)\\b`) },
  { id: "oposicion.no-mandar-contacto-sustantivo", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:ya )?no (?:me )?(?:vuelvan a |sigan |dejen de |quiero que me (?:sigan |vuelvan a )?|deseo que me (?:sigan |vuelvan a )?)?${ENVIAR}\\b(?: \\w+){0,2}? ${CONTACTO_SUSTANTIVO}\\b`) },
  { id: "oposicion.no-escribir-con-marca", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:ya no|no mas|nunca) (?:me )?(?:vuelvan a |sigan |quiero que me (?:sigan |vuelvan a )?)?${CONTACTO_VERBO}\\b|\\bno (?:me )?vuelvan a ${CONTACTO_VERBO}\\b|\\bno (?:quiero|deseo|quisiera) que me (?:sigan |vuelvan a )?${CONTACTO_VERBO}\\b|\\bno (?:quiero|deseo) que me (?:sigan|vuelvan a) ${ENVIAR}\\b`) },
  { id: "oposicion.no-escribir-sin-marca", right: "oposicion", fuerza: "debil", contacto: true, re: re(`\\bno me (?:llamen|escriban|contacten|molesten|hablen)\\b(?! (?:cuando|al |a la |para |que |mas (?:tarde|temprano|rato|despues))|.* (?:cuando|al llegar|a la puerta|timbre|repartidor|toquen|esperen|afuera))`) },
  { id: "oposicion.dejen-de-contactarme", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\bdejen de (?:(?:escrib|llam|contact|molest|hablar|textee|mensajee)\\w*me\\b|(?:mandarme|enviarme|mandar|enviar)(?:me)?\\b(?: \\w+){0,2}? ${CONTACTO_SUSTANTIVO}\\b)`) },
  { id: "oposicion.no-quiero-recibir", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:ya )?no (?:quiero|deseo|quisiera|autorizo) (?:recibir|mas|seguir recibiendo|que me lleguen)\\b(?: \\w+){0,3}? ${CONTACTO_SUSTANTIVO}\\b|\\bya no quiero ${CONTACTO_SUSTANTIVO}\\b`) },
  { id: "oposicion.que-no-me-contacten", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:ya )?no (?:quiero|deseo|quisiera) que me (?:contacten|llamen|escriban|molesten)\\b`) },
  { id: "oposicion.desuscribirme", right: "oposicion", fuerza: "fuerte", contacto: true, re: re(`\\b(?:desuscrib|desubscrib|desapunt)\\w*|\\bunsubscribe\\b|\\b(?:cancel|desactiv|quit)\\w*\\b(?: \\w+){0,4}? (?:suscripcion|promociones|publicidad|mensajes|avisos|notificaciones|lista de difusion|boletin|newsletter|mercadotecnia)\\b`) },

  // ===== ACCESO =====
  { id: "acceso.que-datos-tienen-de-mi", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:que|cuales|cuantos) (?:datos|informacion|info)(?: personales| personal)? (?:mios |mias |mia |mio )?(?:tienen|tiene|guardan|guarda|manejan|almacenan|registran|poseen|han guardado|tengan|conservan|recopilan|recabaron|hay)\\b(?: \\w+){0,3}? (?:de|sobre) (?:mi\\b${NO_ES_PEDIDO}|mi persona)|\\b(?:que )?(?:datos|informacion|info) (?:mios|mias|mia|mio|personal(?:es)?) (?:tienen|guardan|manejan|almacenan)\\b|\\b(?:que|cuales|cuantos) (?:datos|informacion|info) (?:personales )?(?:tienen|guardan)\\b(?: \\w+){0,2}? (?:mios|mias)\\b`) },
  { id: "acceso.que-saben-de-mi", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:que|cuanto) (?:es lo que )?(?:saben|guardan|han guardado|almacenan|registraron|conocen) (?:de|sobre) mi\\b${NO_ES_PEDIDO}`) },
  { id: "acceso.que-tienen-de-mi-sin-sustantivo", right: "acceso", fuerza: "debil", re: re(`\\bque (?:es lo que )?tienen (?:de|sobre) mi\\b${NO_ES_PEDIDO}`) },
  { id: "acceso.pedir-mis-datos", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:quiero|quisiera|necesito|solicito|deseo|pido)\\b(?: \\w+){0,3}? (?:mis datos|mis datos personales|mi informacion personal|una copia de (?:mis datos|mi informacion))\\b|\\b(?:acceso|acceder|conocer|consultar|saber|copia|obtener|entregu\\w*|mand\\w*|envi\\w*|pas(?:en|ame)\\w*|muestr\\w*|denme|dame|ver)\\b(?: \\w+){0,3}? (?:mis datos(?: personales)?|mi informacion personal|toda mi informacion|toda mi info)\\b`) },
  { id: "acceso.todo-lo-que-tengan-de-mi", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:mand\\w*|envi\\w*|pas(?:en|ame)\\w*|muestr\\w*|entreg\\w*|denme|dame|quiero|necesito|saber|ver|conocer)\\b(?: \\w+){0,3}? (?:todo )?lo que (?:tengan|tienen|guardan|saben|hayan guardado|han guardado)\\b(?: \\w+){0,3}? (?:de mi\\b${NO_ES_PEDIDO}|mio|mia|sobre mi)`) },
  { id: "acceso.mis-datos-que-tienen", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:cuales|cuantos) (?:son )?${POSS} (?:datos|informacion|info)(?: personales)? que (?:tienen|guardan|manejan|almacenan|registran)\\b|\\b${POSS} (?:datos|informacion) (?:personales )?que (?:tienen|guardan|manejan|almacenan) (?:de mi|sobre mi)?`) },
  { id: "acceso.por-que-tienen-mi-dato", right: "acceso", fuerza: "fuerte", re: re(`\\bpor que (?:tienen|guardan|conservan|usan|manejan|almacenan|cuentan con|conocen) ${POSS} ${DATO_CONCRETO}\\b|\\bcomo (?:consiguieron|obtuvieron|supieron|lograron|encontraron|sacaron) ${POSS} ${DATO}\\b|\\bquien(?:es)? (?:les|le) (?:dio|dieron|paso|pasaron|dijo) ${POSS} ${DATO}\\b|\\bde donde (?:sacaron|obtuvieron|consiguieron) ${POSS} ${DATO}\\b`) },
  { id: "acceso.con-quien-comparten", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:con|a) quien(?:es)? (?:comparten|compartieron|han compartido|vendieron|venden|ceden|cedieron|comparte)\\b(?: \\w+){0,3}? ${POSS}\\b`) },
  { id: "acceso.que-hacen-con-mis-datos", right: "acceso", fuerza: "fuerte", re: re(`\\b(?:que|para que|como) (?:hacen|hicieron|usan|utilizan|manejan|tratan|ocupan) (?:con )?${POSS} (?:datos|informacion|info|numero|telefono)\\b`) },
  { id: "acceso.tienen-mis-datos-guardados", right: "acceso", fuerza: "debil", re: re(`\\b(?:tienen|guardan|conservan|manejan) ${POSS} (?:datos|informacion|info|numero|telefono)\\b(?: \\w+){0,2}? (?:guardad|registrad|almacenad)\\w*`) },
  { id: "acceso.derecho-por-nombre", right: "acceso", fuerza: "fuerte", re: re(`\\bderecho (?:de |a la |al |a )?acceso\\b|\\bacceso (?:a |de |sobre )?(?:mis |mi |los |la )?(?:datos|informacion|info)\\b`) },

  // ===== RECTIFICACION =====
  { id: "rectificacion.corregir-mis-datos", right: "rectificacion", fuerza: "fuerte", colaDePedido: "anula", re: re(`\\b(?:corrij|corrig|correg|rectific|actualic|actualiz|modific|modifiqu|cambi|arregl)\\w* ${FILL}${POSS} (?:datos(?: personales)?|informacion personal|nombre|apellidos?|correo|email|mail|telefono|numero de telefono|celular)\\b`) },
  { id: "rectificacion.mi-dato-esta-mal", right: "rectificacion", fuerza: "fuerte", re: re(`\\b${POSS} (?:nombre|apellidos?|correo|email|mail|datos|telefono|celular|numero de telefono)\\b(?: \\w+){0,3}? (?:esta|estan|tienen|aparece|aparecen|salio|salen|quedo|quedaron|registraron|capturaron)\\b(?: \\w+){0,2}? (?:mal|incorrect\\w*|equivocad\\w*|erroneo\\w*)\\b|\\btienen (?:mal|incorrecto|equivocado)(?: escrito)?\\b(?: \\w+){0,2}? ${POSS} (?:nombre|apellidos?|correo|email|datos|telefono|celular)\\b`) },
  { id: "rectificacion.rectificar-datos", right: "rectificacion", fuerza: "fuerte", re: re(`\\b(?:rectificar|rectificacion|rectifiquen|rectifico)\\b(?: \\w+){0,3}? (?:datos|informacion|info|mis|mi)\\b|\\bderecho (?:de |a la |al |a )?(?:rectificacion|correccion)\\b|\\b(?:rectificacion|correccion) de (?:mis )?datos\\b`) },
  { id: "rectificacion.rectificar-sin-objeto", right: "rectificacion", fuerza: "debil", re: re(`^(?:(?:\\w+ ){0,3})?(?:rectificar|rectificacion)(?: \\w+){0,1}$`) },

  // ===== PRIVACIDAD EXPLICITA (derecho sin especificar) =====
  { id: "privacidad.derechos-arco", right: "acceso", fuerza: "fuerte", re: re(`^arco$|^(?=.*\\barco\\b)(?=.*\\b(?:datos|derechos|privacidad|solicitud|titular|ejercer|ejercicio)\\b)|\\b(?:derechos? arco|aviso de privacidad|aviso legal de privacidad|proteccion de datos|lfpdppp|datos personales|derechos? (?:sobre|de) (?:mis )?datos|mis derechos (?:sobre|de|como titular|arco))\\b`) },
  { id: "privacidad.palabra-suelta", right: "acceso", fuerza: "debil", re: re(`\\bprivacidad\\b(?!.*\\b(?:mesa|mesas|salon|reservacion|reserva|reservar|area|zona|espacio|lugar|terraza|cabina|sala)\\b)(?<!.*\\b(?:mesa|mesas|salon|reservacion|reserva|reservar|area|zona|espacio|lugar|terraza|cabina|sala)\\b.*)`) },
];

/** Raices cuyo unico efecto es ofrecer el menu: el derecho no se especifica (la pregunta es "como ejerzo mis derechos"). */
const RAICES_SIN_DERECHO: ReadonlySet<string> = new Set(["privacidad.derechos-arco", "privacidad.palabra-suelta"]);

const THIRD_PARTY_RE =
  /\b(?:de|del) (?:mi|su|otro|otra|un|una|el|la) (?:esposa|esposo|pareja|mama|papa|madre|padre|hij[oa]|hermano|hermana|amig[oa]|cliente|paciente|vecin[oa]|persona|jefe|jefa|ex|novio|novia|senor|senora|familiar)\b|\bde (?:otra persona|alguien mas|un tercero|terceros)\b/;

/** Tras el objeto viene "del pedido / de la cuenta / de la factura...": habla del pedido, no de los datos del titular. */
const COLA_DE_PEDIDO = /^\s*(?:y\s+)?(?:(?:de|del|en|a|al|para|por) (?:la |el |mi |esta |esa |este |ese |su )?(?:pedido|orden|ordenes|carrito|comanda|ticket|factura|entrega|envio|reserva|reservacion|reservaciones|compra|cuenta|mesa)\b)/;

export type ArcoIntent =
  /** Peticion fuerte de un derecho concreto: se registra (con CONFIRMO). `contacto` = ademas frena el contacto/publicidad (el webhook revoca el marketing). */
  | { readonly kind: "request"; readonly right: DataRightType; readonly contacto: boolean }
  /** `fuerte` = pregunta explicita por sus derechos/privacidad (el menu sustituye el turno); `debil` = suena a ARCO pero puede ser habla de pedido (el agente sigue y se agrega el menu). */
  | { readonly kind: "menu"; readonly fuerza: FuerzaArco; readonly derechoProbable: DataRightType | null }
  | { readonly kind: "third_party" };

/** Orden de prioridad cuando un mensaje pide varios derechos a la vez: lo mas amplio primero (cancelar incluye frenar el uso). */
const PRIORIDAD: readonly DataRightType[] = ["cancelacion", "oposicion", "rectificacion", "acceso"];

interface Coincidencia {
  readonly raiz: RaizArco;
  readonly fuerza: FuerzaArco;
}

function coincidencias(normalizado: string): Coincidencia[] {
  const salida: Coincidencia[] = [];
  for (const raiz of RAICES_ARCO) {
    const m = raiz.re.exec(normalizado);
    if (!m) continue;
    let fuerza = raiz.fuerza;
    if (raiz.colaDePedido) {
      const cola = normalizado.slice(m.index + m[0].length);
      if (COLA_DE_PEDIDO.test(cola)) {
        if (raiz.colaDePedido === "anula") continue;
        fuerza = "debil";
      }
    }
    salida.push({ raiz, fuerza });
  }
  return salida;
}

/** Que raices (ids) coinciden con el texto: para las pruebas por raiz. */
export function raicesQueCoinciden(message: string): readonly string[] {
  return coincidencias(normalizarParaArco(message)).map((c) => c.raiz.id);
}

/**
 * Detecta una solicitud ARCO (o una revocacion de contacto) en UN mensaje libre. Pura, sin lanzar nunca: una entrada que no es texto devuelve `null`.
 * Ver la cabecera del archivo para el modelo de raices y fuerzas.
 */
export function detectArcoIntent(message: string): ArcoIntent | null {
  if (typeof message !== "string") return null;
  const normalizado = normalizarParaArco(message);
  if (!normalizado) return null;

  // Unificado con el webhook: la baja exacta (BAJA, STOP, "no mas mensajes"...) es oposicion/revocacion de contacto.
  if (detectarOptOut(message) === "baja") return { kind: "request", right: "oposicion", contacto: true };

  const coinc = coincidencias(normalizado);
  if (coinc.length === 0) return null;
  if (THIRD_PARTY_RE.test(normalizado)) return { kind: "third_party" };

  const fuertes = coinc.filter((c) => c.fuerza === "fuerte");
  const concretas = fuertes.filter((c) => !RAICES_SIN_DERECHO.has(c.raiz.id));
  if (concretas.length > 0) {
    const derechos = new Set(concretas.map((c) => c.raiz.right));
    const right = PRIORIDAD.find((r) => derechos.has(r)) ?? concretas[0]!.raiz.right;
    return { kind: "request", right, contacto: concretas.some((c) => c.raiz.contacto === true) };
  }
  if (fuertes.length > 0) return { kind: "menu", fuerza: "fuerte", derechoProbable: null };
  const probable = coinc.find((c) => !RAICES_SIN_DERECHO.has(c.raiz.id));
  return { kind: "menu", fuerza: "debil", derechoProbable: probable ? probable.raiz.right : null };
}

/** `true` si el mensaje pide frenar el contacto/publicidad (BAJA, "ya no me escriban", "olvidense de mi"...): el webhook revoca ademas el marketing de ese telefono. */
export function esOposicionDeContacto(message: string): boolean {
  const intent = detectArcoIntent(message);
  return intent !== null && intent.kind === "request" && intent.contacto;
}

// ===================================================================================================================================================
// ELECCION DEL MENU. El menu deja una marca en el historial; la siguiente respuesta del cliente elige un derecho. Dos estados:
//   - "numerado": el menu SUSTITUYO el turno (pregunta explicita por derechos). El cliente esta en el tramite: se acepta el nombre, sinonimos
//     coloquiales ("borrar", "eliminar", "oponerme", "la de cancelacion") y los numeros 1-4 / "la primera".
//   - "nombres": el menu se AGREGO a una respuesta normal del agente. Un "2" o un "cancelar" pueden ser parte del pedido, asi que solo cuentan el
//     NOMBRE del derecho o una frase con "mis datos" ("borrar mis datos").
// ===================================================================================================================================================
export type EstadoMenuArco = "numerado" | "nombres";

export { ARCO_MENU_MARCA_NOMBRES, ARCO_MENU_MARCA_NUMERADO };

/** El ultimo mensaje del asistente trae un menu ARCO sin contestar? (`mensajes` = historial en orden; solo importa el ultimo `assistant` previo al mensaje del cliente). */
export function estadoDeMenuArco(ultimoTextoDelAsistente: string | null | undefined): EstadoMenuArco | null {
  if (typeof ultimoTextoDelAsistente !== "string") return null;
  if (ultimoTextoDelAsistente.includes(ARCO_MENU_MARCA_NUMERADO)) return "numerado";
  if (ultimoTextoDelAsistente.includes(ARCO_MENU_MARCA_NOMBRES)) return "nombres";
  return null;
}

export type EleccionDeMenu =
  | { readonly tipo: "derechos"; readonly derechos: readonly DataRightType[] }
  /** "todos", "no se", "otra cosa", "una persona": no eligio uno, pero esta en el tramite (se registra la mejor conjetura y se escala). */
  | { readonly tipo: "ambigua" };

const RELLENO_DE_ELECCION = /\b(?:quiero|quisiera|deseo|pues|este|eh|mm|mmm|ok|la|el|lo|los|las|de|del|a|al|opcion|numero|derecho|derechos|por favor|porfa|gracias|solicito|pido|elijo|escojo|prefiero|seria|es|ese|esa|sobre|mi|mis|solo|nomas|quiero ejercer|ejercer)\b/g;
const NOMBRES_ESTRICTOS: ReadonlyArray<{ readonly right: DataRightType; readonly re: RegExp }> = [
  { right: "acceso", re: /^(?:acceso|acceder|el acceso)$/ },
  { right: "rectificacion", re: /^(?:rectificacion|rectificar)$/ },
  { right: "cancelacion", re: /^(?:cancelacion|supresion|suprimir)$/ },
  { right: "oposicion", re: /^(?:oposicion|oponerme|me opongo|oponer|revocacion|revocar)$/ },
];
const CON_MIS_DATOS = /\b(?:mis datos|mi informacion|mi info)\b/;
const SINONIMOS_LAXOS: ReadonlyArray<{ readonly right: DataRightType; readonly re: RegExp }> = [
  { right: "acceso", re: /\b(?:acceso|acceder|conocer|consultar|copia|primera|primero|uno|1|saber que datos|que datos tienen|ver mis datos|conocer mis datos)\b/ },
  { right: "rectificacion", re: /\b(?:rectific\w*|corregir|corrijan|correccion|actualizar|actualicen|modificar|modifiquen|segunda|segundo|dos|2)\b/ },
  { right: "cancelacion", re: /\b(?:cancelacion|cancelar|borrar|borren|eliminar|eliminen|suprimir|supriman|supresion|olvidar|olviden|baja|destruir|tercera|tercero|tres|3)\b/ },
  { right: "oposicion", re: /\b(?:opos\w*|oponerme|oponer|opongo|revocar|revoco|revocacion|dejar de recibir|no manden|no escriban|no llamen|no contacten|cuarta|cuarto|cuatro|4)\b/ },
];
const AMBIGUA_RE = /^(?:todos|todas|los cuatro|las cuatro|cualquiera|ninguno|ninguna|no se|nose|no estoy seguro|otra cosa|ayuda|una persona|un humano|alguien|un asesor|hablar con (?:una |un )?(?:persona|humano|alguien|asesor|encargado|gerente)|no entiendo|cual|cuales|cualquier)(?: .*)?$/;
/** Una sola cifra o numero escrito (la eleccion «2», «la 3», «opcion 4»), nunca dentro de una frase de pedido («2 tacos»). */
const SOLO_NUMERO = /^(?:[1-4]|uno|dos|tres|cuatro)$/;

/** Interpreta la respuesta del cliente a un menu ARCO. `null` = no es una eleccion (sigue el flujo normal). */
export function detectarEleccionDeMenu(message: string, estado: EstadoMenuArco): EleccionDeMenu | null {
  if (typeof message !== "string") return null;
  const normalizado = normalizarParaArco(message);
  if (!normalizado || normalizado.split(" ").length > 12) return null;
  const sinRelleno = normalizado.replace(RELLENO_DE_ELECCION, " ").replace(/\s+/g, " ").trim();
  const derechos = new Set<DataRightType>();
  if (estado === "numerado") {
    // El cliente esta en el tramite, pero un mensaje largo es otra cosa (un pedido): la eleccion es corta.
    if (sinRelleno === "" || sinRelleno.split(" ").length > 4) return null;
    for (const { right, re } of SINONIMOS_LAXOS) {
      const hit = re.exec(sinRelleno);
      if (!hit) continue;
      // Los numeros solo valen SOLOS ("2", "la 3"); «2 tacos» no es la opcion 2.
      if (SOLO_NUMERO.test(hit[0]) && !SOLO_NUMERO.test(sinRelleno)) continue;
      derechos.add(right);
    }
    if (derechos.size === 0) return AMBIGUA_RE.test(sinRelleno) || AMBIGUA_RE.test(normalizado) ? { tipo: "ambigua" } : null;
  } else {
    const conDatos = CON_MIS_DATOS.test(normalizado);
    for (const { right, re } of NOMBRES_ESTRICTOS) if (re.test(sinRelleno)) derechos.add(right);
    if (conDatos) for (const { right, re } of SINONIMOS_LAXOS) if (!SOLO_NUMERO.test(re.exec(normalizado)?.[0] ?? "") && re.test(normalizado)) derechos.add(right);
    if (derechos.size === 0) return null;
  }
  return { tipo: "derechos", derechos: PRIORIDAD.filter((r) => derechos.has(r)) };
}

/** Hay alguna senal de ARCO (aun debil) en el mensaje: sirve para decidir si, dentro de un menu, una respuesta que no es eleccion sigue siendo "del tramite". */
export function hayAlgunaSenalArco(message: string): boolean {
  return detectArcoIntent(message) !== null;
}
