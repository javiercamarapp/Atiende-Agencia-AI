// El worker registra (sin PII, solo el conteo) los avisos de costo no finitos o negativos que la escalera descarto (EscaleraLlamada.costosInvalidos()).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EscalonLlamada } from "@atiende/voice-core";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function llamar(costosMalos: number[]) {
  const api = await crearMundoApi();
  const agente = new AgenteGuionado([]);
  const lineas: { evento: string; campos: Record<string, unknown> }[] = [];
  const escalon: EscalonLlamada = {
    id: "gemini-3.8-live",
    abrirSesion: async (apertura, h) => {
      const sesion = await agente.abrirSesion(apertura, h);
      for (const c of costosMalos) h.costo?.(c);
      return sesion;
    },
  };
  const t = await escenario(api, () => [escalon], { log: (l) => void lineas.push({ evento: l.evento, campos: { ...l.campos } }) });
  const llamada = t.telefonia.llamar({ id: `llamada-ci-${costosMalos.length}`, dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  llamada.clienteCuelga();
  await t.esperarFin();
  return lineas.filter((l) => l.evento === "costos_invalidos");
}

describe("costos invalidos en el cierre de la llamada", () => {
  it("NaN, Infinity y negativos se cuentan y se registran como evento con el conteo y nada mas", async () => {
    const lineas = await llamar([Number.NaN, Number.POSITIVE_INFINITY, -3]);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]!.campos).toMatchObject({ invalidos: 3 });
    expect(Object.keys(lineas[0]!.campos).sort()).toEqual(["callRef", "invalidos"]);
  });
  it("sin avisos invalidos no hay evento", async () => {
    expect(await llamar([])).toEqual([]);
  });
});
