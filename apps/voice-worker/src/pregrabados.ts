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
