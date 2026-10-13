// Derechos ARCO por voz: el worker evalua CADA frase del titular contra el servidor (mismo detector que WhatsApp) y le pasa al agente la respuesta TAL CUAL.
// Antes el endpoint /internal/restaurantes/voz/arco existia pero ningun llamador lo usaba: una solicitud por voz nunca quedaba registrada.
// API real en proceso (repositorio de privacidad en memoria) + telefonia falsa + proveedor guionado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const SIP = "+5219991234567";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function llamar(turnos: { cliente: string; agente: { dice: string }[] }[], desde: string | null = SIP) {
  const api = await crearMundoApi();
  const agente = new AgenteGuionado(turnos);
  const t = await escenario(api, () => [agente.escalon()]);
  const llamada = t.telefonia.llamar({ id: `llamada-arco-${Math.random()}`, dnis: NUMERO_SUCURSAL, desde, ...(desde === null ? { desviadaDesde: "<sip:+529992220002@telmex.invalid>" } : {}) });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  for (let i = 1; i <= turnos.length; i++) await turnoCliente(llamada, api.reloj, () => agente.respondidos, i);
  await vi.waitFor(() => expect(agente.textosRecibidos.length).toBeGreaterThan(0), { timeout: 5_000, interval: 5 });
  // La cola de consultas ARCO corre en segundo plano: se espera a que termine antes de afirmar.
  await vi.waitFor(() => expect(api.peticiones.filter((p) => p.includes("/voz/arco")).length).toBeGreaterThanOrEqual(turnos.length), { timeout: 5_000, interval: 5 });
  await new Promise((r) => setTimeout(r, 20));
  llamada.clienteCuelga();
  await t.esperarFin();
  return { api, agente };
}

describe("ARCO por voz", () => {
  it("una solicitud de supresion queda REGISTRADA con canal voice y el telefono del identificador de llamada (+52 y 10 digitos), y el agente recibe la respuesta tal cual", async () => {
    const { api, agente } = await llamar([{ cliente: "quiero que borren mis datos personales", agente: [{ dice: "Un momento." }] }]);
    expect(api.privacidad.requests).toHaveLength(1);
    expect(api.privacidad.requests[0]).toMatchObject({ channel: "voice", identityBasis: "llamada_identificador", rightType: "cancelacion", customerPhone: "+529991234567" });
    const instruccion = agente.textosRecibidos.find((t) => t.includes("derechos sobre sus datos personales"));
    expect(instruccion).toBeDefined();
    expect(instruccion).toContain("CONFIRMO");
    expect(instruccion).toContain("sin tomar su pedido en este turno");
  });

  it("el menu no es un bucle por voz: la frase siguiente («la de cancelacion») elige el derecho y se registra", async () => {
    const { api, agente } = await llamar([
      { cliente: "quiero ejercer mis derechos ARCO", agente: [{ dice: "Claro." }] },
      { cliente: "la de cancelación", agente: [{ dice: "Listo." }] },
    ]);
    expect(agente.textosRecibidos.some((t) => t.includes("Elija una opción"))).toBe(true);
    expect(api.privacidad.requests).toHaveLength(1);
    expect(api.privacidad.requests[0]).toMatchObject({ rightType: "cancelacion", channel: "voice" });
  });

  it("senal debil («no me llamen»): el agente sigue con el pedido y se le pide ofrecer los derechos al final; no se registra nada", async () => {
    const { api, agente } = await llamar([{ cliente: "no me llamen", agente: [{ dice: "Entendido." }] }]);
    expect(api.privacidad.requests).toHaveLength(0);
    expect(agente.textosRecibidos.some((t) => t.startsWith("(Termine de atender lo que pidió el cliente") && t.includes("derechos ARCO"))).toBe(true);
  });

  it("un pedido normal no dispara nada", async () => {
    const { api, agente } = await llamar([{ cliente: "quiero tres tacos de pastor", agente: [{ dice: "Claro." }] }]);
    expect(api.privacidad.requests).toHaveLength(0);
    expect(agente.textosRecibidos.some((t) => t.startsWith("(El cliente quiere ejercer") || t.startsWith("(Termine de atender"))).toBe(false);
  });
});

describe("ARCO por voz sin telefono confiable", () => {
  it("sin identificador de llamada no hay a quien registrar: no se consulta el servidor ni se inventa un telefono", async () => {
    const api = await crearMundoApi();
    const agente = new AgenteGuionado([{ cliente: "borren mis datos", agente: [{ dice: "Entendido." }] }]);
    const t = await escenario(api, () => [agente.escalon()]);
    const llamada = t.telefonia.llamar({ id: "llamada-arco-anonima", dnis: NUMERO_SUCURSAL, desde: null, desviadaDesde: "<sip:+529992220002@telmex.invalid>" });
    await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
    await turnoCliente(llamada, api.reloj, () => agente.respondidos, 1);
    llamada.clienteCuelga();
    await t.esperarFin();
    expect(api.peticiones.some((p) => p.includes("/voz/arco"))).toBe(false);
    expect(api.privacidad.requests).toHaveLength(0);
  });
});
