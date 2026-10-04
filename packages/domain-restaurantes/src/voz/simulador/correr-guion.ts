// Corre un GUION de llamada de restaurantes contra el nucleo real (@atiende/voice-core): CallStateMachine + ControladorLlamada + ejecutor de
// herramientas del registro unico sobre el mundo sembrado de Los Taquitos de PM. El proveedor es intercambiable: el FALSO guionado (CI, sin
// red ni credenciales) o uno real (Gemini, manual, con GEMINI_API_KEY).
import { correrGuionConAdaptador, proveedorFalsoGuionado as proveedorFalsoCore } from "@atiende/voice-core/simulador";
import type { AdaptadorSimulador, ProveedorSimulable } from "@atiende/voice-core/simulador";
import { canonicalizeMexicanPhone } from "../../phone.ts";
import { REGISTRO_TOOLS_PM, transporteEnProceso } from "../llamada/ejecutor-tools.ts";
import { LIMITES_VOZ_PM, REGLAS_CIERRE_PM } from "../llamada/maquina.ts";
import { crearMundoVoz, SIP_FROM_LLAMANTE } from "./mundo-voz.ts";
import type { MundoVoz } from "./mundo-voz.ts";
import { crearMemoriaPm } from "./memoria-pm.ts";
import type { GuionLlamada, LlamadaSimulada, MemoriaTools } from "./tipos.ts";

export type { ProveedorSimulable };

export interface OpcionesCorrida {
  /** Fabrica del proveedor; por omision el falso con el agente guionado del propio guion. */
  readonly proveedor?: (guion: GuionLlamada) => ProveedorSimulable;
  readonly instruccion?: string;
  readonly voiceId?: string;
}

export const ADAPTADOR_SIMULADOR_PM: AdaptadorSimulador<"pedido_creado", MemoriaTools, MundoVoz> = {
  reglas: REGLAS_CIERRE_PM,
  registro: REGISTRO_TOOLS_PM,
  construirEscalacion: (motivo, resumen) => ({ nombre: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen } }),
  canonicalizarTelefono: canonicalizeMexicanPhone,
  sipFromPorDefecto: SIP_FROM_LLAMANTE,
  crearMundo: crearMundoVoz,
  crearMemoria: crearMemoriaPm,
  transporte: (mundo, { callId, telefono }) => {
    const base = transporteEnProceso(mundo.repo, {
      organizationId: mundo.organizationId,
      channel: "voz",
      phone: telefono,
      lockedPropertyId: mundo.propertyId,
      flow: { key: `call:${callId}`, turn: null },
    });
    return async (nombre, args, senal) => {
      const salida = await base(nombre as never, args, senal);
      return { resultado: salida.resultado, entidadId: salida.orderId };
    };
  },
};

export function proveedorFalsoGuionado(guion: GuionLlamada): ProveedorSimulable {
  return proveedorFalsoCore(guion, crearMemoriaPm());
}

export function correrGuion(guion: GuionLlamada, opciones: OpcionesCorrida = {}): Promise<LlamadaSimulada> {
  // Los limites de la llamada de PM (UN solo "¿sigue ahi?") salvo lo que el guion fije por su cuenta.
  return correrGuionConAdaptador(ADAPTADOR_SIMULADOR_PM, { ...guion, limites: { silenciosMax: LIMITES_VOZ_PM.silenciosMax, ...guion.limites } }, opciones);
}
