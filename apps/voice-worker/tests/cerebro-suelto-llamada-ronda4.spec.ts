// Ronda 4 (P2-d): carrera despedida/colgado. La despedida con pedido es un cierre BLANDO: tras vaciarla hay una gracia antes de colgar, y si el cliente habla
// en ella («ah, y agrega una coca») la llamada no se cuelga. Los cierres duros siguen colgando al instante.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";
import { Worker } from "../src/worker.ts";
import { GRACIA_DESPEDIDA_MS, RUIDO_SIN_TEXTO_MS } from "../src/llamada.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function montar(respuesta: (seq: number) => Record<string, unknown>) {
  const api = await crearMundoApi();
  const telefonia = new TelefoniaFalsa();
  const cuerpos: { seq: number; texto: string }[] = [];
  const fetchSuelto = (async (_u: string, init?: RequestInit) => {
    const c = JSON.parse(String(init?.body));
    cuerpos.push(c);
    return new Response(JSON.stringify({ fin: false, turno: c.seq, ...respuesta(c.seq) }), { status: 200 });
  }) as unknown as typeof fetch;
  let llm: PuertoLlmVoz | null = null;
  let decir: ((t: string) => Promise<void>) | null = null;
  const escalon = {
    id: "cascada-v2" as const,
    abrirSesion: async (_a: unknown, h: { agenteDijo(t: string): void; agenteTermino(): void }) => {
      decir = async (texto: string) => {
        const r = await llm!.completar({ system: "", mensajes: [{ role: "user", content: texto }], herramientas: [] });
        h.agenteDijo(r.texto);
        h.agenteTermino();
      };
      return { enviarTexto: (t: string) => void decir!(t), interrumpir: () => undefined, cerrar: async () => undefined };
    },
  };
  const tareas: { fn: () => void; ms: number; cancelada: boolean }[] = [];
  const worker = new Worker({
    config: api.config,
    telefonia,
    log: () => undefined,
    deps: api.depsAtencion({
      programar: (fn, ms) => { const t = { fn, ms, cancelada: false }; tareas.push(t); return () => { t.cancelada = true; }; },
      crearEscalera: (ctx) => { llm = ctx?.llmVoz ?? null; return crearEscaleraLlamada([escalon as never], { ahora: api.reloj.ahora }); },
      cerebroSuelto: { url: "https://x.invalid/functions/v1/voz-turno", secreto: "s", aviso: null, fetchFn: fetchSuelto, esperar: async () => undefined },
    }),
  });
  expect(await worker.iniciar()).toBe(true);
  const antes = worker.salud().llamadasAtendidas;
  const llamada = telefonia.llamar({ id: "llamada-gracia-1", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
  await vi.waitFor(() => expect(cuerpos).toHaveLength(1), { timeout: 5_000, interval: 5 });
  return { worker, antes, llamada, cuerpos, tareas, decir: (t: string) => decir!(t) };
}

const DESPEDIDA = { texto: "Listo, su pedido quedó registrado. Gracias, buen provecho.", pedido_id: "ped_7" };
const VOZ = (ms: number) => new Int16Array((8000 * ms) / 1000).fill(20000);
const SILENCIO = (ms: number) => new Int16Array((8000 * ms) / 1000);
const gracia = (tareas: { fn: () => void; ms: number; cancelada: boolean }[]) => tareas.filter((t) => t.ms === GRACIA_DESPEDIDA_MS);
const respuestas = (seq: number): Record<string, unknown> => (seq === 0 ? { texto: "Buen día.", pedido_id: null } : seq === 1 ? DESPEDIDA : { texto: "Agregué la coca.", pedido_id: "ped_7" });

describe("despedida con pedido: gracia antes de colgar (P2-d)", () => {
  it("no cuelga al instante: tras vaciar la despedida programa el colgado ~1.8 s despues, y al vencer cuelga", async () => {
    const { worker, antes, tareas, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    expect(worker.salud().llamadasAtendidas).toBe(antes); // sigue en curso durante la gracia
    gracia(tareas)[0]!.fn();
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  });

  it("el cliente dice «ah, y agrega una coca» durante la gracia: el cerebro reabre, se cancela el colgado y la llamada sigue", async () => {
    const { worker, antes, tareas, cuerpos, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    await decir("ah, y agrega una coca");
    expect(cuerpos.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(gracia(tareas)[0]!.cancelada).toBe(true);
    gracia(tareas)[0]!.fn(); // aunque el temporizador dispare, ya no cuelga
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.salud().llamadasAtendidas).toBe(antes);
  });

  it("el cliente empieza a hablar (voz en el puente) durante la gracia: no se cuelga aunque venza el temporizador", async () => {
    const { worker, antes, tareas, llamada, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    llamada.hablar(new Int16Array(1600).fill(20000), 8000); // 200 ms de voz fuerte
    await new Promise((r) => setTimeout(r, 20));
    gracia(tareas)[0]!.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.salud().llamadasAtendidas).toBe(antes);
  });

  it("un cierre duro (fin del servidor) sigue colgando al instante, sin gracia", async () => {
    const { worker, antes, tareas, decir } = await montar((seq) => (seq === 0 ? { texto: "Buen día.", pedido_id: null } : { texto: "Hasta luego.", pedido_id: null, fin: true }));
    await decir("adios");
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
    expect(gracia(tareas)).toHaveLength(0);
  });
});

describe("ruido sobre la gracia sin texto final (ronda 5, P2-3)", () => {
  it("el ruido cancela la gracia pero, si en ~3 s no llega texto final, se reprograma el colgado y la llamada termina (no espera los 20 s)", async () => {
    const { worker, antes, tareas, llamada, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    llamada.hablar(VOZ(200), 8000); // ruido: voz en el puente pero nunca llega texto final
    expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS)).toHaveLength(0); // mientras hay voz no corre ningun plazo
    llamada.hablar(SILENCIO(600), 8000); // el cliente calla de verdad
    await vi.waitFor(() => expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS && !t.cancelada)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    gracia(tareas)[0]!.fn(); // la gracia vieja ya no cuelga (la anulo el ruido)
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.salud().llamadasAtendidas).toBe(antes);
    tareas.find((t) => t.ms === RUIDO_SIN_TEXTO_MS)!.fn(); // vencen los ~3 s sin texto
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(2), { timeout: 5_000, interval: 5 });
    expect(worker.salud().llamadasAtendidas).toBe(antes); // sigue la gracia nueva
    gracia(tareas)[1]!.fn();
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  });

  it("si tras el ruido llega texto final que reabre la llamada, el reintento de colgado no cuelga", async () => {
    const { worker, antes, tareas, llamada, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    llamada.hablar(VOZ(200), 8000);
    llamada.hablar(SILENCIO(600), 8000);
    await vi.waitFor(() => expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    await decir("ah, y agrega una coca"); // el cerebro reabre
    tareas.find((t) => t.ms === RUIDO_SIN_TEXTO_MS)!.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(gracia(tareas)).toHaveLength(1);
    expect(worker.salud().llamadasAtendidas).toBe(antes);
  });

  it("P1 ronda 6: una frase continua de 6 s sobre la gracia sin texto final NO cuelga mientras dura la voz; solo tras el silencio real", async () => {
    const { worker, antes, tareas, llamada, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    for (let i = 0; i < 30; i++) llamada.hablar(VOZ(200), 8000); // 6 s seguidos de voz
    // Ningun plazo de ruido ni gracia nueva mientras el cliente sigue hablando, y aunque venza todo lo viejo, no cuelga.
    expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS && !t.cancelada)).toHaveLength(0);
    for (const t of tareas.filter((x) => x.ms === GRACIA_DESPEDIDA_MS || x.ms === RUIDO_SIN_TEXTO_MS)) t.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(gracia(tareas).filter((t) => !t.cancelada)).toHaveLength(0);
    expect(worker.salud().llamadasAtendidas).toBe(antes);
    llamada.hablar(SILENCIO(600), 8000); // termina de hablar
    await vi.waitFor(() => expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS && !t.cancelada)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    tareas.find((t) => t.ms === RUIDO_SIN_TEXTO_MS && !t.cancelada)!.fn();
    await vi.waitFor(() => expect(gracia(tareas).filter((t) => !t.cancelada)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    gracia(tareas).find((t) => !t.cancelada)!.fn();
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  });

  it("P1 ronda 6: si el cliente vuelve a hablar tras el silencio, el plazo en curso no cuelga", async () => {
    const { worker, antes, tareas, llamada, decir } = await montar(respuestas);
    await decir("confirmo");
    await vi.waitFor(() => expect(gracia(tareas)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    llamada.hablar(VOZ(200), 8000);
    llamada.hablar(SILENCIO(600), 8000);
    await vi.waitFor(() => expect(tareas.filter((t) => t.ms === RUIDO_SIN_TEXTO_MS)).toHaveLength(1), { timeout: 5_000, interval: 5 });
    llamada.hablar(VOZ(200), 8000); // retoma la frase
    for (const t of tareas.filter((x) => x.ms === GRACIA_DESPEDIDA_MS || x.ms === RUIDO_SIN_TEXTO_MS)) t.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(gracia(tareas).filter((t) => !t.cancelada)).toHaveLength(0);
    expect(worker.salud().llamadasAtendidas).toBe(antes);
  });
});
