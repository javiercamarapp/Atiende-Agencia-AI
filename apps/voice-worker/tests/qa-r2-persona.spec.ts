// QA adversarial R2 (lente AGENTES, restaurantes) -- worker REAL de telefonia (#418): re-verificacion del cierre de R1-14 ("quiero hablar con una
// persona" dicho de viva voz escala sin depender del modelo). El cierre conecto la guardia `evaluarPersonaVoz` al SIMULADOR (correr-guion.ts dice
// "misma guardia que produccion"), pero `atenderLlamada` construye el `ControladorLlamada` SIN `guardiaCliente`: en una llamada real la peticion
// queda al criterio del modelo. Telefonia falsa + proveedor guionado + API real en proceso (nada real).
// Convencion: `it.fails` = comportamiento ESPERADO que hoy falla (defecto QA-restaurantes-R2-agentes-NN); `it` = correcto confirmado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import type { PasoGuion } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const SIP = "+5219991234567";
const dice = (texto: string): PasoGuion => ({ dice: texto });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function llamadaQuePidePersona() {
  const api = await crearMundoApi();
  // El modelo IGNORA la peticion dos veces (lo que la guardia determinista debe impedir).
  const agente = new AgenteGuionado([
    { cliente: "No quiero hablar con una máquina, comuníqueme con una persona por favor", agente: [dice("Con gusto le ayudo yo. ¿Qué le preparamos hoy?")] },
    { cliente: "¡Que quiero hablar con un humano!", agente: [dice("Entiendo. ¿Qué le gustaría ordenar?")] },
  ]);
  const t = await escenario(api, () => [agente.escalon()]);
  const llamada = t.telefonia.llamar({ id: "llamada-pide-persona", dnis: NUMERO_SUCURSAL, desde: SIP });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  for (let i = 1; i <= 2 && !llamada.colgadaPorSistema; i++) await turnoCliente(llamada, api.reloj, () => agente.respondidos, i);
  if (!llamada.colgadaPorSistema) llamada.clienteCuelga();
  await t.esperarFin();
  return { api, t };
}

describe("R2 voz real: el cliente pide una persona de viva voz y el modelo lo ignora", () => {
  // QA-restaurantes-R2-agentes-12 (P2, R1-14 REABIERTO en produccion): sin guardia en el worker no hay callback cliente_lo_pide ni cierre escalado.
  it("R2-12 queda el aviso 'escalada:cliente_lo_pide' y la llamada cierra como escalada", async () => {
    const { api, t } = await llamadaQuePidePersona();
    expect(api.mundo.callbacks.map((c) => c.reason)).toContain("escalada:cliente_lo_pide");
    expect(t.worker.resumenes[0]?.resultado).toBe("escalado");
  });

  it("control: el DTMF 0 si escala de forma determinista en el worker real", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-dtmf-r2", dnis: NUMERO_SUCURSAL, desde: SIP });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    llamada.teclear("0");
    await t.esperarFin();
    expect(api.mundo.callbacks).toHaveLength(1);
    expect(t.worker.resumenes[0]?.resultado).toBe("escalado");
  });
});
