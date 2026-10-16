// MODO REAL de la prueba ciega de voz de HOTELES (manual; NUNCA corre en CI ni en `npm test`): los mismos guiones, graders y mundo que el simulador,
// pero el agente es Gemini Live de verdad (sesion de texto con transcripcion). Protecciones, las mismas que las de restaurantes:
//   * exige VOZ_EVALS_REAL=1 y GEMINI_API_KEY (sin ellas lanza antes de abrir ninguna conexion);
//   * tope de gasto ESTIMADO (VOZ_EVALS_MAX_USD, por omision 1, techo 5): costo = minutos de pared de cada guion x VOZ_EVALS_USD_POR_MIN (por
//     omision 0.04, la estimacion del ADR); se corta al alcanzarlo y lista los guiones sin correr;
//   * el modelo sale de GEMINI_LIVE_MODEL (por omision el del ADR, SIN verificar contra la API real);
//   * se omiten los guiones `soloFalso` (dependen de provocar fallas del proveedor).
// Uso: VOZ_EVALS_REAL=1 GEMINI_API_KEY=... npm run evals:hoteles:voz:real -w @atiende/domain-hoteles   (ver real-cli.ts y docs/evals/hoteles/README.md)
import { GEMINI_LIVE_MODELO, crearProveedorGeminiLlamada } from "@atiende/voice-core";
import type { CrearSocketLive } from "@atiende/voice-core";
import { instruccionVozHotel } from "../perfil-voz.ts";
import { correrGuion } from "./correr-guion.ts";
import { evaluarLlamada } from "./graders-voz.ts";
import { GUIONES_ES_MX } from "./guiones-es-mx.ts";
import { HOY_SIM, NOMBRE_HOTEL_SIM } from "./mundo-voz.ts";
import { construirReporte } from "./reporte.ts";
import type { OmitidoEval, ReporteEvals, ResultadoGuionEval } from "./reporte.ts";

/** Techo duro del tope de gasto: ningun valor de VOZ_EVALS_MAX_USD lo supera. */
export const TOPE_USD_TECHO = 5;
export const TOPE_USD_POR_OMISION = 1;

export interface OpcionesRealVoz {
  readonly apiKey: string;
  readonly model: string;
  readonly maxUsd: number;
  readonly usdPorMin: number;
  readonly guiones?: readonly string[];
  readonly voiceId: string;
  /** Solo pruebas: socket falso en lugar del WebSocket real. */
  readonly crearSocket?: CrearSocketLive;
}

export function opcionesRealVozDesdeEntorno(env: Readonly<Record<string, string | undefined>> = process.env): OpcionesRealVoz {
  if (env.VOZ_EVALS_REAL !== "1") throw new Error("Modo real apagado: define VOZ_EVALS_REAL=1 (cuesta dinero; nunca corre en CI).");
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY.");
  const maxUsd = Number(env.VOZ_EVALS_MAX_USD ?? String(TOPE_USD_POR_OMISION));
  const usdPorMin = Number(env.VOZ_EVALS_USD_POR_MIN ?? "0.04");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("VOZ_EVALS_MAX_USD debe ser un numero positivo.");
  if (maxUsd > TOPE_USD_TECHO) throw new Error(`VOZ_EVALS_MAX_USD no puede pasar de ${TOPE_USD_TECHO} (techo duro).`);
  if (!Number.isFinite(usdPorMin) || usdPorMin <= 0) throw new Error("VOZ_EVALS_USD_POR_MIN debe ser un numero positivo.");
  return {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODELO,
    maxUsd,
    usdPorMin,
    guiones: env.VOZ_EVALS_GUIONES?.split(",").map((s) => s.trim()).filter(Boolean),
    voiceId: env.VOZ_EVALS_VOZ || "Kore",
  };
}

export interface ResultadoRealVoz {
  readonly resultados: readonly ResultadoGuionEval[];
  readonly gastoUsdEstimado: number;
  readonly noCorridos: readonly string[];
  readonly omitidos: readonly OmitidoEval[];
  readonly cortadoPorTope: boolean;
}

