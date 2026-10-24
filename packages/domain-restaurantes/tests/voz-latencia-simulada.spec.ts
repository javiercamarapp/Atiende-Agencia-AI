// Latencia por turno medida en SIMULACION (sin llamadas pagadas): corre los 32 guiones de la prueba ciega + los 13 de paridad con el motor real, toma por turno del
// cliente las herramientas que corrieron y el tiempo de servidor medido, y le aplica el modelo de pasos del modelo (supuesto calibrado, ver latencia-simulada.ts).
// Objetivo: p95 por turno <= 18 s. Lo que NO mide: STT/TTS/modelo reales (solo una llamada real).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERRAMIENTAS_VOZ_SOLO_LECTURA } from "../src/voz/llamada/ejecutor-tools.ts";
import { LIMITES_POR_DEFECTO } from "../src/voz/llamada/maquina.ts";
import { ESCENARIOS_PARIDAD, correrEscenario } from "../src/voz/simulador/guiones-paridad.ts";
import type { EscenarioVoz, TurnoMedido } from "../src/voz/simulador/guiones-paridad.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";
import { OBJETIVO_P95_TURNO_MS, PERFIL_CASCADA, PERFIL_GEMINI_LIVE, olasDeHerramientas, peorCasoPorTimeouts, percentil, simularLatencias } from "../src/voz/simulador/latencia-simulada.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

const PRUEBA_CIEGA: readonly EscenarioVoz[] = GUIONES_ES_MX.map((guion) => ({ guion, ahora: "2026-10-07T12:00:00-06:00" }));

async function medirTodo(): Promise<TurnoMedido[]> {
  const todos: TurnoMedido[] = [];
  for (const esc of [...PRUEBA_CIEGA, ...ESCENARIOS_PARIDAD]) {
    vi.setSystemTime(new Date(esc.ahora));
    todos.push(...(await correrEscenario(esc)).turnos);
  }
  return todos;
}

describe("latencia por turno en simulacion", () => {
  it("Gemini Live: p95 por turno <= 18 s; la cascada se reporta (y su peor turno) sin ser el motor de PM", async () => {
    const turnos = await medirTodo();
    expect(turnos.length).toBeGreaterThan(60);
    const servidor = turnos.map((t) => t.servidorMs);
    const gemini = simularLatencias(turnos, PERFIL_GEMINI_LIVE, HERRAMIENTAS_VOZ_SOLO_LECTURA);
    const cascada = simularLatencias(turnos, PERFIL_CASCADA, HERRAMIENTAS_VOZ_SOLO_LECTURA);
    const maxHerr = Math.max(...turnos.map((t) => t.herramientas));
    const maxOlasG = Math.max(...turnos.map((t) => olasDeHerramientas(t.nombres, HERRAMIENTAS_VOZ_SOLO_LECTURA, true)));
    console.log(
      `[latencia-voz] turnos=${turnos.length} servidor(medido) p50=${percentil(servidor, 0.5).toFixed(1)}ms p95=${percentil(servidor, 0.95).toFixed(1)}ms max=${Math.max(...servidor).toFixed(1)}ms | herramientas/turno max=${maxHerr}, olas max (gemini)=${maxOlasG}\n` +
        `[latencia-voz] gemini-live p50=${(percentil(gemini, 0.5) / 1000).toFixed(1)}s p95=${(percentil(gemini, 0.95) / 1000).toFixed(1)}s | cascada p50=${(percentil(cascada, 0.5) / 1000).toFixed(1)}s p95=${(percentil(cascada, 0.95) / 1000).toFixed(1)}s (objetivo p95 <= ${OBJETIVO_P95_TURNO_MS / 1000}s)`,
    );
    // El motor real de pedidos en proceso es despreciable frente al modelo: el presupuesto lo gastan los pasos del modelo y los viajes de red.
    expect(percentil(servidor, 0.95)).toBeLessThan(250);
    expect(percentil(gemini, 0.95)).toBeLessThanOrEqual(OBJETIVO_P95_TURNO_MS);
  });

  it("peor caso por tope de timeouts: dos herramientas que agotan los 4 s caben en el objetivo con Gemini Live (la maquina pasa a una persona al segundo timeout)", () => {
    const peor = peorCasoPorTimeouts(LIMITES_POR_DEFECTO.timeoutsMax, PERFIL_GEMINI_LIVE, LIMITES_POR_DEFECTO.toolTimeoutMs);
    expect(LIMITES_POR_DEFECTO.timeoutsMax).toBe(2);
    expect(peor).toBeLessThanOrEqual(OBJETIVO_P95_TURNO_MS);
  });
});
