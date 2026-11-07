// Cerebro v2: «¿queda algo en la ráfaga que el modelo deba atender?» (hayResidualConContenido del suelto, Revisión 61/62/63, whatsapp-agent-core.ts e69279e
// ~15497-15592), PUERTO LITERAL. Lo usa la decisión de salud antes del modelo (R87-N: alergia sola con residual => el aviso queda y el modelo atiende lo demás).
// Pura: no lee la base ni el reloj.
import { normAviso } from "./avisos.ts";

// Las mismas listas del núcleo (whatsapp-agent-core.ts ~11726-11734).
const COMIDA_RECLAMO =
  "kilo|kilos|carne|carnes|coca|cocas|refresco|refrescos|bebida|bebidas|agua|cerveza|taco|tacos|orden|ordenes|salsa|salsas|guacamole|queso|quesadilla|quesadillas|gringa|gringas|alambre|alambres|suizo|suizos|mestiza|mestizas|papa|papas|frijoles|tortilla|tortillas|limon|limones|cebolla|nachos|torta|tortas|postre|complemento|complementos|pastor|bistec|pollo|pechuga|chorizo|cochinita|res|" +
  "sopa|sopas|arrachera|chuleta|costilla|champinon|champinones|rajas|flauta|flautas|fajita|fajitas|alitas|papadzules|codzitos|hamburguesa|hamburguesas|chetaco|chetacos|quesobich|parrillada|ensalada|flan|jericalla|jericallas|horchata|limonada|limonadas|naranjada|naranjadas|sprite|fanta|michelada|chelada|cafe";
const ARTICULO_RECLAMO =
  "la|el|los|las|un|una|unos|unas|mi|mis|su|sus|\\d+|dos|tres|cuatro|cinco|seis";
const PROTEINA_RECLAMO = "pastor|bistec|pechuga|pollo|res|chorizo|cochinita|suadero|campechano";

/** Revisión 61: cortesía, relleno y la queja misma («qué asco», «muy mal servicio») no cuentan como contenido del residual. */
const RELLENO_RESIDUAL = new Set(
  ("gracias porfa porfis plis pls please por favor ok okey oki okay vale va sale listo perfecto entendido hola buenas buenos " +
    "buen dia dias tarde tardes noche noches saludos oye oiga joven senorita amigo amiga bueno pues este mmm eh ah jaja jeje " +
    "si no ya y e pero o u ni que el la los las lo le les un una unos unas de del al a en con sin para por me te se nos mi mis " +
    "tu tus su sus muy tan mas otro otra otros otras tambien igual todo toda todos todas nada eso esto esa ese es era fue son " +
    "esta estaba estan estuvo hay vino venia vinieron como pedido donde cuando cuanto porque cual verdad mal servicio pesimo " +
    "horrible terrible asco neta nunca siempre vez").split(" "),
);
/** Revisión 61: palabras que hacen de una cláusula una petición con contenido aunque sea corta (producto, cantidad, lugar). */
const CONTENIDO_RESIDUAL = new RegExp(
  String.raw`\d|\b(?:${COMIDA_RECLAMO}|${PROTEINA_RECLAMO}|kilos?|kg|medio|docena|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|` +
    String.raw`calle|domicilio|colonia|col|avenida|av|fraccionamiento|fracc|direccion|recoger|recojo|recogerlo|llevar)\b`,
);
/** Revisión 61: una cláusula que solo nombra productos («la coca», «2 tacos de pastor»): sigue la enumeración de antes. */
// Revisión 63 (R63-1): con cortesía al final («cancelen el pedido de 2 tacos y la coca porfa») sigue siendo la enumeración.
const SOLO_PRODUCTOS_RESIDUAL = new RegExp(
  String.raw`^(?:(?:${ARTICULO_RECLAMO}|de|del|con|sin|mas|otro|otra|otros|otras|tambien|y|e|ni|porfa|porfis|plis|pls|please|por|favor|gracias|${COMIDA_RECLAMO}|${PROTEINA_RECLAMO})(?:\s+|$))+$`,
);
/** Separador de cláusulas del residual: puntuación, «y», «pero» (texto plano; los signos de pregunta se quedan). */
const SEPARA_CLAUSULAS_RESIDUAL = /[,.;:!\n]+|\s+(?:y|e|pero)\s+/;
/** Revisión 62 (R62-2): pedir en presente («quiero», «dame», «mándame», «pásame», «me da»…), texto plano al inicio. */
const PETICION_PRESENTE = new RegExp(
  String.raw`^(?:(?:hola|buenas|oiga|oye|porfa|por\s+favor|y|e|ahora|tambien|mejor|ademas)\s+)*(?:quiero|queremos|quisiera|quisieramos|dame|deme|denme|mandame|mandeme|mandenme|pasame|paseme|pasenme|traeme|traigame|traiganme|ponme|pongame|ponganme|agregame|agregueme|agreguenme|pideme|pidame|me\s+(?:da|das|den|de|manda|mandas|manden|pasa|pasas|pasan|trae|traes|traen|pone|pones|ponen|agrega|agregas|agregan))\b`,
);
/** Describe el pedido pasado (pedí, ordené, me mandaron, llegó…): es contexto de la queja aunque nombre productos. */
const PEDIDO_PASADO = /\b(?:pedi|pedimos|ordene|ordenamos|encargue|encargamos|compre|compramos|mandaron|enviaron|trajeron|dieron|llego|llegaron|vino|vinieron|venia|venian)\b/;
function esPeticionPresente(plano: string): boolean {
  return PETICION_PRESENTE.test(plano) && !PEDIDO_PASADO.test(plano) && CONTENIDO_RESIDUAL.test(plano);
}
/**
 * Revisión 61: ¿la cláusula trae algo que atender? Con número, producto o lugar, o con al menos dos palabras que no son
 * cortesía ni relleno; fuera de la burbuja del riesgo, también cualquier pregunta (dentro, «¿qué pasó?» sigue la queja). Pura.
 */
