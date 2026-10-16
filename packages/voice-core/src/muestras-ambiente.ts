// Muestras de AUDIO para que una persona escuche el ambiente y el tecleo (el desarrollo no puede oir): arma, con el MISMO mezclador de la llamada, una linea de
// tiempo (voz del agente, herramientas en vuelo, el cliente que habla) y devuelve el audio mezclado, la voz sola y las metricas objetivas. Puro: la E/S
// (sintesis de la voz de ejemplo, escritura de archivos) vive en `scripts/voz-muestras-ambiente/`.
import { PRESETS_AMBIENTE } from "./ambiente-restaurante.ts";
import type { PresetAmbiente } from "./ambiente-restaurante.ts";
import { aDbfs, lufsAprox, muestrasRecortadas, pico, rms, ventanasRepetidas } from "./analisis-audio.ts";
import { MezcladorSalida } from "./mezclador-salida.ts";
import { PRESET_RESTAURANTE_HUMANO } from "./preset-restaurante-humano.ts";

export const HZ_MUESTRA = 24_000;

export type TipoMuestra = "ambiente" | "ambiente-tecleo" | "voz-ambiente-tecleo";
export const TIPOS_MUESTRA: readonly TipoMuestra[] = ["ambiente", "ambiente-tecleo", "voz-ambiente-tecleo"];

export interface OpcionesMuestra {
  readonly preset: PresetAmbiente;
  readonly tipo: TipoMuestra;
  readonly segundos?: number;
  readonly semilla?: number;
  /** Porcentaje de plena escala del ambiente (por omision el del preset restaurante-humano). */
  readonly volumenFondo?: number;
  /** Porcentaje del tecleo (por omision 12). */
  readonly volumenTecleo?: number;
  /** Frases de la voz del agente (PCM16 mono a 24 kHz), en el orden de la linea de tiempo; si faltan en `voz-ambiente-tecleo` se usa una voz sintetica de prueba. */
  readonly frases?: readonly Int16Array[];
}

export interface EventoMuestra {
  readonly t: number;
  readonly que: string;
}

export interface ResultadoMuestra {
  readonly pcm: Int16Array;
  /** Solo la voz del agente (sin ambiente ni tecleo), para medir la relacion voz/ambiente. */
  readonly voz: Int16Array;
  readonly eventos: readonly EventoMuestra[];
  readonly hz: number;
}

interface Herramienta {
  readonly desde: number;
  readonly hasta: number;
}

/** Linea de tiempo (segundos) de cada tipo de muestra. */
function lineaDeTiempo(tipo: TipoMuestra): { herramientas: Herramienta[]; frasesEn: number[]; clienteHabla: Herramienta[] } {
  if (tipo === "ambiente") return { herramientas: [], frasesEn: [], clienteHabla: [] };
  if (tipo === "ambiente-tecleo") return { herramientas: [{ desde: 3, hasta: 4.2 }, { desde: 8, hasta: 11 }, { desde: 14.5, hasta: 17.5 }], frasesEn: [], clienteHabla: [{ desde: 16.2, hasta: 16.8 }] };
  // Voz: saludo, el cliente pide, «déjeme anotarlo» con la herramienta en vuelo, resultado, y una segunda herramienta cortada por el cliente (barge-in)
  return {
    herramientas: [{ desde: 8.4, hasta: 12.2 }, { desde: 16, hasta: 19 }],
    frasesEn: [0.8, 8.4, 12.6],
    clienteHabla: [{ desde: 4.8, hasta: 7 }, { desde: 17.4, hasta: 18.2 }],
  };
}

/** Voz sintetica de prueba (zumbido con formantes y silabas), solo para pruebas o si no hay voz de ejemplo: NO pretende sonar humana. */
export function vozSinteticaDePrueba(ms: number, hz = HZ_MUESTRA): Int16Array {
  const n = Math.round((ms / 1000) * hz);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const silaba = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * 150 * h * t) / h;
    out[i] = Math.round(s * silaba * 4000);
  }
  return out;
}