export const instruccionVozEvalsHoteles = (): string =>
  instruccionVozHotel({ hotelName: NOMBRE_HOTEL_SIM, hoy: HOY_SIM, timezone: "America/Mexico_City", horaLocal: "12:00" });

export async function ejecutarPruebaCiegaReal(opts: OpcionesRealVoz, ahora: () => number = Date.now): Promise<ResultadoRealVoz> {
  const instruccion = instruccionVozEvalsHoteles();
  const omitidos: OmitidoEval[] = [];
  const seleccion = GUIONES_ES_MX.filter((g) => {
    if (g.soloFalso) {
      omitidos.push({ id: g.id, motivo: "solo_falso" });
      return false;
    }
    if (opts.guiones && !opts.guiones.some((id) => g.id.startsWith(id))) {
      omitidos.push({ id: g.id, motivo: "no_seleccionado" });
      return false;
    }
    return true;
  });
  const resultados: ResultadoGuionEval[] = [];
  const noCorridos: string[] = [];
  let gasto = 0;
  let cortado = false;
  for (const guion of seleccion) {
    if (cortado || gasto >= opts.maxUsd) {
      cortado = true;
      noCorridos.push(guion.id);
      omitidos.push({ id: guion.id, motivo: "tope_de_gasto" });
      continue;
    }
    const t0 = ahora();
    let r: Omit<ResultadoGuionEval, "latenciaMs">;
    try {
      const llamada = await correrGuion(guion, {
        instruccion,
        voiceId: opts.voiceId,
        proveedor: () => crearProveedorGeminiLlamada({ apiKey: opts.apiKey, model: opts.model, ...(opts.crearSocket ? { crearSocket: opts.crearSocket } : {}) }),
      });
      const graders = await evaluarLlamada(llamada);
      r = { id: guion.id, ok: graders.every((g) => g.ok), graders };
    } catch (err) {
      r = { id: guion.id, ok: false, graders: [], error: err instanceof Error ? err.message.replace(/key=[^&\s]+/g, "key=***") : "error" };
    }
    const dt = ahora() - t0;
    resultados.push({ ...r, latenciaMs: dt });
    gasto += (dt / 60_000) * opts.usdPorMin;
  }
  return { resultados, gastoUsdEstimado: gasto, noCorridos, omitidos, cortadoPorTope: cortado };
}

/** Reporte de una corrida real, listo para escribirse en `docs/evals/hoteles/`. */
export function reporteDeCorridaReal(r: ResultadoRealVoz, opts: Pick<OpcionesRealVoz, "model" | "maxUsd">, fecha: Date = new Date()): ReporteEvals {
  return construirReporte({ canal: "voz", modo: "real", modelo: opts.model, fecha, resultados: r.resultados, omitidos: r.omitidos, gastoUsdEstimado: r.gastoUsdEstimado, topeUsd: opts.maxUsd });
}

/**
 * Corrida con el proveedor FALSO guionado (sin red, sin credenciales, costo cero): deja un reporte de referencia en el mismo formato y prueba que el
 * arnes y los graders estan sanos. NO mide al modelo: eso solo lo hace la corrida real.
 */
export async function ejecutarPruebaCiegaFalsa(ahora: () => number = Date.now, fecha: Date = new Date()): Promise<ReporteEvals> {
  const resultados: ResultadoGuionEval[] = [];
  for (const guion of GUIONES_ES_MX) {
    const t0 = ahora();
    const graders = await evaluarLlamada(await correrGuion(guion));
    resultados.push({ id: guion.id, ok: graders.every((g) => g.ok), graders, latenciaMs: ahora() - t0 });
  }
  return construirReporte({ canal: "voz", modo: "falso", modelo: "proveedor-falso-guionado", fecha, resultados, omitidos: [], gastoUsdEstimado: 0, topeUsd: null });
}
