// PRESET 'restaurante-humano': la configuracion por omision recomendada para un agente de voz de restaurante que suene humano, en español de Mexico, con voz
// FEMENINA, ambiente de restaurante y tecleo mientras anota. Es DATOS + validacion + los bloques de instruccion: no cambia reglas duras, herramientas ni el trato de
// usted de la plataforma (`VOZ_PLATAFORMA.gemini.instruccionIdioma`), y se aplica por organizacion desde Ajustes del agente (cada valor se puede cambiar despues).
//
// FUENTES y JUSTIFICACION de cada valor (lo no medido se dice como juicio):
//   * Voz. Los modelos Live de audio nativo aceptan cualquiera de las 30 voces prediseñadas de Gemini TTS (https://ai.google.dev/gemini-api/docs/live-guide,
//     "Change voice and language"); Google las describe solo con un adjetivo ("Sulafat - Warm", "Callirrhoe - Easy-going", "Aoede - Breezy", etc.), NO publica genero ni
//     acento por voz en la tabla oficial (https://ai.google.dev/gemini-api/docs/speech-generation, "Prebuilt voices"). El genero percibido de la lista
//     `VOCES_FEMENINAS_REFERENCIA` viene de la tabla de voces Chirp 3 HD de Cloud Text-to-Speech (mismos nombres) y es una referencia, no una garantia del modelo Live.
//     Principal: Sulafat (Warm: calida y cercana, lo que pide una taqueria). Alternativas: Callirrhoe (Easy-going: relajada, trato de barrio) y Aoede (Breezy: ligera y agil
//     para hora pico). La decision final es de Javier, que las oye en la vista previa de voz del panel.
//   * Acento mexicano. En la Gemini API los modelos de audio nativo ELIGEN el idioma solos y NO admiten `languageCode` (live-guide: "don't support explicitly setting the
//     language code"; la tabla de idiomas solo trae `es`, sin variante regional); por eso el español de Mexico se pide en la INSTRUCCION (`BLOQUE_ACENTO_MEXICANO` y la
//     linea fija `instruccionIdioma`). Vertex AI si tiene `languageCode` (hoy `idiomaVertex`, por confirmar con la primera llamada real). Lo que NO se puede garantizar: que la
//     voz prediseñada conserve el acento mexicano en todos los turnos; es del proveedor. Se mide escuchando, no con una prueba.
//   * Ritmo 'normal' y estilo 'calido': el ritmo agil atropella numeros y precios (el propio texto de `ajustes-habla` lo advierte) y el pausado alarga la llamada (costo);
//     'calido' es el estilo que pide el rol de anfitriona.
//   * Temperatura 0.4 (juicio de ingenieria, sin medicion): 0 repite frases identicas turno tras turno y suena a grabacion; 1 improvisa. Los precios y totales salen de las
//     herramientas, no del modelo, asi que algo de variacion en la forma de decir las cosas no cambia el pedido. El rango permitido sigue siendo 0..1.
//   * Verbalizacion de la espera: se pide al modelo una frase CORTA ANTES de llamar a las herramientas que tardan (cotizar, confirmar, crear pedido) en el mismo turno, que
//     suena mientras la herramienta corre (sin silencios muertos), y NO antes de las lecturas rapidas (buscar cliente, sucursal, producto). Los 1-4 s tipicos de cotizar
//     (`VIGILAR_SILENCIO_AGENTE_MS` documenta que cotizar tarda 1-4 s) son los que enmascara; no hay umbral en ms dentro de la instruccion (el modelo no mide tiempo): el
//     umbral real es "herramienta de escritura o de calculo". El tecleo cubre el resto de la espera, y el pregrabado de `tool_timeout` sigue ahi como red.
import { esEstiloHabla, esRitmoHabla, esTemperaturaVoz } from "./ajustes-habla.ts";
import type { EstiloHabla, RitmoHabla } from "./ajustes-habla.ts";
import { CATALOGO_VOCES_GEMINI } from "./catalogo-voces.ts";
import { esPresetAmbiente, esVolumenFondo } from "./ambiente-restaurante.ts";
import type { PresetAmbiente } from "./ambiente-restaurante.ts";
import { esVolumenTecleo } from "./tecleo.ts";

export const ID_PRESET_RESTAURANTE_HUMANO = "restaurante-humano";

/** Genero percibido (referencia: tabla Chirp 3 HD de Cloud TTS; Google no lo publica para la API Live) de las voces del catalogo con presentacion femenina. */
export const VOCES_FEMENINAS_REFERENCIA: readonly string[] = Object.freeze([
  "Zephyr", "Kore", "Leda", "Aoede", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat",
]);

