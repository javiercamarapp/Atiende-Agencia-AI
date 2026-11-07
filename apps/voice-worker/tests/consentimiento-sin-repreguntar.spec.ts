// Consentimiento de grabacion (E2E LiveKit 6/7-nov-2026): el cliente contestaba el aviso con su pedido («quiero un cuarto de bistec...») y el worker le mandaba al agente
// «repita la pregunta de grabacion» A LA VEZ que el turno del pedido: el agente decia «no lo escuché bien, ¿autoriza...?» y el pedido se perdia. Regla: si la respuesta
// ambigua ya trae contenido (el cliente siguio con lo suyo), NO se repregunta: la llamada sigue sin grabar (lo conservador). Solo una respuesta corta y confusa
// («¿mande?», «¿cómo?») repite la pregunta.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import { Worker } from "../src/worker.ts";
import { TelefoniaFalsa } from "../src/telefonia/falsa.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import type { TurnoGuion } from "./support/agente-guionado.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function llamar(guion: TurnoGuion[]) {
  const api = await crearMundoApi();
  const telefonia = new TelefoniaFalsa();
  const agente = new AgenteGuionado(guion);
  const worker = new Worker({ config: api.config, telefonia, log: () => undefined, deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada([agente.escalon()], { ahora: api.reloj.ahora }) }) });
  expect(await worker.iniciar()).toBe(true);
  const llamada = telefonia.llamar({ id: "llamada-consent", dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  for (let i = 1; i <= agente.turnos.length; i++) await turnoCliente(llamada, api.reloj, () => agente.respondidos, i);
  llamada.clienteCuelga();
  await vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(1), { timeout: 5_000, interval: 5 });
  const repreguntas = agente.textosRecibidos.filter((t) => /pregunta de grabaci/i.test(t));
  return { api, agente, repreguntas };
}

describe("consentimiento: no se repregunta si el cliente ya siguio con su pedido", () => {
  it("el cliente contesta el aviso con su pedido: NO se repite la pregunta de grabacion y la llamada sigue sin grabar", async () => {
    const { repreguntas, api } = await llamar([
      { cliente: "Quiero un cuarto de kilo de bistec y medio kilo de pastor para recoger", agente: [{ dice: "Claro, un cuarto de bistec y medio de pastor." }] },
      { cliente: "Sí, eso es todo", agente: [{ dice: "Perfecto." }] },
    ]);
    expect(repreguntas).toEqual([]);
    expect(api.peticiones.filter((r) => r.includes("/consentimiento-grabacion"))).toHaveLength(1);
  });

  it("una respuesta corta y confusa («¿mande?») SI repite la pregunta una vez", async () => {
    const { repreguntas } = await llamar([
      { cliente: "¿Mande?", agente: [{ dice: "¿Autoriza grabar la llamada?" }] },
      { cliente: "Sí", agente: [{ dice: "Gracias. ¿Qué le gustaría pedir?" }] },
    ]);
    expect(repreguntas).toHaveLength(1);
  });
});
