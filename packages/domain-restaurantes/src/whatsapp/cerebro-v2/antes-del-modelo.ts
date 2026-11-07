// Cerebro v2 (bandera por organizacion, migracion 190): decision DETERMINISTA antes del modelo con las reglas medidas del repo suelto.
// Junta los bloques puros (salud/alergia, pago, cancelacion) en UNA decision que el turno de WhatsApp ejecuta: avisos a la sucursal (escalar_a_humano), respuesta fija
// sin modelo o texto que va delante de la respuesta del modelo con su bloque de sistema, y los intents del clasificador de alto riesgo de guards.ts que v2 sustituye
// (para no avisar ni contestar dos veces). Pura: no lee la base ni el reloj.
import type { HighRiskIntent } from "../guards.ts";
import type { MotivoEscalacion } from "../../agent-tools/registry.ts";
import { decidirSalud } from "./salud.ts";
import { TRANSFERENCIA_REALIZADA_REPLY, esTransferenciaRealizada } from "./pago.ts";
import { RAZON_CANCELACION, decidirCancelacion, respuestaConPreguntaAlFinal } from "./cancelacion.ts";
import type { DecisionCancelacion } from "./cancelacion.ts";
import { declaraAlergia, esCortesiaSola, MARCA_AVISO_URGENTE, riesgosDeSalud } from "./salud.ts";
import { hayResidualConContenido } from "./residual.ts";
import type { MensajeHilo } from "./texto-plano.ts";

export interface AvisoAntesDelModelo {
  readonly motivo: MotivoEscalacion;
  /** Resumen para la sucursal (la marca URGENTE va al inicio cuando aplica). */
  readonly resumen: string;
  readonly urgente: boolean;
}

export interface DecisionAntesDelModelo {
  readonly avisos: readonly AvisoAntesDelModelo[];
  /** Respuesta completa sin llamar al modelo (null = el turno sigue al modelo). */
  readonly respuestaFija: string | null;
  /** Texto que el cliente lee ANTES de la respuesta del modelo (el aviso ya quedo). */
  readonly prefijoRespuesta: string | null;
  /** Bloque extra de sistema para el modelo (el aviso ya esta registrado: no lo repitas). */
  readonly bloquePrompt: string | null;
  /** Intents de guards.ts que v2 decide por su cuenta (se ignoran en el clasificador de alto riesgo de siempre). */
  readonly sustituye: ReadonlySet<HighRiskIntent>;
  /** Motivo con el que se abre la toma de handoff (solo con respuesta fija). */
  readonly motivoToma: MotivoEscalacion | null;
  /** Decision de cancelacion del suelto (para la pregunta «¿Quiere cancelar su pedido?» / «¿mantengo o cancelo?» al final de la respuesta del modelo). */
  readonly cancelacion: DecisionCancelacion | null;
}

/** La respuesta final del modelo con lo que v2 exige alrededor: el prefijo del aviso ya registrado y la pregunta de cancelacion al final (si no la trae). Pura. */
export function respuestaFinalV2(respuestaModelo: string, d: Pick<DecisionAntesDelModelo, "prefijoRespuesta" | "cancelacion">): string {
  let r = respuestaModelo;
  if (d.cancelacion && (d.cancelacion.preguntaAlFinal || (d.cancelacion.alModelo && d.cancelacion.respuesta))) r = respuestaConPreguntaAlFinal(r, d.cancelacion);
  if (d.prefijoRespuesta && !r.includes(d.prefijoRespuesta)) r = `${d.prefijoRespuesta}\n\n${r}`;
  return r;
}

export interface ContextoAntesDelModelo {
  /** Hay un pedido ya creado y abierto del numero (la alergia se anota en el; la respuesta habla de ese pedido). */
  readonly pedidoEnCurso: boolean;
  /** El cliente escribe en ingles en el hilo (si se omite se infiere de los textos del turno). */
  readonly clienteEnIngles?: boolean;
  /** Hilo ANTES de los mensajes pendientes ({role, content}): la cancelacion lee si ya se pregunto «¿Quiere cancelar su pedido?». Sin el, no se decide cancelacion. */
  readonly mensajes?: readonly MensajeHilo[];
  readonly ahoraMs?: number;
  /** Hay un carrito a medias (cotizacion vigente): «cancela la orden de X» corrige el carrito. */
  readonly carritoEnCurso?: boolean;
  /** Otro intent de alto riesgo del texto que no es la cancelacion (el clasificador de guards.ts), o null. */
  readonly otroRiesgo?: (texto: string) => string | null;
}

