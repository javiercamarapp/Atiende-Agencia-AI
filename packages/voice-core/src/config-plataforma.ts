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
  /** Precios por COMPONENTE de la cascada v2 (Deepgram + LLM por OpenRouter + HeyGen Voice). Solo precios y fuentes: el motor llega en otro PR (P2). */
  readonly cascadaV2: ConfigCascadaV2;
}

/** Promocion de precio con fecha de fin EXPLICITA: se evalua con un reloj inyectado (`ahora`), nunca con `Date.now()` suelto. */
export interface PromocionPrecio {
  /** Precio promocional (misma unidad que el precio de lista). */
  readonly precio: number;
  /** Instante (ISO 8601 con zona) en que la promocion YA no aplica (exclusivo). */
  readonly terminaEn: string;
}

export interface ConfigCascadaV2 {
  readonly deepgram: {
    /** Modelo de STT en streaming: Nova-3 monolingue, codigos `es` / `es-419` (docs de Deepgram; `es-MX` no figura para Nova-3). */
    readonly modelo: string;
    /** US$ por minuto de audio, STREAMING, pago por uso: tarifa VIGENTE. */
    readonly usdPorMinuto: number;
    /** US$ por minuto: tarifa anterior (la que uso el plan de voz del 10-oct). La vigente se publica como promocional por tiempo limitado, SIN fecha de fin: si sube, vuelve aqui. */
    readonly usdPorMinutoAnterior: number;
  };
  /** TTS alternativo: Deepgram Aura-2 (mismo proveedor y llave que el STT). */
  readonly deepgramAura2: {
    /** US$ por 1 000 caracteres, pago por uso. */
    readonly usdPorMilCaracteres: number;
  };
  readonly heygen: {
    /** US$ por MILLON de caracteres, precio de lista. */
    readonly usdPorMillonCaracteres: number;
    readonly promocion: PromocionPrecio;
  };
  readonly llm: {
    readonly modelo: string;
    readonly modeloDificil: string;
    /** El costo del LLM NO se calcula con una tarifa: es el `usage.cost` que OpenRouter reporta en cada respuesta (`costo_estimado = false`). */
    readonly fuenteCosto: "openrouter-usage-cost";
  };
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
  cascadaV2: Object.freeze({
    // Deepgram: https://deepgram.com/pricing (leida el 2026-10-13): Nova-3 Monolingual streaming US$0.0048/min (tachado US$0.0077), Multilingual US$0.0058/min
    // (tachado US$0.0092); la pagina marca las tarifas de streaming como promocionales por tiempo limitado y NO publica fecha de fin. El plan usaba US$0.0077.
    deepgram: Object.freeze({ modelo: "nova-3", usdPorMinuto: 0.0048, usdPorMinutoAnterior: 0.0077 }),
    // Deepgram Aura-2 (TTS alternativo): https://deepgram.com/pricing (leida el 2026-10-13): US$0.030 por 1 000 caracteres pago por uso (US$0.027 en plan Growth),
    // sin marca de promocion. Se usa la tarifa de pago por uso (la mas alta).
    deepgramAura2: Object.freeze({ usdPorMilCaracteres: 0.03 }),
    // HeyGen NO se da por la voz definitiva (investigacion de arquitectura): limite FIJO de 30 solicitudes por minuto en todos los planes y solo entrega WAV a 44.1 kHz;
    // se mantiene como parametro configurable junto a Aura-2. HeyGen Voice: US$30 por millon de caracteres de lista y US$15 en promocion hasta el 31-oct-2026 (cifras del plan de voz y del brief de Javier, 10-oct-2026;
    // NO se pudieron contrastar con la pagina publica de HeyGen: no expone el precio por caracter sin sesion). La promocion termina al acabar el 31-oct en Merida
    // (UTC-6 fijo desde 2022): 2026-11-01T00:00-06:00. Confirmar la zona con HeyGen.
    heygen: Object.freeze({ usdPorMillonCaracteres: 30, promocion: Object.freeze({ precio: 15, terminaEn: "2026-11-01T00:00:00-06:00" }) }),
    // OpenRouter, leido el 2026-10-13 (/api/v1/models/<id>/endpoints): Haiku 5.5 US$0.10 / 0.50 por millon (cache 0.01); Sonnet 5.5 US$2 / 10 (cache 0.10).
    llm: Object.freeze({ modelo: "anthropic/claude-haiku-5.5", modeloDificil: "anthropic/claude-sonnet-5.5", fuenteCosto: "openrouter-usage-cost" as const }),
  }),
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

/** Reloj inyectable: las funciones de precio que dependen de la fecha lo reciben para que las pruebas fijen la hora. */
export type RelojFecha = () => Date;
const relojSistema: RelojFecha = () => new Date();

const microUsd = (usd: number): number => Math.round(usd * 1_000_000);

/** Costo estimado de Deepgram (micro-USD, entero hacia arriba) para `duracionS` segundos de audio enviados al STT. */
export function costoDeepgramMicroUsd(duracionS: number, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  if (typeof duracionS !== "number" || !Number.isFinite(duracionS) || duracionS <= 0) return 0;
  return Math.ceil((duracionS * microUsd(config.cascadaV2.deepgram.usdPorMinuto)) / 60);
}

/** Costo estimado de Deepgram Aura-2 (micro-USD, entero hacia arriba) para `caracteres` sintetizados. US$ por 1 000 caracteres x 1 000 = micro-USD por caracter. */
export function costoDeepgramAura2MicroUsd(caracteres: number, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  if (typeof caracteres !== "number" || !Number.isFinite(caracteres) || caracteres <= 0) return 0;
  return Math.ceil(caracteres * microUsd(config.cascadaV2.deepgramAura2.usdPorMilCaracteres) / 1000);
}

/** US$ por millon de caracteres de HeyGen en el instante `reloj()`: el precio promocional hasta su fecha de fin (exclusiva) y el de lista despues. */
export function heygenUsdPorMillonCaracteres(reloj: RelojFecha = relojSistema, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  const { usdPorMillonCaracteres, promocion } = config.cascadaV2.heygen;
  const fin = Date.parse(promocion.terminaEn);
  // Una fecha de fin ilegible no regala la promocion: se cobra la lista (el lado seguro del tope).
  return Number.isFinite(fin) && reloj().getTime() < fin ? promocion.precio : usdPorMillonCaracteres;
}

/** Costo estimado de HeyGen (micro-USD, entero hacia arriba) para `caracteres` sintetizados. US$ por millon = micro-USD por caracter. */
export function costoHeygenMicroUsd(caracteres: number, reloj: RelojFecha = relojSistema, config: ConfigPlataformaVoz = VOZ_PLATAFORMA): number {
  if (typeof caracteres !== "number" || !Number.isFinite(caracteres) || caracteres <= 0) return 0;
  return Math.ceil(caracteres * heygenUsdPorMillonCaracteres(reloj, config));
}
