// Recorte del silencio INICIAL de cada frase de TTS. Aura-2 antepone ~520-710 ms de silencio a cada sintesis (medido por REST; por WebSocket sin verificar): al sintetizar
// por frase eso suma ~0.65 s al primer audio y abre huecos entre frases. Se descarta lo que no pase de un umbral de energia (ventanas de 10 ms), con un tope y dejando un
// relleno antes de la voz para no comer el ataque de la primera palabra. Si el primer trozo trae una cabecera WAV ("RIFF"), se descartan sus 44 bytes.
// PCM16 mono little-endian. Puro y sin reloj.
export interface OpcionesRecorte {
  /** Energia RMS normalizada (0..1) desde la cual una ventana de 10 ms cuenta como voz. */
  readonly umbral: number;
  /** Tope de silencio que se descarta (ms); pasado ese tope se deja de recortar. */
  readonly maxMs: number;
  /** Silencio que se conserva antes del primer sonido (ms). */
  readonly rellenoMs: number;
}

export interface RecortadorInicial {
  /** Procesa un trozo y devuelve lo que ya se puede reproducir (`null` = todavia es silencio inicial). */
  procesar(bytes: Uint8Array): Uint8Array | null;
  /** Fin de la frase: entrega lo que quedaba en una ventana incompleta si tiene voz (una frase muy corta no se pierde). */
  terminar(): Uint8Array | null;
}

const ES_RIFF = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;

function rms(b: Uint8Array, desde: number, hasta: number): number {
  const n = Math.floor((hasta - desde) / 2);
  if (n <= 0) return 0;
  const v = new DataView(b.buffer, b.byteOffset + desde, n * 2);
  let suma = 0;
  for (let i = 0; i < n; i++) {
    const m = v.getInt16(i * 2, true) / 32768;
    suma += m * m;
  }
  return Math.sqrt(suma / n);
}

export function crearRecortadorInicial(o: OpcionesRecorte, hz: number): RecortadorInicial {
  const muestrasVentana = Math.max(1, Math.round(hz / 100));
  const ventana = muestrasVentana * 2;
  const maxBytes = Math.max(0, Math.round((hz * o.maxMs) / 1000)) * 2;
  const relleno = Math.max(0, Math.round((hz * o.rellenoMs) / 1000)) * 2;
  let primero = true;
  let pasando = false;
  let descartados = 0;
  let pendiente = new Uint8Array(0);
  return {
    procesar(entrada: Uint8Array): Uint8Array | null {
      let b = entrada;
      if (primero) {
        primero = false;
        if (ES_RIFF(b)) b = b.subarray(Math.min(44, b.length));
      }
      if (pasando) return b.length > 0 ? b : null;
      const data = new Uint8Array(pendiente.length + b.length);
      data.set(pendiente, 0);
      data.set(b, pendiente.length);
      pendiente = new Uint8Array(0);
      let pos = 0;
      while (pos + ventana <= data.length) {
        if (rms(data, pos, pos + ventana) >= o.umbral) {
          pasando = true;
          const inicio = Math.max(0, pos - relleno);
          const salida = data.subarray(inicio - (inicio % 2));
          return salida.length > 0 ? salida : null;
        }
        pos += ventana;
        descartados += ventana;
        if (descartados >= maxBytes) {
          // Tope alcanzado sin encontrar voz: no se recorta mas (mejor un hueco que perder el audio).
          pasando = true;
          const salida = data.subarray(pos);
          return salida.length > 0 ? salida : null;
        }
      }
      pendiente = data.slice(pos);
      return null;
    },
    terminar(): Uint8Array | null {
      if (pasando || pendiente.length < 2) return null;
      const resto = pendiente;
      pendiente = new Uint8Array(0);
      return rms(resto, 0, resto.length - (resto.length % 2)) >= o.umbral ? resto.subarray(0, resto.length - (resto.length % 2)) : null;
    },
  };
}
