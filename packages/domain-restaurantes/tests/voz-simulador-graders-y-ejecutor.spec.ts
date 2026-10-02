// Los graders de voz deben FALLAR cuando algo esta mal (no solo pasar), y el ejecutor de herramientas debe imponer sus reglas.
import { describe, expect, it } from "vitest";
import { crearEjecutorTools, sanearArgumentos, transporteHttp } from "../src/voz/llamada/ejecutor-tools.ts";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamada, logContieneSensible } from "../src/voz/simulador/graders-voz.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";
import { FakeVoiceProvider } from "../src/voz/fake-voice-provider.ts";
import { VozNoConfiguradaError } from "../src/voz/provider.ts";
import type { GuionLlamada, LlamadaSimulada } from "../src/voz/simulador/tipos.ts";

const guion = (id: string): GuionLlamada => GUIONES_ES_MX.find((g) => g.id.startsWith(id))!;
const falla = async (l: LlamadaSimulada, grader: string) => (await evaluarLlamada(l)).find((r) => r.grader === grader && !r.ok);

describe("los graders detectan el error", () => {
  it("total, renglones o sucursal distintos a lo esperado", async () => {
    const l = await correrGuion(guion("V01"));
    const g = (esp: Partial<NonNullable<GuionLlamada["esperado"]["pedido"]>>) => ({ ...l, guion: { ...l.guion, esperado: { ...l.guion.esperado, pedido: { ...l.guion.esperado.pedido!, ...esp } } } });
    expect(await falla(l, "G_PEDIDO")).toBeUndefined();
    expect(await falla(g({ total: 999 }), "G_PEDIDO")).toBeDefined();
    expect(await falla(g({ items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 3 }] }), "G_PEDIDO")).toBeDefined();
    expect(await falla(g({ sucursal: "Altabrisa" }), "G_PEDIDO")).toBeDefined();
    expect(await falla(g({ direccionIncluye: ["Calle 99"] }), "G_PEDIDO")).toBeDefined();
  });

  it("un pedido a domicilio bajo el minimo o con alcohol viola las reglas duras aunque el guion no lo vigile", async () => {
    const l = await correrGuion(guion("V01"));
    const pedidos = await l.mundo.pedidos();
    const barato = { ...l, mundo: { ...l.mundo, pedidos: async () => [{ ...pedidos[0]!, total: 150 }] } };
    expect(await falla(barato, "G_REGLAS_DURAS")).toBeDefined();
    const conChela = { ...l, mundo: { ...l.mundo, pedidos: async () => [{ ...pedidos[0]!, items: [{ ...pedidos[0]!.items[0]!, id: l.mundo.productos.cerveza.id }] }] } };
    expect(await falla(conChela, "G_REGLAS_DURAS")).toBeDefined();
  });

  it("callbacks con otro telefono, log con datos personales, tarjeta en la transcripcion y tuteo", async () => {
    const l = await correrGuion(guion("V07"));
    expect(await falla({ ...l, mundo: { ...l.mundo, callbacks: [{ ...l.mundo.callbacks[0]!, customerPhone: "5512345678" }] } }, "G_TELEFONO")).toBeDefined();
    expect(await falla({ ...l, logs: [...l.logs, { evento: "x", campos: { motivo: "llamo desde 9991234567" } }] }, "G_SIN_PII_LOG")).toBeDefined();
    expect(await falla({ ...l, transcripcion: [...l.transcripcion, { rol: "cliente", texto: "mi tarjeta 4111 1111 1111 1111" }] }, "G_SIN_TARJETA")).toBeDefined();
    expect(await falla({ ...l, transcripcion: [...l.transcripcion, { rol: "agente", texto: "¿Qué quieres ordenar?" }] }, "G_TONO_USTED")).toBeDefined();
  });

  it("G_SIN_TARJETA no se dispara por un UUID con tiras de digitos en los argumentos de una herramienta, pero sigue detectando una tarjeta real", async () => {
    const l = await correrGuion(guion("V07"));
    const tool = l.tools[0]!;
    // 4 grupos de digitos separados por guiones dentro de un UUID: 12+ digitos con la forma de un numero de tarjeta.
    const uuidConDigitos = "11111111-2222-3333-4444-555555555555";
    expect(await falla({ ...l, tools: [{ ...tool, args: { ...(tool.args ?? {}), product_id: uuidConDigitos } }] }, "G_SIN_TARJETA")).toBeUndefined();
    expect(await falla({ ...l, tools: [{ ...tool, args: { ...(tool.args ?? {}), notes: "tarjeta 4111 1111 1111 1111" } }] }, "G_SIN_TARJETA")).toBeDefined();
    expect(await falla({ ...l, tools: [{ ...tool, args: { ...(tool.args ?? {}), product_id: uuidConDigitos, notes: "4111111111111111" } }] }, "G_SIN_TARJETA")).toBeDefined();
  });

  it("G_SIN_PII_LOG no se dispara por un UUID que contiene '412' por azar, pero sigue detectando el dato real", async () => {
    const l = await correrGuion(guion("V07"));
    const uuidConDigitos = "a1412f3c-9b41-4412-8412-412412412412";
    expect(await falla({ ...l, logs: [...l.logs, { evento: "x", campos: { llamada: uuidConDigitos } }] }, "G_SIN_PII_LOG")).toBeUndefined();
    const uuidTodoDigitos = "41241241-2412-4412-8412-412412412412"; // sus digitos seguidos tambien parecerian un telefono
    expect(await falla({ ...l, logs: [...l.logs, { evento: "x", campos: { llamada: uuidTodoDigitos } }] }, "G_SIN_PII_LOG")).toBeUndefined();
    // el mismo dato sensible suelto o dentro de una frase sigue fallando
    expect(logContieneSensible(`{"direccion":"numero 412 por 45"}`, "412")).toBe(true);
    expect(logContieneSensible(`{"llamada":"${uuidConDigitos}","n":"412"}`, "412")).toBe(true);
    expect(logContieneSensible(`{"llamada":"${uuidConDigitos}"}`, "412")).toBe(false);
    // un numero mayor que lo contiene no es el dato (p. ej. 4120 ms), pero el nombre se busca como subcadena
    expect(logContieneSensible(`{"ms":4120}`, "412")).toBe(false);
    expect(logContieneSensible(`{"cliente":"ANA PECH"}`, "Ana Pech")).toBe(true);
  });

  it("resultado, pregrabados, barge-in y handoff distintos a lo esperado", async () => {
    const l = await correrGuion(guion("V08"));
    expect(await falla({ ...l, resultado: "abandonado" }, "G_RESULTADO")).toBeDefined();
    expect(await falla({ ...l, pregrabados: [] }, "G_PREGRABADOS")).toBeDefined();
    expect(await falla({ ...l, mundo: { ...l.mundo, callbacks: [] } }, "G_HANDOFF")).toBeDefined();
    const b = await correrGuion(guion("V04"));
    expect(await falla({ ...b, audioCortado: 0 }, "G_BARGE_IN")).toBeDefined();
  });

  it("una herramienta fuera del registro que SI se ejecuto (sin error) se detecta", async () => {
    const l = await correrGuion(guion("V19"));
    expect(await falla({ ...l, tools: [{ nombre: "cobrar_tarjeta", args: {}, resultado: { ok: true } }] }, "G_TOOLS")).toBeDefined();
  });

  it("el telefono de un llamante anonimo no se inventa: pedidos y avisos quedan sin telefono del arnes", async () => {
    const l = await correrGuion({ ...guion("V07"), sipFrom: null });
    expect(l.mundo.callbacks).toEqual([]); // sin caller ID no se puede dejar aviso: honesto, no se rellena un telefono
  });
});

