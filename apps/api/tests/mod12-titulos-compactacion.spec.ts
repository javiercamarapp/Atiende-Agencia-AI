// MOD-12: titulos de conversaciones (plataforma:titulos_resumenes) y compactacion de historial (plataforma:compactacion_historial) del Copiloto.
// LLM guionado (sin red). Cubre: titulo sin PII, nunca bloquea la respuesta, respaldo determinista, rol correcto, resumen sin cifras.
import { describe, expect, it, vi } from "vitest";
import type { DataChatAnswer, DataChatCompletion, DataChatHistoryTurn } from "@atiende/agent-core/data-chat";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { beginTurnPersistence, type ConversacionScope, type ConversacionesRepository, type ResultadoGuardado, type TurnoAGuardar } from "../src/data-chat/conversaciones.ts";
import { COMPACTACION_TURNOS_RECIENTES, COMPACTACION_UMBRAL_TOKENS, compactarHistorial, sanitizarResumen } from "../src/data-chat/compactacion.ts";
import { generarTitulo, sanitizarTitulo, tituloPredeterminado } from "../src/data-chat/titulos.ts";
import { COMPACTACION_HISTORIAL_ROLE, TITULOS_RESUMENES_ROLE } from "../src/production/llm-models.ts";
import type { AppDeps } from "../src/deps.ts";

const ok = (text: string): ReturnType<DataChatCompletion> => Promise.resolve({ text, model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 });

describe("sanitizarTitulo", () => {
  it("acepta un titulo corto y limpia comillas, marcado y punto final; toma solo la primera linea", () => {
    expect(sanitizarTitulo('"Ventas por día de la semana."')).toBe("Ventas por día de la semana");
    expect(sanitizarTitulo("**Ocupación del mes**\nexplicacion extra")).toBe("Ocupación del mes");
  });

  it("descarta titulos con PII, enlaces, cifras largas, vacios o demasiado largos", () => {
    expect(sanitizarTitulo("Ventas de juan.perez@example.com")).toBeNull();
    expect(sanitizarTitulo("Llamar al 55 1234 5678 hoy")).toBeNull();
    expect(sanitizarTitulo("Ver https://evil.example/x")).toBeNull();
    expect(sanitizarTitulo("Cuenta 123456789")).toBeNull();
    expect(sanitizarTitulo("")).toBeNull();
    expect(sanitizarTitulo(undefined)).toBeNull();
    expect(sanitizarTitulo("ab")).toBeNull();
    expect(sanitizarTitulo("x".repeat(61))).toBeNull();
  });

  it("tituloPredeterminado replica el de la base: pregunta aplanada, 60 caracteres y puntos suspensivos", () => {
    expect(tituloPredeterminado("  ¿Cuánto   vendí\nayer? ")).toBe("¿Cuánto vendí ayer?");
    expect(tituloPredeterminado("a".repeat(70))).toBe(`${"a".repeat(60)}…`);
  });
});

describe("generarTitulo", () => {
  it("manda al modelo SOLO la pregunta redactada (sin PII) y devuelve el titulo validado", async () => {
    const complete = vi.fn((_req: Parameters<DataChatCompletion>[0]) => ok("Ventas semanales"));
    const t = await generarTitulo(complete, "¿Cuánto vendí? escríbeme a juan@example.com o al 55 1234 5678");
    expect(t).toBe("Ventas semanales");
    const enviado = JSON.stringify(complete.mock.calls[0]![0]);
    expect(enviado).not.toContain("juan@example.com");
    expect(enviado).not.toContain("1234 5678");
    expect(complete.mock.calls[0]![0].tools).toBeUndefined();
  });

  it("si el modelo devuelve PII, un enlace o falla (interruptor apagado, tope, error): null y NO lanza", async () => {
    expect(await generarTitulo(() => ok("Ventas de ana@example.com"), "x")).toBeNull();
    expect(await generarTitulo(() => ok("https://x.example/y titulo"), "x")).toBeNull();
    const errores: unknown[] = [];
    expect(await generarTitulo(() => Promise.reject(new Error("kill switch")), "x", (e) => errores.push(e))).toBeNull();
    expect(errores).toHaveLength(1);
  });
});

