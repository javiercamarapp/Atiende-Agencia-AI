// Instrumentacion del banco de voz: envuelve un proveedor simulable (Gemini Live real o cascada) para registrar, por llamada,
// los instantes de cada evento (texto del cliente enviado, primer texto del agente, fin de turno, herramientas) y el costo real
// que reporta el proveedor. Solo mide; no cambia el comportamiento del proveedor ni del controlador.
import type { ProveedorSimulable } from "../../packages/voice-core/src/simulador/correr-guion.ts";

export type EventoT = { readonly t: number; readonly tipo: "envia" | "dice" | "termina" | "tool_ini" | "tool_fin" | "llm_ini" | "llm_primero" | "llm_fin" | "interrumpido" | "caido" };
export interface LlamadaLlm {
  readonly modelo: string;
  readonly tIni: number;
  readonly tPrimero: number | null;
  readonly tFin: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
  readonly tokensReasoning: number;
  readonly costoUsd: number;
  readonly herramientas: number;
  readonly detalleTools?: string[];
  readonly ttftMs?: number | null;
  readonly totalMs?: number;
}

export interface Medicion {
  readonly eventos: EventoT[];
  readonly llamadasLlm: LlamadaLlm[];
  /** Costo (micro-USD) que el proveedor reporto por h.costo, y cuanto de el fue `real` (tokens informados por el proveedor). */
  costoMicro: number;
  costoRealMicro: number;
  caidas: string[];
}

export function nuevaMedicion(): Medicion {
  return { eventos: [], llamadasLlm: [], costoMicro: 0, costoRealMicro: 0, caidas: [] };
}

export function instrumentar(base: ProveedorSimulable, m: Medicion, ahora: () => number = () => performance.now()): ProveedorSimulable {
  return {
    ...(base.caer ? { caer: () => base.caer!() } : {}),
    inactivo: () => base.inactivo(),
    abrirSesion: async (apertura, h) => {
      const hh = {
        ...h,
        agenteDijo: (t: string) => {
          m.eventos.push({ t: ahora(), tipo: "dice" });
          h.agenteDijo(t);
        },
        agenteTermino: () => {
          m.eventos.push({ t: ahora(), tipo: "termina" });
          h.agenteTermino();
        },
        interrumpido: () => {
          m.eventos.push({ t: ahora(), tipo: "interrumpido" });
          h.interrumpido();
        },
        ejecutarTool: async (l: Parameters<typeof h.ejecutarTool>[0]) => {
          m.eventos.push({ t: ahora(), tipo: "tool_ini" });
          try {
            return await h.ejecutarTool(l);
          } finally {
            m.eventos.push({ t: ahora(), tipo: "tool_fin" });
          }
        },
        costo: (micro: number, real?: boolean) => {
          m.costoMicro += micro;
          if (real) m.costoRealMicro += micro;
          h.costo?.(micro, real);
        },
        caido: (razon: string, handle: string | null) => {
          m.caidas.push(razon.replace(/key=[^&\s]+/g, "key=***").slice(0, 80));
          m.eventos.push({ t: ahora(), tipo: "caido" });
          h.caido(razon, handle);
        },
      };
      const s = await base.abrirSesion(apertura, hh);
      return {
        enviarTexto: (t: string) => {
          m.eventos.push({ t: ahora(), tipo: "envia" });
          s.enviarTexto(t);
        },
        ...(s.enviarAudio ? { enviarAudio: (p: Uint8Array) => s.enviarAudio!(p) } : {}),
        interrumpir: () => s.interrumpir(),
        cerrar: () => s.cerrar(),
      };
    },
  };
}

export interface LatenciaTurno {
  /** ms desde que el cliente termina de hablar hasta el primer texto/token del agente (en Gemini: primera transcripcion de su audio; en la cascada: primer token del ultimo LLM del turno, o la primera herramienta si no hay texto). */
  readonly primeroMs: number | null;
  /** ms hasta que el agente termina su turno (incluye herramientas). */
  readonly completoMs: number | null;
}

/** Latencia por turno del cliente: ventana [envia_i, envia_{i+1}). */
export function latenciasPorTurno(m: Medicion): LatenciaTurno[] {
  const ev = m.eventos;
  const idx = ev.map((e, i) => (e.tipo === "envia" ? i : -1)).filter((i) => i >= 0);
  const out: LatenciaTurno[] = [];
  idx.forEach((ini, k) => {
    const fin = k + 1 < idx.length ? idx[k + 1]! : ev.length;
    const t0 = ev[ini]!.t;
    const ventana = ev.slice(ini + 1, fin);
    const tFin = ventana.find((e) => e.tipo === "termina")?.t;
    const tDice = ventana.find((e) => e.tipo === "dice")?.t;
    // Cascada: el primer token del ultimo LLM del turno (la sesion de texto no emite `dice` hasta tener todo el texto).
    const llms = m.llamadasLlm.filter((l) => l.tIni >= t0 && (k + 1 >= idx.length || l.tIni < ev[fin]!.t));
    const ultimo = llms[llms.length - 1];
    const tTok = ultimo?.tPrimero ?? null;
    const primero = tDice !== undefined && llms.length === 0 ? tDice : tTok !== null ? tTok : tDice ?? null;
    out.push({ primeroMs: primero === null ? null : primero - t0, completoMs: tFin === undefined ? null : tFin - t0 });
  });
  return out;
}

/** Espera a que el proveedor este realmente callado: sin eventos durante `calmaMs`, sin herramientas en curso y sin turno pendiente (max `maxMs`). */
export async function esperarCalma(m: Medicion, ahora: () => number = () => performance.now(), calmaMs = 1800, maxMs = 45_000): Promise<void> {
  const t0 = ahora();
  for (;;) {
    const ev = m.eventos;
    const ultimo = ev.length ? ev[ev.length - 1]!.t : t0;
    const ini = ev.filter((e) => e.tipo === "tool_ini").length;
    const fin = ev.filter((e) => e.tipo === "tool_fin").length;
    if (ini === fin && ahora() - ultimo >= calmaMs) return;
    if (ahora() - t0 > maxMs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
