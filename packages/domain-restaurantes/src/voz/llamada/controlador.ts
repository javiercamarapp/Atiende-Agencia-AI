// Controlador de la llamada de restaurantes: el nucleo (maquina + sesion + ejecutor + cola de eventos) es de @atiende/voice-core; aqui se
// fijan las reglas de cierre de restaurantes y la escalada con `escalar_a_humano` (que pide `customer_name`), y se conserva el vocabulario
// historico (`orderId`) del ejecutor que recibe.
import { ControladorLlamada as ControladorCore } from "@atiende/voice-core";
import type { DepsControlador as DepsCore, EventoKpiLlamada, ResultadoLlamada as ResultadoCore, TurnoTranscrito } from "@atiende/voice-core";
import { comoEjecutorCore } from "./ejecutor-tools.ts";
import type { EjecutorTools } from "./ejecutor-tools.ts";
import { REGLAS_CIERRE_PM } from "./maquina.ts";
import type { VozResultado } from "../types.ts";

export type { EventoKpiLlamada, TurnoTranscrito };

export type DepsControlador = Omit<DepsCore<"pedido_creado">, "reglas" | "construirEscalacion" | "ejecutor"> & {
  readonly ejecutor: EjecutorTools;
};

export type ResultadoLlamada = ResultadoCore<"pedido_creado"> & { readonly resultado: VozResultado };

export class ControladorLlamada extends ControladorCore<"pedido_creado"> {
  constructor(deps: DepsControlador) {
    super({
      ...deps,
      ejecutor: comoEjecutorCore(deps.ejecutor),
      reglas: REGLAS_CIERRE_PM,
      construirEscalacion: (motivo, resumen) => ({ nombre: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen } }),
    });
  }
}
