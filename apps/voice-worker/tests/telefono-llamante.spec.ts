// Caller ID con desvio condicional: puede llegar el numero de la SUCURSAL en vez del cliente (la red re-origina la llamada) o nada. Pruebas con INVITEs
// simulados (atributos SIP que entrega LiveKit) de los tres casos: cliente directo, desvio CON caller ID del cliente y desvio SIN caller ID / con el de la
// sucursal; y de punta a punta contra la API real en proceso: el token solo se emite con un telefono confiable o con el que el cliente dicta y confirma.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPARADOR_SALUDO } from "../src/llamada.ts";
import { cargarConfig, normalizarNumero } from "../src/config.ts";
import type { EntradaDnis } from "../src/config.ts";
import { infoDeParticipanteSip } from "../src/telefonia/sip-atributos.ts";
import { INSTRUCCION_TELEFONO_NO_CONFIABLE, TOOL_CONFIRMAR_TELEFONO, numerosDeCabeceraDesvio, resolverTelefonoLlamante } from "../src/telefono-llamante.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

void DISPARADOR_SALUDO;
const BRIDGE = "+52 999 111 0001";
const LINEA_SUCURSAL = "+52 999 222 0002"; // la linea Telmex de la sucursal que desvia al puente
const CLIENTE = "+5219993334444";

const ENTRADA: EntradaDnis = {
  orgSlug: "los-taquitos-de-pm",
  organizationId: "00000000-0000-4000-8000-000000000001",
  propertyId: "00000000-0000-4000-8000-0000000000a1",
  branchSlug: "fco-montejo",
  secreto: "s",
  secretoEnv: "VOICE_SECRET_FCO",
  topeMensualUsd: null,
  modoEntrada: "desborde",
  numerosSucursal: ["9992220002"],
};
const PUENTES = new Set(["9991110001", "9991110099"]);

/** INVITE simulado: lo que LiveKit entrega al worker como atributos del participante SIP. */
function invite(atributos: Record<string, string>) {
  return infoDeParticipanteSip(atributos);
}
const resolver = (atributos: Record<string, string>) => {
  const info = invite(atributos);
  return resolverTelefonoLlamante({ sipFrom: info.sipFrom, desviadaDesde: info.desviadaDesde, entrada: ENTRADA, numerosPuente: PUENTES });
};

