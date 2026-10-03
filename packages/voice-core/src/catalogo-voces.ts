// Catalogo ESTATICO de las 30 voces predefinidas de Gemini (`voice_name` de la Live API; los
// modelos Live nativos usan las mismas voces que el TTS). Verificado el 30-sep-2026 contra:
//   - pm/voz/6-paridad-elevenlabs-y-clonacion.md (lista de 30 nombres, fuente
//     docs.cloud.google.com/.../live-api/configure-language-voice y ai.google.dev/.../live-api/capabilities);
//   - ai.google.dev/gemini-api/docs/speech-generation, seccion "Prebuilt voices" (nombre + estilo).
// Las voces NO traen etiqueta de idioma ni de genero: son multilingues y el acento/tono se pide
// por prompt. Por eso este catalogo no inventa `genero` ni `acento` (la UI oculta esos filtros).
// `estilo` es el descriptor oficial tal cual lo publica Google (en ingles).
// No hay `preview_url` oficial por voz: las muestras se generan y guardan aparte (fuera de esta tarea).

export interface VozCatalogoItem {
  /** Valor exacto de `voice_name` que se manda al proveedor. */
  readonly id: string;
  readonly nombre: string;
  readonly estilo: string;
}

const VOCES: ReadonlyArray<readonly [string, string]> = [
  ["Zephyr", "Bright"],
  ["Puck", "Upbeat"],
  ["Charon", "Informative"],
  ["Kore", "Firm"],
  ["Fenrir", "Excitable"],
  ["Leda", "Youthful"],
  ["Orus", "Firm"],
  ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"],
  ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"],
  ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"],
  ["Algieba", "Smooth"],
  ["Despina", "Smooth"],
  ["Erinome", "Clear"],
  ["Algenib", "Gravelly"],
  ["Rasalgethi", "Informative"],
  ["Laomedeia", "Upbeat"],
  ["Achernar", "Soft"],
  ["Alnilam", "Firm"],
  ["Schedar", "Even"],
  ["Gacrux", "Mature"],
  ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"],
  ["Vindemiatrix", "Gentle"],
  ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"],
  ["Sulafat", "Warm"],
];

export const CATALOGO_VOCES_GEMINI: readonly VozCatalogoItem[] = Object.freeze(VOCES.map(([nombre, estilo]) => Object.freeze({ id: nombre, nombre, estilo })));

/** Voz por defecto de una sucursal sin configuracion guardada (solo un valor inicial del
 * formulario; no implica que la voz este "habilitada"). */
export const VOZ_POR_DEFECTO = "Kore";

export function esVozDeGemini(voiceId: unknown): voiceId is string {
  return typeof voiceId === "string" && CATALOGO_VOCES_GEMINI.some((v) => v.id === voiceId);
}
