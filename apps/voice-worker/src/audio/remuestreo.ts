// Remuestreo PCM16 mono en flujo (por trozos) entre las tasas de la telefonia (8, 16 o 48 kHz) y las de los escalones de voz (16 kHz de entrada,
// 24 kHz de salida). Reduciendo la tasa promedia la ventana de entrada que cubre cada muestra de salida (anti-aliasing por area); subiendola
// interpola linealmente. Es suficiente para voz telefonica y no depende de ningun binario nativo: lo prueban los tests con energia y longitud.
//
// Un `Remuestreador` lleva estado (el resto de entrada que aun no completa una muestra de salida): se crea uno por direccion y por llamada.

export class Remuestreador {
  private readonly razon: number;
  private pendiente = new Float32Array(0);
  /** Indice absoluto (en la entrada) de `pendiente[0]`. */
  private base = 0;
  /** Indice de la proxima muestra de salida. */
  private siguiente = 0;

  constructor(
    readonly hzEntrada: number,
    readonly hzSalida: number,
  ) {
    if (!Number.isFinite(hzEntrada) || !Number.isFinite(hzSalida) || hzEntrada <= 0 || hzSalida <= 0) throw new RangeError("Remuestreador: tasas invalidas.");
    this.razon = hzEntrada / hzSalida;
  }

  /** Procesa un trozo y devuelve las muestras de salida que ya se pueden calcular. */
  procesar(trozo: Int16Array): Int16Array {
    if (this.hzEntrada === this.hzSalida) return trozo.slice();
    if (trozo.length > 0) {
      const junto = new Float32Array(this.pendiente.length + trozo.length);
      junto.set(this.pendiente);
      for (let i = 0; i < trozo.length; i++) junto[this.pendiente.length + i] = trozo[i] ?? 0;
      this.pendiente = junto;
    }
    const salida: number[] = [];
    const total = this.base + this.pendiente.length;
    const r = this.razon;
    for (;;) {
      if (r >= 1) {
        const ini = this.siguiente * r;
        const fin = (this.siguiente + 1) * r;
        if (Math.ceil(fin - 1e-9) > total) break;
        let suma = 0;
        let peso = 0;
        for (let i = Math.floor(ini + 1e-9); i < Math.ceil(fin - 1e-9); i++) {
          const w = Math.min(i + 1, fin) - Math.max(i, ini);
          if (w <= 0) continue;
          suma += (this.pendiente[i - this.base] ?? 0) * w;
          peso += w;
        }
        salida.push(peso > 0 ? suma / peso : 0);
      } else {
        const p = this.siguiente * r;
        const i0 = Math.floor(p);
        if (i0 + 1 >= total) break;
        const f = p - i0;
        const a = this.pendiente[i0 - this.base] ?? 0;
        const b = this.pendiente[i0 + 1 - this.base] ?? 0;
        salida.push(a + (b - a) * f);
      }
      this.siguiente += 1;
    }
    // Descarta lo que ya nunca se vuelve a leer.
    const desde = Math.max(this.base, Math.floor(this.siguiente * r + 1e-9));
    if (desde > this.base) {
      this.pendiente = this.pendiente.slice(Math.min(desde - this.base, this.pendiente.length));
      this.base = desde;
    }
    const resultado = new Int16Array(salida.length);
    for (let i = 0; i < salida.length; i++) resultado[i] = Math.max(-32768, Math.min(32767, Math.round(salida[i] ?? 0)));
    return resultado;
  }
}

/** Remuestreo de un buffer completo (pregrabados, pruebas). */
export function remuestrearPcm16(entrada: Int16Array, hzEntrada: number, hzSalida: number): Int16Array {
  const r = new Remuestreador(hzEntrada, hzSalida);
  return r.procesar(entrada);
}
