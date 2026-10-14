// Ambiente y tecleo en la llamada del worker: se arma el mezclador con lo que trae el contexto, las herramientas de AMBOS motores avisan inicio/fin y el cliente
// que habla corta el tecleo. Telefonia falsa + proveedor guionado + API real en proceso: sin red ni reloj real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import { AJUSTES_AGENTE_POR_DEFECTO, InMemoryAjustesAgenteRepository } from "@atiende/domain-restaurantes";
import { Worker } from "../src/worker.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { semillaDeLlamada } from "../src/llamada.ts";
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