const TOPE_RESUMEN = 500;

/** v2 SIEMPRE decide salud/alergia y transferencia (aunque hoy no haya riesgo): asi las negaciones y figuras que el suelto ya descarta no escalan por guards.ts. */
const SUSTITUYE_SIEMPRE: ReadonlySet<HighRiskIntent> = new Set<HighRiskIntent>(["alergia_salud", "transferencia"]);
/** Con el hilo disponible v2 tambien decide la cancelacion (posible baja, retractacion, «¿mantengo o cancelo?»). */
const SUSTITUYE_CON_CANCELACION: ReadonlySet<HighRiskIntent> = new Set<HighRiskIntent>(["alergia_salud", "transferencia", "cancelacion_modificacion"]);

/** Motivo del monorrepo para una escritura de cancelacion del suelto (el resumen lleva la etiqueta del suelto para la bandeja). */
function avisoDeCancelacion(op: { readonly operacion: string; readonly motivo: string; readonly motivoNuevo?: string; readonly mensaje: string; readonly encabezado?: string }): AvisoAntesDelModelo | null {
  // «anexar» agrega texto a un aviso ABIERTO del suelto: aqui no hay fila abierta que leer, asi que no se crea otro aviso (evita duplicados).
  if (op.operacion === "anexar") return null;
  const motivo = op.operacion === "convertir" ? (op.motivoNuevo ?? op.motivo) : op.operacion === "cancelar" ? RAZON_CANCELACION : op.motivo;
  const etiqueta = motivo === RAZON_CANCELACION ? "[cancelacion]" : motivo === "posible_baja_pedido" ? "[posible baja: el cliente duda o pregunto por cancelar]" : `[${motivo}]`;
  return { motivo: "cancelacion_modificacion", resumen: `${etiqueta} ${op.encabezado ? `${op.encabezado} ` : ""}${op.mensaje}`.slice(0, TOPE_RESUMEN), urgente: false };
}

