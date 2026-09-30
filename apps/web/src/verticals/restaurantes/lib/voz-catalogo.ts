// Catálogo ESTÁTICO de las 30 voces predefinidas de Gemini Live (`voice_name`).
// Sin clonación, sin "Mis voces" y sin diseño de voz: Gemini Live no los ofrece de
// forma self-serve (ver la corrección de motor de voz en la cola maestra). Las voces
// son multilingües y no vienen etiquetadas por idioma ni por acento; por eso el
// catálogo NO tiene filtro de género ni de acento -- el acento se pide en el prompt.
//
// `tono` es el descriptor que Google publica para cada voz en su documentación,
// traducido al español (sin género gramatical). Ver knownGaps del PR: la
// traducción se hizo de memoria de esa lista y conviene contrastarla con la doc.

export interface VozCatalogo {
  /** Nombre de la voz en Gemini Live (valor de `voice_name`). */
  readonly id: string;
  readonly nombre: string;
  /** Descriptor de tono, en español. */
  readonly tono: string;
}

function v(id: string, tono: string): VozCatalogo {
  return { id, nombre: id, tono };
}

export const CATALOGO_VOCES: readonly VozCatalogo[] = [
  v("Zephyr", "Brillante"),
  v("Puck", "Animado"),
  v("Charon", "Informativo"),
  v("Kore", "Firme"),
  v("Fenrir", "Entusiasta"),
  v("Leda", "Juvenil"),
  v("Orus", "Firme"),
  v("Aoede", "Ligero"),
  v("Callirrhoe", "Relajado"),
  v("Autonoe", "Brillante"),
  v("Enceladus", "Susurrante"),
  v("Iapetus", "Claro"),
  v("Umbriel", "Relajado"),
  v("Algieba", "Fluido"),
  v("Despina", "Fluido"),
  v("Erinome", "Claro"),
  v("Algenib", "Grave y áspero"),
  v("Rasalgethi", "Informativo"),
  v("Laomedeia", "Animado"),
  v("Achernar", "Suave"),
  v("Alnilam", "Firme"),
  v("Schedar", "Uniforme"),
  v("Gacrux", "Maduro"),
  v("Pulcherrima", "Directo"),
  v("Achird", "Cercano"),
  v("Zubenelgenubi", "Casual"),
  v("Vindemiatrix", "Amable"),
  v("Sadachbia", "Vivaz"),
  v("Sadaltager", "Experto"),
  v("Sulafat", "Cálido"),
];

export function buscarVoz(id: string | null | undefined): VozCatalogo | undefined {
  if (!id) return undefined;
  return CATALOGO_VOCES.find((x) => x.id === id);
}

/** Filtra por nombre o tono, sin distinguir mayúsculas ni acentos. */
export function filtrarVoces(voces: readonly VozCatalogo[], consulta: string): readonly VozCatalogo[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(consulta.trim());
  if (!q) return voces;
  return voces.filter((x) => norm(x.nombre).includes(q) || norm(x.tono).includes(q));
}

/**
 * Ruta de la muestra de audio de una voz. No hay `preview_url` de fábrica: las
 * muestras son archivos propios generados una vez y servidos como estáticos. Si el
 * archivo no existe todavía, la interfaz lo dice (ver AgenteVoz.tsx); nunca inventa audio.
 */
export function urlMuestraVoz(baseUrl: string, id: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}media/voces/${id.toLowerCase()}.mp3`;
}
