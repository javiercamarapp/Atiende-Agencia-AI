// Bombeo de la salida de audio de UNA llamada con ambiente/tecleo: pide al `MezcladorSalida` una trama de `frameMs` (20 ms) tras otra y la entrega a la linea,
// SIN adelantarse mas de `adelantoMaxMs` al reloj (la cola del destino no crece sin limite y un barge-in corta rapido). El reloj, la espera y el destino se inyectan:
// las pruebas lo mueven a mano; LiveKit pasa `captureFrame` y `setTimeout`. Termina cuando `terminado()` es true.
import type { MezcladorSalida } from "@atiende/voice-core";

export interface OpcionesBombeo {
  readonly mezclador: MezcladorSalida;
  readonly enviar: (trama: Int16Array) => Promise<void>;
  readonly ahora: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  readonly terminado: () => boolean;
  readonly frameMs?: number;
  readonly adelantoMaxMs?: number;
}

export async function bombearSalida(o: OpcionesBombeo): Promise<number> {
  const frameMs = o.frameMs ?? 20;
  const adelantoMax = o.adelantoMaxMs ?? 200;
  const porTrama = Math.round((o.mezclador.hz * frameMs) / 1000);
  const inicio = o.ahora();
  let enviadas = 0;
  while (!o.terminado()) {
    await o.enviar(o.mezclador.siguiente(porTrama));
    enviadas++;
    const adelanto = enviadas * frameMs - (o.ahora() - inicio);
    if (adelanto > adelantoMax) await o.dormir(adelanto - adelantoMax / 2);
  }
  return enviadas;
}
