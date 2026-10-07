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
    /** `speechConfig.languageCode` del setup de la Gemini API (BCP-47); `null` = no enviarlo. Los modelos de audio nativo de la Gemini API ELIGEN el idioma
     * solos y no admiten `languageCode` (investigacion 4-oct): el idioma se fija en la instruccion (`instruccionIdioma`). */
    readonly idioma: string | null;
    /** `speechConfig.languageCode` del adaptador de Vertex AI, donde el parametro SI existe (por confirmar con la primera llamada real). */
    readonly idiomaVertex: string;
    /** Linea fija que va AL INICIO de la instruccion de sistema: fija el espanol de Mexico y el trato de usted (guia oficial de Live API). */
    readonly instruccionIdioma: string;
    /** Precio estimado por minuto de llamada (audio entrada + salida), micro-USD. Con la facturacion compuesta de Gemini Live (cada turno vuelve a cobrar
     * el audio acumulado) el punto medio de la investigacion es US$0.075/min; sirve de piso cuando el proveedor no reporta tokens. */
    readonly precioMicroUsdPorMinuto: number;
    /** Precio por MILLON de tokens (micro-USD por token) de `gemini-3.8-live`, nivel de pago: https://ai.google.dev/gemini-api/docs/pricing */
    readonly preciosTokenMicroUsd: { readonly textoEntrada: number; readonly audioEntrada: number; readonly textoSalida: number; readonly audioSalida: number };
    /** Como lee el worker `usageMetadata`: `por_turno` = cada mensaje trae los tokens de ESE turno (el prompt incluye el contexto acumulado, que Gemini vuelve a
     * cobrar: la facturacion compuesta) y se SUMAN; `acumulado` = cada mensaje trae el total de la sesion y se resta el anterior. VERIFICADO con la medicion cruda contra la API
     * (work/voz/medicion, 7 llamadas; investigacion §6.2): cada `usageMetadata` trae TODO el contexto del turno (el prompt crece turno a turno), asi que es `por_turno`
     * y NO se resta el anterior. No cambiar a `acumulado` por una conciliacion de factura sin revisar antes el desglose por modalidad. */
    readonly usoReportado: "por_turno" | "acumulado";
    /** Deteccion de actividad de voz del servidor. `silencioFinMs` cierra el turno del cliente; menos = responde antes pero corta al que hace pausas. */
    readonly vad: { readonly silencioFinMs: number; readonly prefijoMs: number; readonly sensibilidadFin: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | null; readonly sensibilidadInicio: "START_SENSITIVITY_HIGH" | "START_SENSITIVITY_LOW" | null };
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
  gemini: Object.freeze({
    modelo: "gemini-3.8-live",
    temperatura: 0,
    idioma: null,
    idiomaVertex: "es-US",
    instruccionIdioma: "Responda siempre y únicamente en español de México, tratando al cliente de usted. RESPOND UNMISTAKABLY IN MEXICAN SPANISH.",
    precioMicroUsdPorMinuto: 75_000,
    preciosTokenMicroUsd: Object.freeze({ textoEntrada: 0.75, audioEntrada: 3, textoSalida: 4.5, audioSalida: 12 }),
    usoReportado: "por_turno" as const,
    vad: Object.freeze({ silencioFinMs: 500, prefijoMs: 60, sensibilidadFin: "END_SENSITIVITY_HIGH" as const, sensibilidadInicio: null }),
  }),
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

/** Subconjunto de `usageMetadata` de Gemini Live que importa para el costo. */
export interface UsoGemini {
  readonly promptTokenCount?: number;
  readonly responseTokenCount?: number;
  readonly toolUsePromptTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly promptTokensDetails?: readonly { readonly modality?: string; readonly tokenCount?: number }[];
  readonly responseTokensDetails?: readonly { readonly modality?: string; readonly tokenCount?: number }[];
}

const nat = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** Costo (micro-USD, entero hacia arriba) de UN mensaje `usageMetadata` con la tarifa por modalidad. El desglose por modalidad NO suma el total: la medicion cruda
 * (work/voz/medicion, 7 llamadas) trae en cada turno tokens de entrada y de salida sin desglose (p. ej. 4759 TEXT + 251 AUDIO = 5010 contra promptTokenCount 5804). Lo que
 * falta del desglose (el conteo total menos lo detallado) se cobra a la tarifa de AUDIO (la mas cara): sobreestimar es el lado seguro del tope, subestimar es el bug.
 * Sin desglose alguno todo el conteo va a tarifa de audio. Los tokens de pensamiento y de uso de herramientas se cobran como texto. */
export function costoDeUsoGeminiMicroUsd(uso: UsoGemini, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  const p = config.gemini.preciosTokenMicroUsd;
  const entrada = (uso.promptTokensDetails ?? []).reduce((s, d) => s + nat(d.tokenCount) * (d.modality === "TEXT" ? p.textoEntrada : p.audioEntrada), 0);
  const detalladoEntrada = (uso.promptTokensDetails ?? []).reduce((s, d) => s + nat(d.tokenCount), 0);
  const entradaSinDesglose = Math.max(0, nat(uso.promptTokenCount) - detalladoEntrada) * p.audioEntrada;
  const salida = (uso.responseTokensDetails ?? []).reduce((s, d) => s + nat(d.tokenCount) * (d.modality === "TEXT" ? p.textoSalida : p.audioSalida), 0);
  const detalladoSalida = (uso.responseTokensDetails ?? []).reduce((s, d) => s + nat(d.tokenCount), 0);
  const salidaSinDesglose = Math.max(0, nat(uso.responseTokenCount) - detalladoSalida) * p.audioSalida;
  const extra = nat(uso.toolUsePromptTokenCount) * p.textoEntrada + nat(uso.thoughtsTokenCount) * p.textoSalida;
  return Math.ceil(entrada + entradaSinDesglose + salida + salidaSinDesglose + extra);
}