export interface PresetVozHumano {
  readonly id: typeof ID_PRESET_RESTAURANTE_HUMANO;
  readonly voz: { readonly principal: string; readonly alternativas: readonly string[] };
  readonly ritmo: RitmoHabla;
  readonly estilo: EstiloHabla;
  readonly temperatura: number;
  /** Anexa el bloque de naturalidad (muletillas escasas, español de Mexico, verbalizacion de la espera, interrupciones) a la instruccion. */
  readonly humanizar: boolean;
  readonly fondo: { readonly activo: boolean; readonly preset: PresetAmbiente; readonly volumen: number };
  readonly tecleo: { readonly activo: boolean; readonly volumen: number };
}

export const PRESET_RESTAURANTE_HUMANO: PresetVozHumano = Object.freeze({
  id: ID_PRESET_RESTAURANTE_HUMANO,
  voz: Object.freeze({ principal: "Sulafat", alternativas: Object.freeze(["Callirrhoe", "Aoede"]) }),
  ritmo: "normal",
  estilo: "calido",
  temperatura: 0.4,
  humanizar: true,
  // 7 %: por debajo del 8 % historico; con ducking y la linea telefonica el ambiente se queda DETRAS (nunca tapa), y el tecleo (12 %) se oye sobre el.
  fondo: Object.freeze({ activo: true, preset: "cocina-taqueria", volumen: 7 }),
  tecleo: Object.freeze({ activo: true, volumen: 12 }),
});

/** Candidatas de VOZ FEMENINA es-MX para la cascada v2 (TTS), SIN integrar todavia: solo anotadas (fuente: ~/atiende-loop/pm/arquitectura-agentes-modelos-2026.md, 13-oct-2026). Ids y etiquetas
 * son los de la documentacion de cada proveedor; se confirman con la API al integrarlas. HeyGen Voice NO es candidata para telefono (30 solicitudes/min fijas, WAV 44.1 kHz, sin precio publico). */
export const CANDIDATAS_TTS_CASCADA_V2: ReadonlyArray<{ readonly proveedor: string; readonly voces: readonly string[]; readonly nota: string }> = Object.freeze([
  {
    proveedor: "Azure MAI-Voice-2.1-Flash (preview, sin SLA)",
    voces: Object.freeze(["es-MX-Valeria:MAI-Voice-2.1-Flash", "es-MX-Harper:MAI-Voice-2.1-Flash"]),
    nota: "Locale es-MX explicito; Harper trae los estilos agent y customer_call_center. Respaldo estable: es-MX-Ximena:DragonHDLatestNeural o es-MX-DaliaNeural.",
  },
  {
    proveedor: "Deepgram Aura-2",
    voces: Object.freeze(["aura-2-estrella-es", "aura-2-olivia-es"]),
    nota: "Etiqueta oficial Mexican (es-mx), mu-law 8 kHz nativo, mismo proveedor que el STT. Muestras sin cuenta: https://static.deepgram.com/examples/Estrella.wav y Spanish_speaker_750_Olivia.wav.",
  },
  {
    proveedor: "ElevenLabs (Eleven v4 Turbo)",
    voces: Object.freeze([]),
    nota: "Sin voz es-MX oficial: solo con una voz CLONADA (PVC de una locutora mexicana, con su consentimiento). Voice Library con filtro de acento Mexican: ids de terceros no verificados, no se anotan.",
  },
  {
    proveedor: "Gemini TTS (respaldo)",
    voces: Object.freeze(["Sulafat", "Callirrhoe", "Aoede"]),
    nota: "Las mismas voces femeninas del catalogo; Extended Voice Library con language_code es-MX y gender female (https://ai.google.dev/gemini-api/docs/speech-generation).",
  },
]);

export interface ProblemaPreset {
  readonly campo: string;
  readonly mensaje: string;
}

