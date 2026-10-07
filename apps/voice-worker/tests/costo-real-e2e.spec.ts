// Del `usageMetadata` de la sesion a `core.usage_cost_event`: el costo REAL que reporta el escalon viaja por el controlador, el tramo, la API y llega al evento con
// `costo_estimado = false`; sin costo real el evento sigue estimado. Y el tope por llamada (ahora US$0.50) corta con el costo REAL acumulado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi, mensajeQueSono } from "./support/mundo-api.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const GUION = [
  { cliente: "Hola, quiero un pedido", agente: [{ dice: "Claro, con gusto." }] },
  { cliente: "Seis tacos de bistec", agente: [{ dice: "Anotado." }] },
];

describe("costo real de Gemini hasta core.usage_cost_event", () => {
  it("el costo reportado por el escalon se registra tal cual (por debajo incluso de la tarifa por minuto) con costo_estimado = false", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado(GUION);
    agente.costoRealPorRespuestaMicroUsd = 12_345;
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-costo-real", dnis: NUMERO_SUCURSAL, desde: "+5219993334444" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 2);
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.llamadaRepo.eventos).toHaveLength(1);
    expect(api.llamadaRepo.eventos[0]).toMatchObject({ proveedor: "gemini-3.8-live", costoMicroUsd: 24_690, costoEstimado: false });
    expect(t.worker.resumenes[0]?.costoMicroUsd).toBe(24_690);
  });

  it("sin costo real el evento queda ESTIMADO (piso por minuto), igual que antes", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado(GUION);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-costo-estimado", dnis: NUMERO_SUCURSAL, desde: "+5219993334444" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.llamadaRepo.eventos[0]).toMatchObject({ costoEstimado: true });
  });

  it("el tope por llamada corta con el costo REAL acumulado: pregrabado `limite_costo`, callback y la llamada cierra escalada", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado(GUION);
    agente.costoRealPorRespuestaMicroUsd = 260_000; // dos respuestas = US$0.52 > tope de US$0.50
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-tope-costo", dnis: NUMERO_SUCURSAL, desde: "+5219993334444" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 2);
    await t.esperarFin();
    expect(llamada.salida.map((x) => mensajeQueSono(x.pcm, x.hz))).toContain("limite_costo");
    expect(api.mundo.callbacks).toHaveLength(1);
    expect(t.worker.resumenes[0]).toMatchObject({ resultado: "escalado" });
  });
});
