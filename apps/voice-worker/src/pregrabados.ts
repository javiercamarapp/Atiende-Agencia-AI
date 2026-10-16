// Audios PREGRABADOS: los 15 mensajes de `MENSAJE_IDS` como WAV locales (assets/<id>.wav). Se reproducen desde disco, no desde el TTS del proveedor,
// porque la sintesis puede ser justo lo que fallo. Los genera una sola vez `scripts/voz-pregrabados.ts`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MENSAJE_IDS } from "@atiende/voice-core";
import type { MensajeId } from "@atiende/voice-core";
import { leerWav } from "./audio/pcm.ts";
import type { AudioWav } from "./audio/pcm.ts";

export interface AudiosPregrabados {
  readonly audios: ReadonlyMap<MensajeId, AudioWav>;
  readonly faltantes: readonly MensajeId[];
  /** Ids cuyo archivo existe pero no es un WAV PCM16 mono valido (cuentan como faltantes). */
  readonly invalidos: readonly MensajeId[];
}

export async function cargarPregrabados(dir: string): Promise<AudiosPregrabados> {
  const audios = new Map<MensajeId, AudioWav>();
  const faltantes: MensajeId[] = [];
  const invalidos: MensajeId[] = [];
  for (const id of MENSAJE_IDS) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dir, `${id}.wav`)));
    } catch {
      faltantes.push(id);
      continue;
    }
    try {
      audios.set(id, leerWav(bytes));
    } catch {
      invalidos.push(id);
      faltantes.push(id);
    }
  }
  return { audios, faltantes, invalidos };
}

/** Frecuencias de muestreo que el puente sabe remuestrear (la TTS entrega 24 kHz; la linea es 8/16 kHz). */
export const HZ_PREGRABADO_VALIDOS: readonly number[] = [8_000, 16_000, 24_000];
export const DURACION_MIN_PREGRABADO_S = 0.5;
export const DURACION_MAX_PREGRABADO_S = 30;

export interface ReportePregrabado {
  readonly id: MensajeId;
  readonly ok: boolean;
  readonly hz: number | null;
  readonly duracionS: number | null;
  readonly problema: string | null;
}

/** Verifica los 15 WAV de `dir`: existen, son PCM16 mono, su frecuencia es una que el puente remuestrea y su duracion es de un mensaje (0.5 a 30 s; menos es un error disfrazado). */
export async function verificarPregrabados(dir: string): Promise<{ readonly ok: boolean; readonly reportes: readonly ReportePregrabado[] }> {
  const { audios, faltantes, invalidos } = await cargarPregrabados(dir);
  const reportes: ReportePregrabado[] = MENSAJE_IDS.map((id) => {
    const a = audios.get(id);
    if (!a) return { id, ok: false, hz: null, duracionS: null, problema: invalidos.includes(id) ? "no es un WAV PCM16 mono valido" : faltantes.includes(id) ? "falta el archivo" : "no se pudo leer" };
    const duracionS = a.muestras.length / a.hz;
    const problema = !HZ_PREGRABADO_VALIDOS.includes(a.hz) ? `frecuencia ${a.hz} Hz no soportada (${HZ_PREGRABADO_VALIDOS.join("/")})` : duracionS < DURACION_MIN_PREGRABADO_S ? `dura ${duracionS.toFixed(2)} s: demasiado corto` : duracionS > DURACION_MAX_PREGRABADO_S ? `dura ${duracionS.toFixed(1)} s: demasiado largo` : null;
    return { id, ok: problema === null, hz: a.hz, duracionS: Math.round(duracionS * 100) / 100, problema };
  });
  return { ok: reportes.every((r) => r.ok), reportes };
}
