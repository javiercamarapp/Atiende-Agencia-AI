// B03 (import-orig-04): cierre del pedido por WhatsApp con botones «Confirmar pedido» / «Cambiar algo».
//
// Problema medido (ronda 2): el cierre dependia de que el cliente escribiera «si» (1 cierre en 127 conversaciones, 23 bucles repitiendo el
// resumen). El resumen ahora sale en UN solo mensaje interactivo (tipo `button` de la Cloud API, maximo 3 botones, titulo <= 20 caracteres,
// cuerpo <= 1024) con dos botones. Lo determinista vive aqui; el modelo no decide nada de esto.
//
// Principios:
//   * El boton es un ATAJO, no un camino nuevo: el toque en «Confirmar pedido» entra al turno como un «si» explicito y el pedido se crea por el
//     MISMO camino de siempre (confirmar_resumen -> crear_pedido): el servidor revalida precio, zona, horario, pedido grande y huella. El «si» escrito
//     sigue funcionando igual.
//   * El id del boton va atado a UN resumen: lleva la huella de la cotizacion (`quote_hash`) y el instante en que se cotizo. Al tocarlo se compara con la
//     cotizacion VIGENTE del servidor: un boton de un resumen viejo (el pedido cambio, vencio o ya se creo) nunca crea nada y recibe una respuesta honesta.
//   * El id lleva ademas una suma de verificacion corta (sha256, SIN secreto): detecta ids mal formados o editados a mano. NO es una firma criptografica: la
//     autenticidad del toque la da la firma HMAC del webhook de Meta; la proteccion contra repeticiones es la comparacion con el estado del servidor.
//   * Degrada a texto: si el cuerpo no cabe en un mensaje interactivo, o el canal no admite botones (el widget demo y el simulador del panel no entregan
//     nada a Meta), el cliente conserva el resumen en texto con su pregunta de siempre y puede contestar «si».
import { createHash } from "node:crypto";
import { QUOTE_TTL_MS, type OrderFlowSnapshot } from "../agent-tools/order-flow.ts";

/** Titulos fijos (Meta: <= 20 caracteres). */
export const BOTON_CONFIRMAR_TITULO = "Confirmar pedido";
export const BOTON_CAMBIAR_TITULO = "Cambiar algo";

/** Limites reales de la Cloud API para un mensaje interactivo de botones de respuesta. */
export const BOTONES_MAX = 3;
export const BOTON_TITULO_MAX = 20;
export const BOTON_ID_MAX = 256;
export const BOTONES_CUERPO_MAX = 1024;

/** Ventana de servicio de WhatsApp: 24 h desde el ultimo mensaje del cliente. Se deja una hora de margen para no encolar un mensaje que Meta rechazaria. */
export const VENTANA_SERVICIO_MS = 24 * 60 * 60 * 1000;
export const MARGEN_VENTANA_MS = 60 * 60 * 1000;

/** Cuerpo del mensaje de botones cuando el resumen NO cabe en 1024 caracteres: el resumen sale como texto y los botones van aparte, con esta pregunta. */
export const TEXTO_BOTONES_APARTE = "¿Confirmamos su pedido tal como quedó en el resumen?";

export type AccionBoton = "confirmar" | "cambiar";

export interface BotonResumen {
  readonly accion: AccionBoton;
  /** Huella de la cotizacion (`quote_hash`, 32 hex) a la que pertenece el boton. */
  readonly quoteHash: string;
  /** Instante (ms) en que se cotizo: distingue dos cotizaciones del mismo carrito en momentos distintos. */
  readonly quotedAtMs: number;
}

export interface BotonSalida {
  readonly id: string;
  readonly title: string;
}

const VERSION = "rp1";
const ID_RE = /^rp1:(confirmar|cambiar):([0-9a-f]{32}):([0-9a-z]{1,12}):([0-9a-f]{8})$/;

function sumaDeVerificacion(accion: AccionBoton, quoteHash: string, quotedAt36: string): string {
  return createHash("sha256").update(`${VERSION}|${accion}|${quoteHash}|${quotedAt36}`).digest("hex").slice(0, 8);
}

/** Id del boton de un resumen: `rp1:<accion>:<quote_hash>:<instante en base 36>:<suma>` (< 80 caracteres, el tope de Meta es 256). */
export function idDeBoton(b: BotonResumen): string {
  const at36 = Math.max(0, Math.trunc(b.quotedAtMs)).toString(36);
  return `${VERSION}:${b.accion}:${b.quoteHash}:${at36}:${sumaDeVerificacion(b.accion, b.quoteHash, at36)}`;
}

/** Parseo estricto: `null` si el id no es de esta funcion, esta mal formado o la suma de verificacion no coincide (cualquier otro boton sigue por su camino). */
export function parsearIdDeBoton(id: unknown): BotonResumen | null {
  if (typeof id !== "string" || id.length > BOTON_ID_MAX) return null;
  const m = ID_RE.exec(id);
  if (!m) return null;
  const [, accion, quoteHash, at36, suma] = m as unknown as [string, AccionBoton, string, string, string];
  if (sumaDeVerificacion(accion, quoteHash, at36) !== suma) return null;
  const quotedAtMs = parseInt(at36, 36);
  if (!Number.isSafeInteger(quotedAtMs)) return null;
  return { accion, quoteHash, quotedAtMs };
}

