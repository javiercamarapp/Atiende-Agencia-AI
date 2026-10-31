// PM Paquete C: seguimiento y demora, quejas, ráfagas con autocorrecciones, cambios a mitad del pedido, audios/imágenes, llamadas y cancelación por tardanza.
//
// Módulo AUTÓNOMO: no importa nada del perfil ni del registro de herramientas. Lo enlaza el integrador (ver el PR): agrega `PM_PAQUETE_C_PROMPT` al final del bloque de reglas de
// `buildPmSystemPrompt` (perfil-pm.ts). Las llamadas de WhatsApp NO dependen del prompt: las resuelve el turno (llm-turn-handler.ts) con texto fijo y sin modelo.
//
// Decisiones de Javier que este módulo respeta (21-oct-2026): quejas = se escalan y se avisa al encargado (comportamiento actual); PM nunca reembolsa; el agente no inventa cortesías.
// Cancelaciones: Javier dijo «no se puede cancelar» pero los chats muestran que el personal sí cancela antes de cocina. NO se cambia la política: se mantiene escalar al encargado
// (motivo cancelacion_modificacion) sin prometer ni negar la cancelación; la contradicción queda documentada en el PR para que Javier decida.

/** Texto fijo ante una llamada (o videollamada) de WhatsApp. Sin hora, sin promesas, sin teléfono inventado. */
export const COPY_LLAMADA_NO_RECIBIDA = "Por este medio no recibimos llamadas. Si gusta, escríbanos aquí su pedido o su duda y con gusto le ayudamos.";

/** Segunda llamada seguida (el cliente insiste): más breve, para no repetir el mismo párrafo. */
export const COPY_LLAMADA_REPETIDA = "Aquí solo atendemos por mensaje escrito. Escríbanos su pedido y le ayudamos enseguida.";

/** Frase fija (NU-4) con la que el servidor le dice al cliente que su «si» llego pero el pedido no alcanzo a registrarse; el siguiente turno la reconoce para no crear un pedido duplicado. */
export const MARCA_SI_SIN_REGISTRAR = "no alcancé a registrar su pedido";

/** Respuesta si el cliente vuelve a escribir «si» mientras el equipo registra su pedido a mano. Contiene la marca: el bloqueo dura hasta que haya otra respuesta distinta. */
export const COPY_SI_REPETIDO_SIN_REGISTRAR = `Ya tengo su confirmación, pero ${MARCA_SI_SIN_REGISTRAR} por este medio. Un compañero de la sucursal lo registra y se lo confirma por aquí; no hace falta que escriba de nuevo.`;

/** Marcador que deja el servidor cuando recibe una llamada como evento (lo reconoce `esAvisoDeLlamada`). */
export const MARCADOR_LLAMADA = "[El cliente intentó llamar por WhatsApp (llamada de voz o videollamada).]";

const LLAMADA_MAX_CHARS = 80;
const LLAMADA_RE = /^(?:(?:llamada|videollamada)(?:\s+de\s+(?:voz|video))?(?:\s+(?:perdida|rechazada|sin\s+respuesta|entrante|saliente))?|missed\s+(?:voice\s+|video\s+)?call)\s*(?:\(?\d{1,2}:\d{2}\)?|\d+\s*(?:s|seg|min)\.?)?$/;
const LLAMADA_MARCADOR_RE = /^\[el cliente intento llamar por whatsapp\b[^\]]*\]$/;

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s()[\].:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El mensaje ENTERO es solo el aviso de una llamada de WhatsApp («Llamada de voz perdida», «Missed video call») o el marcador del servidor?
 * Es estricto a propósito: «te llamo más tarde» o un pedido que menciona una llamada NO cuentan, así que un cliente con un pedido real nunca recibe este texto fijo.
 */
export function esAvisoDeLlamada(texto: string): boolean {
  if (typeof texto !== "string" || texto.length === 0 || texto.length > LLAMADA_MAX_CHARS * 2) return false;
  const n = normalizar(texto);
  if (n.length === 0) return false;
  if (LLAMADA_MARCADOR_RE.test(n)) return true;
  return n.length <= LLAMADA_MAX_CHARS && LLAMADA_RE.test(n);
}

/** Reglas de prompt del paquete C (para el bloque de reglas de PM; ver el PR para el punto de enlace). Sin datos de chats reales. */
export const PM_PAQUETE_C_PROMPT = `PAQUETE C: SEGUIMIENTO, QUEJAS, RÁFAGAS Y CAMBIOS
C1. SEGUIMIENTO Y DEMORA («¿ya salió?», «¿falta mucho?», «ya pasó mucho tiempo»): use SOLO el "Pedido reciente" o buscar_cliente (paso 16); no diga «ya salió», «va en camino» ni «está por llegar» si la sucursal no lo marcó. Si ya pasó el tiempo prometido o el cliente lleva mucho esperando, disculpa breve («disculpe la espera») y escale con escalar_a_humano, motivo "tiempos_entrega", con la hora de confirmación del pedido; el servidor agrega folio y dirección. Sin dato del estado, dígalo con sinceridad («no tengo el estado de su pedido; ya avisé a la sucursal para que se lo confirmen») y escale; nunca deje la pregunta sin respuesta. Si escribe varias veces seguidas, conteste cada mensaje con una frase distinta y útil, sin repetir la disculpa completa y sin escalar otra vez si ya avisó en esta conversación.
C2. QUEJAS (salsas olvidadas, piezas faltantes, pedido tardado): como el paso 14, con escalar_a_humano motivo "queja" y el detalle exacto («faltaron las salsas», «faltó una orden de papas»); aunque haya otro aviso abierto (un cambio o una cancelación), la queja lleva su propio aviso. PM nunca reembolsa: ni reembolsos, descuentos, cortesías, reposición ni tiempos de reposición; lo decide el encargado. No niegue ni discuta («yo sí se las puse»): crea al cliente y deje la verificación al equipo.
C3. RÁFAGAS Y AUTOCORRECCIONES: varios mensajes seguidos (4 a 12) son UNA sola petición y una sola respuesta. Si se corrige («mejor 5», «no, de bistec»), vale la última versión; no cobre ni liste lo corregido. Si pega una plantilla rellena, tome sus datos sin repetirla. Termine con UN solo resumen en lista y un sí claro (pasos 10 y 11).
C4. CAMBIOS A MITAD DEL PEDIDO: antes de confirmar recotice y repita el resumen (paso 2); después, paso 13. Si el pedido a domicilio aún no sale y el cliente prefiere recoger («mejor paso por él»), pase el cambio con escalar_a_humano (motivo "cancelacion_modificacion") sin recargo inventado ni tiempos; si ya salió, ofrezca un pedido nuevo.
C5. AUDIOS, IMÁGENES Y LLAMADAS: una nota de voz transcrita se confirma con el cliente antes de cotizar. Una imagen con una dirección o un pedido no se da por leída: pida el pin de WhatsApp o que lo escriba en una línea; nunca finja haber visto o escuchado lo que no se pudo abrir. Las llamadas de WhatsApp no se reciben: «por este medio no recibimos llamadas; escríbanos aquí su pedido».
C6. CANCELAR POR TARDANZA («ya me cansé de esperar, cancélalo», «mejor ya no lo quiero»): disculpa breve y escale al encargado con escalar_a_humano, motivo "cancelacion_modificacion", con el detalle de la tardanza. No prometa ni niegue la cancelación ni dé una regla por su cuenta: diga que ya avisó al encargado y que él le confirma. Sin descuentos, cortesías ni reembolsos para retenerlo; no insista si ya decidió.`;