function clausulaConContenido(clausula: string, delRiesgo: boolean): boolean {
  if (!delRiesgo && /[¿?]/.test(clausula)) return true;
  const plano = clausula.replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (plano === "") return false;
  if (CONTENIDO_RESIDUAL.test(plano)) return true;
  return plano.split(" ").filter((w) => !RELLENO_RESIDUAL.has(w)).length >= 2;
}
/**
 * Revisión 61 (regla genérica): tras decidir una respuesta fija (reclamo, cancelación, pregunta de cancelar) para algunas
 * burbujas, ¿queda algo en la ráfaga que el modelo deba atender? El residual es la ráfaga sin las burbujas que dispararon el
 * camino fijo y, dentro de cada una de esas, sin la cláusula que lo disparó ni lo que va antes (se parte en «,», «.», «y»,
 * «pero»). No cuentan
 * la cortesía, una burbuja que `burbujaAtendida` ya cubre (fuera de las del riesgo), una cláusula que `yaAtendida`
 * reconoce (el riesgo mismo, la demora, el «ya no lo quiero») ni, dentro de la burbuja
 * del riesgo, una cláusula que solo enumera productos («faltaron 2 tacos y una coca»). En otra burbuja, un producto con
 * artículo indefinido o número («y una coca») es pedir; con definido o posesivo («y la coca») sigue la queja. Pura.
 */
export function hayResidualConContenido(
  textos: readonly string[],
  disparadores: ReadonlySet<string>,
  burbujaAtendida: (texto: string) => boolean,
  yaAtendida: (clausula: string) => boolean,
): boolean {
  return textos.some((t) => {
    const disparo = disparadores.has(t);
    if (!disparo && burbujaAtendida(t)) return false;
    // En la burbuja del riesgo, lo que va ANTES de la cláusula que lo disparó es contexto de la queja («pedí una papa de
    // bistec y me llegó de pechuga»): solo cuenta lo que viene después.
    let trasElRiesgo = !disparo;
    return normAviso(t).split(SEPARA_CLAUSULAS_RESIDUAL).some((c) => {
      const clausula = c.trim();
      if (clausula === "") return false;
      if (yaAtendida(clausula)) {
        trasElRiesgo = true;
        return false;
      }
      const plano = clausula.replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
      // Revisión 62 (R62-2): antes del disparo, solo describir el pedido pasado («pedí una de bistec», «me mandaron…») es
      // contexto; pedir algo en presente con producto o cantidad («quiero 2 tacos de pastor, me faltó la coca») es residual.
      if (!trasElRiesgo) return esPeticionPresente(plano);
      if (SOLO_PRODUCTOS_RESIDUAL.test(plano) && (disparo || /^(?:(?:y|e|ni)\s+)?(?:la|el|los|las|mi|mis|su|sus)\b/.test(plano))) {
        return false;
      }
      return clausulaConContenido(clausula, disparo);
    });
  });
}
