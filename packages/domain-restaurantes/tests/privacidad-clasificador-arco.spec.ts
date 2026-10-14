// Clasificador LLM de ARCO: contrato (fail-open, timeout, tope, privacidad del prompt, costo) y arbitraje con la capa regex (`intencionesPorMensaje`).
// Aqui el modelo es un doble determinista; la calidad del modelo REAL se mide con scripts/medir-clasificador-arco (docs/ARCO-CLASIFICADOR.md).
import { describe, expect, it, vi } from "vitest";
import {
  UMBRAL_CONFIANZA_ALTA,
  crearClasificadorArco,
  debeClasificarArco,
  decidirConClasificador,
  parsearSalidaClasificador,
  textoParaClasificador,
  type ClasificadorArco,
  type CompletarJson,
  type EventoClasificador,
  type ResultadoClasificadorArco,
} from "../src/privacidad/clasificador-arco.ts";
import { intencionesPorMensaje } from "../src/privacidad/arco-intent.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const json = (o: unknown): string => JSON.stringify(o);
const ok = (intencion: string, confianza: number, derecho: string | null = null) => ({ text: json({ intencion, confianza, derecho_mas_probable: derecho }), model: "m", tokensIn: 700, tokensOut: 20, costUsd: 0.00008 });

describe("parsearSalidaClasificador", () => {
  it("acepta el esquema y ajusta la confianza a 0..1", () => {
    expect(parsearSalidaClasificador(json({ intencion: "cancelacion", confianza: 0.9, derecho_mas_probable: "cancelacion" }))).toEqual({ intencion: "cancelacion", confianza: 0.9, derechoMasProbable: "cancelacion" });
    expect(parsearSalidaClasificador(json({ intencion: "ninguna", confianza: 7, derecho_mas_probable: null }))?.confianza).toBe(1);
    expect(parsearSalidaClasificador(json({ intencion: "acceso", confianza: "0.8", derecho_mas_probable: "acceso" }))?.confianza).toBe(0.8);
  });
  it("tolera un bloque ```json", () => {
    expect(parsearSalidaClasificador('```json\n{"intencion":"ninguna","confianza":0.9,"derecho_mas_probable":null}\n```')?.intencion).toBe("ninguna");
  });
  it.each(["", "no json", "[]", "null", "{}", json({ intencion: "inventada", confianza: 0.9 }), json({ intencion: "acceso" }), json({ intencion: "acceso", confianza: "alta" })])("rechaza %j", (t) => {
    expect(parsearSalidaClasificador(t)).toBeNull();
  });
  it("un derecho_mas_probable invalido se vuelve null", () => {
    expect(parsearSalidaClasificador(json({ intencion: "acceso", confianza: 0.9, derecho_mas_probable: "otro" }))?.derechoMasProbable).toBeNull();
  });
});

describe("prefiltro de vocabulario: lo claramente solo-pedido no llega al modelo", () => {
  it.each(["2 tacos de pastor", "hola buenas tardes", "quiero una pizza grande de peperoni", "gracias", "ok", "a que hora cierran", "con refresco de limon"])("«%s» no se clasifica", (t) => {
    expect(debeClasificarArco(t)).toBe(false);
  });
  it.each(["paren de mandarme mensajes", "para que quieren mi numero", "ya basta de mensajes", "quiero darme de baja", "no me sigan escribiendo", "venden mis datos"])("«%s» si", (t) => {
    expect(debeClasificarArco(t)).toBe(true);
  });
  it("entradas que no son texto no se clasifican y no lanzan", () => {
    for (const v of [0, null, undefined, false, [], {}]) expect(debeClasificarArco(v as unknown as string)).toBe(false);
  });
});