/** Los dos botones del resumen, ya validados contra los limites de la Cloud API. */
export function construirBotonesDeConfirmacion(cotizacion: { readonly quoteHash: string; readonly quotedAtMs: number }): readonly BotonSalida[] {
  const botones: BotonSalida[] = [
    { id: idDeBoton({ accion: "confirmar", ...cotizacion }), title: BOTON_CONFIRMAR_TITULO },
    { id: idDeBoton({ accion: "cambiar", ...cotizacion }), title: BOTON_CAMBIAR_TITULO },
  ];
  if (botones.length > BOTONES_MAX) throw new Error("demasiados botones");
  for (const b of botones) {
    if (b.title.length === 0 || b.title.length > BOTON_TITULO_MAX) throw new Error(`titulo de boton invalido: ${b.title}`);
    if (b.id.length === 0 || b.id.length > BOTON_ID_MAX) throw new Error("id de boton invalido");
  }
  return botones;
}

/** El mensaje trae un resumen para confirmar: algo que parece un total en pesos. Los turnos que solo preguntan (¿a nombre de quien?) no llevan botones. */
export function pareceResumenParaConfirmar(reply: string): boolean {
  return /\$\s*\d/.test(reply);
}

/** El cuerpo cabe en UN mensaje interactivo (resumen + botones juntos). */
export function cabeEnMensajeInteractivo(reply: string): boolean {
  return reply.length >= 1 && reply.length <= BOTONES_CUERPO_MAX;
}

/** Dentro de la ventana de 24 h del cliente (con margen). Sin dato de cuando escribio (`undefined`) se asume que acaba de escribir: es la respuesta a su mensaje. */
export function dentroDeVentanaDeServicio(recibidoEnMs: number | undefined, ahoraMs: number): boolean {
  if (recibidoEnMs === undefined || !Number.isFinite(recibidoEnMs)) return true;
  return ahoraMs - recibidoEnMs <= VENTANA_SERVICIO_MS - MARGEN_VENTANA_MS;
}

// ---------------------------------------------------------------------------------------------------------------------
// Marcador del toque dentro del historial (mismo patron que el marcador de ubicacion o de sticker): el texto del cliente es el titulo del boton y una linea
// aparte lleva el id. Asi el toque viaja igual por el camino sin espera y por el de la espera de rafagas, y el turno puede decidir sin el modelo si el boton es
// vigente. Un texto ESCRITO por el cliente nunca puede traer un marcador (se elimina al entrar).
// ---------------------------------------------------------------------------------------------------------------------

const MARCADOR_RE = /\[boton:(rp1:[a-z]+:[0-9a-f]{32}:[0-9a-z]{1,12}:[0-9a-f]{8})\]/g;

/** Linea que se agrega al mensaje del cliente cuando el origen fue un toque a un boton de resumen (id valido), o `""`. */
export function marcadorDeToque(botonId: unknown): string {
  return parsearIdDeBoton(botonId) ? `[boton:${botonId as string}]` : "";
}

