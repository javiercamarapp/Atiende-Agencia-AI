// Latencia de ARRANQUE de la llamada: tiempo desde que entra la llamada hasta que el agente recibe la orden de saludar. Antes del cambio eran 5 viajes SECUENCIALES
// a la API antes de abrir la sesion (contexto, conversacion, modo de entrada, aviso de privacidad, token) y el aviso de tope; ahora son 2 olas (contexto -> conversacion +
// privacidad + token en paralelo) y lo no critico (modo de entrada, aviso de tope) corre en segundo plano. Con 150 ms por viaje se mide con reloj real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClienteApi } from "../src/api-cliente.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const VIAJE_MS = 150;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function medir(opts: { topeCerca?: boolean } = {}): Promise<{ arranqueMs: number; viajes: string[]; enParalelo: number }> {
  const api = await crearMundoApi(opts.topeCerca ? { gastoPrevioMicroUsd: 4_000_000, topeMensualUsd: 5 } : {});
  let activos = 0;
  let maxActivos = 0;
  const viajes: string[] = [];
  const fetchLento: typeof fetch = async (input, init) => {
    activos += 1;
    maxActivos = Math.max(maxActivos, activos);
    viajes.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname);
    await new Promise((r) => setTimeout(r, VIAJE_MS));
    try {
      return await api.fetchFn(input, init);
    } finally {
      activos -= 1;
    }
  };
  const agente = new AgenteGuionado([]);
  const t = await escenario(api, () => [agente.escalon()], { api: new ClienteApi({ baseUrl: api.config.apiBaseUrl, internalSecret: api.config.internalSecret, fetchFn: fetchLento }) });
  const t0 = performance.now();
  const llamada = t.telefonia.llamar({ id: "llamada-arranque", dnis: NUMERO_SUCURSAL, desde: "+5219993334444" });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 10_000, interval: 5 });
  const arranqueMs = Math.round(performance.now() - t0);
  llamada.clienteCuelga();
  await t.esperarFin();
  return { arranqueMs, viajes, enParalelo: maxActivos };
}

describe("latencia de arranque de la llamada", () => {
  it("la sesion abre tras 2 olas de viajes a la API (contexto; luego conversacion + privacidad + token en paralelo), no tras 5 secuenciales", async () => {
    const m = await medir();
    console.log(`[latencia] arranque con ${VIAJE_MS} ms por viaje: ${m.arranqueMs} ms, ${m.viajes.length} viajes, hasta ${m.enParalelo} en paralelo`);
    // 5 viajes secuenciales serian >= 750 ms (+ la apertura); con 2 olas son ~300 ms.
    expect(m.arranqueMs).toBeLessThan(VIAJE_MS * 3.5);
    expect(m.enParalelo).toBeGreaterThanOrEqual(3);
    // Nada se perdio: los mismos viajes de antes siguen ocurriendo.
    expect(m.viajes.some((v) => v.endsWith("/llamada/contexto"))).toBe(true);
    expect(m.viajes.some((v) => v.endsWith("/privacidad/apertura"))).toBe(true);
    expect(m.viajes.some((v) => v.endsWith("/voice/call-token"))).toBe(true);
    expect(m.viajes.some((v) => v.endsWith("/modo-entrada"))).toBe(true);
  });

  it("el aviso de tope mensual (80 %) ya no retrasa el saludo pero SE ENVIA antes de terminar la llamada", async () => {
    const m = await medir({ topeCerca: true });
    console.log(`[latencia] arranque con aviso de tope: ${m.arranqueMs} ms, ${m.viajes.length} viajes`);
    expect(m.arranqueMs).toBeLessThan(VIAJE_MS * 3.5);
    expect(m.viajes.some((v) => v.endsWith("/voz/tope-mensual"))).toBe(true);
  });
});
