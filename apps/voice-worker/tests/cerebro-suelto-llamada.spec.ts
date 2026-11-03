// El cerebro suelto conectado a `atenderLlamada`: telefonia falsa + API real en proceso + `voz-turno` FALSO. La sesion de la cascada se reemplaza por una que
// llama al puerto LLM que arma el worker (lo que hace la cascada v2 con el texto del STT). Verifica el cableado: apertura seq 0, turnos, y colgado propio con pedido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";
import { Worker } from "../src/worker.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("cerebro suelto dentro de atenderLlamada", () => {
  it("abre con seq 0, manda los turnos con el telefono del caller ID y cuelga solo tras la despedida con pedido", async () => {
    const api = await crearMundoApi();
    const telefonia = new TelefoniaFalsa();
    const cuerpos: { seq: number; texto: string; telefono: string }[] = [];
    const fetchSuelto = (async (_u: string, init?: RequestInit) => {
      const c = JSON.parse(String(init?.body));
      cuerpos.push(c);
      const r = c.seq === 0 ? { texto: "Buen día, esta llamada se graba.", pedido_id: null } : c.seq === 1 ? { texto: "¿Cuántos tacos?", pedido_id: null } : { texto: "Listo, su pedido quedó registrado. Gracias, buen provecho.", pedido_id: "ped_7" };
      return new Response(JSON.stringify({ ...r, fin: false, turno: c.seq }), { status: 200 });
    }) as unknown as typeof fetch;
    let llm: PuertoLlmVoz | null = null;
    let decir: ((t: string) => Promise<void>) | null = null;
    const dicho: string[] = [];
    const escalon = {
      id: "cascada-v2" as const,
      abrirSesion: async (_a: unknown, h: { agenteDijo(t: string): void; agenteTermino(): void }) => {
        decir = async (texto: string) => {
          const r = await llm!.completar({ system: "", mensajes: [{ role: "user", content: texto }], herramientas: [], onTextDelta: (d) => dicho.push(d) });
          h.agenteDijo(r.texto);
          h.agenteTermino();
        };
        return { enviarTexto: (t: string) => void decir!(t), interrumpir: () => undefined, cerrar: async () => undefined };
      },
    };
    const worker = new Worker({
      config: api.config,
      telefonia,
      log: () => undefined,
      deps: api.depsAtencion({
        crearEscalera: (ctx) => {
          llm = ctx?.llmVoz ?? null;
          return crearEscaleraLlamada([escalon as never], { ahora: api.reloj.ahora });
        },
        cerebroSuelto: { url: "https://x.invalid/functions/v1/voz-turno", secreto: "s", aviso: null, fetchFn: fetchSuelto, esperar: async () => undefined },
      }),
    });
    expect(await worker.iniciar()).toBe(true);
    const antes = worker.salud().llamadasAtendidas;
    telefonia.llamar({ id: "llamada-suelta-1", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(cuerpos).toHaveLength(1), { timeout: 5_000, interval: 5 });
    expect(cuerpos[0]).toEqual({ call_id: "llamada-suelta-1", telefono: "9991234567", seq: 0, texto: "" });
    await decir!("quiero tacos");
    await decir!("de bistec");
    expect(cuerpos.map((c) => [c.seq, c.texto])).toEqual([[0, ""], [1, "quiero tacos"], [2, "de bistec"]]);
    // Sin que el cliente cuelgue: el worker cuelga por su cuenta tras la despedida con pedido.
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  });

  it("si voz-turno falla y el worker cuelga con «una persona le devolvera la llamada», registra el aviso en registrar-contacto con call_id y sin bloquear el colgado", async () => {
    const api = await crearMundoApi();
    const telefonia = new TelefoniaFalsa();
    const registros: { url: string; secreto: string | null; cuerpo: Record<string, unknown> }[] = [];
    const fetchSuelto = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/registrar-contacto")) {
        registros.push({ url, secreto: new Headers(init?.headers).get("x-atiende-tool-secret"), cuerpo: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ error: "interno" }), { status: 502 });
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
    const worker = new Worker({
      config: api.config,
      telefonia,
      log: () => undefined,
      deps: api.depsAtencion({
        crearEscalera: (ctx) => {
          llm = ctx?.llmVoz ?? null;
          return crearEscaleraLlamada([escalon as never], { ahora: api.reloj.ahora });
        },
        cerebroSuelto: { url: "https://x.invalid/functions/v1/voz-turno", secreto: "s", aviso: null, fetchFn: fetchSuelto, esperar: async () => undefined, registrarContacto: { url: "https://x.invalid/functions/v1/registrar-contacto", secreto: "tool-s" } },
      }),
    });
    expect(await worker.iniciar()).toBe(true);
    const antes = worker.salud().llamadasAtendidas;
    telefonia.llamar({ id: "llamada-fallida-1", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
    expect(registros).toHaveLength(1);
    expect(registros[0]!.secreto).toBe("tool-s");
    expect(registros[0]!.cuerpo).toMatchObject({ conversation_id: "llamada-fallida-1", customer_phone: "9991234567", motivo: "otro" });
  });

  it("id de llamada corto (< 6 caracteres): la llamada se atiende con un call_id rellenado, no se cae", async () => {
    const api = await crearMundoApi();
    const telefonia = new TelefoniaFalsa();
    const cuerpos: { call_id: string; seq: number }[] = [];
    const fetchSuelto = (async (_u: string, init?: RequestInit) => {
      const c = JSON.parse(String(init?.body));
      cuerpos.push(c);
      return new Response(JSON.stringify({ texto: "Buen día.", pedido_id: null, fin: false, turno: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    let llm: PuertoLlmVoz | null = null;
    const escalon = { id: "cascada-v2" as const, abrirSesion: async (_a: unknown, h: { agenteDijo(t: string): void; agenteTermino(): void }) => ({ enviarTexto: (t: string) => void llm!.completar({ system: "", mensajes: [{ role: "user", content: t }], herramientas: [] }).then((r) => { h.agenteDijo(r.texto); h.agenteTermino(); }), interrumpir: () => undefined, cerrar: async () => undefined }) };
    const worker = new Worker({
      config: api.config,
      telefonia,
      log: () => undefined,
      deps: api.depsAtencion({
        crearEscalera: (ctx) => { llm = ctx?.llmVoz ?? null; return crearEscaleraLlamada([escalon as never], { ahora: api.reloj.ahora }); },
        cerebroSuelto: { url: "https://x.invalid/functions/v1/voz-turno", secreto: "s", aviso: null, fetchFn: fetchSuelto, esperar: async () => undefined },
      }),
    });
    expect(await worker.iniciar()).toBe(true);
    telefonia.llamar({ id: "ab1", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(cuerpos).toHaveLength(1), { timeout: 5_000, interval: 5 });
    expect(cuerpos[0]!.call_id).toBe("llamada_ab1");
  });

  it("si armar el cerebro suelto lanza, la llamada se cierra con pregrabado y la telefonia cuelga (no queda muda ni tumba el worker)", async () => {
    const api = await crearMundoApi();
    const telefonia = new TelefoniaFalsa();
    const cfg = { url: "https://x.invalid/functions/v1/voz-turno", secreto: "s", aviso: null, esperar: async () => undefined, get timeoutMs(): number { throw new Error("config rara"); } };
    const worker = new Worker({
      config: api.config,
      telefonia,
      log: () => undefined,
      deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([], { ahora: api.reloj.ahora }), cerebroSuelto: cfg }),
    });
    expect(await worker.iniciar()).toBe(true);
    const antes = worker.salud().llamadasAtendidas;
    telefonia.llamar({ id: "llamada-rara-1", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
    await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  });
});
