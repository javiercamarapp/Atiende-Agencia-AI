// Estimador del costo de UNA llamada con Gemini Live bajo la FACTURACION COMPUESTA: la API cobra por turno todos los tokens que estan en la ventana de contexto,
// asi que el audio acumulado se vuelve a facturar como entrada en cada turno (https://ai.google.dev/gemini-api/docs/live-api/best-practices). El cobro "de lista"
// lineal (US$0.023/min) se queda corto. Es el calculo de la investigacion de voz de PM (4-oct-2026, `gemini_costo.py`) portado a codigo para que el tope por
// llamada, `VOZ_EVALS_USD_POR_MIN` y las pruebas usen UNA sola cuenta. Es una ESTIMACION de planeacion: el costo registrado en `core.usage_cost_event` sale del
// `usageMetadata` real de la sesion (`costoDeUsoGeminiMicroUsd`), y la primera factura de Gemini lo concilia.
import { VOZ_PLATAFORMA } from "./config-plataforma.ts";
import type { ConfigPlataformaVoz } from "./config-plataforma.ts";

/** Tokens de audio por segundo (Gemini Live). */
export const TOKENS_AUDIO_POR_SEGUNDO = 25;
/** Transcripciones de entrada y salida: ~180 tokens por minuto cada una, al precio de texto de salida. */
const TOKENS_TRANSCRIPCION_POR_MINUTO = 180;

export interface EscenarioLlamadaGemini {
  readonly duracionS: number;
  /** Fraccion del tiempo en que habla el cliente (0-1). */
  readonly fraccionCliente: number;
  /** Fraccion del tiempo en que habla el agente (0-1). */
  readonly fraccionAgente: number;
  readonly turnos: number;
  /** Tokens de texto de la instruccion de sistema + declaracion de herramientas (se re-procesan en cada turno). */
  readonly tokensSistema: number;
  /** Tokens de texto que acumulan las respuestas de herramientas a lo largo de la llamada. */
  readonly tokensHerramientas: number;
  /** true = el silencio del cliente tambien cuenta como audio de entrada en el historial (peor caso). */
  readonly silencioCuenta: boolean;
}

export interface CostoLlamadaGemini {
  readonly entradaUsd: number;
  readonly salidaUsd: number;
  readonly transcripcionUsd: number;
  readonly totalUsd: number;
  readonly usdPorMinuto: number;
}

export function estimarCostoLlamadaGemini(e: EscenarioLlamadaGemini, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): CostoLlamadaGemini {
  const p = config.gemini.preciosTokenMicroUsd;
  const usd = (microUsdPorToken: number): number => microUsdPorToken / 1_000_000;
  const audioSalida = e.duracionS * e.fraccionAgente * TOKENS_AUDIO_POR_SEGUNDO;
  const audioEntradaCliente = e.duracionS * (e.silencioCuenta ? 1 : e.fraccionCliente) * TOKENS_AUDIO_POR_SEGUNDO;
  // El audio del agente tambien queda en el historial y se vuelve a cobrar como entrada de audio.
  const audioContextoTotal = audioEntradaCliente + audioSalida;
  let entrada = 0;
  for (let k = 1; k <= e.turnos; k++) {
    const f = k / e.turnos;
    entrada += e.tokensSistema * usd(p.textoEntrada) + e.tokensHerramientas * f * usd(p.textoEntrada) + audioContextoTotal * f * usd(p.audioEntrada);
  }
  const salida = audioSalida * usd(p.audioSalida);
  const transcripcion = (e.duracionS / 60) * 2 * TOKENS_TRANSCRIPCION_POR_MINUTO * usd(p.textoSalida);
  const totalUsd = entrada + salida + transcripcion;
  return { entradaUsd: entrada, salidaUsd: salida, transcripcionUsd: transcripcion, totalUsd, usdPorMinuto: e.duracionS > 0 ? totalUsd / (e.duracionS / 60) : 0 };
}

/** Escenarios de la investigacion (bajo / medio / alto). El MEDIO es el que calibra `precioMicroUsdPorMinuto` y `VOZ_EVALS_USD_POR_MIN`. */
export const ESCENARIOS_COSTO_GEMINI: Readonly<Record<"bajo" | "medio" | "alto", EscenarioLlamadaGemini>> = {
  bajo: { duracionS: 120, fraccionCliente: 0.35, fraccionAgente: 0.4, turnos: 10, tokensSistema: 4000, tokensHerramientas: 1500, silencioCuenta: false },
  medio: { duracionS: 138, fraccionCliente: 0.35, fraccionAgente: 0.45, turnos: 16, tokensSistema: 5000, tokensHerramientas: 3000, silencioCuenta: false },
  alto: { duracionS: 180, fraccionCliente: 0.35, fraccionAgente: 0.5, turnos: 22, tokensSistema: 7000, tokensHerramientas: 5000, silencioCuenta: true },
};

/** Tope de costo por llamada propuesto (micro-USD): ~3x el caso medio (US$0.172) y por encima del alto (US$0.423); corta una llamada fuera de lo normal sin
 * cortar a una larga legitima. Configurable en el worker con `VOICE_COSTO_MAX_LLAMADA_USD`. El valor anterior (US$0.10) cortaba una llamada media a la mitad. */
export const COSTO_MAX_LLAMADA_MICRO_USD = 500_000;