describe("resolverTelefonoLlamante con INVITEs simulados", () => {
  it("1) cliente directo: el From es el del cliente -> confiable, no desviada", () => {
    expect(resolver({ "sip.phoneNumber": CLIENTE, "sip.trunkPhoneNumber": BRIDGE })).toEqual({ telefono: "9993334444", confiable: true, motivo: "ok", desviada: false });
  });

  it("2) desvio CON caller ID del cliente: el From es el del cliente y la Diversion trae la linea de la sucursal -> confiable y desviada", () => {
    const r = resolver({ "sip.phoneNumber": CLIENTE, "sip.trunkPhoneNumber": BRIDGE, "sip.h.diversion": `<sip:${LINEA_SUCURSAL.replace(/\s/g, "")}@telmex.invalid>;reason=no-answer;counter=1` });
    expect(r).toEqual({ telefono: "9993334444", confiable: true, motivo: "ok", desviada: true });
  });

  it("3a) desvio SIN caller ID (anonimo): no hay telefono confiable", () => {
    const r = resolver({ "sip.phoneNumber": "anonymous", "sip.trunkPhoneNumber": BRIDGE, "sip.h.diversion": `<sip:${LINEA_SUCURSAL.replace(/\s/g, "")}@telmex.invalid>;reason=user-busy` });
    expect(r).toEqual({ telefono: null, confiable: false, motivo: "anonimo", desviada: true });
  });

  it("3b) desvio re-originado: el From es la linea de la SUCURSAL declarada -> no confiable", () => {
    expect(resolver({ "sip.phoneNumber": LINEA_SUCURSAL, "sip.trunkPhoneNumber": BRIDGE, "sip.h.diversion": "<sip:+529992220002@telmex.invalid>" })).toMatchObject({ telefono: null, confiable: false, motivo: "numero_sucursal", desviada: true });
  });

  it("3c) re-originado SIN que la sucursal haya declarado su linea: el numero de la Diversion lo delata -> no confiable", () => {
    const r = resolverTelefonoLlamante({ sipFrom: invite({ "sip.phoneNumber": "+529995550000" }).sipFrom, desviadaDesde: "<sip:+52 999 555 0000@telmex.invalid>;reason=no-answer", entrada: { ...ENTRADA, numerosSucursal: [] }, numerosPuente: PUENTES });
    expect(r).toMatchObject({ telefono: null, confiable: false, motivo: "numero_de_desvio" });
  });

  it("3d) el From es un numero puente de la tabla DNIS (el propio puente re-origino) -> no confiable", () => {
    expect(resolver({ "sip.phoneNumber": "+5219991110099" })).toMatchObject({ confiable: false, motivo: "numero_puente" });
  });

  it("3e) sin From en absoluto (atributo ausente o vacio) -> no confiable", () => {
    expect(resolver({ "sip.trunkPhoneNumber": BRIDGE })).toMatchObject({ confiable: false, motivo: "sin_from", desviada: false });
    expect(resolver({ "sip.phoneNumber": "  ", "sip.trunkPhoneNumber": BRIDGE })).toMatchObject({ confiable: false, motivo: "sin_from" });
  });

  it.each(["unavailable", "restricted", "private", "withheld"])("el origen '%s' tampoco es un telefono", (v) => {
    expect(resolver({ "sip.phoneNumber": v })).toMatchObject({ confiable: false, motivo: "anonimo" });
  });

  it("un From que no es un telefono mexicano valido no es confiable", () => {
    expect(resolver({ "sip.phoneNumber": "12345" })).toMatchObject({ confiable: false, motivo: "anonimo" });
  });
});

describe("numerosDeCabeceraDesvio (Diversion / History-Info)", () => {
  it("extrae el numero de sip: y tel: en distintas formas y varias entradas", () => {
    expect(numerosDeCabeceraDesvio('"Sucursal" <sip:+529992220002@telmex.invalid>;reason=no-answer')).toEqual(["9992220002"]);
    expect(numerosDeCabeceraDesvio("<sip:+5219990001111@h?Reason=SIP%3Bcause%3D486>;index=1,<sip:+5219990002222@h>;index=1.1")).toEqual(["9990001111", "9990002222"]);
    expect(numerosDeCabeceraDesvio("<tel:+52-999-222-0002>")).toEqual(["9992220002"]);
  });
  it("vacio, ausente, enorme o sin numeros: lista vacia", () => {
    expect(numerosDeCabeceraDesvio(null)).toEqual([]);
    expect(numerosDeCabeceraDesvio("")).toEqual([]);
    expect(numerosDeCabeceraDesvio("<sip:anonymous@anonymous.invalid>")).toEqual([]);
    expect(numerosDeCabeceraDesvio(`<sip:+5299922200${"0".repeat(2000)}@h>`)).toEqual([]);
  });
});

