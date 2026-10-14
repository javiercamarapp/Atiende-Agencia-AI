// Bombeo de la salida de audio de UNA llamada con ambiente/tecleo: pide al `MezcladorSalida` una trama de `frameMs` (20 ms) tras otra y la entrega a la linea.
// El ritmo lo manda la COLA REAL del destino (`colaMs`, en LiveKit `AudioSource.queuedDuration`), no el reloj de pared: se rellena solo cuando la cola baja de
// `objetivoMaxMs` y se duerme hasta dejarla en `objetivoMinMs`. Asi la cola queda en ~40-80 ms (esa es la latencia que el bombeo anade a cada respuesta y el retraso
// del barge-in), un hilo bloqueado no deja una cola larga para el resto de la llamada y, tras un `clearQueue`, el hueco se rellena de inmediato.
// Todo se inyecta (cola, espera, destino, fin): las pruebas lo mueven a mano; LiveKit pasa `captureFrame`, `queuedDuration` y `setTimeout`.
import type { MezcladorSalida } from "@atiende/voice-core";

export const COLA_OBJETIVO_MIN_MS = 40;
export const COLA_OBJETIVO_MAX_MS = 80;

export interface OpcionesBombeo {
  readonly mezclador: MezcladorSalida;
  readonly enviar: (trama: Int16Array) => Promise<void>;
  /** Milisegundos de audio que el destino tiene encolados sin reproducir. */
  readonly colaMs: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  readonly terminado: () => boolean;
  readonly frameMs?: number;
  readonly objetivoMinMs?: number;
  readonly objetivoMaxMs?: number;
  /** Se llama cuando la voz del agente EMPIEZA a entrar a la salida, con la cola (ms) que tenia el destino: es el retraso que el bombeo anade a esa respuesta. */
  readonly alTomarVoz?: (colaMs: number) => void;
}

export async function bombearSalida(o: OpcionesBombeo): Promise<number> {
  const frameMs = o.frameMs ?? 20;
  const minMs = o.objetivoMinMs ?? COLA_OBJETIVO_MIN_MS;
  const maxMs = o.objetivoMaxMs ?? COLA_OBJETIVO_MAX_MS;
  const porTrama = Math.round((o.mezclador.hz * frameMs) / 1000);
  let enviadas = 0;
  let vozAntes = false;
  while (!o.terminado()) {
    const cola = o.colaMs();
    if (cola >= maxMs) {
      await o.dormir(Math.max(1, cola - minMs));
      continue;
    }
    const hayVoz = o.mezclador.agenteHablando;
    if (hayVoz && !vozAntes) o.alTomarVoz?.(cola);
    vozAntes = hayVoz;
    await o.enviar(o.mezclador.siguiente(porTrama));
    enviadas++;
  }
  return enviadas;
}

/** Como `bombearSalida`, pero un fallo (del destino o del mezclador) NO se traga: se avisa con un codigo corto SIN PII para que la llamada vuelva al audio sin mezcla. */
export async function bombearConRespaldo(o: OpcionesBombeo & { readonly alFallo: (codigo: string) => void }): Promise<void> {
  try {
    await bombearSalida(o);
  } catch (err) {
    o.alFallo(err instanceof Error ? err.name.slice(0, 40) || "Error" : "Error");
  }
}
