// Utilidades de PCM16 mono little-endian: conversion entre bytes (el formato de los escalones de voz de @atiende/voice-core) y muestras,
// energia y un lector/escritor minimo de WAV. Sin dependencias.

/** Bytes PCM16 LE -> muestras. Un byte sobrante (media muestra) se descarta. */
export function bytesAMuestras(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const salida = new Int16Array(n);
  const vista = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) salida[i] = vista.getInt16(i * 2, true);
  return salida;
}

/** Muestras -> bytes PCM16 LE. */
export function muestrasABytes(muestras: Int16Array): Uint8Array {
  const bytes = new Uint8Array(muestras.length * 2);
  const vista = new DataView(bytes.buffer);
  for (let i = 0; i < muestras.length; i++) vista.setInt16(i * 2, muestras[i] ?? 0, true);
  return bytes;
}

/** Energia RMS normalizada (0..1). */
export function energiaMuestras(muestras: Int16Array): number {
  if (muestras.length === 0) return 0;
  let suma = 0;
  for (let i = 0; i < muestras.length; i++) {
    const m = (muestras[i] ?? 0) / 32768;
    suma += m * m;
  }
  return Math.sqrt(suma / muestras.length);
}

export interface AudioWav {
  readonly muestras: Int16Array;
  readonly hz: number;
}

/** Lee un WAV PCM16 mono. Falla en voz alta con cualquier otro formato: un pregrabado ilegible nunca debe sonar como ruido. */
export function leerWav(bytes: Uint8Array): AudioWav {
  if (bytes.byteLength < 44) throw new Error("wav_demasiado_corto");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texto = (o: number, n: number): string => String.fromCharCode(...bytes.subarray(o, o + n));
  if (texto(0, 4) !== "RIFF" || texto(8, 4) !== "WAVE") throw new Error("wav_sin_cabecera_riff");
  let pos = 12;
  let hz = 0;
  let canales = 0;
  let bits = 0;
  let formato = 0;
  while (pos + 8 <= bytes.byteLength) {
    const id = texto(pos, 4);
    const tam = v.getUint32(pos + 4, true);
    const cuerpo = pos + 8;
    if (id === "fmt ") {
      formato = v.getUint16(cuerpo, true);
      canales = v.getUint16(cuerpo + 2, true);
      hz = v.getUint32(cuerpo + 4, true);
      bits = v.getUint16(cuerpo + 14, true);
    } else if (id === "data") {
      if (formato !== 1 || bits !== 16 || canales !== 1) throw new Error("wav_no_es_pcm16_mono");
      const fin = Math.min(bytes.byteLength, cuerpo + tam);
      return { muestras: bytesAMuestras(bytes.subarray(cuerpo, fin)), hz };
    }
    pos = cuerpo + tam + (tam % 2);
  }
  throw new Error("wav_sin_datos");
}

/** Muestras PCM16 mono -> WAV (cabecera de 44 bytes). */
export function escribirWav(muestras: Int16Array, hz: number): Uint8Array {
  const datos = muestrasABytes(muestras);
  const wav = new Uint8Array(44 + datos.byteLength);
  const v = new DataView(wav.buffer);
  const texto = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  texto(0, "RIFF");
  v.setUint32(4, 36 + datos.byteLength, true);
  texto(8, "WAVE");
  texto(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, hz, true);
  v.setUint32(28, hz * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  texto(36, "data");
  v.setUint32(40, datos.byteLength, true);
  wav.set(datos, 44);
  return wav;
}
