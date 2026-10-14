// MEZCLADOR de la salida de audio de la llamada: junta, trama a trama, la voz del agente (cola de audio PCM16 de 24 kHz), el ambiente de restaurante
// (`AmbienteRestaurante`) y el tecleo (`OrquestadorTecleo`) en UNA sola secuencia continua. Es PURO y dirigido por quien lo consume: `siguiente(n)` entrega
// las proximas n muestras (el worker de LiveKit lo llama cada 20 ms; la vista previa del panel, por trozos de ~100 ms; las pruebas, a mano).
//
// Reglas de mezcla (para que nada tape la voz):
//   * el ambiente BAJA mientras suena la voz del agente o habla el cliente (ducking suave, ver `Ducking`);
//   * el tecleo se calla mientras el agente habla (lo decide el orquestador con `fijarAgenteHablando`);
//   * la suma satura a PCM16 en vez de desbordar.
// `cortarAgente()` (barge-in) vacia la cola del agente y resuelve las promesas pendientes; el cliente que habla tambien corta el tecleo.
import { AmbienteRestaurante } from "./ambiente-restaurante.ts";
import type { OpcionesAmbiente } from "./ambiente-restaurante.ts";
import { OrquestadorTecleo } from "./tecleo.ts";
import type { OpcionesTecleo } from "./tecleo.ts";

export interface OpcionesMezclador {
  readonly hz?: number;
  readonly ambiente?: Omit<OpcionesAmbiente, "hz"> | null;
  readonly tecleo?: Omit<OpcionesTecleo, "hz"> | null;
}

interface TramoAgente {
  readonly muestras: Int16Array;
  pos: number;
  readonly listo: () => void;
}

export class MezcladorSalida {
  readonly hz: number;
  readonly ambiente: AmbienteRestaurante | null;
  readonly tecleo: OrquestadorTecleo | null;
  private cola: TramoAgente[] = [];
  private cliente = false;

  constructor(o: OpcionesMezclador = {}) {
    this.hz = o.hz ?? 24_000;
    const amb = o.ambiente ? new AmbienteRestaurante({ ...o.ambiente, hz: this.hz }) : null;
    const tec = o.tecleo ? new OrquestadorTecleo({ ...o.tecleo, hz: this.hz }) : null;
    this.ambiente = amb?.activo ? amb : null;
    this.tecleo = tec?.activo ? tec : null;
  }

  /** Hay algo que mezclar ademas de la voz (si no, el worker usa su camino de siempre, sin bombeo continuo). */
  get conEfectos(): boolean {
    return this.ambiente !== null || this.tecleo !== null;
  }

  /** Muestras de voz del agente que faltan por salir. */
  get pendientes(): number {
    return this.cola.reduce((a, t) => a + t.muestras.length - t.pos, 0);
  }

  get agenteHablando(): boolean {
    return this.cola.length > 0;
  }

  /** Encola audio del agente (PCM16 a la tasa del mezclador). Resuelve cuando ya salio entero o se corto. */
  encolarAgente(muestras: Int16Array): Promise<void> {
    if (muestras.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.cola.push({ muestras, pos: 0, listo: resolve });
    });
  }

  /** Barge-in: calla al agente y libera a quien esperaba su audio. */
  cortarAgente(): void {
    const tramos = this.cola;
    this.cola = [];
    for (const t of tramos) t.listo();
  }

  /** El cliente habla (o dejo de hablar): baja el ambiente; si empezo, corta el tecleo. */
  fijarClienteHablando(habla: boolean): void {
    this.cliente = habla;
    this.ambiente?.fijarClienteHablando(habla);
    if (habla) this.tecleo?.clienteHabla();
  }

  herramientaInicia(id: string): void {
    this.tecleo?.herramientaInicia(id);
  }

  herramientaTermina(id: string, ok = true): void {
    this.tecleo?.herramientaTermina(id, ok);
  }

  /** Las proximas `n` muestras de la salida (voz + ambiente + tecleo). Siempre devuelve exactamente n (silencio si no hay nada). */
  siguiente(n: number): Int16Array {
    const voz = new Int16Array(n);
    let i = 0;
    while (i < n && this.cola.length > 0) {
      const t = this.cola[0]!;
      const k = Math.min(n - i, t.muestras.length - t.pos);
      voz.set(t.muestras.subarray(t.pos, t.pos + k), i);
      t.pos += k;
      i += k;
      if (t.pos >= t.muestras.length) {
        this.cola.shift();
        t.listo();
      }
    }
    const hablaAgente = i > 0 || this.cola.length > 0;
    this.tecleo?.fijarAgenteHablando(hablaAgente);
    const salida = new Int16Array(n);
    const amb = this.ambiente ? this.ambiente.siguienteMuestras(n, voz) : null;
    const tec = this.tecleo ? this.tecleo.siguiente(n) : null;
    for (let j = 0; j < n; j++) {
      const suma = voz[j]! + (amb ? amb[j]! : 0) + (tec ? Math.round(tec[j]! * 32767) : 0);
      salida[j] = suma > 32767 ? 32767 : suma < -32768 ? -32768 : suma;
    }
    return salida;
  }

  /** Cliente hablando ahora (para el log/pruebas). */
  get clienteHablando(): boolean {
    return this.cliente;
  }
}
