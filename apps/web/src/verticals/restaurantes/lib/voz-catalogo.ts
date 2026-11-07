// Catálogo ESTÁTICO de las 30 voces predefinidas de Gemini Live (`voice_name`).
// Sin clonación, sin "Mis voces" y sin diseño de voz: Gemini Live no los ofrece de
// forma self-serve (ver la corrección de motor de voz en la cola maestra). Las voces
// son multilingües y no vienen etiquetadas por idioma ni por acento; por eso el
// catálogo NO tiene filtro de género ni de acento -- el acento se pide en el prompt.
//
// `tono` es el descriptor que Google publica para cada voz en su documentación,
// traducido al español (sin género gramatical). Ver knownGaps del PR: la
// traducción se hizo de memoria de esa lista y conviene contrastarla con la doc.
// En inglés (consola en EN) `tono` es el descriptor original de Google; se traduce en cada lectura.
import { traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesAgenteVoz } from "@atiende/ui/i18n/restaurantes/agenteVoz";

export interface VozCatalogo {
  /** Nombre de la voz en Gemini Live (valor de `voice_name`). */
  readonly id: string;
  readonly nombre: string;
  /** Descriptor de tono, en el idioma de la consola. */
  readonly tono: string;
}

const tr = traductorActivo(restaurantesAgenteVoz);

function v(id: string, clave: Clave): VozCatalogo {
  return {
    id,
    nombre: id,
    get tono() {
      return tr(clave);
    },
  };
}

export const CATALOGO_VOCES: readonly VozCatalogo[] = [
  v("Zephyr", "restaurantes.agenteVoz.tono.Zephyr"),
  v("Puck", "restaurantes.agenteVoz.tono.Puck"),
  v("Charon", "restaurantes.agenteVoz.tono.Charon"),
  v("Kore", "restaurantes.agenteVoz.tono.Kore"),
  v("Fenrir", "restaurantes.agenteVoz.tono.Fenrir"),
  v("Leda", "restaurantes.agenteVoz.tono.Leda"),
  v("Orus", "restaurantes.agenteVoz.tono.Orus"),
  v("Aoede", "restaurantes.agenteVoz.tono.Aoede"),
  v("Callirrhoe", "restaurantes.agenteVoz.tono.Callirrhoe"),
  v("Autonoe", "restaurantes.agenteVoz.tono.Autonoe"),
  v("Enceladus", "restaurantes.agenteVoz.tono.Enceladus"),
  v("Iapetus", "restaurantes.agenteVoz.tono.Iapetus"),
  v("Umbriel", "restaurantes.agenteVoz.tono.Umbriel"),
  v("Algieba", "restaurantes.agenteVoz.tono.Algieba"),
  v("Despina", "restaurantes.agenteVoz.tono.Despina"),
  v("Erinome", "restaurantes.agenteVoz.tono.Erinome"),
  v("Algenib", "restaurantes.agenteVoz.tono.Algenib"),
  v("Rasalgethi", "restaurantes.agenteVoz.tono.Rasalgethi"),
  v("Laomedeia", "restaurantes.agenteVoz.tono.Laomedeia"),
  v("Achernar", "restaurantes.agenteVoz.tono.Achernar"),
  v("Alnilam", "restaurantes.agenteVoz.tono.Alnilam"),
  v("Schedar", "restaurantes.agenteVoz.tono.Schedar"),
  v("Gacrux", "restaurantes.agenteVoz.tono.Gacrux"),
  v("Pulcherrima", "restaurantes.agenteVoz.tono.Pulcherrima"),
  v("Achird", "restaurantes.agenteVoz.tono.Achird"),
  v("Zubenelgenubi", "restaurantes.agenteVoz.tono.Zubenelgenubi"),
  v("Vindemiatrix", "restaurantes.agenteVoz.tono.Vindemiatrix"),
  v("Sadachbia", "restaurantes.agenteVoz.tono.Sadachbia"),
  v("Sadaltager", "restaurantes.agenteVoz.tono.Sadaltager"),
  v("Sulafat", "restaurantes.agenteVoz.tono.Sulafat"),
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
