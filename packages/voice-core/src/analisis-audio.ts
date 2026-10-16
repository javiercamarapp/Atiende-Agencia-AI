// Medidas objetivas de audio PCM16 (puras, sin dependencias) para validar el ambiente y el tecleo sin poder ESCUCHARLOS: nivel RMS, pico, sonoridad aproximada
// (LUFS sin compuerta, ponderacion K de ITU-R BS.1770), energia por banda (FFT) y huella para detectar bucles repetidos. Las usan las pruebas y el script de
// muestras (`scripts/voz-muestras-ambiente/`).

const aFlotante = (m: Int16Array | Float32Array | Float64Array): Float64Array => {
  if (m instanceof Float64Array) return m;
  const s = new Float64Array(m.length);
  const esInt = m instanceof Int16Array;
  for (let i = 0; i < m.length; i++) s[i] = esInt ? m[i]! / 32768 : m[i]!;
  return s;
};

/** RMS en escala 0..1 (plena escala = 1). Vacio = 0. */
export function rms(m: Int16Array | Float32Array | Float64Array): number {
  const x = aFlotante(m);
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** Pico absoluto en escala 0..1 (un Int16 -32768 cuenta 1.0). */
export function pico(m: Int16Array | Float32Array | Float64Array): number {
  const x = aFlotante(m);
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

export const aDbfs = (lineal: number): number => (lineal <= 1e-9 ? -Infinity : 20 * Math.log10(lineal));

/** Cantidad de muestras que tocan la plena escala (saturacion/recorte): 0 en un audio sano. */
export function muestrasRecortadas(m: Int16Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] === 32767 || m[i] === -32768) n++;
  return n;
}

interface Bicuad {
  b: [number, number, number];
  a: [number, number];
}

function filtrar(x: Float64Array, c: Bicuad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = c.b[0] * xi + c.b[1] * x1 + c.b[2] * x2 - c.a[0] * y1 - c.a[1] * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Sonoridad integrada APROXIMADA en LUFS: ponderacion K (BS.1770) y media cuadratica de toda la senal, SIN compuerta por bloques. Sirve para comparar. */
export function lufsAprox(m: Int16Array | Float32Array | Float64Array, hz: number): number {
  const x = aFlotante(m);
  if (x.length === 0) return -Infinity;
  // Etapa 1: estante alto (f0 1681.97 Hz, +4 dB). Etapa 2: pasa-altos (38.135 Hz, Q 0.5003). Coeficientes por transformada bilineal para cualquier tasa.
  const G = 3.999843853973347;
  const Q1 = 0.7071752369554196;
  const f1 = 1681.9744509555319;
  const K1 = Math.tan((Math.PI * f1) / hz);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K1 / Q1 + K1 * K1;
  const estante: Bicuad = {
    b: [(Vh + (Vb * K1) / Q1 + K1 * K1) / a0, (2 * (K1 * K1 - Vh)) / a0, (Vh - (Vb * K1) / Q1 + K1 * K1) / a0],
    a: [(2 * (K1 * K1 - 1)) / a0, (1 - K1 / Q1 + K1 * K1) / a0],
  };
  const Q2 = 0.5003270373253953;
  const f2 = 38.13547087613982;
  const K2 = Math.tan((Math.PI * f2) / hz);
  const a02 = 1 + K2 / Q2 + K2 * K2;
  const altos: Bicuad = { b: [1, -2, 1], a: [(2 * (K2 * K2 - 1)) / a02, (1 - K2 / Q2 + K2 * K2) / a02] };
  const y = filtrar(filtrar(x, estante), altos);
  let s = 0;
  for (let i = 0; i < y.length; i++) s += y[i]! * y[i]!;
  const ms = s / y.length;
  return ms <= 1e-18 ? -Infinity : -0.691 + 10 * Math.log10(ms);
}

/** FFT radix-2 en sitio. `re` e `im` de largo potencia de 2. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Fraccion (0..1) de la energia que cae entre `desdeHz` y `hastaHz` (promedio de ventanas Hann de 4096 muestras). 0 si no hay energia. */
export function fraccionEnergiaEnBanda(m: Int16Array | Float32Array | Float64Array, hz: number, desdeHz: number, hastaHz: number): number {
  const x = aFlotante(m);
  const N = 4096;
  let banda = 0;
  let total = 0;
  for (let ini = 0; ini + N <= x.length; ini += N) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[ini + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * hz) / N;
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      total += p;
      if (f >= desdeHz && f <= hastaHz) banda += p;
    }
  }
  return total === 0 ? 0 : banda / total;
}

/** Cuantas ventanas EXACTAMENTE iguales (mismos bytes) hay de `ventana` muestras sin traslape: 0 = ningun bloque se repite (no hay bucle). Ignora ventanas de puro silencio. */
export function ventanasRepetidas(m: Int16Array, ventana: number): number {
  const vistas = new Set<string>();
  let repetidas = 0;
  for (let ini = 0; ini + ventana <= m.length; ini += ventana) {
    const trozo = m.subarray(ini, ini + ventana);
    let hayAudio = false;
    for (let i = 0; i < trozo.length; i++) if (trozo[i] !== 0) { hayAudio = true; break; }
    if (!hayAudio) continue;
    const clave = Buffer.from(trozo.buffer, trozo.byteOffset, trozo.byteLength).toString("base64");
    if (vistas.has(clave)) repetidas++;
    else vistas.add(clave);
  }
  return repetidas;
}

/** Autocorrelacion normalizada maxima de la envolvente (RMS por bloques de `bloque` muestras) para retardos de `minRetardo`..`maxRetardo` bloques. Un bucle
 * de N segundos da un valor cercano a 1 en su retardo; un ambiente sin bucle se queda claramente por debajo. */
export function autocorrelacionEnvolvente(m: Int16Array | Float64Array, bloque: number, minRetardo: number, maxRetardo: number): number {
  const x = aFlotante(m);
  const env: number[] = [];
  for (let ini = 0; ini + bloque <= x.length; ini += bloque) env.push(rms(x.subarray(ini, ini + bloque)));
  const media = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const c = env.map((v) => v - media);
  const varianza = c.reduce((a, b) => a + b * b, 0);
  if (varianza === 0) return 0;
  let mejor = -1;
  for (let r = minRetardo; r <= Math.min(maxRetardo, c.length - 2); r++) {
    let s = 0;
    for (let i = 0; i + r < c.length; i++) s += c[i]! * c[i + r]!;
    mejor = Math.max(mejor, s / varianza);
  }
  return mejor;
}
