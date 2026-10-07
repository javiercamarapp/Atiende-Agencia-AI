// Arma un worker con telefonia falsa sobre un mundo de API, listo para recibir llamadas simuladas.
import { expect, vi } from "vitest";
import { crearEscaleraLlamada } from "@atiende/voice-core";
import type { EscalonLlamada } from "@atiende/voice-core";
import type { DepsAtencion } from "../../src/llamada.ts";
import { TelefoniaFalsa } from "../../src/telefonia/falsa.ts";
import { Worker } from "../../src/worker.ts";
import type { MundoApi } from "./mundo-api.ts";

export async function escenario(api: MundoApi, escalones: () => EscalonLlamada[], extra: Partial<DepsAtencion> = {}) {
  const telefonia = new TelefoniaFalsa();
  const worker = new Worker({
    config: api.config,
    telefonia,
    log: () => undefined,
    deps: api.depsAtencion({ crearEscalera: () => crearEscaleraLlamada(escalones(), { ahora: api.reloj.ahora }), ...extra }),
  });
  expect(await worker.iniciar()).toBe(true);
  return {
    telefonia,
    worker,
    esperarFin: (n = 1) => vi.waitFor(() => expect(worker.salud().llamadasAtendidas).toBe(n), { timeout: 5_000, interval: 5 }),
  };
}
