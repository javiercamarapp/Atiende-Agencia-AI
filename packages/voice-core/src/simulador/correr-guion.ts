// Corre un GUION de llamada contra el nucleo real: CallStateMachine + ControladorLlamada + ejecutor de herramientas del
// registro de la vertical sobre su mundo sembrado. El proveedor es intercambiable: el FALSO guionado (CI, sin red ni credenciales)
// o uno real (Gemini, manual, con GEMINI_API_KEY). Todo lo que depende de la vertical entra por el `AdaptadorSimulador`.
import { crearEjecutorTools } from "../llamada/ejecutor-tools.ts";
import type { RegistroToolsVoz, TransporteTools } from "../llamada/ejecutor-tools.ts";
import { ControladorLlamada } from "../llamada/controlador.ts";
import type { GuardiaCliente } from "../llamada/controlador.ts";
import { LIMITES_POR_DEFECTO } from "../llamada/maquina.ts";
import type { ReglasCierreLlamada } from "../llamada/maquina.ts";
import type { MensajeId } from "../llamada/mensajes.ts";
import { extraerTelefonoSipFrom } from "../llamada/sip.ts";
import type { CanonicalizarTelefono } from "../llamada/sip.ts";
import type { AbrirSesionLlamada } from "../llamada/sesion.ts";
import { FakeVoiceProvider } from "../fake-voice-provider.ts";
import { CerebroGuionado } from "./cerebro-guionado.ts";
import type { GuionLlamada, LlamadaSimulada, MemoriaObservable, MundoBase } from "./tipos.ts";

/** Proveedor que el simulador sabe conducir. */
export interface ProveedorSimulable {
  readonly abrirSesion: AbrirSesionLlamada;
  /** Espera a que el proveedor termine de responder lo enviado. */
  inactivo(): Promise<void>;
  /** Solo el falso: provoca la caida del proveedor. */
  caer?(): void;
}

/** Todo lo que el simulador necesita de UNA vertical. */
export interface AdaptadorSimulador<R extends string, M extends MemoriaObservable, W extends MundoBase> {
  readonly reglas: ReglasCierreLlamada<R>;
  readonly registro: RegistroToolsVoz;
  /** Si la vertical tiene maquina de estados por llamada (guardia/alResultado con estado), crea un registro NUEVO por llamada; `registro` queda para quien solo lee las definiciones. */
  readonly crearRegistro?: () => RegistroToolsVoz;
  readonly construirEscalacion: (motivo: string, resumen: string) => { readonly nombre: string; readonly args: Readonly<Record<string, unknown>> };
  readonly canonicalizarTelefono: CanonicalizarTelefono;
  /** Cabecera SIP From del llamante del arnes (el guion puede poner otra o `null` = anonimo). */
  readonly sipFromPorDefecto: string;
  crearMundo(): W;
  crearMemoria(): M;
  /** Guardia determinista de la vertical sobre lo que dice el cliente (citas: crisis). `decir` lo pone el simulador (queda en `textosGuardia`). Recibe el mundo para leer, p. ej., el rubro del negocio. */
  readonly guardiaCliente?: (mundo: W) => Omit<GuardiaCliente, "decir">;
  /** Transporte EN PROCESO sobre el mundo (simulador y pruebas; nunca produccion). */
  transporte(mundo: W, ctx: { readonly callId: string; readonly telefono: string | null }): TransporteTools;
}

export interface OpcionesCorrida<R extends string, E extends object, M extends MemoriaObservable> {
  /** Fabrica del proveedor; por omision el falso con el agente guionado del propio guion. */
  readonly proveedor?: (guion: GuionLlamada<R, E, M>) => ProveedorSimulable;
  readonly instruccion?: string;
  readonly voiceId?: string;
}

export function proveedorFalsoGuionado<R extends string, E extends object, M extends MemoriaObservable>(guion: GuionLlamada<R, E, M>, memoria: M): ProveedorSimulable {
  const respuestas = guion.turnos.flatMap((t) => (t.kind === "voz" ? [t.agente] : []));
  const falso = new FakeVoiceProvider({ cerebro: new CerebroGuionado<M>(respuestas, memoria), fallasAlAbrir: 0 });
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

export async function correrGuionConAdaptador<R extends string, E extends object, M extends MemoriaObservable, W extends MundoBase>(
  adaptador: AdaptadorSimulador<R, M, W>,
  guion: GuionLlamada<R, E, M>,
  opciones: OpcionesCorrida<R, E, M> = {},
): Promise<LlamadaSimulada<R, E, M, W>> {
  const mundo = adaptador.crearMundo();
  const proveedor = (opciones.proveedor ?? ((g: GuionLlamada<R, E, M>) => proveedorFalsoGuionado(g, adaptador.crearMemoria())))(guion);
  const limites = { ...LIMITES_POR_DEFECTO, ...(guion.limites ?? {}) };
  const sipFrom = guion.sipFrom === undefined ? adaptador.sipFromPorDefecto : guion.sipFrom;
  const callId = `sim-${guion.id}`;

  const transporteBase = adaptador.transporte(mundo, { callId, telefono: extraerTelefonoSipFrom(sipFrom, adaptador.canonicalizarTelefono) });
  const transporte: TransporteTools = guion.toolLenta
    ? async (nombre, args, senal, contexto) => {
        if (nombre === guion.toolLenta!.nombre) await dormirDe(guion.toolLenta!.ms);
        return transporteBase(nombre, args, senal, contexto);
      }
    : transporteBase;

  const tools: { nombre: string; args: unknown; resultado: unknown }[] = [];
  const pregrabados: MensajeId[] = [];
  const logs: LlamadaSimulada["logs"][number][] = [];
  const kpi: unknown[] = [];
  let audioCortado = 0;
  const textosGuardia: string[] = [];
  const guardiaBase = adaptador.guardiaCliente?.(mundo);

  const ctrl = new ControladorLlamada<R>({
    callId,
    reglas: adaptador.reglas,
    construirEscalacion: adaptador.construirEscalacion,
    propertyId: mundo.propertyId,
    organizationId: mundo.organizationId,
    abrirSesion: proveedor.abrirSesion,
    ...(guardiaBase ? { guardiaCliente: { evaluar: (t: string) => guardiaBase.evaluar(t), decir: (t: string) => void textosGuardia.push(t) } } : {}),
    ejecutor: crearEjecutorTools({ registro: adaptador.crearRegistro ? adaptador.crearRegistro() : adaptador.registro, transporte, timeoutMs: limites.toolTimeoutMs }),
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
  return { guion, mundo, iniciada, resultado, pregrabados, audioCortado, transcripcion: ctrl.transcripcion, tools, logs, kpi, textosGuardia };
}
