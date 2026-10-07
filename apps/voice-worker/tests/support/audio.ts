// Utilidades de prueba: tonos y silencios PCM16 con energia conocida.
export function tono(hz: number, duracionMs: number, frecuencia = 440, amplitud = 0.5): Int16Array {
  const n = Math.round((hz * duracionMs) / 1000);
  const salida = new Int16Array(n);
  for (let i = 0; i < n; i++) salida[i] = Math.round(Math.sin((2 * Math.PI * frecuencia * i) / hz) * amplitud * 32767);
  return salida;
}

export function silencio(hz: number, duracionMs: number): Int16Array {
  return new Int16Array(Math.round((hz * duracionMs) / 1000));
}

export function rms(m: Int16Array): number {
  if (m.length === 0) return 0;
  let s = 0;
  for (const v of m) s += (v / 32768) ** 2;
  return Math.sqrt(s / m.length);
}