describe("el prompt no lleva datos extra", () => {
  it("tarjetas redactadas y numeros largos enmascarados; acotado", () => {
    const t = textoParaClasificador("borren mis datos, mi tarjeta es 4111 1111 1111 1111 y mi cel 999 123 4567 o +52 1 999 123 4567");
    expect(t).not.toMatch(/4111/);
    expect(t).not.toMatch(/999 123/);
    expect(t).toContain("[numero]");
    expect(textoParaClasificador("a".repeat(5000)).length).toBeLessThanOrEqual(1200);
  });
  it("lo que se manda al proveedor es solo el mensaje (sin telefono, organizacion ni historial)", async () => {
    const vistos: { system: string; user: string }[] = [];
    const c = crearClasificadorArco({ completar: async (e) => { vistos.push({ system: e.system, user: e.user }); return ok("ninguna", 0.9); } });
    await c.clasificar({ texto: "paren de mandarme mensajes al 9991234567", organizationId: ORG });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.user).toContain("paren de mandarme mensajes");
    expect(vistos[0]!.user).not.toContain("9991234567");
    expect(vistos[0]!.user).not.toContain(ORG);
    expect(vistos[0]!.system).not.toContain(ORG);
  });
  it("pide salida JSON con esquema estricto", async () => {
    let schema: Record<string, unknown> | null = null;
    const c = crearClasificadorArco({ completar: async (e) => { schema = e.schema; return ok("ninguna", 0.9); } });
    await c.clasificar({ texto: "borren mis datos", organizationId: ORG });
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["intencion", "confianza", "derecho_mas_probable"] });
  });
});

describe("fail-open: el pedido NUNCA se bloquea", () => {
  const casos: [string, CompletarJson, string][] = [
    ["el proveedor lanza", async () => { throw new Error("boom"); }, "proveedor"],
    ["el modelo contesta basura", async () => ({ text: "lo siento" }), "json_invalido"],
    ["el interruptor de plataforma esta apagado", async () => { throw Object.assign(new Error("apagado"), { name: "KillSwitchEngagedError" }); }, "apagado"],
    ["se agoto el tope diario del rol", async () => { throw Object.assign(new Error("tope"), { name: "RoleDailyTurnLimitExceededError" }); }, "tope_diario"],
  ];
  it.each(casos)("%s -> null y la falla queda registrada", async (_n, completar, falla) => {
    const eventos: EventoClasificador[] = [];
    const c = crearClasificadorArco({ completar, alFinalizar: (e) => eventos.push(e) });
    await expect(c.clasificar({ texto: "borren mis datos", organizationId: ORG })).resolves.toBeNull();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ ok: false, falla });
  });
  it("excede el timeout -> null (y aborta la peticion)", async () => {
    let abortado = false;
    const eventos: EventoClasificador[] = [];
    const c = crearClasificadorArco({
      timeoutMs: 20,
      alFinalizar: (e) => eventos.push(e),
      completar: (e) => new Promise((_, rechazar) => { e.signal.addEventListener("abort", () => { abortado = true; rechazar(new Error("abortado")); }); }),
    });
    const t0 = Date.now();
    await expect(c.clasificar({ texto: "borren mis datos", organizationId: ORG })).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(abortado).toBe(true);
    expect(eventos[0]).toMatchObject({ ok: false, falla: "timeout" });
  });
  it("un proveedor que ignora la senal igual no cuelga al turno (carrera con el timeout)", async () => {
    const c = crearClasificadorArco({ timeoutMs: 20, completar: () => new Promise(() => undefined) });
    await expect(c.clasificar({ texto: "borren mis datos", organizationId: ORG })).resolves.toBeNull();
  });
  it("un registrador de eventos que lanza no rompe el turno", async () => {
    const c = crearClasificadorArco({ completar: async () => ok("acceso", 0.9, "acceso"), alFinalizar: () => { throw new Error("log roto"); } });
    await expect(c.clasificar({ texto: "para que quieren mi numero", organizationId: ORG })).resolves.toMatchObject({ intencion: "acceso" });
  });
});