/** Quita cualquier marcador de un texto (lo que el cliente ESCRIBE no puede falsificar un toque). */
export function quitarMarcadoresDeToque(texto: string): string {
  if (!texto.includes("[boton:")) return texto;
  // Hasta que no cambie: «[bo[boton:x]ton:<id>]» deja un marcador valido al quitar el interno.
  let actual = texto;
  for (let previo = ""; previo !== actual; ) {
    previo = actual;
    actual = actual.replace(/\[boton:[^\]\n[]*\]/g, "");
  }
  return actual.replace(/\[boton:/g, "").trim();
}

/** Contenido que se guarda en el historial: el titulo que toco (ya redactado) y, aparte, el marcador del toque. */
export function contenidoDeMensajeConToque(textoRedactado: string, botonId: unknown): string {
  const marcador = marcadorDeToque(botonId);
  const limpio = quitarMarcadoresDeToque(textoRedactado);
  return marcador ? `${limpio}\n${marcador}` : limpio;
}

/** El toque que trae un mensaje del historial, o `null`. */
export function toqueDeMensaje(content: string): BotonResumen | null {
  MARCADOR_RE.lastIndex = 0;
  const m = MARCADOR_RE.exec(content);
  MARCADOR_RE.lastIndex = 0;
  return m ? parsearIdDeBoton(m[1]) : null;
}

/** Texto que lee el MODELO en lugar del marcador. Confirmar es un «si» explicito (solo si es el ultimo mensaje del cliente y el boton es vigente). */
export const NOTA_TOQUE_CONFIRMAR = "[El cliente tocó el botón «Confirmar pedido» del resumen vigente: es un sí explícito a ese resumen. Llame confirmar_resumen y enseguida crear_pedido con los mismos datos del resumen, SIN repetirlo.]";
/** Variante cuando el SERVIDOR ya ejecuto `confirmar_resumen` por el toque vigente (una vuelta menos del modelo): solo falta `crear_pedido`. */
export const NOTA_TOQUE_CONFIRMAR_YA_REGISTRADA = "[El cliente tocó el botón «Confirmar pedido» del resumen vigente: es un sí explícito a ese resumen y el sistema YA registró la confirmación (confirmar_resumen ya se ejecutó, no la llame otra vez). Llame crear_pedido con los mismos datos del resumen, SIN repetirlo.]";
export const NOTA_TOQUE_CAMBIAR = "[El cliente tocó el botón «Cambiar algo» del resumen: no cree el pedido. Pregúntele qué desea cambiar y, con su respuesta, vuelva a cotizar y a mostrar el resumen.]";

/** Contenido del mensaje tal como lo ve el modelo: sin ids; los toques se vuelven una nota. `esElUltimo` = es el ultimo mensaje del cliente. */
export function contenidoParaElModelo(content: string, opciones: { readonly esElUltimo: boolean; readonly confirmarVigente: boolean; readonly confirmacionYaRegistrada?: boolean }): string {
  const toque = toqueDeMensaje(content);
  if (!toque) return content;
  const base = quitarMarcadoresDeToque(content);
  if (toque.accion === "cambiar") return `${base}\n${NOTA_TOQUE_CAMBIAR}`;
  if (!(opciones.esElUltimo && opciones.confirmarVigente)) return base;
  return `${base}\n${opciones.confirmacionYaRegistrada === true ? NOTA_TOQUE_CONFIRMAR_YA_REGISTRADA : NOTA_TOQUE_CONFIRMAR}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Vigencia del toque (determinista, contra la maquina de estados del pedido en el servidor).
// ---------------------------------------------------------------------------------------------------------------------

export type VigenciaDelToque =
  /** El resumen es el vigente: el «si» sigue el camino de siempre (el servidor revalida todo al crear). */
  | "vigente"
  /** Ese resumen ya se convirtio en pedido: nada que hacer, no se duplica. */
  | "ya_creado"
  /** El resumen se acepto pero el pedido NO se registro: quedo retenido (pedido grande) y la sucursal lo confirmara. Nunca se dice «ya quedo registrado». */
  | "retenido"
  /** El pedido se esta registrando en este instante (otro toque o el «si» escrito). */
  | "en_proceso"
  /** El pedido cambio, la cotizacion vencio o ya no existe: el boton no aplica. */
  | "obsoleto"
  /** No hay forma de comprobarlo (base sin la maquina de estados): se sigue como un «si» escrito, que es el camino de siempre. */
  | "no_verificable";

/** Nota: una re-cotizacion IDENTICA conserva el instante de la primera (`quotedAtMs`), asi que los botones de un resumen repetido vencen a los 20 min de la PRIMERA cotizacion, igual que la cotizacion misma. */
export function vigenciaDelToque(snap: OrderFlowSnapshot | null, toque: BotonResumen, ahoraMs: number): VigenciaDelToque {
  if (snap === null) return "no_verificable";
  const ctx = snap.context;
  if (!snap.state || !ctx) return "obsoleto";
  if (ctx.quoteHash !== toque.quoteHash || ctx.quotedAtMs !== toque.quotedAtMs) return "obsoleto";
  if (snap.state === "creado") return ctx.orderId ? "ya_creado" : "retenido";
  if (snap.state === "creando") return "en_proceso";
  if (ahoraMs - ctx.quotedAtMs > QUOTE_TTL_MS) return "obsoleto";
  return "vigente";
}

/** Respuestas fijas (sin modelo) para un toque que no puede seguir. De «usted», como el resto del perfil. */
export const RESPUESTA_TOQUE_OBSOLETO =
  "Ese resumen ya no es el vigente (su pedido cambió o el resumen venció), así que no lo confirmé. Dígame qué desea pedir o cambiar y le preparo el resumen otra vez.";
export const RESPUESTA_TOQUE_YA_CREADO = "Su pedido ya quedó registrado y no se duplicó. Si desea agregar algo más, dígame y le preparo un pedido nuevo.";
export const RESPUESTA_TOQUE_RETENIDO = "Su pedido está pendiente de que la sucursal lo confirme; ya se le avisó y lo contactará. No se duplicó.";
export const RESPUESTA_TOQUE_EN_PROCESO = "Su pedido se está registrando en este momento. En unos segundos le confirmo.";

export function respuestaDeToqueQueNoSigue(v: VigenciaDelToque): string | null {
  if (v === "obsoleto") return RESPUESTA_TOQUE_OBSOLETO;
  if (v === "ya_creado") return RESPUESTA_TOQUE_YA_CREADO;
  if (v === "retenido") return RESPUESTA_TOQUE_RETENIDO;
  if (v === "en_proceso") return RESPUESTA_TOQUE_EN_PROCESO;
  return null;
}
