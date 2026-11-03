// Ronda 4 (P2-d): carrera despedida/colgado. La despedida con pedido es un cierre BLANDO: tras vaciarla hay una gracia antes de colgar, y si el cliente habla
// en ella («ah, y agrega una coca») la llamada no se cuelga. Los cierres duros siguen colgando al instante.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";
import { Worker } from "../src/worker.ts";
import { GRACIA_DESPEDIDA_MS } from "../src/llamada.ts";
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
const gracia = (tareas: { ms: number }[]) => tareas.filter((t) => t.ms === GRACIA_DESPEDIDA_MS);
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
