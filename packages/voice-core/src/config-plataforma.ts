// UNA sola configuracion de voz de plataforma, igual para TODAS las verticales (restaurantes, hoteles y, despues, citas/licitaciones):
// la escalera de proveedores, los modelos y el precio por minuto con el que se estima el costo. Una vertical NO elige otro modelo ni otro
// proveedor por su cuenta (decision de Javier, 3-oct): lo suyo es la persona, el prompt, las tools y las guardias, no el motor ni el costo.
//
// Escalera HIBRIDA (decision de Javier, 3-oct 02:50):
//   1. Gemini Live directo (`GEMINI_API_KEY`, `gemini-3.8-live`)                         principal
//   2. Cascada OpenRouter (`OPENROUTER_API_KEY`): STT -> Gemini por texto -> TTS          respaldo automatico si Google falla o no hay llave
//   3. Humano / buzon con callback                                                         cuando no queda ningun escalon (maquina de la llamada)
// `gpt-live-1` salio de la escalera (pediria otra llave).
//
// Dinero siempre entero (micro-USD, como `core.llm_usage_daily`). Los precios son ESTIMACIONES de lista, no una factura: el evento de costo
// se registra con `costo_estimado = true` hasta conciliar contra el proveedor. Los identificadores de modelo de la cascada no se probaron contra
// la API real (no hay credencial en este entorno): se cambian AQUI, en un solo lugar, y aplican a todas las verticales a la vez.

export type EscalonVoz = "gemini-3.8-live" | "cascada-openrouter";

/** Orden de la escalera: el primero que abre, atiende. */
export const ESCALERA_VOZ: readonly EscalonVoz[] = ["gemini-3.8-live", "cascada-openrouter"];

export interface ConfigPlataformaVoz {
  readonly escalera: readonly EscalonVoz[];
  readonly gemini: {
    readonly modelo: string;
    /** Temperatura de generacion (0 = determinista: el agente vivo de PM corre asi, sin variar precios ni reglas). */
    readonly temperatura: number;
    /** `speechConfig.languageCode` del setup de Gemini Live (BCP-47); `null` = no enviarlo y dejar que el proveedor detecte. */
    readonly idioma: string | null;
    /** Precio estimado por minuto de llamada (audio entrada + salida), micro-USD. */
    readonly precioMicroUsdPorMinuto: number;
  };
  readonly cascada: {
    readonly baseUrl: string;
    readonly modeloStt: string;
    /** Modelo de texto: el que resuelva el gateway de agent-core para el rol de voz (la cascada solo lo nombra para el costo). */
    readonly modeloLlm: string;
    readonly modeloTts: string;
    /** Temperatura del modelo de texto de la cascada (mismo criterio que `gemini.temperatura`). */
    readonly temperatura: number;
    /** Tope de terminos de vocabulario (nombres y apodos del menu) que se pasan al STT como pista. */
    readonly vocabularioMax: number;
    /** Precio estimado por minuto de llamada, micro-USD (STT + LLM + TTS). Es el que usa el evento de costo. */
    readonly precioMicroUsdPorMinuto: number;
    /** Desglose de referencia (la cascada reporta costo por turno con estos). */
    readonly sttMicroUsdPorSegundoAudio: number;
    readonly ttsMicroUsdPorMilCaracteres: number;
  };
  /** Silencio (ms) que cierra el turno del cliente en la cascada (en Gemini lo decide el proveedor). */
  readonly cascadaSilencioFinTurnoMs: number;
}

export const VOZ_PLATAFORMA: ConfigPlataformaVoz = Object.freeze({
  escalera: ESCALERA_VOZ,
  gemini: Object.freeze({ modelo: "gemini-3.8-live", temperatura: 0, idioma: "es-US", precioMicroUsdPorMinuto: 18_000 }),
  cascada: Object.freeze({
    baseUrl: "https://openrouter.ai/api/v1",
    modeloStt: "openai/whisper-large-v3-turbo",
    modeloLlm: "google/gemini-3.8-flash",
    modeloTts: "google/gemini-3.8-flash-tts",
    temperatura: 0,
    vocabularioMax: 200,
    precioMicroUsdPorMinuto: 14_000,
    sttMicroUsdPorSegundoAudio: 70,
    ttsMicroUsdPorMilCaracteres: 15_000,
  }),
  cascadaSilencioFinTurnoMs: 700,
});

export function precioPorMinutoMicroUsd(escalon: EscalonVoz, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  return escalon === "gemini-3.8-live" ? config.gemini.precioMicroUsdPorMinuto : config.cascada.precioMicroUsdPorMinuto;
}

/** Costo estimado de un tramo de llamada (entero, redondeado hacia arriba: nunca subestima). */
export function costoEstimadoMicroUsd(escalon: EscalonVoz, duracionS: number, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  if (!Number.isFinite(duracionS) || duracionS <= 0) return 0;
  return Math.ceil((duracionS * precioPorMinutoMicroUsd(escalon, config)) / 60);
}
