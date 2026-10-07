// Casos de la atencion de una llamada: numero desconocido, interruptor por sucursal, tope mensual, DTMF, silencio, API caida,
// base sin migrar y caida de escalon a mitad de llamada. Cada caso corre contra la API real en proceso y afirma EFECTOS (que se pidio a la API, que
// sono, que se guardo), no solo estados.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MensajeId } from "@atiende/voice-core";
import { DISPARADOR_SALUDO } from "../src/llamada.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { hablar, turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";
import { mensajeQueSono } from "./support/mundo-api.ts";
import type { LlamadaFalsa } from "../src/telefonia/falsa.ts";

const SIP = "+5219991234567";

// El contexto de la API usa la hora real del servidor: se fija (solo `Date`) a 2026-03-10 18:00Z = 12:00 en Merida (UTC-6, sin horario de verano).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const sonidos = (l: LlamadaFalsa): (MensajeId | null)[] => l.salida.map((t) => mensajeQueSono(t.pcm, t.hz));
const pregrabadosQueSonaron = (l: LlamadaFalsa): MensajeId[] => sonidos(l).filter((m): m is MensajeId => m !== null);

// El llamante sin caller ID / con un caller ID que no es del cliente se cubre en `telefono-llamante.spec.ts` (el agente pide y confirma el telefono).

describe("numero marcado (DNIS) desconocido", () => {
  it("cuelga sin tocar la API ni abrir sesion: no se sabe a que restaurante pertenece", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-x", dnis: "+52 999 777 0000", desde: SIP });
    await t.esperarFin();
    expect(api.peticiones).toEqual([]);
    expect(agente.aperturasPedidas).toBe(0);
    expect(llamada.colgadaPorSistema).toBe(true);
    expect(t.worker.resumenes[0]?.resultado).toBe("dnis_desconocido");
  });
});