export function renderizarMuestra(o: OpcionesMuestra): ResultadoMuestra {
  if (!(PRESETS_AMBIENTE as readonly string[]).includes(o.preset)) throw new RangeError(`preset desconocido: ${String(o.preset)}`);
  if (!TIPOS_MUESTRA.includes(o.tipo)) throw new RangeError(`tipo de muestra desconocido: ${String(o.tipo)}`);
  const segundos = o.segundos ?? 18;
  if (!Number.isFinite(segundos) || segundos < 1 || segundos > 120) throw new RangeError("segundos: entre 1 y 120");
  const m = new MezcladorSalida({
    hz: HZ_MUESTRA,
    ambiente: { volumen: o.volumenFondo ?? PRESET_RESTAURANTE_HUMANO.fondo.volumen, preset: o.preset, semilla: o.semilla ?? 1 },
    ...(o.tipo === "ambiente" ? {} : { tecleo: { volumen: o.volumenTecleo ?? 12, semilla: (o.semilla ?? 1) + 1000 } }),
  });
  const linea = lineaDeTiempo(o.tipo);
  const total = Math.round(segundos * HZ_MUESTRA);
  const trama = 480; // 20 ms
  const pcm = new Int16Array(total);
  const voz = new Int16Array(total);
  const eventos: EventoMuestra[] = [];
  const frases = linea.frasesEn.map((_, i) => o.frases?.[i] ?? vozSinteticaDePrueba(2200));
  let proxFrase = 0;
  const idsEnVuelo = new Map<number, string>();
  const clienteActivo = { v: false };
  let vozPos = 0;
  const ventanaVoz: Int16Array[] = [];
  for (let i = 0; i < total; i += trama) {
    const t = i / HZ_MUESTRA;
    const n = Math.min(trama, total - i);
    while (proxFrase < linea.frasesEn.length && t >= linea.frasesEn[proxFrase]!) {
      void m.encolarAgente(frases[proxFrase]!);
      ventanaVoz.push(frases[proxFrase]!);
      eventos.push({ t: linea.frasesEn[proxFrase]!, que: `el agente habla (frase ${proxFrase + 1})` });
      proxFrase++;
    }
    linea.herramientas.forEach((h, k) => {
      if (t >= h.desde && !idsEnVuelo.has(k) && t < h.hasta) {
        idsEnVuelo.set(k, `h${k}`);
        m.herramientaInicia(`h${k}`);
        eventos.push({ t: h.desde, que: `herramienta ${k + 1} inicia` });
      } else if (t >= h.hasta && idsEnVuelo.get(k) !== "fin" && idsEnVuelo.has(k)) {
        m.herramientaTermina(`h${k}`, true);
        idsEnVuelo.set(k, "fin");
        eventos.push({ t: h.hasta, que: `herramienta ${k + 1} termina` });
      }
    });
    const habla = linea.clienteHabla.some((c) => t >= c.desde && t < c.hasta);
    if (habla !== clienteActivo.v) {
      clienteActivo.v = habla;
      m.fijarClienteHablando(habla);
      eventos.push({ t, que: habla ? "el cliente habla (baja el ambiente y se corta el tecleo)" : "el cliente calla" });
      if (habla) {
        m.cortarAgente();
        ventanaVoz.length = 0;
        vozPos = 0;
      }
    }
    const antes = m.pendientes;
    const mezcla = m.siguiente(n);
    pcm.set(mezcla.subarray(0, n), i);
    // La voz sola: lo que salio de la cola del agente en esta trama (la mezcla menos ambiente/tecleo no se puede separar, asi que se lleva la cuenta aparte).
    const salio = Math.min(antes, n);
    if (salio > 0) {
      let faltan = salio;
      while (faltan > 0 && ventanaVoz.length > 0) {
        const f = ventanaVoz[0]!;
        const k = Math.min(faltan, f.length - vozPos);
        voz.set(f.subarray(vozPos, vozPos + k), i + (salio - faltan));
        vozPos += k;
        faltan -= k;
        if (vozPos >= f.length) {
          ventanaVoz.shift();
          vozPos = 0;
        }
      }
    }
  }
  return { pcm, voz, eventos, hz: HZ_MUESTRA };
}

export interface MetricasMuestra {
  readonly duracionS: number;
  readonly rmsDbfs: number;
  readonly lufsAprox: number;
  readonly picoDbfs: number;
  readonly muestrasRecortadas: number;
  /** Ventanas de 1 s identicas (0 = sin bucle). */
  readonly ventanasRepetidas: number;
  /** Voz del agente contra el resto (ambiente + tecleo) en dB durante las frases; null si no hay voz. */
  readonly vozSobreAmbienteDb: number | null;
}

function medir(pcm: Int16Array, voz: Int16Array, resto: Int16Array, hz: number): MetricasMuestra {
  let vozE = 0;
  let restoE = 0;
  let n = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (voz[i] !== 0) {
      const v = voz[i]! / 32768;
      const r = resto[i]! / 32768;
      vozE += v * v;
      restoE += r * r;
      n++;
    }
  }
  return {
    duracionS: pcm.length / hz,
    rmsDbfs: aDbfs(rms(pcm)),
    lufsAprox: lufsAprox(pcm, hz),
    picoDbfs: aDbfs(pico(pcm)),
    muestrasRecortadas: muestrasRecortadas(pcm),
    ventanasRepetidas: ventanasRepetidas(pcm, hz),
    vozSobreAmbienteDb: n === 0 || restoE === 0 ? null : 10 * Math.log10(vozE / n / (restoE / n)),
  };
}