describe("compactarHistorial", () => {
  const turno = (i: number, chars: number): DataChatHistoryTurn => ({ role: i % 2 === 0 ? "user" : "assistant", text: `t${i} ${"x".repeat(chars)}` });
  const largo = Array.from({ length: 10 }, (_, i) => turno(i, 700)); // ~7000 caracteres = ~1750 tokens > umbral

  it("bajo el umbral no llama al modelo y deja el historial intacto", async () => {
    const complete = vi.fn(() => ok("Resumen de ventas y cancelaciones."));
    const corto = [turno(0, 50), turno(1, 50)];
    expect(await compactarHistorial(complete, corto)).toEqual({ history: corto });
    expect(complete).not.toHaveBeenCalled();
    expect(COMPACTACION_UMBRAL_TOKENS).toBeGreaterThan(0);
  });

  it("sobre el umbral resume la parte VIEJA y deja los ultimos turnos completos", async () => {
    const complete = vi.fn((_req: Parameters<DataChatCompletion>[0]) => ok("Hablaron de ventas por día y de cancelaciones del mes."));
    const r = await compactarHistorial(complete, largo);
    expect(r.resumen).toBe("Hablaron de ventas por día y de cancelaciones del mes.");
    expect(r.history).toEqual(largo.slice(-COMPACTACION_TURNOS_RECIENTES));
    expect(JSON.stringify(complete.mock.calls[0]![0])).toContain("t0 ");
    expect(JSON.stringify(complete.mock.calls[0]![0])).not.toContain("t9 "); // lo reciente no se resume
  });

  it("un resumen con cifras, PII o enlaces se descarta: historial intacto; un fallo del modelo tambien", async () => {
    expect((await compactarHistorial(() => ok("Vendieron 1,500 pesos en total."), largo)).resumen).toBeUndefined();
    expect((await compactarHistorial(() => ok("Hablaron con ana@example.com de ventas."), largo)).resumen).toBeUndefined();
    expect((await compactarHistorial(() => ok("Ver https://x.example para mas informacion."), largo)).resumen).toBeUndefined();
    const r = await compactarHistorial(() => Promise.reject(new Error("tope")), largo);
    expect(r).toEqual({ history: largo });
    expect(sanitizarResumen("Hablaron de ventas por sucursal.")).toBe("Hablaron de ventas por sucursal.");
  });

  it("sin completador (interruptor o sin proveedor) el historial queda tal cual", async () => {
    expect(await compactarHistorial(undefined, largo)).toEqual({ history: largo });
  });
});

// ---- cableado en beginTurnPersistence ----