export function decidirAntesDelModelo(pendientes: readonly string[], ctx: ContextoAntesDelModelo): DecisionAntesDelModelo {
  const textos = pendientes.map((t) => String(t ?? "")).filter((t) => t.trim() !== "");
  const avisos: AvisoAntesDelModelo[] = [];
  // R87-N (suelto): ¿la ráfaga trae algo más que atender aparte del riesgo de salud? Mismo cálculo que el núcleo (hayResidualConContenido): disparadores = los textos
  // con el riesgo; no cuentan la cortesía ni la cláusula que es el riesgo mismo (u otro riesgo de alto nivel que ya tiene su camino).
  const disparadoresSalud = new Set(textos.filter((t) => riesgosDeSalud(t).length > 0));
  const residualConContenido = disparadoresSalud.size > 0 && hayResidualConContenido(
    textos,
    disparadoresSalud,
    (t) => esCortesiaSola(t),
    (c) => esCortesiaSola(c) || riesgosDeSalud(c).length > 0 || declaraAlergia(c) || (ctx.otroRiesgo ? ctx.otroRiesgo(c) !== null : false),
  );
  const salud = decidirSalud(textos, { pedidoEnCurso: ctx.pedidoEnCurso, residualConContenido, ...(ctx.clienteEnIngles !== undefined ? { clienteEnIngles: ctx.clienteEnIngles } : {}) });
  // Decision del dueño (7-nov): toda ALERGIA declarada escala como URGENTE (marca al inicio y notificacion critica); la salud conserva la urgencia del suelto.
  for (const a of salud.avisos) {
    const urgente = a.urgente || a.intent === "alergia";
    const mensaje = urgente && !a.mensaje.startsWith(MARCA_AVISO_URGENTE) ? `${MARCA_AVISO_URGENTE}\n${a.mensaje}` : a.mensaje;
    avisos.push({ motivo: "alergia_salud", resumen: mensaje.slice(0, TOPE_RESUMEN), urgente });
  }

  // Transferencia YA realizada (R75-5 / R76-7 / R77-3): hay dinero movido que una persona revisa; la peticion en futuro la contesta el modelo.
  const transferencia = textos.filter((t) => esTransferenciaRealizada(t));
  if (transferencia.length > 0) avisos.push({ motivo: "transferencia", resumen: `El cliente dice que ya pago por transferencia: «${transferencia.join(" / ")}»`.slice(0, TOPE_RESUMEN), urgente: false });

  const sustituye = ctx.mensajes ? SUSTITUYE_CON_CANCELACION : SUSTITUYE_SIEMPRE;
  if (salud.tipo !== null && !salud.seguirAlModelo) {
    const respuesta = transferencia.length > 0 && salud.respuesta ? `${salud.respuesta} ${TRANSFERENCIA_REALIZADA_REPLY}` : salud.respuesta;
    // Como el suelto: la alergia sola NO cede la conversacion (el agente sigue y crear_pedido espera la confirmacion de la sucursal, guardaAlergiaV2);
    // la salud (malestar, reaccion, emergencia) si abre la toma.
    const soloAlergia = salud.tipo === "alergia" || salud.tipo === "alergia_en_curso";
    return { avisos, respuestaFija: respuesta, prefijoRespuesta: null, bloquePrompt: null, sustituye, motivoToma: soloAlergia ? null : "alergia_salud", cancelacion: null };
  }
  if (transferencia.length > 0 && salud.tipo === null) {
    return { avisos, respuestaFija: TRANSFERENCIA_REALIZADA_REPLY, prefijoRespuesta: null, bloquePrompt: null, sustituye, motivoToma: "transferencia", cancelacion: null };
  }

  // Cancelacion / retractacion / posible baja (R26-R93): solo con el hilo (sin el no se sabe si ya se pregunto).
  const cancelacion = ctx.mensajes
    ? decidirCancelacion(textos, {
        mensajes: ctx.mensajes,
        pedidoVivo: ctx.pedidoEnCurso,
        ahoraMs: ctx.ahoraMs ?? 0,
        carritoEnCurso: ctx.carritoEnCurso === true,
        declaraAlergia,
        ...(ctx.otroRiesgo ? { otroRiesgo: ctx.otroRiesgo } : {}),
        ...(ctx.clienteEnIngles !== undefined ? { ingles: ctx.clienteEnIngles } : {}),
      })
    : null;
  const cancelacionActiva = cancelacion !== null && cancelacion.accion !== "nada";
  if (cancelacionActiva) for (const op of cancelacion.avisos) {
    const a = avisoDeCancelacion(op);
    if (a) avisos.push(a);
  }
  const bloques = [salud.tipo !== null ? (salud.bloquePrompt ?? null) : null, cancelacionActiva ? cancelacion.nota : null].filter((b): b is string => typeof b === "string" && b !== "");
  if (cancelacionActiva && !cancelacion.alModelo && cancelacion.respuesta) {
    const fija = salud.tipo !== null && salud.respuesta ? `${salud.respuesta}\n\n${cancelacion.respuesta}` : cancelacion.respuesta;
    // Solo la cancelacion confirmada cede la conversacion a una persona; la posible baja pregunta y el agente sigue.
    return { avisos, respuestaFija: fija, prefijoRespuesta: null, bloquePrompt: null, sustituye, motivoToma: cancelacion.accion === "avisar_cancelacion" ? "cancelacion_modificacion" : null, cancelacion };
  }
  return {
    avisos,
    respuestaFija: null,
    prefijoRespuesta: salud.tipo !== null ? salud.respuesta : null,
    bloquePrompt: bloques.length > 0 ? bloques.join("\n\n") : null,
    sustituye,
    motivoToma: null,
    cancelacion: cancelacionActiva ? cancelacion : null,
  };
}
