// MODO REAL de la prueba ciega de voz (manual; NUNCA corre en CI ni en `npm test`): los mismos guiones y graders, pero el agente es
// Gemini Live de verdad (sesion de texto con transcripcion). Protecciones:
//   * exige VOZ_EVALS_REAL=1 y GEMINI_API_KEY (sin ellas lanza antes de abrir ninguna conexion);
//   * tope de gasto ESTIMADO (VOZ_EVALS_MAX_USD, por omision 1): costo = minutos de pared de cada guion x VOZ_EVALS_USD_POR_MIN
//     (por omision US$0.075, el punto medio de la facturacion compuesta); se corta al alcanzarlo y lista los guiones sin correr;
//   * el modelo sale de GEMINI_LIVE_MODEL (por omision el del ADR, SIN verificar contra la API real);
//   * se omiten los guiones `soloFalso` (dependen de provocar fallas del proveedor).
// Uso: VOZ_EVALS_REAL=1 GEMINI_API_KEY=... npm run evals:voz:real -w @atiende/domain-restaurantes
import { crearProveedorGeminiLlamada } from "../llamada/gemini-live-sesion.ts";
import type { CrearSocketLive } from "../llamada/gemini-live-sesion.ts";
import { GEMINI_LIVE_MODELO } from "../gemini-live-provider.ts";
import { VOZ_PLATAFORMA } from "@atiende/voice-core";
import { correrGuion } from "./correr-guion.ts";
import { evaluarLlamada } from "./graders-voz.ts";
import { GUIONES_ES_MX } from "./guiones-es-mx.ts";
import { crearMundoVoz } from "./mundo-voz.ts";
import { instruccionVozPm } from "./prompt-voz.ts";
import type { ResultadoGrader } from "./tipos.ts";

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
  const maxUsd = Number(env.VOZ_EVALS_MAX_USD ?? "1");
  // Por omision el punto medio de la facturacion compuesta de Gemini Live (US$0.075/min; src/costo-gemini.ts), no el US$0.04 lineal del ADR.
  const usdPorMin = Number(env.VOZ_EVALS_USD_POR_MIN ?? String(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto / 1_000_000));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("VOZ_EVALS_MAX_USD debe ser un numero positivo.");
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
  readonly resultados: readonly { readonly id: string; readonly ok: boolean; readonly graders: readonly ResultadoGrader[]; readonly error?: string }[];
  readonly gastoUsdEstimado: number;
  readonly noCorridos: readonly string[];
  readonly cortadoPorTope: boolean;
}

export async function ejecutarPruebaCiegaReal(opts: OpcionesRealVoz, ahora: () => number = Date.now): Promise<ResultadoRealVoz> {
  const mundoRef = crearMundoVoz();
  const branches = [
    { propertyId: mundoRef.propertyId, slug: "fco-montejo", name: "Francisco de Montejo", address: null },
    { propertyId: "altabrisa", slug: "altabrisa", name: "Altabrisa", address: null },
  ];
  const instruccion = instruccionVozPm(branches, "lunes 18:30", "lunes", "fco-montejo");
  const seleccion = GUIONES_ES_MX.filter((g) => !g.soloFalso && (!opts.guiones || opts.guiones.some((id) => g.id.startsWith(id))));
  const resultados: ResultadoRealVoz["resultados"][number][] = [];
  const noCorridos: string[] = [];
  let gasto = 0;
  let cortado = false;
  for (const guion of seleccion) {
    if (cortado || gasto >= opts.maxUsd) {
      cortado = true;
      noCorridos.push(guion.id);
      continue;
    }
    const t0 = ahora();
    try {
      const llamada = await correrGuion(guion, {
        instruccion,
        voiceId: opts.voiceId,
        proveedor: () => crearProveedorGeminiLlamada({ apiKey: opts.apiKey, model: opts.model, ...(opts.crearSocket ? { crearSocket: opts.crearSocket } : {}) }),
      });
      const graders = await evaluarLlamada(llamada);
      resultados.push({ id: guion.id, ok: graders.every((g) => g.ok), graders });
    } catch (err) {
      resultados.push({ id: guion.id, ok: false, graders: [], error: err instanceof Error ? err.message.replace(/key=[^&\s]+/g, "key=***") : "error" });
    }
    gasto += ((ahora() - t0) / 60_000) * opts.usdPorMin;
  }
  return { resultados, gastoUsdEstimado: gasto, noCorridos, cortadoPorTope: cortado };
}
