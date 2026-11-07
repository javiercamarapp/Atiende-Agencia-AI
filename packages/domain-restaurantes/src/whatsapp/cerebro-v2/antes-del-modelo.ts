// Cerebro v2 (bandera por organizacion, migracion 190): decision DETERMINISTA antes del modelo con las reglas medidas del repo suelto.
// Junta los bloques puros (salud/alergia, pago, cancelacion) en UNA decision que el turno de WhatsApp ejecuta: avisos a la sucursal (escalar_a_humano), respuesta fija
// sin modelo o texto que va delante de la respuesta del modelo con su bloque de sistema, y los intents del clasificador de alto riesgo de guards.ts que v2 sustituye
// (para no avisar ni contestar dos veces). Pura: no lee la base ni el reloj.
import type { HighRiskIntent } from "../guards.ts";
import type { MotivoEscalacion } from "../../agent-tools/registry.ts";
import { decidirSalud } from "./salud.ts";
import { TRANSFERENCIA_REALIZADA_REPLY, esTransferenciaRealizada } from "./pago.ts";

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
}

export interface ContextoAntesDelModelo {
  /** Hay un pedido ya creado y abierto del numero (la alergia se anota en el; la respuesta habla de ese pedido). */
  readonly pedidoEnCurso: boolean;
  /** El cliente escribe en ingles en el hilo (si se omite se infiere de los textos del turno). */
  readonly clienteEnIngles?: boolean;
}

const TOPE_RESUMEN = 500;

/** v2 SIEMPRE decide salud/alergia y transferencia (aunque hoy no haya riesgo): asi las negaciones y figuras que el suelto ya descarta no escalan por guards.ts. */
const SUSTITUYE_SIEMPRE: ReadonlySet<HighRiskIntent> = new Set<HighRiskIntent>(["alergia_salud", "transferencia"]);

export function decidirAntesDelModelo(pendientes: readonly string[], ctx: ContextoAntesDelModelo): DecisionAntesDelModelo {
  const textos = pendientes.map((t) => String(t ?? "")).filter((t) => t.trim() !== "");
  const avisos: AvisoAntesDelModelo[] = [];
  const salud = decidirSalud(textos, { pedidoEnCurso: ctx.pedidoEnCurso, ...(ctx.clienteEnIngles !== undefined ? { clienteEnIngles: ctx.clienteEnIngles } : {}) });
  for (const a of salud.avisos) avisos.push({ motivo: "alergia_salud", resumen: a.mensaje.slice(0, TOPE_RESUMEN), urgente: a.urgente });

  // Transferencia YA realizada (R75-5 / R76-7 / R77-3): hay dinero movido que una persona revisa; la peticion en futuro la contesta el modelo.
  const transferencia = textos.filter((t) => esTransferenciaRealizada(t));
  if (transferencia.length > 0) avisos.push({ motivo: "transferencia", resumen: `El cliente dice que ya pago por transferencia: «${transferencia.join(" / ")}»`.slice(0, TOPE_RESUMEN), urgente: false });

  if (salud.tipo !== null && !salud.seguirAlModelo) {
    const respuesta = transferencia.length > 0 && salud.respuesta ? `${salud.respuesta} ${TRANSFERENCIA_REALIZADA_REPLY}` : salud.respuesta;
    return { avisos, respuestaFija: respuesta, prefijoRespuesta: null, bloquePrompt: null, sustituye: SUSTITUYE_SIEMPRE, motivoToma: "alergia_salud" };
  }
  if (transferencia.length > 0 && salud.tipo === null) {
    return { avisos, respuestaFija: TRANSFERENCIA_REALIZADA_REPLY, prefijoRespuesta: null, bloquePrompt: null, sustituye: SUSTITUYE_SIEMPRE, motivoToma: "transferencia" };
  }
  return {
    avisos,
    respuestaFija: null,
    prefijoRespuesta: salud.tipo !== null ? salud.respuesta : null,
    bloquePrompt: salud.tipo !== null ? (salud.bloquePrompt ?? null) : null,
    sustituye: SUSTITUYE_SIEMPRE,
    motivoToma: null,
  };
}
