// Agregacion de metricas por turno/llamada y percentiles. Puro.
export const pct = (xs: readonly number[], p: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]!;
};

/** Un turno del cliente con audio real. Tiempos en ms; null si no ocurrio (sin final del STT o el agente no hablo). */
export interface TurnoAudio {
  readonly dicho: string;
  readonly oido: string;
  readonly audioS: number;
  readonly sttMs: number | null;       // fin de voz del cliente -> primer final del STT (incluye el endpointing)
  readonly llmMs: number | null;       // final del STT -> primera frase del agente entregada al TTS
  readonly ttsMs: number | null;       // primera frase -> primer audio del TTS
  readonly totalMs: number | null;     // fin de voz del cliente -> primer audio del agente
  readonly finales: number;            // cuantos finales (speech_final) entrego el STT para este turno
  readonly wer: { s: number; d: number; i: number; n: number };
  readonly numeros: { n: number; errores: number };
  readonly terminos: { n: number; errores: number };
  readonly direccion: boolean;
}

const suma = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export function resumenTurnos(ts: readonly TurnoAudio[]) {
  const num = (f: (t: TurnoAudio) => number | null) => ts.map(f).filter((x): x is number => typeof x === "number");
  const N = suma(ts.map((t) => t.wer.n));
  const E = suma(ts.map((t) => t.wer.s + t.wer.d + t.wer.i));
  const dir = ts.filter((t) => t.direccion);
  const Nd = suma(dir.map((t) => t.wer.n)); const Ed = suma(dir.map((t) => t.wer.s + t.wer.d + t.wer.i));
  return {
    turnos: ts.length,
    sinFinal: ts.filter((t) => t.sttMs === null).length,
    werGlobal: N ? E / N : null, werDireccion: Nd ? Ed / Nd : null, turnosDireccion: dir.length,
    numerosN: suma(ts.map((t) => t.numeros.n)), numerosErrores: suma(ts.map((t) => t.numeros.errores)),
    terminosN: suma(ts.map((t) => t.terminos.n)), terminosErrores: suma(ts.map((t) => t.terminos.errores)),
    sttP50: pct(num((t) => t.sttMs), 0.5), sttP95: pct(num((t) => t.sttMs), 0.95),
    llmP50: pct(num((t) => t.llmMs), 0.5), ttsP50: pct(num((t) => t.ttsMs), 0.5), ttsP95: pct(num((t) => t.ttsMs), 0.95),
    totalP50: pct(num((t) => t.totalMs), 0.5), totalP95: pct(num((t) => t.totalMs), 0.95),
  };
}