describe("interruptor por sucursal (voz_config.habilitado = false)", () => {
  it("contesta con el pregrabado de desborde segun la hora, deja un callback y NO abre sesion con Gemini", async () => {
    const api = await crearMundoApi({ habilitado: false });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-off", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();

    expect(agente.aperturasPedidas).toBe(0);
    expect(pregrabadosQueSonaron(llamada)).toHaveLength(1);
    expect(pregrabadosQueSonaron(llamada)[0]).toMatch(/^saludo_respaldo_(dias|tardes|noches)$/);
    expect(api.mundo.callbacks).toHaveLength(1);
    expect(api.mundo.callbacks[0]).toMatchObject({ reason: expect.any(String) });
    expect(t.worker.resumenes[0]).toMatchObject({ resultado: "escalado", costoMicroUsd: 0 });
    expect(api.llamadaRepo.eventos).toHaveLength(0);
  });

  it("el saludo pregrabado sigue la hora LOCAL de la sucursal (Merida), no la del servidor", async () => {
    const api = await crearMundoApi({ habilitado: false });
    const t = await escenario(api, () => [new AgenteGuionado([]).escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-hora", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();
    // El reloj de prueba es 2026-03-10 18:00Z = 12:00 en Merida (UTC-6): buenas tardes.
    expect(pregrabadosQueSonaron(llamada)).toEqual(["saludo_respaldo_tardes"]);
  });
});

describe("tope mensual de gasto de voz por organizacion", () => {
  it("con el gasto del mes en el tope, no se abre sesion: pregrabado `tope_mensual` + callback", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 5_000_000, topeMensualUsd: 5 });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-tope", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();
    expect(agente.aperturasPedidas).toBe(0);
    expect(pregrabadosQueSonaron(llamada)).toEqual(["tope_mensual"]);
    expect(api.mundo.callbacks).toHaveLength(1);
  });

  it("el gasto llega al 80 % del tope: la llamada SE atiende y se avisa al owner/admin una vez (nivel 80, con las cifras)", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 4_000_000, topeMensualUsd: 5 });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-80", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.cuerpos.get("/internal/restaurantes/voz/tope-mensual")).toEqual([{ organizationId: api.mundo.organizationId, propertyId: api.mundo.propertyId, nivel: "80", usadoMicroUsd: 4_000_000, limiteMicroUsd: 5_000_000 }]);
    expect(pregrabadosQueSonaron(llamada)).not.toContain("tope_mensual");
  });

  it("el gasto alcanza el tope: se rechaza la llamada y el aviso es de nivel `alcanzado`", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 5_000_000, topeMensualUsd: 5 });
    const t = await escenario(api, () => [new AgenteGuionado([]).escalon()]);
    t.telefonia.llamar({ id: "llamada-100", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();
    expect(api.cuerpos.get("/internal/restaurantes/voz/tope-mensual")).toMatchObject([{ nivel: "alcanzado", usadoMicroUsd: 5_000_000, limiteMicroUsd: 5_000_000 }]);
  });

  it("por debajo del 80 % o sin tope configurado no se avisa nada", async () => {
    const a = await crearMundoApi({ gastoPrevioMicroUsd: 3_999_999, topeMensualUsd: 5 });
    const ta = await escenario(a, () => [new AgenteGuionado([]).escalon()]);
    const la = ta.telefonia.llamar({ id: "llamada-79", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(a.peticiones.some((p) => p.endsWith("/conversaciones"))).toBe(true), { timeout: 5_000, interval: 5 });
    la.clienteCuelga();
    await ta.esperarFin();
    expect(a.cuerpos.has("/internal/restaurantes/voz/tope-mensual")).toBe(false);
    const b = await crearMundoApi({ gastoPrevioMicroUsd: 999_000_000 });
    const tb = await escenario(b, () => [new AgenteGuionado([]).escalon()]);
    const lb = tb.telefonia.llamar({ id: "llamada-sin-tope", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(b.peticiones.some((p) => p.endsWith("/conversaciones"))).toBe(true), { timeout: 5_000, interval: 5 });
    lb.clienteCuelga();
    await tb.esperarFin();
    expect(b.cuerpos.has("/internal/restaurantes/voz/tope-mensual")).toBe(false);
  });

  it("por debajo del tope la llamada se atiende", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 4_999_999, topeMensualUsd: 5 });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-bajo", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(pregrabadosQueSonaron(llamada)).not.toContain("tope_mensual");
  });

  it("el tope de plataforma (VOICE_TOPE_MENSUAL_USD) aplica cuando la organizacion no lo sobreescribe", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 2_000_000, envExtra: { VOICE_TOPE_MENSUAL_USD: "2" } });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-plat", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();
    expect(agente.aperturasPedidas).toBe(0);
    expect(pregrabadosQueSonaron(llamada)).toEqual(["tope_mensual"]);
  });

  it("la sobreescritura de la organizacion gana al tope de plataforma", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 2_000_000, topeMensualUsd: 10, envExtra: { VOICE_TOPE_MENSUAL_USD: "2" } });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-org", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
  });

  it("base sin migrar (gasto no disponible): NO bloquea la llamada y el costo queda 'no disponible aun' sin romper nada", async () => {
    const api = await crearMundoApi({ gastoPrevioMicroUsd: 999_000_000, topeMensualUsd: 1 });
    api.llamadaRepo.disponible = false;
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-sinmigrar", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(pregrabadosQueSonaron(llamada)).not.toContain("tope_mensual");
    expect(t.worker.resumenes[0]?.resultado).toBe("abandonado");
    expect(api.llamadaRepo.eventos).toHaveLength(0);
    // La conversacion igual se cerro: lo que no existe aun es el costo y el modo de entrada, no la llamada.
    expect((await api.voz.listConversaciones(api.mundo.organizationId, api.mundo.propertyId, {})).valor.items[0]?.resultado).toBe("abandonado");
  });
});

