// Ayudantes para conducir una llamada simulada por la telefonia falsa: el cliente habla (tono) y calla (silencio) con el reloj manual. Cada trozo de
// 20 ms cede el turno al bucle de eventos para que el proveedor guionado y la API en proceso avancen como en tiempo real.
import { expect, vi } from "vitest";
import type { LlamadaFalsa } from "../../src/telefonia/falsa.ts";
import { silencio, tono } from "./audio.ts";
import type { RelojManual } from "./mundo-api.ts";

const HZ = 8_000;
const CHUNK_MS = 20;
const cederTurno = (): Promise<void> => new Promise((r) => setImmediate(r));

export async function hablar(llamada: LlamadaFalsa, reloj: RelojManual, ms = 800, hz = HZ): Promise<void> {
  for (let t = 0; t < ms; t += CHUNK_MS) {
    reloj.avanzar(CHUNK_MS);
    llamada.hablar(tono(hz, CHUNK_MS, 300, 0.4), hz);
    await cederTurno();
  }
}

export async function callar(llamada: LlamadaFalsa, reloj: RelojManual, ms = 900, hz = HZ): Promise<void> {
  for (let t = 0; t < ms; t += CHUNK_MS) {
    reloj.avanzar(CHUNK_MS);
    llamada.hablar(silencio(hz, CHUNK_MS), hz);
    await cederTurno();
  }
}

/** Un turno del cliente: habla, calla y espera a que el proveedor guionado haya contestado `esperado` veces. */
export async function turnoCliente(llamada: LlamadaFalsa, reloj: RelojManual, respondidos: () => number, esperado: number, hz = HZ): Promise<void> {
  await hablar(llamada, reloj, 800, hz);
  await callar(llamada, reloj, 900, hz);
  await vi.waitFor(() => expect(respondidos()).toBeGreaterThanOrEqual(esperado), { timeout: 5_000, interval: 5 });
}
