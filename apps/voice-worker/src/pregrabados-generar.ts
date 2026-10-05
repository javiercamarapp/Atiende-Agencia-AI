// Genera UNA SOLA VEZ los audios PREGRABADOS de la llamada (los 15 mensajes de `MENSAJES_PREGRABADOS`) con el TTS de la cascada (misma llave
// `OPENROUTER_API_KEY` y mismo modelo que `VOZ_PLATAFORMA.cascada.modeloTts`) y los guarda como WAV PCM16 mono en `assets/<id>.wav`. Los reproduce el
// worker desde disco: la sintesis del proveedor puede ser justo lo que fallo cuando hace falta decir "tuvimos un problema con el sistema".
//
//   * Sin llave: falla con un mensaje claro y NO escribe nada (nunca se generan audios falsos ni silencios que parezcan buenos).
//   * Tope de gasto: se estima ANTES de pedir el primer audio (caracteres x precio de lista del TTS); si pasa el tope, no se pide nada.
//   * Un archivo que ya existe se respeta (se genera una sola vez) salvo `forzar`.
//   * Cada WAV se escribe completo y de una vez; una respuesta que no es audio utilizable no deja un archivo a medias.
//
// ESTADO DE VERIFICACION (honesto): la forma de la peticion sigue la documentacion publica de OpenRouter (`/audio/speech`, `response_format: "pcm"` =
// PCM16 a 24 kHz) y se prueba con un `fetch` FALSO; NO se probo contra la API real (no hay credencial en este entorno). Escuchar los 15 audios antes de
// publicarlos es parte del paso 5 de la activacion (docs/VOZ-PM.md).
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MENSAJE_IDS, VOZ_PLATAFORMA } from "@atiende/voice-core";
import type { CatalogoMensajes, ConfigPlataformaVoz, MensajeId } from "@atiende/voice-core";
import { bytesAMuestras, escribirWav } from "./audio/pcm.ts";

export const HZ_TTS = 24_000;
/** Menos de medio segundo de audio no es un mensaje: es un error disfrazado de respuesta. */
const BYTES_MINIMOS = HZ_TTS * 2 * 0.5;

export class PregrabadosError extends Error {}

export interface OpcionesGenerarPregrabados {
  readonly apiKey: string | null;
  readonly textos: CatalogoMensajes;
  readonly dir: string;
  readonly voz: string;
  /** Tope de gasto estimado (USD) para esta corrida. */
  readonly topeUsd: number;
  readonly forzar?: boolean;
  readonly config?: ConfigPlataformaVoz;
  readonly fetchFn?: typeof fetch;
}

export interface ResultadoGenerarPregrabados {
  readonly generados: readonly MensajeId[];
  readonly omitidos: readonly MensajeId[];
  readonly fallidos: readonly { readonly id: MensajeId; readonly motivo: string }[];
  readonly costoEstimadoMicroUsd: number;
}

const costoMicroUsd = (texto: string, c: ConfigPlataformaVoz): number => Math.ceil((texto.length / 1000) * c.cascada.ttsMicroUsdPorMilCaracteres);

async function existe(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).size > 0;
  } catch {
    return false;
  }
}

export async function generarPregrabados(o: OpcionesGenerarPregrabados): Promise<ResultadoGenerarPregrabados> {
  if (!o.apiKey || o.apiKey.trim() === "") {
    throw new PregrabadosError("Falta OPENROUTER_API_KEY: no se genero ningun audio. Los pregrabados salen del TTS real; no se inventan audios de relleno.");
  }
  if (!Number.isFinite(o.topeUsd) || o.topeUsd <= 0) throw new PregrabadosError("El tope de gasto (--tope-usd) debe ser un numero mayor que 0.");
  const config = o.config ?? VOZ_PLATAFORMA;
  const fetchFn = o.fetchFn ?? fetch;

  const pendientes: MensajeId[] = [];
  const omitidos: MensajeId[] = [];
  for (const id of MENSAJE_IDS) {
    if (!o.forzar && (await existe(join(o.dir, `${id}.wav`)))) omitidos.push(id);
    else pendientes.push(id);
  }
  const estimado = pendientes.reduce((s, id) => s + costoMicroUsd(o.textos[id], config), 0);
  if (estimado > o.topeUsd * 1_000_000) {
    throw new PregrabadosError(`El costo estimado (${(estimado / 1_000_000).toFixed(4)} USD) pasa el tope de ${o.topeUsd} USD: no se pidio ningun audio. Sube --tope-usd si es correcto.`);
  }

  await mkdir(o.dir, { recursive: true });
  const generados: MensajeId[] = [];
  const fallidos: { id: MensajeId; motivo: string }[] = [];
  let gastado = 0;
  for (const id of pendientes) {
    const costo = costoMicroUsd(o.textos[id], config);
    if (gastado + costo > o.topeUsd * 1_000_000) {
      fallidos.push({ id, motivo: "tope_de_gasto" });
      continue;
    }
    try {
      const res = await fetchFn(`${config.cascada.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: config.cascada.modeloTts, input: o.textos[id], voice: o.voz, response_format: "pcm" }),
        signal: AbortSignal.timeout(30_000),
      });
      gastado += costo;
      if (!res.ok) {
        fallidos.push({ id, motivo: `http_${res.status}` });
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < BYTES_MINIMOS) {
        fallidos.push({ id, motivo: "audio_demasiado_corto" });
        continue;
      }
      const destino = join(o.dir, `${id}.wav`);
      await writeFile(`${destino}.tmp`, escribirWav(bytesAMuestras(bytes), HZ_TTS));
      await rename(`${destino}.tmp`, destino);
      generados.push(id);
    } catch {
      // El mensaje del error puede traer la URL o cabeceras: solo un codigo corto.
      fallidos.push({ id, motivo: "red" });
    }
  }
  return { generados, omitidos, fallidos, costoEstimadoMicroUsd: gastado };
}