describe("costo y tope por organizacion y dia", () => {
  it("cada llamada informa tokens y costo (el costo real por mensaje queda medible)", async () => {
    const eventos: EventoClasificador[] = [];
    const c = crearClasificadorArco({ completar: async () => ok("cancelacion", 0.95, "cancelacion"), alFinalizar: (e) => eventos.push(e) });
    await c.clasificar({ texto: "quiten mis datos", organizationId: ORG });
    expect(eventos[0]).toMatchObject({ ok: true, intencion: "cancelacion", tokensIn: 700, tokensOut: 20, costUsd: 0.00008, model: "m" });
  });
  it("el tope diario por organizacion corta las llamadas (otra organizacion y el dia siguiente no se ven afectados)", async () => {
    let ahora = Date.parse("2026-10-14T12:00:00Z");
    const completar = vi.fn(async () => ok("ninguna", 0.9));
    const eventos: EventoClasificador[] = [];
    const c = crearClasificadorArco({ completar, topeDiarioPorOrganizacion: 2, ahoraMs: () => ahora, alFinalizar: (e) => eventos.push(e) });
    expect(await c.clasificar({ texto: "borren mis datos", organizationId: ORG })).not.toBeNull();
    expect(await c.clasificar({ texto: "borren mis datos", organizationId: ORG })).not.toBeNull();
    expect(await c.clasificar({ texto: "borren mis datos", organizationId: ORG })).toBeNull();
    expect(eventos.at(-1)).toMatchObject({ ok: false, falla: "tope_diario" });
    expect(completar).toHaveBeenCalledTimes(2);
    expect(await c.clasificar({ texto: "borren mis datos", organizationId: "otra" })).not.toBeNull();
    ahora += 24 * 3600 * 1000;
    expect(await c.clasificar({ texto: "borren mis datos", organizationId: ORG })).not.toBeNull();
  });
});

describe("decidirConClasificador", () => {
  const r = (intencion: ResultadoClasificadorArco["intencion"], confianza: number, d: ResultadoClasificadorArco["derechoMasProbable"] = null): ResultadoClasificadorArco => ({ intencion, confianza, derechoMasProbable: d });
  it("confianza alta -> peticion; revocacion_contacto es oposicion con contacto", () => {
    expect(decidirConClasificador(r("cancelacion", 0.9, "cancelacion"))).toEqual({ tipo: "peticion", right: "cancelacion", contacto: false });
    expect(decidirConClasificador(r("revocacion_contacto", 0.8, "oposicion"))).toEqual({ tipo: "peticion", right: "oposicion", contacto: true });
    expect(UMBRAL_CONFIANZA_ALTA).toBe(0.7);
  });
  it("confianza media -> senal debil; baja -> nada", () => {
    expect(decidirConClasificador(r("acceso", 0.5, "acceso"))).toEqual({ tipo: "debil", derechoProbable: "acceso" });
    expect(decidirConClasificador(r("acceso", 0.2, "acceso"))).toEqual({ tipo: "nada" });
  });
  it("ninguna segura (>= 0.8) permite descartar; insegura no", () => {
    expect(decidirConClasificador(r("ninguna", 0.95))).toEqual({ tipo: "ninguna_segura" });
    expect(decidirConClasificador(r("ninguna", 0.6))).toEqual({ tipo: "nada" });
  });
  it("sin resultado (falla) -> nada", () => {
    expect(decidirConClasificador(null)).toEqual({ tipo: "nada" });
  });
});

function falso(respuestas: Record<string, ResultadoClasificadorArco | null>): ClasificadorArco & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    async clasificar({ texto }) {
      llamadas.push(texto);
      return respuestas[texto] ?? { intencion: "ninguna", confianza: 0.95, derechoMasProbable: null };
    },
  };
}
const R = (intencion: ResultadoClasificadorArco["intencion"], confianza: number, d: ResultadoClasificadorArco["derechoMasProbable"] = null): ResultadoClasificadorArco => ({ intencion, confianza, derechoMasProbable: d });

