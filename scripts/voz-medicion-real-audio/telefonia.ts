// Linea telefonica sintetica sobre PCM16 mono de 16 kHz: banda 300-3400 Hz, ida y vuelta por 8 kHz mu-law (G.711) y mezcla de ruido de fondo a una SNR dada.
// Puro y determinista (el rng se inyecta). Aproxima una llamada PSTN/SIP sin red telefonica: NO modela perdida de paquetes ni jitter.
export type Rng = () => number;

const BIAS = 0x84; const CLIP = 32635;

/** G.711 mu-law: muestra PCM16 -> byte. */
export function mulawEncode(muestra: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(muestra)));
  const signo = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp -= 1;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(signo | (exp << 4) | mant) & 0xff;
}

/** G.711 mu-law: byte -> muestra PCM16. */
export function mulawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const signo = u & 0x80; const exp = (u >> 4) & 7; const mant = u & 0x0f;
  const m = (((mant << 3) + BIAS) << exp) - BIAS;
  return signo ? -m : m;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }
function biquad(tipo: "lp" | "hp", fc: number, fs: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * fc) / fs; const c = Math.cos(w); const al = Math.sin(w) / (2 * q); const a0 = 1 + al;
  const b = tipo === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return { b0: b[0]! / a0, b1: b[1]! / a0, b2: b[2]! / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
function filtrar(x: Float64Array, f: Biquad): Float64Array {
  const y = new Float64Array(x.length); let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = f.b0 * x[i]! + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Pasa-banda 300-3400 Hz (paso alto 300 + paso bajo 3400, 4 polos cada uno). */
export function pasaBandaTelefonica(x: Float64Array, fs: number): Float64Array {
  let y = x;
  for (const f of [biquad("hp", 300, fs), biquad("hp", 300, fs), biquad("lp", 3400, fs), biquad("lp", 3400, fs)]) y = filtrar(y, f);
  return y;
}

/** mu-law ida y vuelta a 8 kHz: entrada y salida a `fs` (16 kHz). Decima x2 (ya limitada en banda), codifica, decodifica e interpola. */
export function mulawIdaYVuelta8k(x: Float64Array): Float64Array {
  const n8 = Math.floor(x.length / 2);
  const d = new Float64Array(n8);
  for (let i = 0; i < n8; i += 1) d[i] = mulawDecode(mulawEncode(x[2 * i]!));
  const y = new Float64Array(n8 * 2);
  for (let i = 0; i < n8; i += 1) { y[2 * i] = d[i]!; y[2 * i + 1] = i + 1 < n8 ? (d[i]! + d[i + 1]!) / 2 : d[i]!; }
  return filtrar(filtrar(y, biquad("lp", 3400, 16_000)), biquad("lp", 3400, 16_000));
}

const gauss = (rng: Rng): number => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

export function rms(x: ArrayLike<number>, umbral = 0): number {
  let s = 0; let k = 0;
  for (let i = 0; i < x.length; i += 1) { const v = x[i]!; if (Math.abs(v) >= umbral) { s += v * v; k += 1; } }
  return k === 0 ? 0 : Math.sqrt(s / k);
}

/** Ruido de fondo (blanco suavizado tipo "sala/calle" + zumbido de 60 Hz suave) con la potencia pedida respecto del habla: `snrDb` = 20 log10(rms habla / rms ruido). */
export function mezclarRuido(x: Float64Array, fs: number, snrDb: number, rng: Rng): Float64Array {
  const habla = rms(x, 300) || 1000;
  const objetivo = habla / 10 ** (snrDb / 20);
  const r = new Float64Array(x.length); let lp = 0;
  for (let i = 0; i < r.length; i += 1) { lp = 0.85 * lp + 0.15 * gauss(rng); r[i] = lp + 0.15 * Math.sin((2 * Math.PI * 60 * i) / fs); }
  const k = objetivo / (rms(r) || 1);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i += 1) y[i] = x[i]! + r[i]! * k;
  return y;
}

export interface OpcionesLinea { readonly snrDb: number }

export const aFloat = (pcm: Int16Array): Float64Array => Float64Array.from(pcm);
export function aPcm16(x: Float64Array): Int16Array {
  const o = new Int16Array(x.length);
  for (let i = 0; i < x.length; i += 1) o[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]!)));
  return o;
}

/** Cadena completa de linea telefonica sobre PCM16 de 16 kHz. Sin `opciones`: solo banda + mu-law; con `snrDb`: ademas ruido de fondo. */
export function lineaTelefonica(pcm: Int16Array, rng: Rng, opciones?: OpcionesLinea): Int16Array {
  let x = pasaBandaTelefonica(aFloat(pcm), 16_000);
  x = mulawIdaYVuelta8k(x);
  if (opciones) x = mezclarRuido(x, 16_000, opciones.snrDb, rng);
  return aPcm16(x);
}
