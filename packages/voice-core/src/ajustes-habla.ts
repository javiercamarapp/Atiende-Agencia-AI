// Ajustes de habla de la voz, equivalentes en Gemini a lo que el original de ElevenLabs llamaba velocidad/estabilidad/estilo.
//
// HONESTO sobre lo que Gemini Live permite (leido en docs el 4-oct-2026, https://ai.google.dev/gemini-api/docs/live):
//   * `temperature` SI es un parametro (generationConfig.temperature): se manda tal cual.
//   * NO hay parametro numerico de velocidad, estabilidad ni similitud: el ritmo y el estilo de los modelos Live nativos se piden
//     por INSTRUCCION. Por eso aqui son un texto fijo, versionado y probado que se ANEXA a la instruccion del sistema, y la
//     pantalla lo declara asi ("se pide al modelo; no es un control numerico del proveedor").
//   * Clonar una voz tampoco existe (solo las 30 voces del catalogo): no se construye.
// El texto anexado nunca cambia reglas, herramientas ni el trato de usted: solo como suena. Va AL FINAL de la instruccion para que no
// desplace las reglas duras de la vertical, pero es corto y declara su limite.

export const RITMOS_HABLA = ["pausado", "normal", "agil"] as const;
export type RitmoHabla = (typeof RITMOS_HABLA)[number];

export const ESTILOS_HABLA = ["neutro", "calido", "sobrio", "animado"] as const;
export type EstiloHabla = (typeof ESTILOS_HABLA)[number];

/** Rango de `temperature` que la plataforma deja elegir para voz (Gemini acepta 0..2; mas alto improvisa de mas en un pedido). */
export const TEMPERATURA_VOZ_MIN = 0;
export const TEMPERATURA_VOZ_MAX = 1;

export interface AjustesHabla {
  readonly ritmo: RitmoHabla;
  readonly estilo: EstiloHabla;
}

export const AJUSTES_HABLA_POR_DEFECTO: AjustesHabla = Object.freeze({ ritmo: "normal", estilo: "neutro" });

const TEXTO_RITMO: Readonly<Record<RitmoHabla, string>> = {
  pausado: "Habla con un ritmo pausado y pronuncia con claridad, sobre todo precios, direcciones y telefonos.",
  normal: "",
  agil: "Habla con un ritmo agil y directo, sin rodeos, pero sin atropellar numeros, precios ni direcciones.",
};

const TEXTO_ESTILO: Readonly<Record<EstiloHabla, string>> = {
  neutro: "",
  calido: "Tu voz es calida y cercana.",
  sobrio: "Tu voz es sobria y serena.",
  animado: "Tu voz es animada y entusiasta, sin exagerar.",
};

export function esRitmoHabla(v: unknown): v is RitmoHabla {
  return typeof v === "string" && (RITMOS_HABLA as readonly string[]).includes(v);
}

export function esEstiloHabla(v: unknown): v is EstiloHabla {
  return typeof v === "string" && (ESTILOS_HABLA as readonly string[]).includes(v);
}

export function esTemperaturaVoz(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= TEMPERATURA_VOZ_MIN && v <= TEMPERATURA_VOZ_MAX;
}

/** Bloque de instruccion para el ritmo y el estilo elegidos; vacio con los valores por defecto (no cambia nada). */
export function instruccionDeHabla(ajustes: AjustesHabla): string {
  const partes = [TEXTO_RITMO[ajustes.ritmo], TEXTO_ESTILO[ajustes.estilo]].filter((t) => t !== "");
  if (partes.length === 0) return "";
  return `ESTILO DE HABLA (solo cambia como suenas; no cambia ninguna regla, herramienta ni el trato de usted): ${partes.join(" ")}`;
}

/** Anexa el bloque de habla al final de la instruccion (si hay). */
export function conInstruccionDeHabla(instruccion: string, ajustes: AjustesHabla): string {
  const bloque = instruccionDeHabla(ajustes);
  if (bloque === "") return instruccion;
  return instruccion.trim() === "" ? bloque : `${instruccion.trimEnd()}\n\n${bloque}`;
}
