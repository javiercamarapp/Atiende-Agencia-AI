// Corre un GUION de llamada de hoteles contra el nucleo real (@atiende/voice-core): CallStateMachine + ControladorLlamada + ejecutor de herramientas del
// registro de hoteles (con su maquina de reserva) sobre el mundo sembrado. El proveedor es intercambiable: el FALSO guionado (CI, sin red ni
// credenciales) o uno real (manual). Cada llamada crea su propio registro: la maquina de la reserva lleva estado POR llamada.
import { correrGuionConAdaptador, proveedorFalsoGuionado as proveedorFalsoCore } from "@atiende/voice-core/simulador";
import type { AdaptadorSimulador, ProveedorSimulable } from "@atiende/voice-core/simulador";
import { REGLAS_CIERRE_HOTELES, crearRegistroToolsHoteles } from "../registro-tools.ts";
import type { ResultadoVozHoteles } from "../registro-tools.ts";
import { canonicalizarTelefonoHoteles } from "../telefono.ts";
import { transporteEnProcesoHoteles } from "../transporte.ts";
import { crearMemoriaHoteles } from "./memoria-hoteles.ts";
import { AHORA_SIM, SIP_FROM_LLAMANTE, crearMundoVozHoteles } from "./mundo-voz.ts";
import type { MundoVozHoteles } from "./mundo-voz.ts";
import type { GuionLlamada, LlamadaSimulada, MemoriaHoteles } from "./tipos.ts";

export type { ProveedorSimulable };

export interface OpcionesCorrida {
  /** Fabrica del proveedor; por omision el falso con el agente guionado del propio guion. */
  readonly proveedor?: (guion: GuionLlamada) => ProveedorSimulable;
  readonly instruccion?: string;
  readonly voiceId?: string;
}

export function crearAdaptadorSimuladorHoteles(): AdaptadorSimulador<ResultadoVozHoteles, MemoriaHoteles, MundoVozHoteles> {
  return {
    reglas: REGLAS_CIERRE_HOTELES,
    registro: crearRegistroToolsHoteles(),
    // La maquina de la reserva lleva estado: un registro NUEVO por llamada.
    crearRegistro: crearRegistroToolsHoteles,
    construirEscalacion: (motivo, resumen) => ({ nombre: "derivar_a_humano", args: { motivo: `llamada: ${motivo}`, resumen } }),
    canonicalizarTelefono: canonicalizarTelefonoHoteles,
    sipFromPorDefecto: SIP_FROM_LLAMANTE,
    crearMundo: () => crearMundoVozHoteles(),
    crearMemoria: crearMemoriaHoteles,
    transporte: (mundo, { callId, telefono }) =>
      transporteEnProcesoHoteles({ hotelesRepo: mundo.hoteles, reservas: mundo.reservas, organizationId: mundo.organizationId, propertyId: mundo.propertyId, now: AHORA_SIM }, { telefono, llamadaId: callId }),
  };
}

export function proveedorFalsoGuionado(guion: GuionLlamada): ProveedorSimulable {
  return proveedorFalsoCore(guion, crearMemoriaHoteles());
}

export function correrGuion(guion: GuionLlamada, opciones: OpcionesCorrida = {}): Promise<LlamadaSimulada> {
  return correrGuionConAdaptador(crearAdaptadorSimuladorHoteles(), guion, opciones);
}
