// Utilidades de PCM16 mono little-endian: parseo de bytes, recorte de silencios, trozos de 20 ms para el streaming y duracion. Puro.
export const HZ_CLIENTE = 16_000;
export const TROZO_MS = 20;

export function parsearPcm16(bytes: Uint8Array): Int16Array {
  const par = bytes.byteLength - (bytes.byteLength % 2);
  const o = new Int16Array(par / 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, par);
  for (let i = 0; i < o.length; i += 1) o[i] = dv.getInt16(i * 2, true);
  return o;
}

export function pcmABytes(pcm: Int16Array): Uint8Array {
  const b = new Uint8Array(pcm.length * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < pcm.length; i += 1) dv.setInt16(i * 2, pcm[i]!, true);
  return b;
}

export const duracionS = (pcm: { length: number }, hz = HZ_CLIENTE): number => pcm.length / hz;

/** Quita el silencio inicial y final (muestras bajo `umbral`) conservando `margenMs` a cada lado: el "fin de voz" que se mide es el del ultimo sonido real, no la cola del TTS. */
export function recortarSilencios(pcm: Int16Array, hz = HZ_CLIENTE, umbral = 400, margenMs = 40): Int16Array {
  let a = 0; let b = pcm.length - 1;
  while (a < pcm.length && Math.abs(pcm[a]!) < umbral) a += 1;
  while (b >= a && Math.abs(pcm[b]!) < umbral) b -= 1;
  if (a >= pcm.length) return new Int16Array(0);
  const m = Math.round((margenMs * hz) / 1000);
  return pcm.slice(Math.max(0, a - m), Math.min(pcm.length, b + 1 + m));
}

export const silencio = (ms: number, hz = HZ_CLIENTE): Int16Array => new Int16Array(Math.round((ms * hz) / 1000));

export function concatenar(...partes: Int16Array[]): Int16Array {
  const o = new Int16Array(partes.reduce((a, p) => a + p.length, 0)); let k = 0;
  for (const p of partes) { o.set(p, k); k += p.length; }
  return o;
}

/** Parte en trozos de `ms` (el ultimo puede ser mas corto), listos para `enviarAudio`. */
export function trozos(pcm: Int16Array, hz = HZ_CLIENTE, ms = TROZO_MS): Int16Array[] {
  const n = Math.round((ms * hz) / 1000); const o: Int16Array[] = [];
  for (let i = 0; i < pcm.length; i += n) o.push(pcm.subarray(i, Math.min(pcm.length, i + n)));
  return o;
}
