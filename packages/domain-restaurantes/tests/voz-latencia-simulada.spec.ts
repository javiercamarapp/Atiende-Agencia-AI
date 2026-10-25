// Latencia por turno en SIMULACION (sin llamadas pagadas): corre los 32 guiones de la prueba ciega + los 13 de paridad con el motor real, toma por turno del cliente
// las herramientas que corrieron y el tiempo de servidor medido, y le aplica el modelo de pasos del modelo de latencia-simulada.ts.
// IMPORTANTE: la latencia del MODELO (STT + LLM + TTS) es un SUPUESTO calibrado con medidas previas, NO una medicion de esta suite. Estas pruebas verifican la COHERENCIA del
// modelo y del conteo de herramientas por turno; no demuestran que un modelo real cumpla el objetivo de p95 <= 18 s (eso solo lo dice una llamada real, VOZ-ESTADO §5).
// Por eso NO hay un assert "p95 <= 18 s": con un supuesto como entrada seria casi tautologico. El tiempo de servidor solo tiene un tope holgado de cordura (no flaky en CI cargado).
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

describe("latencia por turno en simulacion (coherencia del modelo, no medicion del modelo real)", () => {
  it("el modelo de latencia es coherente con los turnos medidos: piso del servidor, orden entre motores, olas <= herramientas y determinismo", async () => {
    const turnos = await medirTodo();
    expect(turnos.length).toBeGreaterThan(60);
    const servidor = turnos.map((t) => t.servidorMs);
    const gemini = simularLatencias(turnos, PERFIL_GEMINI_LIVE, HERRAMIENTAS_VOZ_SOLO_LECTURA);
    const cascada = simularLatencias(turnos, PERFIL_CASCADA, HERRAMIENTAS_VOZ_SOLO_LECTURA);

    // Cada turno aporta las mismas muestras a los dos motores y ninguna latencia baja del piso fisico (viajes de red + servidor medido).
    expect(gemini).toHaveLength(cascada.length);
    expect(Math.min(...gemini)).toBeGreaterThan(Math.min(...servidor));
    // Las olas nunca superan las herramientas del turno; paralelizar lectura (Gemini) nunca da MAS olas que la cascada en serie.
    for (const t of turnos) {
      const olasG = olasDeHerramientas(t.nombres, HERRAMIENTAS_VOZ_SOLO_LECTURA, true);
      const olasC = olasDeHerramientas(t.nombres, HERRAMIENTAS_VOZ_SOLO_LECTURA, false);
      expect(t.nombres.length).toBe(t.herramientas);
      expect(olasG).toBeLessThanOrEqual(olasC);
      expect(olasC).toBeLessThanOrEqual(t.herramientas);
    }
    // Con los perfiles supuestos la cascada es mas lenta que Gemini Live en mediana y en cola (si esto se invierte, cambio el supuesto o el conteo de olas, no el modelo real).
    expect(percentil(cascada, 0.5)).toBeGreaterThan(percentil(gemini, 0.5));
    expect(percentil(cascada, 0.95)).toBeGreaterThan(percentil(gemini, 0.95));
    // Reproducible: misma semilla, mismas muestras.
    expect(simularLatencias(turnos, PERFIL_GEMINI_LIVE, HERRAMIENTAS_VOZ_SOLO_LECTURA)).toEqual(gemini);
    // Tope de cordura MUY holgado para el servidor en proceso (performance.now real): atrapa una regresion patologica sin ser flaky en un CI cargado. No es un SLO.
    expect(percentil(servidor, 0.95)).toBeLessThan(2_000);
  });

  it("peor caso por tope de timeouts (aritmetica sobre el perfil SUPUESTO): dos herramientas que agotan los 4 s caben en el objetivo con Gemini Live (la maquina pasa a una persona al segundo timeout)", () => {
    const peor = peorCasoPorTimeouts(LIMITES_POR_DEFECTO.timeoutsMax, PERFIL_GEMINI_LIVE, LIMITES_POR_DEFECTO.toolTimeoutMs);
    expect(LIMITES_POR_DEFECTO.timeoutsMax).toBe(2);
    expect(peor).toBeLessThanOrEqual(OBJETIVO_P95_TURNO_MS);
  });
});