const SCOPE: ConversacionScope = { organizationId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000b1", vertical: "hoteles" };
const OK_ANSWER: DataChatAnswer = { status: "ok", text: "Ocupación del 35 %.", blocks: [], sources: [], toolsUsed: [] };

class Repo {
  titulo = "";
  appended: TurnoAGuardar[] = [];
  historial: DataChatHistoryTurn[] = [];
  retitularLlamadas = 0;
  retitularVisible = true;
  async loadHistory(): Promise<DataChatHistoryTurn[] | null> {
    return this.historial;
  }
  async append(_scope: ConversacionScope, t: TurnoAGuardar): Promise<ResultadoGuardado> {
    this.appended.push(t);
    this.titulo = tituloPredeterminado(t.userText);
    return { guardado: true, conversationId: t.conversationId ?? "00000000-0000-4000-8000-0000000000c1", seq: 2 };
  }
  async retitular(_scope: ConversacionScope, _id: string, actual: string, nuevo: string): Promise<boolean> {
    this.retitularLlamadas += 1;
    if (!this.retitularVisible || this.titulo !== actual) return false;
    this.titulo = nuevo;
    return true;
  }
}

function deps(repo: Repo, completion: (org: string, role?: string) => DataChatCompletion, rolesAuxiliares = true): AppDeps {
  const session = {} as TenantDbSession;
  const engine = { withAppSession: async (_c: unknown, fn: (s: TenantDbSession) => Promise<unknown>) => fn(session) } as unknown as TenancyEngine;
  return { engine, dataChat: { completion, rolesAuxiliares, conversaciones: () => repo as unknown as ConversacionesRepository } } as unknown as AppDeps;
}

describe("titulo de una conversacion nueva (cableado)", () => {
  it("la respuesta se guarda con el titulo determinista y NO espera al modelo; despues del commit el titulo cambia al generado, con el rol correcto", async () => {
    const repo = new Repo();
    const roles: (string | undefined)[] = [];
    const persist = await beginTurnPersistence(deps(repo, (_o, role) => { roles.push(role); return () => ok("Ocupación del hotel"); }), {} as TenantDbSession, { conversationId: "new", history: [], scope: SCOPE, propertyId: null });
    const respuesta = await persist.finish({} as TenantDbSession, "¿Cuál es la ocupación?", undefined, OK_ANSWER);
    expect(respuesta).toMatchObject({ guardado: true, conversationId: "00000000-0000-4000-8000-0000000000c1" });
    expect(repo.titulo).toBe("¿Cuál es la ocupación?"); // determinista: la respuesta no esperó al modelo
    expect(roles).toEqual([]); // ni siquiera se pidio todavia
    await persist.despuesDelCommit();
    expect(repo.titulo).toBe("Ocupación del hotel");
    expect(roles).toEqual([TITULOS_RESUMENES_ROLE]);
  });

  it("si el modelo devuelve PII o el interruptor esta apagado, el titulo determinista se queda y nada lanza", async () => {
    for (const completion of [() => ok("Ocupación de ana@example.com"), () => Promise.reject(new Error("rol apagado"))] as DataChatCompletion[]) {
      const repo = new Repo();
      const persist = await beginTurnPersistence(deps(repo, () => completion), {} as TenantDbSession, { conversationId: "new", history: [], scope: SCOPE, propertyId: null });
      await persist.finish({} as TenantDbSession, "¿Cuál es la ocupación?", undefined, OK_ANSWER);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(persist.despuesDelCommit()).resolves.toBeUndefined();
      spy.mockRestore();
      expect(repo.titulo).toBe("¿Cuál es la ocupación?");
    }
  });

  it("el titulo guardado y enviado al modelo salen de la pregunta REDACTADA (sin correos ni telefonos)", async () => {
    const repo = new Repo();
    const vistos: string[] = [];
    const persist = await beginTurnPersistence(deps(repo, () => (req) => { vistos.push(JSON.stringify(req)); return ok("Ventas semanales"); }), {} as TenantDbSession, { conversationId: "new", history: [], scope: SCOPE, propertyId: null });
    await persist.finish({} as TenantDbSession, "ventas, avisa a juan@example.com al 55 1234 5678", undefined, OK_ANSWER);
    expect(repo.appended[0]!.userText).not.toContain("juan@example.com");
    await persist.despuesDelCommit();
    expect(vistos[0]).not.toContain("juan@example.com");
    expect(vistos[0]).not.toContain("1234 5678");
  });

  it("si el usuario ya renombro la conversacion, el titulo generado NO la pisa; el titulo se pide UNA vez aunque se reintente el UPDATE", async () => {
    const repo = new Repo();
    const complete = vi.fn(() => ok("Ocupación del hotel"));
    const persist = await beginTurnPersistence(deps(repo, () => complete), {} as TenantDbSession, { conversationId: "new", history: [], scope: SCOPE, propertyId: null });
    await persist.finish({} as TenantDbSession, "¿Cuál es la ocupación?", undefined, OK_ANSWER);
    repo.titulo = "Mi titulo propio";
    await persist.despuesDelCommit();
    await persist.despuesDelCommit();
    expect(repo.titulo).toBe("Mi titulo propio");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(repo.retitularLlamadas).toBe(2);
  });

  it("una conversacion EXISTENTE no se retitula, y sin los roles auxiliares activos no hay ninguna llamada al modelo", async () => {
    const repo = new Repo();
    const complete = vi.fn(() => ok("Otro titulo"));
    const existente = await beginTurnPersistence(deps(repo, () => complete), {} as TenantDbSession, { conversationId: "00000000-0000-4000-8000-0000000000c1", history: [], scope: SCOPE, propertyId: null });
    await existente.finish({} as TenantDbSession, "otra pregunta", undefined, OK_ANSWER);
    await existente.despuesDelCommit();
    expect(complete).not.toHaveBeenCalled();
    const apagado = await beginTurnPersistence(deps(repo, () => complete, false), {} as TenantDbSession, { conversationId: "new", history: [], scope: SCOPE, propertyId: null });
    await apagado.finish({} as TenantDbSession, "pregunta", undefined, OK_ANSWER);
    await apagado.despuesDelCommit();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("compactacion (cableado)", () => {
  it("una conversacion larga entrega el resumen de lo viejo y solo los ultimos turnos; el rol es el de compactacion", async () => {
    const repo = new Repo();
    repo.historial = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `t${i} ${"x".repeat(700)}` }));
    const roles: (string | undefined)[] = [];
    const persist = await beginTurnPersistence(deps(repo, (_o, role) => { roles.push(role); return () => ok("Hablaron de ventas y cancelaciones."); }), {} as TenantDbSession, { conversationId: "00000000-0000-4000-8000-0000000000c1", history: [], scope: SCOPE, propertyId: null });
    expect(persist.resumen).toBe("Hablaron de ventas y cancelaciones.");
    expect(persist.history).toHaveLength(COMPACTACION_TURNOS_RECIENTES);
    expect(roles).toContain(COMPACTACION_HISTORIAL_ROLE);
  });

  it("una conversacion corta no llama al modelo", async () => {
    const repo = new Repo();
    repo.historial = [{ role: "user", text: "hola" }, { role: "assistant", text: "hola" }];
    const complete = vi.fn(() => ok("x"));
    const persist = await beginTurnPersistence(deps(repo, () => complete), {} as TenantDbSession, { conversationId: "00000000-0000-4000-8000-0000000000c1", history: [], scope: SCOPE, propertyId: null });
    expect(persist.resumen).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });
  const largo10 = () => Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `t${i} ${"x".repeat(700)}` }));
  const ID = "00000000-0000-4000-8000-0000000000c1";

  it("un turno de ruta directa (tool) no compacta ni llama al modelo", async () => {
    const repo = new Repo();
    repo.historial = largo10();
    const complete = vi.fn(() => ok("Hablaron de ventas y cancelaciones."));
    const persist = await beginTurnPersistence(deps(repo, () => complete), {} as TenantDbSession, { conversationId: ID, history: [], scope: SCOPE, propertyId: null, tool: "ventas_semana" });
    expect(complete).not.toHaveBeenCalled();
    expect(persist.resumen).toBeUndefined();
    expect(persist.history).toHaveLength(10);
  });

  it("si el cliente aborta, la compactacion no espera al modelo y devuelve el historial tal cual", async () => {
    const repo = new Repo();
    repo.historial = largo10();
    const ac = new AbortController();
    const complete = vi.fn(() => new Promise<never>(() => undefined));
    const p = beginTurnPersistence(deps(repo, () => complete), {} as TenantDbSession, { conversationId: ID, history: [], scope: SCOPE, propertyId: null, signal: ac.signal });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const persist = await p;
    expect(persist.resumen).toBeUndefined();
    expect(persist.history).toHaveLength(10);
  });
});