describe("modo de entrada (desborde / total / prueba)", () => {
  it("un encabezado de desvio del conmutador marca la llamada como desborde", async () => {
    const api = await crearMundoApi();
    const t = await escenario(api, () => [new AgenteGuionado([]).escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-desv", dnis: NUMERO_SUCURSAL, desde: SIP, desviadaDesde: "<sip:+529991110000@conmutador>;reason=no-answer" });
    await vi.waitFor(() => expect(api.llamadaRepo.modos.size).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
    expect([...api.llamadaRepo.modos.values()]).toEqual([{ modo: "desborde", franja: "tarde" }]);
    expect(t.worker.resumenes[0]?.modoEntrada).toBe("desborde");
  });

  it("sin desvio rige lo configurado en la sucursal; `prueba` manda siempre", async () => {
    const a = await crearMundoApi({ modoEntrada: "desborde" });
    const ta = await escenario(a, () => [new AgenteGuionado([]).escalon()]);
    const la = ta.telefonia.llamar({ id: "llamada-cfg", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(a.llamadaRepo.modos.size).toBe(1), { timeout: 5_000, interval: 5 });
    la.clienteCuelga();
    await ta.esperarFin();
    expect([...a.llamadaRepo.modos.values()][0]?.modo).toBe("desborde");

    const b = await crearMundoApi({ modoEntrada: "prueba" });
    const tb = await escenario(b, () => [new AgenteGuionado([]).escalon()]);
    const lb = tb.telefonia.llamar({ id: "llamada-prueba", dnis: NUMERO_SUCURSAL, desde: SIP, desviadaDesde: "<sip:+529991110000@c>" });
    await vi.waitFor(() => expect(b.llamadaRepo.modos.size).toBe(1), { timeout: 5_000, interval: 5 });
    lb.clienteCuelga();
    await tb.esperarFin();
    expect([...b.llamadaRepo.modos.values()][0]?.modo).toBe("prueba");
  });

  it("base sin migrar (modo no disponible): la llamada se atiende igual", async () => {
    const api = await crearMundoApi();
    api.llamadaRepo.disponible = false;
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-sinmodo", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.llamadaRepo.modos.size).toBe(0);
    expect(t.worker.resumenes[0]?.modoEntrada).toBe("total");
  });
});

describe("DTMF y silencio", () => {
  it("el cliente marca 0: pregrabado de persona, callback y la llamada termina escalada", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-dtmf", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.teclear("0");
    await t.esperarFin();
    expect(pregrabadosQueSonaron(llamada)).toContain("handoff");
    expect(api.mundo.callbacks).toHaveLength(1);
    expect(t.worker.resumenes[0]?.resultado).toBe("escalado");
    expect(llamada.colgadaPorSistema).toBe(true);
  });

  it("el cliente guarda silencio: re-pregunta dos veces y a la tercera se despide y cuelga (abandonada)", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const reloj: { tick: (() => void) | null } = { tick: null };
    const t = await escenario(api, () => [agente.escalon()], {
      programar: (fn, ms) => {
        if (ms === 1000) reloj.tick = fn;
        return () => undefined;
      },
    });
    const llamada = t.telefonia.llamar({ id: "llamada-silencio", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await vi.waitFor(() => expect(reloj.tick).not.toBeNull());
    for (let s = 0; s < 40 && !llamada.terminada; s++) {
      api.reloj.avanzar(1_000);
      reloj.tick?.();
      await new Promise((r) => setImmediate(r));
    }
    await t.esperarFin();
    expect(pregrabadosQueSonaron(llamada)).toEqual(["silencio_reprompt", "silencio_reprompt", "silencio_despedida"]);
    expect(t.worker.resumenes[0]?.resultado).toBe("abandonado");
  });

  it("el reloj corta la llamada al llegar al tope de duracion: avisa a los 7 min y cierra a los 8 con callback", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const reloj: { tick: (() => void) | null } = { tick: null };
    const t = await escenario(api, () => [agente.escalon()], {
      // Con voz continua del cliente el silencio no cuenta: solo corre el reloj de duracion.
      programar: (fn, ms) => {
        if (ms === 1000) reloj.tick = fn;
        return () => undefined;
      },
    });
    const llamada = t.telefonia.llamar({ id: "llamada-larga", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await vi.waitFor(() => expect(reloj.tick).not.toBeNull());
    for (let s = 0; s < 500 && !llamada.terminada; s++) {
      await hablar(llamada, api.reloj, 20); // el cliente sigue hablando: sin silencio
      reloj.tick?.();
    }
    await t.esperarFin();
    const sonaron = pregrabadosQueSonaron(llamada);
    expect(sonaron).toContain("aviso_duracion");
    expect(sonaron).toContain("limite_duracion");
    expect(api.mundo.callbacks).toHaveLength(1);
  });
});

describe("API no disponible", () => {
  it("sin contexto (la voz no esta disponible en la API): pregrabado de falla, cuelga y NO abre sesion con el proveedor", async () => {
    const api = await crearMundoApi({ sinVozRepo: true });
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-api", dnis: NUMERO_SUCURSAL, desde: SIP });
    await t.esperarFin();
    expect(agente.aperturasPedidas).toBe(0);
    expect(pregrabadosQueSonaron(llamada)).toEqual(["proveedor_caido"]);
    expect(llamada.colgadaPorSistema).toBe(true);
    expect(t.worker.resumenes[0]?.resultado).toBe("api_no_disponible");
  });

  it("sin repositorio de privacidad: la llamada se atiende sin aviso ni grabacion (no se pide consentimiento)", async () => {
    const api = await crearMundoApi({ sinPrivacidad: true });
    const agente = new AgenteGuionado([{ cliente: "Hola", agente: [{ dice: "Con gusto." }] }]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-sinpriv", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    expect(agente.textosRecibidos[0]).toBe(DISPARADOR_SALUDO);
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.peticiones.some((p) => p.includes("/consentimiento-grabacion"))).toBe(false);
  });
});

describe("caida de escalon a mitad de llamada", () => {
  it("Gemini se cae y la cascada continua SIN volver a saludar; el costo queda desglosado por escalon", async () => {
    const api = await crearMundoApi();
    const gemini = new AgenteGuionado([{ cliente: "Hola, quiero hacer un pedido", agente: [{ dice: "Claro, con gusto. ¿Recoger o domicilio?" }] }]);
    const cascada = new AgenteGuionado([{ cliente: "A domicilio, por favor", agente: [{ dice: "Perfecto, ¿en qué colonia?" }] }]);
    const t = await escenario(api, () => [gemini.escalon("gemini-3.8-live"), cascada.escalon("cascada-openrouter")]);
    const llamada = t.telefonia.llamar({ id: "llamada-cae", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(gemini.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    // El saludo no tiene consentimiento pendiente que responder: el primer turno ya es el pedido (no se pide consentimiento a mano aqui).
    await turnoCliente(llamada, api.reloj, () => gemini.respondidos, 1);

    gemini.caer("ws_cerrado");
    await vi.waitFor(() => expect(cascada.aperturasPedidas).toBe(1), { timeout: 5_000, interval: 5 });

    // La cascada recibe el resumen REDACTADO de lo dicho y la orden de no saludar; nadie le manda otra vez el disparador del saludo.
    expect(cascada.aperturas[0]?.instruccion).toContain("continua sin volver a saludar");
    expect(cascada.aperturas[0]?.instruccion).toContain("Cliente: Hola, quiero hacer un pedido");
    expect(cascada.textosRecibidos.filter((x) => x.startsWith("(La llamada acaba de conectarse"))).toHaveLength(0);
    expect(gemini.textosRecibidos.filter((x) => x.startsWith("(La llamada acaba de conectarse"))).toHaveLength(1);

    // La llamada sigue por el segundo escalon: el cliente habla y la cascada contesta.
    await turnoCliente(llamada, api.reloj, () => cascada.respondidos, 1);
    llamada.clienteCuelga();
    await t.esperarFin();

    expect(t.worker.resumenes[0]?.resultado).toBe("abandonado");
    expect(api.llamadaRepo.eventos.map((e) => e.proveedor)).toEqual(["gemini-3.8-live", "cascada-openrouter"]);
    expect(api.llamadaRepo.eventos.every((e) => e.costoMicroUsd > 0)).toBe(true);
    // El error de proveedor quedo registrado como metrica operativa.
    expect(api.kpi.eventos.some((e) => e.tipo === "error_proveedor" && e.proveedor === "gemini")).toBe(true);
  });

  it("si ningun escalon vuelve a abrir: pregrabado de falla, callback y cuelga (nunca queda en silencio)", async () => {
    const api = await crearMundoApi();
    const gemini = new AgenteGuionado([]);
    const t = await escenario(api, () => [gemini.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-muere", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(gemini.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    gemini.fallasAlAbrir = 5;
    gemini.caer("ws_cerrado");
    await t.esperarFin();
    expect(pregrabadosQueSonaron(llamada)).toContain("proveedor_caido");
    expect(api.mundo.callbacks).toHaveLength(1);
    expect(t.worker.resumenes[0]?.resultado).toBe("escalado");
  });
});