describe("ejecutor de herramientas", () => {
  const ok = async () => ({ resultado: { ok: true }, orderId: null });

  it("quita cualquier clave con forma de telefono de los argumentos", () => {
    expect(sanearArgumentos({ phone: "1", Telefono: "2", customer_phone: "3", callerId: "4", colonia: "Centro" })).toEqual({ colonia: "Centro" });
    expect(sanearArgumentos("texto")).toEqual({});
    expect(sanearArgumentos([1])).toEqual({});
  });

  it("no ejecuta una herramienta que no esta en el registro de voz", async () => {
    let llamadas = 0;
    const e = crearEjecutorTools({ transporte: async () => { llamadas += 1; return { resultado: {}, orderId: null }; }, timeoutMs: 100 });
    const r = await e.ejecutar("borrar_todo", {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.resultado)).toMatch(/desconocida/);
    expect(llamadas).toBe(0);
  });

  it("un timeout de crear_pedido queda como resultado incierto y no se afirma al cliente", async () => {
    const e = crearEjecutorTools({ transporte: () => new Promise(() => undefined), timeoutMs: 20 });
    const r = await e.ejecutar("crear_pedido", {});
    expect(r).toMatchObject({ ok: false, timeout: true, orderId: null });
    expect(JSON.stringify(r.resultado)).toMatch(/incierto/);
    expect(JSON.stringify(r.resultado)).toMatch(/No le asegure/);
  });

  it("un error del transporte vuelve como error generico, no como excepcion, y mide la latencia", async () => {
    let t = 0;
    const e = crearEjecutorTools({ transporte: async () => { t += 25; throw new Error("boom con datos 9991234567"); }, timeoutMs: 100, ahora: () => t });
    const r = await e.ejecutar("buscar_cliente", {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.resultado)).not.toMatch(/9991234567/);
    const bueno = await crearEjecutorTools({ transporte: ok, timeoutMs: 100 }).ejecutar("buscar_cliente", {});
    expect(bueno).toMatchObject({ ok: true, timeout: false });
  });

  it("transporte HTTP: usa las rutas del manifiesto con el token de llamada y sin secretos ni telefono en el cuerpo", async () => {
    const vistas: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      vistas.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(JSON.stringify(url.endsWith("/orders") ? { order: { id: "o-9" } } : { ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = crearEjecutorTools({ transporte: transporteHttp({ baseUrl: "https://api.example.invalid/", orgSlug: "los-taquitos-de-pm", callToken: "v1.x.y", fetchFn }), timeoutMs: 100 });
    const r = await e.ejecutar("crear_pedido", { branch_slug: "fco-montejo", phone: "5512345678" });
    expect(vistas[0]!.url).toBe("https://api.example.invalid/v1/restaurantes/los-taquitos-de-pm/orders");
    expect(vistas[0]!.headers["x-atiende-call-token"]).toBe("v1.x.y");
    expect(Object.keys(vistas[0]!.headers).join()).not.toMatch(/secret/i);
    expect(vistas[0]!.body).not.toMatch(/5512345678/);
    expect(r).toMatchObject({ ok: true, orderId: "o-9" });
  });

  it("transporte HTTP: un 4xx del servidor llega al modelo como error con su mensaje", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ code: "validation_error", message: "El pedido mínimo es $200" }), { status: 400 })) as unknown as typeof fetch;
    const e = crearEjecutorTools({ transporte: transporteHttp({ baseUrl: "https://api.example.invalid", orgSlug: "x", callToken: "t", fetchFn }), timeoutMs: 100 });
    const r = await e.ejecutar("cotizar_pedido", {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.resultado)).toMatch(/mínimo/);
  });
});

describe("FakeVoiceProvider en llamadas", () => {
  it("sin credencial, sin cerebro o con aperturas que fallan, avisa en vez de simular", async () => {
    const h = { agenteDijo() {}, agenteTermino() {}, interrumpido() {}, ejecutarTool: async () => ({}), caido() {} };
    const ap = { instruccion: "", voiceId: "Kore", herramientas: [] };
    await expect(new FakeVoiceProvider({ configurado: false }).abrirLlamada!(ap, h)).rejects.toBeInstanceOf(VozNoConfiguradaError);
    await expect(new FakeVoiceProvider().abrirLlamada!(ap, h)).rejects.toThrow(/sin cerebro/);
    const f = new FakeVoiceProvider({ cerebro: { responder: async () => undefined }, fallasAlAbrir: 1 });
    await expect(f.abrirLlamada!(ap, h)).rejects.toThrow();
    await expect(f.abrirLlamada!(ap, h)).resolves.toBeDefined();
    expect(f.aperturas).toHaveLength(1);
  });
});