describe("intencionesPorMensaje: arbitraje regex + clasificador", () => {
  it("sin clasificador: solo la capa regex", async () => {
    expect(await intencionesPorMensaje(["borren mis datos", "hola"], undefined, ORG)).toHaveLength(1);
  });
  it("una peticion regex fuerte se respeta SIN llamar al modelo", async () => {
    const c = falso({});
    const r = await intencionesPorMensaje(["borren mis datos"], c, ORG);
    expect(r[0]!.intent).toMatchObject({ kind: "request", right: "cancelacion" });
    expect(c.llamadas).toEqual([]);
  });
  it("lo que la regex no vio y el modelo reconoce (confianza alta) se vuelve peticion", async () => {
    const c = falso({ "oiga ya no quiero que me anden buscando": R("revocacion_contacto", 0.92, "oposicion") });
    const r = await intencionesPorMensaje(["oiga ya no quiero que me anden buscando"], c, ORG);
    expect(r).toHaveLength(1);
    expect(r[0]!.intent).toMatchObject({ kind: "request", right: "oposicion", contacto: true });
  });
  it("confianza media -> senal debil (el agente sigue con el pedido); baja -> nada", async () => {
    const media = await intencionesPorMensaje(["quisiera saber cosas sobre lo que ustedes guardan"], falso({ "quisiera saber cosas sobre lo que ustedes guardan": R("acceso", 0.5, "acceso") }), ORG);
    expect(media[0]!.intent).toMatchObject({ kind: "menu", fuerza: "debil", derechoProbable: "acceso" });
    const baja = await intencionesPorMensaje(["quisiera saber cosas sobre lo que ustedes guardan"], falso({ "quisiera saber cosas sobre lo que ustedes guardan": R("acceso", 0.2, "acceso") }), ORG);
    expect(baja).toHaveLength(0);
  });
  it("el modelo descarta una senal regex DEBIL con «ninguna» segura, pero nunca una fuerte", async () => {
    const c = falso({ "no me llamen": R("ninguna", 0.95) });
    expect(await intencionesPorMensaje(["no me llamen"], c, ORG)).toHaveLength(0);
    const c2 = falso({ "borren mis datos": R("ninguna", 0.99) });
    expect(await intencionesPorMensaje(["borren mis datos"], c2, ORG)).toHaveLength(1);
  });
  it("una raiz fuerte de precision media (arbitrable) SI la puede descartar el modelo", async () => {
    const c = falso({ "ya no me llamen al telefono fijo": R("ninguna", 0.95) });
    expect(await intencionesPorMensaje(["ya no me llamen al telefono fijo"], c, ORG)).toHaveLength(0);
    const sinModelo = await intencionesPorMensaje(["ya no me llamen al telefono fijo"], undefined, ORG);
    expect(sinModelo[0]!.intent).toMatchObject({ kind: "request", right: "oposicion" });
  });
  it("si el modelo falla (null) se queda la capa regex, fuerte o debil", async () => {
    const roto: ClasificadorArco = { clasificar: async () => null };
    expect(await intencionesPorMensaje(["ya no me llamen al telefono fijo"], roto, ORG)).toHaveLength(1);
    expect(await intencionesPorMensaje(["no me llamen"], roto, ORG)).toHaveLength(1);
    expect(await intencionesPorMensaje(["oiga ya no quiero que me anden buscando"], roto, ORG)).toHaveLength(0);
  });
  it("mensajes solo-pedido no llegan al modelo", async () => {
    const c = falso({});
    await intencionesPorMensaje(["2 tacos de pastor", "con refresco"], c, ORG);
    expect(c.llamadas).toEqual([]);
  });
  it("rafaga partida: ningun mensaje solo es peticion, pero juntos si -> el clasificador lee los ultimos mensajes JUNTOS", async () => {
    const c = falso({ "paren | de molestarme con eso": R("revocacion_contacto", 0.9, "oposicion") });
    const r = await intencionesPorMensaje(["paren", "de molestarme con eso"], c, ORG);
    expect(c.llamadas).toContain("paren | de molestarme con eso");
    expect(r.some((x) => x.intent.kind === "request")).toBe(true);
  });
  it("la ventana de rafaga no se usa si algun mensaje ya fue peticion", async () => {
    const c = falso({});
    await intencionesPorMensaje(["borren mis datos", "gracias"], c, ORG);
    expect(c.llamadas.some((t) => t.includes(" | "))).toBe(false);
  });
  it("datos de otra persona: el modelo no lo convierte en solicitud", async () => {
    const c = falso({});
    const r = await intencionesPorMensaje(["borren los datos personales de mi esposa"], c, ORG);
    expect(r[0]!.intent.kind).toBe("third_party");
  });
});
