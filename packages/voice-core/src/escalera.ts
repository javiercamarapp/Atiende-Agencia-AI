// Escalera de proveedores de UNA llamada: abre el primer escalon que responde (Gemini Live -> cascada OpenRouter) y, si el escalon que atiende
// se cae a media llamada, la reconexion del controlador cae al SIGUIENTE (no reintenta al que acaba de fallar). Cuando no queda ninguno, `abrirSesion`
// lanza el ultimo error y la maquina de la llamada hace lo suyo: pregrabado `proveedor_caido` + persona/buzon con callback.
//
// Es POR LLAMADA (lleva estado: quien ya fallo, el tramo de cada escalon y lo que se dijo): se crea una por llamada con `crearEscaleraLlamada`.
// Al cambiar de escalon a media llamada la nueva sesion recibe, junto con la instruccion de la vertical, un resumen REDACTADO de lo ya dicho (la
// cascada no tiene el handle de reanudacion de Gemini) para no volver a saludar ni repreguntar.
import type { EscalonVoz } from "./config-plataforma.ts";
import type { TramoLlamada } from "./costo.ts";
import { redactarTranscripcion } from "./transcripcion.ts";
import type { AbrirSesionLlamada, AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "./llamada/sesion.ts";

export interface EscalonLlamada {
  readonly id: EscalonVoz;
  readonly abrirSesion: AbrirSesionLlamada;
}

export interface EscaleraLlamada {
  /** Se le pasa al `ControladorLlamada` como `abrirSesion`. */
  readonly abrirSesion: AbrirSesionLlamada;
  /** Escalon que atiende ahora (o el ultimo que atendio); null si ninguno abrio todavia. */
  escalonActual(): EscalonVoz | null;
  /** Escalones que ya intentaron y fallaron en esta llamada, en orden. */
  fallidos(): readonly EscalonVoz[];
  /** Tramos de la llamada para el costo (cierra el que siga abierto). */
  tramos(): readonly TramoLlamada[];
}

export interface OpcionesEscalera {
  readonly ahora?: () => number;
  /** Cuantas lineas recientes se resumen al cambiar de escalon. */
  readonly lineasContexto?: number;
}

interface TramoAbierto {
  readonly escalon: EscalonVoz;
  readonly inicioMs: number;
  finMs: number | null;
  reportado: number;
}

export function crearEscaleraLlamada(escalones: readonly EscalonLlamada[], opts: OpcionesEscalera = {}): EscaleraLlamada {
  const ahora = opts.ahora ?? (() => Date.now());
  const lineasContexto = opts.lineasContexto ?? 12;
  const fallidos: EscalonVoz[] = [];
  const dicho: string[] = [];
  const tramos: TramoAbierto[] = [];
  let actual: EscalonVoz | null = null;

  const cerrarTramo = (t: TramoAbierto): void => {
    if (t.finMs === null) t.finMs = ahora();
  };

  const abrirSesion: AbrirSesionLlamada = async (apertura, manejadores) => {
    let ultimoError: unknown = new Error("Ningun escalon de voz esta configurado.");
    for (const escalon of escalones) {
      if (fallidos.includes(escalon.id)) continue;
      const tramo: TramoAbierto = { escalon: escalon.id, inicioMs: ahora(), finMs: null, reportado: 0 };
      const envueltos: ManejadoresSesion = {
        ...manejadores,
        agenteDijo: (texto) => {
          dicho.push(`Agente: ${texto}`);
          manejadores.agenteDijo(texto);
        },
        usuarioDijo: (texto) => {
          dicho.push(`Cliente: ${texto}`);
          manejadores.usuarioDijo?.(texto);
        },
        costo: (microUsd) => {
          tramo.reportado += microUsd;
          manejadores.costo?.(microUsd);
        },
        caido: (razon, handle) => {
          // El escalon que atendia se cayo: se cierra su tramo y NO se reintenta en esta llamada.
          cerrarTramo(tramo);
          if (!fallidos.includes(escalon.id)) fallidos.push(escalon.id);
          manejadores.caido(razon, handle);
        },
      };
      const instruccion = fallidos.length > 0 ? `${apertura.instruccion}${resumenContexto(dicho, lineasContexto)}` : apertura.instruccion;
      // Una reanudacion con handle solo vale para el escalon que lo emitio (Gemini): los demas abren de cero con el resumen.
      const aperturaEscalon: AperturaLlamada = { ...apertura, instruccion, reanudarHandle: escalon.id === "gemini-3.8-live" ? apertura.reanudarHandle ?? null : null };
      try {
        const sesion = await escalon.abrirSesion(aperturaEscalon, envueltos);
        tramos.push(tramo);
        actual = escalon.id;
        return envolverSesion(sesion, tramo, cerrarTramo);
      } catch (err) {
        fallidos.push(escalon.id);
        ultimoError = err;
      }
    }
    throw ultimoError;
  };

  return {
    abrirSesion,
    escalonActual: () => actual,
    fallidos: () => [...fallidos],
    tramos: () =>
      tramos.map((t) => {
        cerrarTramo(t);
        return { escalon: t.escalon, duracionS: Math.max(0, ((t.finMs ?? t.inicioMs) - t.inicioMs) / 1000), costoReportadoMicroUsd: t.reportado };
      }),
  };
}

function envolverSesion(sesion: VozSesionLlamada, tramo: TramoAbierto, cerrarTramo: (t: TramoAbierto) => void): VozSesionLlamada {
  return {
    enviarTexto: (t) => sesion.enviarTexto(t),
    ...(sesion.enviarAudio ? { enviarAudio: (pcm: Uint8Array) => sesion.enviarAudio?.(pcm) } : {}),
    interrumpir: () => sesion.interrumpir(),
    cerrar: async () => {
      cerrarTramo(tramo);
      await sesion.cerrar();
    },
  };
}

function resumenContexto(dicho: readonly string[], n: number): string {
  if (dicho.length === 0) return "\n\nLa llamada se reconecto por una falla tecnica: continua con naturalidad, sin volver a saludar.";
  const recientes = dicho.slice(-n).map((l) => redactarTranscripcion(l));
  return `\n\nLa llamada se reconecto por una falla tecnica. Lo dicho hasta ahora (continua sin volver a saludar ni repetir lo ya resuelto):\n${recientes.join("\n")}`;
}
