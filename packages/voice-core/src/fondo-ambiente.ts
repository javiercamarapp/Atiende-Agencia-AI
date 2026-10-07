// Sonido de fondo de restaurante OPCIONAL para la llamada (apagado por omision). Se mezcla en el worker de LiveKit sobre el audio
// del agente, a volumen bajo. No hay archivo de audio con licencia que empacar: el murmullo se SINTETIZA (ruido filtrado con
// modulacion lenta, determinista por semilla), asi no hay un asset externo ni un costo, y la prueba es exacta.
//
// Este modulo es PURO (PCM16 little-endian mono, el formato del agente de Gemini a 24 kHz): el worker de telefonia (apps/voice-worker, PR
// aparte) solo tiene que llamar `mezclar(trozo)` por cada trozo de audio que reproduce. Sin ese worker en main, la opcion queda en la
// configuracion y esta mezcla probada en aislado; la dependencia se declara en el PR.
//
// Seguridad de la llamada: el volumen se acota a `FONDO_VOLUMEN_MAX` (el fondo nunca tapa la voz del agente) y la suma se satura en vez
// de desbordar (un desborde de PCM16 suena como un chasquido).

export const FONDO_VOLUMEN_MIN = 0;
/** Porcentaje maximo del fondo respecto a plena escala. */
export const FONDO_VOLUMEN_MAX = 20;
export const FONDO_VOLUMEN_POR_DEFECTO = 8;
export const HZ_AUDIO_AGENTE = 24_000;

export function esVolumenFondo(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= FONDO_VOLUMEN_MIN && v <= FONDO_VOLUMEN_MAX;
}

/** Generador pseudoaleatorio determinista (mulberry32): mismo fondo en cada prueba. */
function crearAzar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OpcionesFondo {
  /** Porcentaje de plena escala (0..FONDO_VOLUMEN_MAX). 0 = apagado: `mezclar` devuelve el audio tal cual. */
  readonly volumen: number;
  readonly semilla?: number;
  readonly hz?: number;
}

/** Murmullo de fondo: ruido marron (integrado y con fuga, grave) con un vaiven lento de amplitud, como una sala con gente. */
export class FondoRestaurante {
  readonly volumen: number;
  private readonly azar: () => number;
  private readonly hz: number;
  private marron = 0;
  private fase = 0;

  constructor(opciones: OpcionesFondo) {
    if (!esVolumenFondo(opciones.volumen)) throw new RangeError(`volumen del fondo: entero entre ${FONDO_VOLUMEN_MIN} y ${FONDO_VOLUMEN_MAX}`);
    this.volumen = opciones.volumen;
    this.azar = crearAzar(opciones.semilla ?? 1);
    this.hz = opciones.hz ?? HZ_AUDIO_AGENTE;
  }

  get activo(): boolean {
    return this.volumen > 0;
  }

  /** Siguientes `muestras` del murmullo (solo fondo, sin voz), PCM16 little-endian. Con volumen 0 es silencio. */
  siguiente(muestras: number): Uint8Array {
    const salida = new Uint8Array(muestras * 2);
    const vista = new DataView(salida.buffer);
    if (!this.activo) return salida;
    const ganancia = (this.volumen / 100) * 32767;
    for (let i = 0; i < muestras; i++) {
      this.marron = (this.marron + (this.azar() * 2 - 1) * 0.12) * 0.985;
      this.fase += (2 * Math.PI * 0.35) / this.hz;
      const vaiven = 0.75 + 0.25 * Math.sin(this.fase);
      const x = Math.max(-1, Math.min(1, this.marron * 3.2 * vaiven));
      vista.setInt16(i * 2, Math.round(x * ganancia), true);
    }
    return salida;
  }

  /** Mezcla el fondo bajo un trozo de audio del agente (PCM16 LE). Satura, nunca desborda; con el fondo apagado devuelve el mismo trozo. */
  mezclar(agente: Uint8Array): Uint8Array {
    if (!this.activo) return agente;
    const n = Math.floor(agente.byteLength / 2);
    const fondo = this.siguiente(n);
    const a = new DataView(agente.buffer, agente.byteOffset, n * 2);
    const f = new DataView(fondo.buffer, fondo.byteOffset, n * 2);
    const salida = new Uint8Array(agente.byteLength);
    const s = new DataView(salida.buffer);
    for (let i = 0; i < n; i++) {
      const suma = a.getInt16(i * 2, true) + f.getInt16(i * 2, true);
      s.setInt16(i * 2, suma > 32767 ? 32767 : suma < -32768 ? -32768 : suma, true);
    }
    if (agente.byteLength % 2 === 1) salida[agente.byteLength - 1] = agente[agente.byteLength - 1]!;
    return salida;
  }
}
