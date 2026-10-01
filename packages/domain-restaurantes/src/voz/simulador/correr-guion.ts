// Corre un GUION de llamada contra el nucleo real: CallStateMachine + ControladorLlamada + ejecutor de herramientas del
// registro unico sobre el mundo sembrado. El proveedor es intercambiable: el FALSO guionado (CI, sin red ni credenciales)
// o uno real (Gemini, manual, con GEMINI_API_KEY).
import { crearEjecutorTools, transporteEnProceso } from "../llamada/ejecutor-tools.ts";
import { ControladorLlamada } from "../llamada/controlador.ts";
import { LIMITES_POR_DEFECTO } from "../llamada/maquina.ts";
import type { MensajeId } from "../llamada/mensajes.ts";
import { extraerTelefonoSipFrom } from "../llamada/sip.ts";
import type { AbrirSesionLlamada } from "../llamada/sesion.ts";
import { FakeVoiceProvider } from "../fake-voice-provider.ts";
import { CerebroGuionado } from "./cerebro-guionado.ts";
import { crearMundoVoz, SIP_FROM_LLAMANTE } from "./mundo-voz.ts";
import type { GuionLlamada, LlamadaSimulada, PasoAgente } from "./tipos.ts";

/** Proveedor que el simulador sabe conducir. */
export interface ProveedorSimulable {
  readonly abrirSesion: AbrirSesionLlamada;
  /** Espera a que el proveedor termine de responder lo enviado. */
  inactivo(): Promise<void>;
  /** Solo el falso: provoca la caida del proveedor. */
  caer?(): void;
}

export interface OpcionesCorrida {
  /** Fabrica del proveedor; por omision el falso con el agente guionado del propio guion. */
  readonly proveedor?: (guion: GuionLlamada) => ProveedorSimulable;
  readonly instruccion?: string;
  readonly voiceId?: string;
}

export function proveedorFalsoGuionado(guion: GuionLlamada): ProveedorSimulable {
  const respuestas: (readonly PasoAgente[])[] = guion.turnos.flatMap((t) => (t.kind === "voz" ? [t.agente] : []));
  const falso = new FakeVoiceProvider({ cerebro: new CerebroGuionado(respuestas), fallasAlAbrir: 0 });
  const original = falso.abrirLlamada!;
  let fallasPendientes = guion.fallasAlReabrir ?? 0;
  let aperturas = 0;
  return {
    abrirSesion: async (apertura, h) => {
      aperturas += 1;
      // La primera apertura nunca falla: `fallasAlReabrir` cuenta solo las reconexiones.
      if (aperturas > 1 && fallasPendientes > 0) {
        fallasPendientes -= 1;
        throw new Error("el proveedor falso no reabre");
      }
      return original(apertura, h);
    },
    inactivo: () => falso.inactivo(),
    caer: () => falso.caer(),
  };
}

const dormirDe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function correrGuion(guion: GuionLlamada, opciones: OpcionesCorrida = {}): Promise<LlamadaSimulada> {
  const mundo = crearMundoVoz();
  const proveedor = (opciones.proveedor ?? proveedorFalsoGuionado)(guion);
  const limites = { ...LIMITES_POR_DEFECTO, ...(guion.limites ?? {}) };
  const sipFrom = guion.sipFrom === undefined ? SIP_FROM_LLAMANTE : guion.sipFrom;
  const callId = `sim-${guion.id}`;

  const transporteBase = transporteEnProceso(mundo.repo, {
    organizationId: mundo.organizationId,
    channel: "voz",
    phone: extraerTelefonoSipFrom(sipFrom),
    lockedPropertyId: mundo.propertyId,
    flow: { key: `call:${callId}`, turn: null },
  });
  const transporte: typeof transporteBase = guion.toolLenta
    ? async (nombre, args, senal) => {
        if (nombre === guion.toolLenta!.nombre) await dormirDe(guion.toolLenta!.ms);
        return transporteBase(nombre, args, senal);
      }
    : transporteBase;

  const tools: { nombre: string; args: unknown; resultado: unknown }[] = [];
  const pregrabados: MensajeId[] = [];
  const logs: LlamadaSimulada["logs"][number][] = [];
  const kpi: unknown[] = [];
  let audioCortado = 0;

  const ctrl = new ControladorLlamada({
    callId,
    propertyId: mundo.propertyId,
    organizationId: mundo.organizationId,
    abrirSesion: proveedor.abrirSesion,
    ejecutor: crearEjecutorTools({ transporte, timeoutMs: limites.toolTimeoutMs }),
    instruccion: opciones.instruccion ?? "",
    voiceId: opciones.voiceId ?? "Kore",
    limites,
    reproducir: (m) => void pregrabados.push(m),
    cortarAudio: () => void (audioCortado += 1),
    log: (l) => void logs.push(l),
    kpi: (e) => void kpi.push(e),
    dormir: async () => undefined,
    trazarTool: (t) => void tools.push(t),
  });

  const { iniciada } = await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null, ...(guion.inicio ?? {}) });
  const sincronizar = async () => {
    await proveedor.inactivo();
    await ctrl.vacio();
    await proveedor.inactivo();
    await ctrl.vacio();
  };
  if (iniciada) {
    for (const t of guion.turnos) {
      switch (t.kind) {
        case "voz":
          if (t.interrumpe) await ctrl.usuarioHabla();
          await ctrl.usuarioDijo(t.cliente);
          await sincronizar();
          break;
        case "confuso":
          await ctrl.usuarioDijo(t.cliente, false);
          break;
        case "no_entendido":
          await ctrl.noEntendido();
          break;
        case "silencio":
          await ctrl.silencio(t.ms);
          break;
        case "ruido":
          await ctrl.ruido();
          break;
        case "dtmf":
          await ctrl.dtmf(t.digito);
          break;
        case "tick":
          await ctrl.tick(t.segundos);
          break;
        case "costo":
          await ctrl.costo(t.microUsd);
          break;
        case "proveedor_cae":
          proveedor.caer?.();
          await sincronizar();
          break;
        case "cuelga":
          await ctrl.clienteCuelga();
          break;
      }
      if (ctrl.maquina.estadoActual === "cerrada") break;
    }
  }
  await sincronizar();
  // El guion termino con la llamada abierta: el cliente cuelga.
  if (iniciada && ctrl.maquina.estadoActual !== "cerrada") await ctrl.clienteCuelga();
  const resultado = iniciada ? (ctrl.maquina.resultado ?? "abandonado") : "no_iniciada";
  return { guion, mundo, iniciada, resultado, pregrabados, audioCortado, transcripcion: ctrl.transcripcion, tools, logs, kpi };
}