describe("VOICE_DNIS_MAP: numerosSucursal", () => {
  const base = { orgSlug: "los-taquitos-de-pm", organizationId: ENTRADA.organizationId, propertyId: ENTRADA.propertyId, branchSlug: "fco-montejo", secretoEnv: "VOICE_SECRET_FCO" };
  const env = (extra: unknown) => ({ LIVEKIT_URL: "wss://x.invalid", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s", ATIENDE_API_URL: "http://a.invalid", INTERNAL_SECRET: "i", GEMINI_API_KEY: "g", VOICE_SECRET_FCO: "s", VOICE_DNIS_MAP: JSON.stringify({ [BRIDGE]: { ...base, ...(extra as object) } }) });
  it("normaliza a 10 digitos, quita repetidos y por omision es vacia", () => {
    const c = cargarConfig(env({ numerosSucursal: ["+52 999 222 0002", "9992220002", "(999) 333-0003"] }));
    expect(c.motivos).toEqual([]);
    expect(c.dnis.get(normalizarNumero(BRIDGE)!)?.numerosSucursal).toEqual(["9992220002", "9993330003"]);
    expect(cargarConfig(env({})).dnis.get("9991110001")?.numerosSucursal).toEqual([]);
  });
  it.each([["no es lista", "9992220002"], ["numero corto", ["123"]], ["no es texto", [5]]])("rechaza %s", (_n, valor) => {
    const c = cargarConfig(env({ numerosSucursal: valor }));
    expect(c.estado).toBe("no_configurado");
    expect(c.motivos.join(" ")).toContain("numerosSucursal");
  });
});

// El contexto de la API usa la hora real: se fija solo `Date` (mismo criterio que llamada-casos.spec.ts).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const tokensPedidos = (peticiones: readonly string[]): number => peticiones.filter((p) => p.includes("/voice/call-token")).length;
const cuerposToken = (cuerpos: Map<string, unknown[]>) => [...cuerpos.entries()].filter(([k]) => k.endsWith("/voice/call-token")).flatMap(([, v]) => v as { caller_phone: string; telefono_declarado?: boolean }[]);

describe("de punta a punta: cliente directo", () => {
  it("el token se emite al abrir con el telefono del From, sin la herramienta del worker ni el anexo a la instruccion", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([{ cliente: "Hola", agente: [{ tool: "buscar_cliente", args: {} }] }]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-directa", dnis: NUMERO_SUCURSAL, desde: CLIENTE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    expect(cuerposToken(api.cuerpos).map((c) => normalizarNumero(c.caller_phone))).toEqual(["9993334444"]);
    expect(cuerposToken(api.cuerpos).some((c) => c.telefono_declarado === true)).toBe(false);
    expect(agente.aperturas[0]!.herramientas.map((h) => h.name)).not.toContain(TOOL_CONFIRMAR_TELEFONO);
    expect(agente.aperturas[0]!.instruccion).not.toContain(INSTRUCCION_TELEFONO_NO_CONFIABLE);
    expect(agente.resultados[0]!.resultado).not.toMatchObject({ error: "telefono_pendiente" });
    llamada.clienteCuelga();
    await t.esperarFin();
  });
});

describe("de punta a punta: desvio con caller ID del cliente", () => {
  it("es confiable (la Diversion trae la linea de la sucursal, no el From) y la llamada queda marcada como desborde", async () => {
    const api = await crearMundoApi({ numerosSucursal: [LINEA_SUCURSAL] });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-desv-ok", dnis: NUMERO_SUCURSAL, desde: CLIENTE, desviadaDesde: "<sip:+529992220002@telmex.invalid>;reason=no-answer" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    expect(cuerposToken(api.cuerpos).map((c) => normalizarNumero(c.caller_phone))).toEqual(["9993334444"]);
    expect(agente.aperturas[0]!.herramientas.map((h) => h.name)).not.toContain(TOOL_CONFIRMAR_TELEFONO);
    await vi.waitFor(() => expect(api.llamadaRepo.modos.size).toBe(1), { timeout: 5_000, interval: 5 });
    expect([...api.llamadaRepo.modos.values()][0]).toMatchObject({ modo: "desborde" });
    llamada.clienteCuelga();
    await t.esperarFin();
  });
});

describe("de punta a punta: desvio SIN caller ID o con el de la sucursal", () => {
  const casos: [string, { desde: string | null | undefined; desviadaDesde: string }][] = [
    ["anonimo", { desde: null, desviadaDesde: "<sip:+529992220002@telmex.invalid>" }],
    ["sin From", { desde: undefined, desviadaDesde: "<sip:+529992220002@telmex.invalid>" }],
    ["el From es la linea de la sucursal", { desde: "+5219992220002", desviadaDesde: "<sip:+529992220002@telmex.invalid>" }],
  ];

  it.each(casos)("%s: no se emite token al abrir; la sesion recibe la instruccion de pedir el telefono y la herramienta del worker", async (_n, c) => {
    const api = await crearMundoApi({ numerosSucursal: [LINEA_SUCURSAL] });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-pend", dnis: NUMERO_SUCURSAL, ...c });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    expect(tokensPedidos(api.peticiones)).toBe(0);
    expect(agente.aperturas[0]!.instruccion).toContain(INSTRUCCION_TELEFONO_NO_CONFIABLE);
    expect(agente.aperturas[0]!.herramientas.map((h) => h.name)).toContain(TOOL_CONFIRMAR_TELEFONO);
    // Antes habia un `anonima` con pregrabado de persona: ahora SE ATIENDE (no cuelga ni escala).
    expect(llamada.colgadaPorSistema).toBe(false);
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(t.worker.resumenes[0]?.resultado).toBe("abandonado");
  });

  it("antes de confirmar, ninguna herramienta corre (telefono_pendiente); con el telefono dictado se emite el token con ESE numero y las herramientas funcionan", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([
      {
        cliente: "Mi número es nueve nueve nueve, uno dos tres, cuatro cinco seis siete",
        agente: [
          { tool: "buscar_cliente", args: {} },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "999 123 45 67" } },
          { tool: "buscar_cliente", args: {} },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "999 000 11 22" } },
        ],
      },
    ]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-dicta", dnis: NUMERO_SUCURSAL, desde: null, desviadaDesde: "<sip:+529992220002@telmex.invalid>" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);

    expect(agente.resultados[0]!.resultado).toMatchObject({ error: "telefono_pendiente" });
    expect(agente.resultados[1]!.resultado).toMatchObject({ ok: true });
    expect(agente.resultados[2]!.resultado).not.toMatchObject({ error: "telefono_pendiente" });
    // Una sola emision, con el telefono canonico dictado; un segundo numero NO cambia la identidad de la llamada.
    expect(cuerposToken(api.cuerpos).map((c) => normalizarNumero(c.caller_phone))).toEqual(["9991234567"]);
    // El telefono dictado viaja marcado: la API no le devuelve nombre, direcciones ni pedidos de ese numero (nadie verifico que sea del llamante).
    expect(cuerposToken(api.cuerpos).every((c) => c.telefono_declarado === true)).toBe(true);
    expect(agente.resultados[3]!.resultado).toMatchObject({ ok: true, ya_registrado: true });
    llamada.clienteCuelga();
    await t.esperarFin();
  });

  it("rechaza un numero invalido y el de la sucursal / del puente como telefono del cliente (sin emitir token)", async () => {
    const api = await crearMundoApi({ numerosSucursal: [LINEA_SUCURSAL] });
    const agente = new AgenteGuionado([
      {
        cliente: "es el de la tienda",
        agente: [
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "123" } },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "no es un numero" } },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "999 222 00 02" } },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "999 111 00 01" } },
          { tool: TOOL_CONFIRMAR_TELEFONO, args: {} },
        ],
      },
    ]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-mal", dnis: NUMERO_SUCURSAL, desde: undefined });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    expect(agente.resultados.map((r) => (r.resultado as { error?: string }).error)).toEqual(["telefono_invalido", "telefono_invalido", "telefono_no_valido", "telefono_no_valido", "telefono_invalido"]);
    expect(tokensPedidos(api.peticiones)).toBe(0);
    llamada.clienteCuelga();
    await t.esperarFin();
  });

  it("si la API no puede emitir el token, el agente recibe un error honesto y el telefono sigue pendiente (se puede reintentar)", async () => {
    const api = await crearMundoApi({ envExtra: { VOICE_SECRET_FCO: "otro-secreto-que-la-api-no-acepta" } });
    const agente = new AgenteGuionado([{ cliente: "mi numero", agente: [{ tool: TOOL_CONFIRMAR_TELEFONO, args: { numero: "9991234567" } }, { tool: "buscar_cliente", args: {} }] }]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-token-mal", dnis: NUMERO_SUCURSAL, desde: null });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    expect(agente.resultados[0]!.resultado).toMatchObject({ error: "no_se_pudo_registrar" });
    expect(agente.resultados[1]!.resultado).toMatchObject({ error: "telefono_pendiente" });
    llamada.clienteCuelga();
    await t.esperarFin();
  });
});