/** Valida cualquier preset (el de plataforma o uno armado por el panel). Devuelve la lista de problemas (vacia = valido). Nunca lanza con entradas raras (0, '', null, false, [], {}). */
export function validarPresetHumano(p: unknown): ProblemaPreset[] {
  const problemas: ProblemaPreset[] = [];
  const mal = (campo: string, mensaje: string): void => void problemas.push({ campo, mensaje });
  if (typeof p !== "object" || p === null || Array.isArray(p)) return [{ campo: "preset", mensaje: "se esperaba un objeto" }];
  const o = p as Record<string, unknown>;
  const voz = o.voz;
  if (typeof voz !== "object" || voz === null || Array.isArray(voz)) mal("voz", "se esperaba un objeto con principal y alternativas");
  else {
    const v = voz as Record<string, unknown>;
    const enCatalogo = (id: unknown): boolean => typeof id === "string" && CATALOGO_VOCES_GEMINI.some((c) => c.id === id);
    if (!enCatalogo(v.principal)) mal("voz.principal", "no esta en el catalogo de voces");
    else if (!VOCES_FEMENINAS_REFERENCIA.includes(v.principal as string)) mal("voz.principal", "debe ser una voz femenina del catalogo");
    if (!Array.isArray(v.alternativas) || v.alternativas.some((a) => !enCatalogo(a))) mal("voz.alternativas", "lista de voces del catalogo");
  }
  if (!esRitmoHabla(o.ritmo)) mal("ritmo", "ritmo desconocido");
  if (!esEstiloHabla(o.estilo)) mal("estilo", "estilo desconocido");
  if (!esTemperaturaVoz(o.temperatura)) mal("temperatura", "numero entre 0 y 1");
  if (typeof o.humanizar !== "boolean") mal("humanizar", "true o false");
  const f = o.fondo as Record<string, unknown> | null | undefined;
  if (typeof f !== "object" || f === null || Array.isArray(f)) mal("fondo", "se esperaba un objeto");
  else {
    if (typeof f.activo !== "boolean") mal("fondo.activo", "true o false");
    if (!esPresetAmbiente(f.preset)) mal("fondo.preset", "preset de ambiente desconocido");
    if (!esVolumenFondo(f.volumen)) mal("fondo.volumen", "entero entre 0 y 20");
  }
  const t = o.tecleo as Record<string, unknown> | null | undefined;
  if (typeof t !== "object" || t === null || Array.isArray(t)) mal("tecleo", "se esperaba un objeto");
  else {
    if (typeof t.activo !== "boolean") mal("tecleo.activo", "true o false");
    if (!esVolumenTecleo(t.volumen)) mal("tecleo.volumen", "entero entre 0 y 25");
  }
  return problemas;
}

/** Acento y lexico de Mexico. Va a la instruccion, porque la Gemini API no deja fijar el idioma por parametro en los modelos de audio nativo. */
export const BLOQUE_ACENTO_MEXICANO =
  "ESPAÑOL DE MÉXICO: hable con el acento y el léxico del español de México (entonación mexicana, no de España ni neutra). Use con naturalidad y SIN abusar expresiones como " +
  "«mande» cuando no oyó bien, «con gusto», «claro que sí», «ahorita» (en el sentido de «en un momento»), «le anoto», «para llevar», «orden», «salsa»; «órale» solo si el cliente " +
  "lo usa primero y a lo sumo una vez por llamada. Conserve el trato de usted de la plataforma. Números y precios en pesos, dichos como se dicen en México («ciento veinte pesos»).";

/** Bloque de naturalidad (muletillas escasas, confirmaciones cortas, verbalizacion de la espera, interrupciones). Corto a proposito: va al final y no desplaza las reglas duras. */
export const BLOQUE_NATURALIDAD =
  "NATURALIDAD (solo cambia cómo suena; no cambia reglas, herramientas ni precios): conteste en frases cortas, de una a dos por turno. Use una muletilla breve («a ver», «mmm», «claro») " +
  "como mucho una vez cada varios turnos, nunca seguidas. Confirme con palabras cortas («listo», «va», «perfecto») en vez de repetir todo lo que dijo el cliente. No lea listas largas: " +
  "ofrezca dos o tres opciones y pregunte cuál prefiere. No repita el nombre del cliente en cada frase: úselo al saludar y al confirmar, y ya. " +
  "ANTES de llamar a cotizar, confirmar o crear el pedido diga una frase muy corta («déjeme anotarlo, un momento», «permítame, lo anoto») y llame a la herramienta en ese mismo turno; " +
  "NO diga nada antes de las consultas rápidas (buscar cliente, sucursal o producto). Nunca deje un silencio largo sin avisar. " +
  "Si el cliente la interrumpe, calle de inmediato, retome lo que dijo el cliente y no repita lo anterior desde el principio.";

/** Instruccion completa del preset (acento + naturalidad), para anexar al final de la instruccion del agente. */
export function instruccionHumana(): string {
  return `${BLOQUE_ACENTO_MEXICANO}\n\n${BLOQUE_NATURALIDAD}`;
}

/** Anexa la instruccion humana al final (si se pide). Idempotente: no la duplica si ya esta. */
export function conInstruccionHumana(instruccion: string, humanizar: boolean): string {
  if (!humanizar) return instruccion;
  if (instruccion.includes(BLOQUE_NATURALIDAD)) return instruccion;
  const bloque = instruccionHumana();
  return instruccion.trim() === "" ? bloque : `${instruccion.trimEnd()}\n\n${bloque}`;
}
