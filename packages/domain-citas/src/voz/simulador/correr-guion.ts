// Corre un GUION de llamada de citas contra el nucleo real (@atiende/voice-core): CallStateMachine + ControladorLlamada + ejecutor de herramientas del
// registro de citas (con su maquina de la cita y la guardia de crisis) sobre el mundo sembrado. El proveedor es intercambiable: el FALSO guionado (CI,
// sin red ni credenciales) o uno real (manual). Cada llamada crea su propio registro: la maquina de la cita lleva estado POR llamada.
import { correrGuionConAdaptador, proveedorFalsoGuionado as proveedorFalsoCore } from "@atiende/voice-core/simulador";
import type { AdaptadorSimulador, ProveedorSimulable } from "@atiende/voice-core/simulador";
import { requiresCrisisGuardrail } from "../../vertical-config.ts";
import { evaluarCrisisVoz } from "../guardia-crisis.ts";
import { REGLAS_CIERRE_CITAS, crearRegistroToolsCitas } from "../registro-tools.ts";
import type { ResultadoVozCitas } from "../registro-tools.ts";
import { canonicalizarTelefonoCitas } from "../telefono.ts";
import { transporteEnProcesoCitas } from "../transporte.ts";
import { crearMemoriaCitas } from "./memoria-citas.ts";
import { SIP_FROM_LLAMANTE, crearMundoVozCitas } from "./mundo-voz.ts";
import type { MundoVozCitas } from "./mundo-voz.ts";
import type { GuionLlamada, LlamadaSimulada, MemoriaCitas } from "./tipos.ts";

export type { ProveedorSimulable };

export interface OpcionesCorrida {
  /** Fabrica del proveedor; por omision el falso con el agente guionado del propio guion. */
  readonly proveedor?: (guion: GuionLlamada) => ProveedorSimulable;
  readonly instruccion?: string;
  readonly voiceId?: string;
}

export function crearAdaptadorSimuladorCitas(): AdaptadorSimulador<ResultadoVozCitas, MemoriaCitas, MundoVozCitas> {
  return {
    reglas: REGLAS_CIERRE_CITAS,
    registro: crearRegistroToolsCitas(),
    // La maquina de la cita lleva estado: un registro NUEVO por llamada.
    crearRegistro: crearRegistroToolsCitas,
    construirEscalacion: (motivo, resumen) => ({ nombre: "derivar_a_humano", args: { motivo: motivo === "crisis" ? motivo : `llamada: ${motivo}`, resumen } }),
    canonicalizarTelefono: canonicalizarTelefonoCitas,
    sipFromPorDefecto: SIP_FROM_LLAMANTE,
    crearMundo: () => crearMundoVozCitas(),
    crearMemoria: crearMemoriaCitas,
    // Misma regla que produccion: la guardia solo existe si el rubro del negocio es de salud (aqui, psicologo).
    guardiaCliente: (mundo) => ({ evaluar: (texto) => (requiresCrisisGuardrail(mundo.rubro) ? evaluarCrisisVoz(texto) : null) }),
    transporte: (mundo, { callId, telefono }) => {
      const transporte = transporteEnProcesoCitas({ repo: mundo.repo, organizationId: mundo.organizationId }, { telefono, llamadaId: callId });
      return async (nombre, args, senal) => {
        await mundo.listo;
        return transporte(nombre, args, senal);
      };
    },
  };
}

export function proveedorFalsoGuionado(guion: GuionLlamada): ProveedorSimulable {
  return proveedorFalsoCore(guion, crearMemoriaCitas());
}

export function correrGuion(guion: GuionLlamada, opciones: OpcionesCorrida = {}): Promise<LlamadaSimulada> {
  return correrGuionConAdaptador(crearAdaptadorSimuladorCitas(), guion, opciones);
}
