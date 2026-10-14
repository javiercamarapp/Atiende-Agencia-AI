// Ambiente y tecleo en la llamada del worker: se arma el mezclador con lo que trae el contexto, las herramientas de AMBOS motores avisan inicio/fin y el cliente
// que habla corta el tecleo. Telefonia falsa + proveedor guionado + API real en proceso: sin red ni reloj real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import { AJUSTES_AGENTE_POR_DEFECTO, InMemoryAjustesAgenteRepository } from "@atiende/domain-restaurantes";
import { Worker } from "../src/worker.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { HERRAMIENTAS_SIN_TECLEO, semillaDeLlamada } from "../src/llamada.ts";
import { TOOL_CONFIRMAR_TELEFONO } from "../src/telefono-llamante.ts";
import type { OpcionesLlamadaFalsa } from "../src/telefonia/falsa.ts";
import { leerSonidoLlamada } from "../src/api-cliente.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import type { TurnoGuion } from "./support/agente-guionado.ts";
import { callar, hablar, turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const SIP_DESDE = "+5219991234567";
const GUION: TurnoGuion[] = [
  { cliente: "Sí, autorizo que se grabe la llamada", agente: [{ dice: "Gracias, queda registrado. ¿Qué desea pedir?" }] },
  { cliente: "Quiero hacer un pedido", agente: [{ tool: "buscar_cliente", args: {} }, { tool: "buscar_cliente", args: {} }, { dice: "Con gusto, dígame qué le preparo." }] },
];

const PRESET = { ...AJUSTES_AGENTE_POR_DEFECTO, vozFondoActivo: true, vozFondoVolumen: 7, vozFondoPreset: "sala-tranquila", vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: true } as const;

async function llamar(ajustes: InMemoryAjustesAgenteRepository | undefined) {
  const api = await crearMundoApi({ ...(ajustes ? { ajustesAgente: ajustes } : {}) });
  const telefonia = new TelefoniaFalsa();
  const agente = new AgenteGuionado(GUION);
  const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
  expect(await worker.iniciar()).toBe(true);
  const antes = worker.salud().llamadasAtendidas;
  const llamada = telefonia.llamar({ id: "llamada-sonido", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
  await turnoCliente(llamada, api.reloj, () => agente.respondidos, 2);
  llamada.clienteCuelga();
  await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 5_000, interval: 5 });
  return { api, llamada, agente };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("ambiente y tecleo en la llamada", () => {
  it("con el preset guardado: el mezclador se abre con el preset y los volumenes de los ajustes, y la voz del agente sale por el", async () => {
    const ajustes = new InMemoryAjustesAgenteRepository();
    const api = await crearMundoApi({ ajustesAgente: ajustes });
    await ajustes.guardar(api.mundo.organizationId, "u", PRESET);
    const telefonia = new TelefoniaFalsa();
    const agente = new AgenteGuionado(GUION);
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
    await worker.iniciar();
    const llamada = telefonia.llamar({ id: "llamada-sonido", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    const m = llamada.salidaMezclada!;
    expect(m).not.toBeNull();
    expect(m.ambiente).toMatchObject({ volumen: 7, preset: "sala-tranquila" });
    expect(m.tecleo).toMatchObject({ volumen: 12 });
    // Con el mezclador abierto, la voz NO usa `tel.reproducir`: sale por las tramas mezcladas.
    await vi.waitFor(() => expect(llamada.tramasMezcladas.length).toBeGreaterThan(0), { timeout: 5_000, interval: 5 });
    expect(llamada.salida).toHaveLength(0);
    llamada.clienteCuelga();
  });

  it("sin ajustes (base sin migrar / API vieja) la llamada suena como siempre: sin mezclador y por tel.reproducir", async () => {
    const { llamada } = await llamar(undefined);
    expect(llamada.salidaMezclada).toBeNull();
    expect(llamada.salida.length).toBeGreaterThan(0);
  });

  it("ajustes con todo apagado: tampoco se abre el mezclador", async () => {
    const ajustes = new InMemoryAjustesAgenteRepository();
    const api = await crearMundoApi({ ajustesAgente: ajustes });
    await ajustes.guardar(api.mundo.organizationId, "u", { ...AJUSTES_AGENTE_POR_DEFECTO });
    const telefonia = new TelefoniaFalsa();
    const agente = new AgenteGuionado(GUION);
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
    await worker.iniciar();
    const llamada = telefonia.llamar({ id: "llamada-apagada", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    expect(llamada.salidaMezclada).toBeNull();
    llamada.clienteCuelga();
  });

  it("cada herramienta (de cualquier motor: todas pasan por el ejecutor) avisa inicio y fin al tecleo, balanceados", async () => {
    const ajustes = new InMemoryAjustesAgenteRepository();
    const eventos: string[] = [];
    const api = await crearMundoApi({ ajustesAgente: ajustes });
    await ajustes.guardar(api.mundo.organizationId, "u", PRESET);
    const telefonia = new TelefoniaFalsa();
    const agente = new AgenteGuionado(GUION);
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
    await worker.iniciar();
    const llamada = telefonia.llamar({ id: "llamada-herr", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    const m = llamada.salidaMezclada!;
    const ini = m.herramientaInicia.bind(m);
    const fin = m.herramientaTermina.bind(m);
    m.herramientaInicia = (id) => (eventos.push(`i:${id}`), ini(id));
    m.herramientaTermina = (id, ok) => (eventos.push(`t:${id}:${ok}`), fin(id, ok));
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 2);
    llamada.clienteCuelga();
    expect(eventos.filter((e) => e.startsWith("i:"))).toHaveLength(2);
    expect(eventos.filter((e) => e.startsWith("t:"))).toHaveLength(2);
    expect(eventos[0]!.startsWith("i:")).toBe(true);
    expect(m.tecleo!.herramientasEnVuelo).toBe(0);
  });

  it("el cliente que habla avisa al mezclador (baja el ambiente y corta el tecleo) y al callar lo suelta", async () => {
    const ajustes = new InMemoryAjustesAgenteRepository();
    const api = await crearMundoApi({ ajustesAgente: ajustes });
    await ajustes.guardar(api.mundo.organizationId, "u", PRESET);
    const telefonia = new TelefoniaFalsa();
    const agente = new AgenteGuionado(GUION);
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
    await worker.iniciar();
    const llamada = telefonia.llamar({ id: "llamada-cliente", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    const m = llamada.salidaMezclada!;
    const cortar = vi.spyOn(m.tecleo!, "clienteHabla");
    await hablar(llamada, api.reloj, 400);
    expect(m.clienteHablando).toBe(true);
    expect(cortar).toHaveBeenCalled();
    await callar(llamada, api.reloj, 900);
    expect(m.clienteHablando).toBe(false);
    llamada.clienteCuelga();
  });
});

async function conPreset(fake: OpcionesLlamadaFalsa = {}, extraDeps: Record<string, unknown> = {}) {
  const ajustes = new InMemoryAjustesAgenteRepository();
  const api = await crearMundoApi({ ajustesAgente: ajustes });
  await ajustes.guardar(api.mundo.organizationId, "u", PRESET);
  const telefonia = new TelefoniaFalsa();
  const agente = new AgenteGuionado(GUION);
  const eventos: { evento: string; campos: Record<string, string | number | boolean> }[] = [];
  const worker = new Worker({
    config: api.config,
    telefonia,
    log: () => undefined,
    deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }), log: (l) => void eventos.push({ evento: l.evento, campos: { ...l.campos } }), ...extraDeps }),
  });
  await worker.iniciar();
  const antes = worker.salud().llamadasAtendidas;
  const llamada = telefonia.llamar({ id: "llamada-cierre", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE, ...fake });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  const termino = (): Promise<void> => vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(antes + 1), { timeout: 3_000, interval: 5 });
  return { api, llamada, agente, eventos, termino, worker };
}

describe("cierre de la llamada con la salida mezclada (sin cuelgues)", () => {
  it("el cliente cuelga con voz del agente EN COLA y nadie la consume (bombeo parado, la telefonia no libera nada): la llamada igual cierra, cuelga y registra", async () => {
    const t = await conPreset({ vaciarMezclada: false, liberarMezcladaAlColgar: false });
    expect(t.llamada.salidaMezclada!.pendientes).toBeGreaterThan(0); // el saludo sigue en la cola: nadie la oyo
    t.llamada.clienteCuelga();
    await t.termino(); // antes del arreglo esto se quedaba esperando para siempre en `puente.vaciar()`
    expect(t.llamada.colgadaPorSistema).toBe(true);
    expect(t.llamada.salidaMezclada!.pendientes).toBe(0);
    expect(t.eventos.some((e) => e.evento === "atencion_fin")).toBe(true);
  });

  it("si el bombeo FALLA a media llamada: se registra un codigo sin PII, el mezclador se apaga y la voz siguiente sale por tel.reproducir sin mezcla", async () => {
    const t = await conPreset();
    await vi.waitFor(() => expect(t.llamada.tramasMezcladas.length).toBeGreaterThan(0), { timeout: 3_000, interval: 5 });
    t.llamada.fallarSalidaMezclada("TypeError");
    expect(t.eventos.find((e) => e.evento === "sonido_mezclador_fallo")?.campos).toMatchObject({ codigo: "TypeError" });
    const antes = t.llamada.salida.length;
    await turnoCliente(t.llamada, t.api.reloj, () => t.agente.respondidos, 1);
    await vi.waitFor(() => expect(t.llamada.salida.length).toBeGreaterThan(antes), { timeout: 3_000, interval: 5 });
    t.llamada.clienteCuelga();
    await t.termino();
  });

  it("registra, sin PII, el retraso de cola que anadio el bombeo a las respuestas (p50/p95)", async () => {
    const t = await conPreset();
    for (const ms of [40, 60, 80]) t.llamada.tomarVoz(ms);
    t.llamada.clienteCuelga();
    await t.termino();
    expect(t.eventos.find((e) => e.evento === "salida_cola_p50")?.campos).toMatchObject({ ms: 60, intento: 3 });
    expect(t.eventos.find((e) => e.evento === "salida_cola_p95")?.campos).toMatchObject({ ms: 80 });
  });

  it("el log del sonido solo lleva campos permitidos (nada de PII)", async () => {
    const t = await conPreset();
    t.llamada.clienteCuelga();
    await t.termino();
    const campos = t.eventos.find((e) => e.evento === "sonido_ambiente")?.campos ?? {};
    expect(campos).toMatchObject({ mensaje: "fondo+tecleo" });
    expect(Object.keys(campos).sort()).toEqual(["callRef", "mensaje"]);
  });

  it("escalar a una persona y registrar el telefono dictado no hacen sonar el tecleo", () => {
    expect(HERRAMIENTAS_SIN_TECLEO.has("escalar_a_humano")).toBe(true);
    expect(HERRAMIENTAS_SIN_TECLEO.has(TOOL_CONFIRMAR_TELEFONO)).toBe(true);
    expect(HERRAMIENTAS_SIN_TECLEO.has("cotizar_pedido")).toBe(false);
  });
});

describe("temperatura de la voz de los ajustes", () => {
  async function conTemperatura(vozTemperatura: number | null) {
    const ajustes = new InMemoryAjustesAgenteRepository();
    const api = await crearMundoApi({ ajustesAgente: ajustes });
    await ajustes.guardar(api.mundo.organizationId, "u", { ...AJUSTES_AGENTE_POR_DEFECTO, vozTemperatura });
    const telefonia = new TelefoniaFalsa();
    const agente = new AgenteGuionado(GUION);
    const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
    await worker.iniciar();
    const llamada = telefonia.llamar({ id: "llamada-temp", dnis: NUMERO_SUCURSAL, desde: SIP_DESDE });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.clienteCuelga();
    return agente.aperturas[0]!;
  }

  it("la temperatura elegida llega a la apertura de la sesion del proveedor (Gemini Live y cascada la leen de ahi)", async () => {
    expect((await conTemperatura(0.4)).temperatura).toBe(0.4);
  });

  it("una temperatura mayor al tope llega a la apertura ya bajada a 0.4 (el worker no confia solo en la API)", async () => {
    expect((await conTemperatura(0.9)).temperatura).toBe(0.4);
  });

  it("sin temperatura en los ajustes la apertura no la fija (manda la de la plataforma)", async () => {
    const apertura = await conTemperatura(null);
    expect(apertura.temperatura ?? null).toBeNull();
  });
});

describe("contratos de entrada del sonido que manda la API", () => {
  it("lo invalido se descarta como 'sin sonido' (nunca rompe la llamada)", () => {
    for (const malo of [0, "", null, false, [], {}, undefined, { fondo: 1, tecleo: "x" }, { fondo: { activo: true, volumen: 99, preset: "cocina-taqueria" }, tecleo: { activo: true, volumen: 99 } }, { fondo: { activo: true, volumen: 5, preset: "x" } }]) {
      expect(leerSonidoLlamada(malo)).toBeNull();
    }
  });

  it("lo valido se acepta y una mitad invalida se apaga sin tumbar la otra", () => {
    expect(leerSonidoLlamada({ fondo: { activo: true, volumen: 7, preset: "calle-ocupada" }, tecleo: { activo: true, volumen: 12 } })).toEqual({ fondo: { activo: true, volumen: 7, preset: "calle-ocupada" }, tecleo: { activo: true, volumen: 12 } });
    expect(leerSonidoLlamada({ fondo: { activo: true, volumen: 7, preset: "calle-ocupada" }, tecleo: { activo: true, volumen: 99 } })).toEqual({ fondo: { activo: true, volumen: 7, preset: "calle-ocupada" }, tecleo: { activo: false, volumen: 0 } });
  });

  it("la semilla de la llamada es estable por callId y distinta entre llamadas", () => {
    expect(semillaDeLlamada("a")).toBe(semillaDeLlamada("a"));
    expect(semillaDeLlamada("a")).not.toBe(semillaDeLlamada("b"));
    expect(Number.isInteger(semillaDeLlamada(""))).toBe(true);
  });
});
