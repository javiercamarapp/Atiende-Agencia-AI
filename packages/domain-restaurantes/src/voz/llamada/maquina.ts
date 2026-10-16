// Maquina de estados de la llamada de voz de restaurantes: el nucleo es de @atiende/voice-core (ADR-PM-001 §4); aqui solo se
// fija el objetivo de restaurantes (`crear_pedido` -> `pedido_creado`, `escalar_a_humano`) y se conserva el vocabulario
// historico (`orderId`, `hayPedido`) para el worker, el simulador y las pruebas.
import { CallStateMachine as CallStateMachineCore, LIMITES_POR_DEFECTO } from "@atiende/voice-core";
import type { AccionLlamada as AccionCore, EstadoLlamada, EventoLlamada as EventoCore, LimitesLlamada, OpcionesMaquinaLlamada } from "@atiende/voice-core";
import type { MotivoEscalacion } from "../../agent-tools/registry.ts";

export { LIMITES_POR_DEFECTO };

/** Limites de la llamada de PM: los de la plataforma salvo `silenciosMax: 1` (el agente vivo hace UN solo "¿sigue ahi?" y se despide;
 * el valor por omision de voice-core, 2, queda igual para las otras verticales). */
export const LIMITES_VOZ_PM: LimitesLlamada = Object.freeze({
  ...LIMITES_POR_DEFECTO,
  silenciosMax: 1,
  // QA-PM-R2-voz-05: con UNA sola reconexion a los 400 ms, una caida de Gemini (ws_1011, intermitente: 5 de 38 llamadas) fallaba 5/5 y se perdian las ventas.
  // Tres intentos con espera creciente: el 1011 suele durar unos segundos.
  reconexionesMax: 3,
  reconexionEsperaMs: [400, 1500, 3500],
});
export type { EstadoLlamada, LimitesLlamada, OpcionesMaquinaLlamada };

/** Reglas de cierre de restaurantes: un pedido creado logra la llamada; el agente pasa a una persona con `escalar_a_humano`. */
export const REGLAS_CIERRE_PM = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "escalar_a_humano" } as const;

type ResultadoToolEvento = Extract<EventoCore, { tipo: "tool_resultado" }>;
/** Igual que el evento del core, pero el resultado de una tool trae `orderId` (el id del pedido creado). */
export type EventoLlamada = Exclude<EventoCore, { tipo: "tool_resultado" }> | (Omit<ResultadoToolEvento, "entidadId"> & { readonly orderId?: string | null });

export type AccionLlamada = AccionCore<"pedido_creado">;
export type { MotivoEscalacion };

export class CallStateMachine extends CallStateMachineCore<"pedido_creado"> {
  constructor(limites: LimitesLlamada = LIMITES_POR_DEFECTO, opciones: OpcionesMaquinaLlamada = {}) {
    super(REGLAS_CIERRE_PM, limites, opciones);
  }
  get hayPedido(): boolean {
    return this.hayObjetivo;
  }
  override recibir(ev: EventoLlamada | EventoCore): readonly AccionCore<"pedido_creado">[] {
    if (ev.tipo === "tool_resultado" && "orderId" in ev) {
      const { orderId, ...resto } = ev;
      return super.recibir({ ...resto, entidadId: orderId ?? null });
    }
    return super.recibir(ev as EventoCore);
  }
}