/** Medidas de la muestra tal como sale del mezclador (24 kHz, banda ancha). */
export function medirMuestra(r: ResultadoMuestra): MetricasMuestra {
  const resto = Int16Array.from(r.pcm, (v, i) => v - r.voz[i]!);
  return medir(r.pcm, r.voz, resto, r.hz);
}

/** Medidas de la muestra COMO LA OYE EL CLIENTE POR TELEFONO (8 kHz, 300-3400 Hz, mu-law): se pasan a telefono la mezcla, la voz sola y el resto por separado (aproximado: la compresion mu-law no es lineal). */
export function medirTelefono(r: ResultadoMuestra): MetricasMuestra {
  const resto = Int16Array.from(r.pcm, (v, i) => v - r.voz[i]!);
  return medir(aTelefono(r.pcm, r.hz), aTelefono(r.voz, r.hz), aTelefono(resto, r.hz), 8000);
}

// ---- WAV y version «telefono» ----

/** WAV PCM16 mono. */
export function escribirWav16(pcm: Int16Array, hz: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const txt = (o: number, s: string): void => void [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  txt(8, "WAVE");
  txt(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, hz, true);
  v.setUint32(28, hz * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  txt(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/** Lee un WAV PCM16 mono (el que produce `say --data-format=LEI16`); falla en voz alta con otro formato. */
export function leerWav16(bytes: Uint8Array): { pcm: Int16Array; hz: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const txt = (o: number, n: number): string => String.fromCharCode(...bytes.subarray(o, o + n));
  if (bytes.byteLength < 44 || txt(0, 4) !== "RIFF" || txt(8, 4) !== "WAVE") throw new Error("wav_invalido");
  let pos = 12;
  let hz = 0;
  while (pos + 8 <= bytes.byteLength) {
    const id = txt(pos, 4);
    const tam = v.getUint32(pos + 4, true);
    if (id === "fmt ") {
      if (v.getUint16(pos + 8, true) !== 1 || v.getUint16(pos + 10, true) !== 1 || v.getUint16(pos + 22, true) !== 16) throw new Error("wav_no_es_pcm16_mono");
      hz = v.getUint32(pos + 12, true);
    } else if (id === "data") {
      const n = Math.floor(Math.min(tam, bytes.byteLength - pos - 8) / 2);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = v.getInt16(pos + 8 + i * 2, true);
      return { pcm, hz };
    }
    pos += 8 + tam + (tam % 2);
  }
  throw new Error("wav_sin_datos");
}

/** Remuestreo lineal sencillo (basta para muestras de escucha). */
export function remuestrearLineal(pcm: Int16Array, hzEntrada: number, hzSalida: number): Int16Array {
  if (hzEntrada === hzSalida) return pcm;
  const n = Math.floor((pcm.length * hzSalida) / hzEntrada);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * hzEntrada) / hzSalida;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = Math.round(pcm[i0]! * (1 - f) + (pcm[Math.min(i0 + 1, pcm.length - 1)] ?? 0) * f);
  }
  return out;
}

function mulawIda(x: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const s = x < 0 ? 0x80 : 0;
  const m = Math.min(Math.abs(x), CLIP) + BIAS;
  let exp = 7;
  for (let mask = 0x4000; (m & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mant = (m >> (exp + 3)) & 0x0f;
  return ~(s | (exp << 4) | mant) & 0xff;
}
function mulawVuelta(b: number): number {
  b = ~b & 0xff;
  const sign = b & 0x80;
  const exp = (b >> 4) & 7;
  const mant = b & 0x0f;
  const m = (((mant << 3) + 0x84) << exp) - 0x84;
  return sign ? -m : m;
}

/** Como lo oye el cliente por telefono: pasa-banda 300-3400 Hz, 8 kHz y compresion mu-law (G.711) ida y vuelta. */
export function aTelefono(pcm24k: Int16Array, hz = HZ_MUESTRA): Int16Array {
  const x = Float64Array.from(pcm24k, (v) => v);
  const pasoBajo = (entrada: Float64Array, corte: number): Float64Array => {
    const a = 1 - Math.exp((-2 * Math.PI * corte) / hz);
    const y = new Float64Array(entrada.length);
    let p = 0;
    for (let i = 0; i < entrada.length; i++) y[i] = p += a * (entrada[i]! - p);
    return y;
  };
  let b: Float64Array = x;
  for (let k = 0; k < 3; k++) b = pasoBajo(b, 3400);
  let altos: Float64Array = b;
  for (let k = 0; k < 2; k++) {
    const lp = pasoBajo(altos, 300);
    altos = Float64Array.from(altos, (v, i) => v - lp[i]!);
  }
  const a8 = remuestrearLineal(Int16Array.from(altos, (v) => Math.max(-32768, Math.min(32767, Math.round(v)))), hz, 8000);
  return Int16Array.from(a8, (v) => mulawVuelta(mulawIda(v)));
}
