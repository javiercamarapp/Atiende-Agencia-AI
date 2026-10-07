// Arma la escalera de la plataforma a partir de las credenciales: es lo que usa el worker de voz (y el simulador "real") de CUALQUIER vertical.
// Ninguna vertical elige proveedor: todas pasan por aqui, con `VOZ_PLATAFORMA`.
import { VOZ_PLATAFORMA } from "./config-plataforma.ts";
import type { ConfigPlataformaVoz, EscalonVoz } from "./config-plataforma.ts";
import { crearEscaleraLlamada } from "./escalera.ts";
import type { EscalonLlamada, EscaleraLlamada, OpcionesEscalera } from "./escalera.ts";
import { crearProveedorCascadaLlamada } from "./llamada/cascada-openrouter.ts";
import type { PuertoLlmVoz } from "./llamada/cascada-openrouter.ts";
import { VozNoConfiguradaError } from "./provider.ts";
import { crearProveedorGeminiLlamada } from "./llamada/gemini-live-sesion.ts";
import type { CrearSocketLive, GeminiLiveSesionOpciones, VertexLiveOpciones } from "./llamada/gemini-live-sesion.ts";

export interface CredencialesVoz {
  /** `GEMINI_API_KEY`: habilita el escalon 1. */
  readonly geminiApiKey: string | null;
  /** `OPENROUTER_API_KEY` (la misma del texto): habilita el escalon 2 (con el puerto del LLM). */
  readonly openrouterApiKey: string | null;
}

export interface DepsPlataformaVoz extends CredencialesVoz {
  /** Gateway de texto (agent-core) detras de un puerto; sin el, la cascada no puede pensar y queda sin configurar. */
  readonly llm: PuertoLlmVoz | null;
  readonly config?: ConfigPlataformaVoz;
  readonly fetchFn?: typeof fetch;
  readonly crearSocket?: CrearSocketLive;
  /** Adaptador de Vertex AI en lugar de la Gemini API (`GEMINI_BACKEND=vertex`); la `geminiApiKey` deja de usarse para el escalon 1. */
  readonly vertex?: VertexLiveOpciones;
  /** Herramientas de solo lectura que el escalon de Gemini puede correr en paralelo (ver `GeminiLiveSesionOpciones.herramientasEnParalelo`). */
  readonly herramientasEnParalelo?: ReadonlySet<string>;
  /** Ajuste fino del VAD sin tocar codigo (`VOICE_VAD_*` en el worker). */
  readonly vad?: GeminiLiveSesionOpciones["vad"];
}

export interface EstadoEscalonVoz {
  readonly escalon: EscalonVoz;
  readonly configurado: boolean;
  /** Que falta, en claro (nunca la llave). */
  readonly detalle: string;
}

export interface EstadoEscaleraVoz {
  /** true si al menos un escalon puede atender una llamada. */
  readonly operativa: boolean;
  readonly escalones: readonly EstadoEscalonVoz[];
}

const lleno = (v: string | null): boolean => v !== null && v.trim() !== "";

/** Estado HONESTO de la escalera para el panel: que escalones tienen credencial. No abre sesiones ni gasta. */
export function estadoEscalera(deps: Pick<DepsPlataformaVoz, "geminiApiKey" | "openrouterApiKey" | "llm"> & { readonly vertex?: VertexLiveOpciones }): EstadoEscaleraVoz {
  const gemini = deps.vertex ? true : lleno(deps.geminiApiKey);
  const cascada = lleno(deps.openrouterApiKey) && deps.llm !== null;
  const escalones: EstadoEscalonVoz[] = [
    { escalon: "gemini-3.8-live", configurado: gemini, detalle: gemini ? (deps.vertex ? "Vertex AI configurado (no se probó la red)." : "Credencial presente (no se probó la red).") : "Falta GEMINI_API_KEY." },
    {
      escalon: "cascada-openrouter",
      configurado: cascada,
      detalle: cascada ? "Credencial presente (no se probó la red)." : lleno(deps.openrouterApiKey) ? "Falta el gateway de texto del servidor." : "Falta OPENROUTER_API_KEY.",
    },
  ];
  return { operativa: gemini || cascada, escalones };
}

/** Los escalones en el orden de la escalera de plataforma; los que no tienen credencial lanzan `VozNoConfiguradaError` y se saltan. */
export function crearEscalonesPlataforma(deps: DepsPlataformaVoz): EscalonLlamada[] {
  const config = deps.config ?? VOZ_PLATAFORMA;
  const gemini = crearProveedorGeminiLlamada({ apiKey: deps.geminiApiKey, model: config.gemini.modelo, ...(deps.vertex ? { vertex: deps.vertex } : {}), ...(deps.herramientasEnParalelo ? { herramientasEnParalelo: deps.herramientasEnParalelo } : {}), ...(deps.vad ? { vad: deps.vad } : {}), ...(deps.crearSocket ? { crearSocket: deps.crearSocket } : {}) });
  const cascada = crearProveedorCascadaLlamada({
    apiKey: deps.openrouterApiKey,
    llm: deps.llm ?? { completar: () => Promise.reject(new Error("sin gateway de texto")) },
    config,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
  const sinGateway: EscalonLlamada["abrirSesion"] = () => Promise.reject(new VozNoConfiguradaError("Voz no configurada: la cascada necesita el gateway de texto."));
  const porId: Record<EscalonVoz, EscalonLlamada> = {
    "gemini-3.8-live": { id: "gemini-3.8-live", abrirSesion: gemini.abrirSesion },
    "cascada-openrouter": { id: "cascada-openrouter", abrirSesion: deps.llm ? cascada.abrirSesion : sinGateway },
  };
  return config.escalera.map((id) => porId[id]);
}

/** Escalera lista para UNA llamada. */
export function crearEscaleraPlataforma(deps: DepsPlataformaVoz, opts?: OpcionesEscalera): EscaleraLlamada {
  return crearEscaleraLlamada(crearEscalonesPlataforma(deps), opts);
}
