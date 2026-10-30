// El worker reenvia a la API el turno del CLIENTE (`x-atiende-call-turn`) en cada herramienta: lo fija el controlador de la llamada (contador monotono de hablas
// inteligibles del cliente), nunca el modelo. Con el, la API (real, en proceso) rechaza confirmar en el mismo turno en que se cotiza y lo acepta en uno posterior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRANCH_SLUG_PRINCIPAL } from "../../../packages/domain-restaurantes/src/voz/simulador/mundo-voz.ts";
import type { MemoriaTools } from "../../../packages/domain-restaurantes/src/voz/simulador/tipos.ts";
import { AgenteGuionado } from "./support/agente-guionado.ts";
import type { PasoGuion, TurnoGuion } from "./support/agente-guionado.ts";
import { escenario } from "./support/escenario.ts";
import { turnoCliente } from "./support/llamada.ts";
import { NUMERO_SUCURSAL, crearMundoApi } from "./support/mundo-api.ts";

const SUC = BRANCH_SLUG_PRINCIPAL;
const CABECERA = "x-atiende-call-turn";
const linea = (m: MemoriaTools) => {
  const p = m.producto("bistec");
  return { product_id: p.id, product_name: p.name, requested_quantity: 6, tortilla: "maiz" };
};
const cotizar: PasoGuion = { tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: [linea(m)], canal: "domicilio", colonia_entrega: "Centro" }) };
const buscar: PasoGuion = { tool: "buscar_producto", args: { query: "bistec", branch_slug: SUC } };
const confirmar: PasoGuion = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
const resumen: PasoGuion = { dice: "Son dos órdenes de tres tacos de bistec. ¿Le parece bien?" };

interface Visto {
  readonly ruta: string;
  readonly turno: string | null;
}

async function llamar(turnos: readonly TurnoGuion[]) {
  const api = await crearMundoApi();
  const vistos: Visto[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    vistos.push({ ruta: url.pathname, turno: new Headers(init?.headers).get(CABECERA) });
    return api.fetchFn(input, init);
  };
  const agente = new AgenteGuionado(turnos);
  const t = await escenario(api, () => [agente.escalon()], { fetchFn });
  const llamada = t.telefonia.llamar({ id: `turno-${Math.random().toString(36).slice(2, 8)}`, dnis: NUMERO_SUCURSAL, desde: "+5219991234567" });
  await vi.waitFor(() => expect(agente.saludos).toBe(1), { timeout: 5_000, interval: 5 });
  for (let i = 1; i <= turnos.length; i++) await turnoCliente(llamada, api.reloj, () => agente.respondidos, i);
  llamada.clienteCuelga();
  await t.esperarFin();
  const de = (sufijo: string) => vistos.filter((v) => v.ruta.endsWith(sufijo));
  const resultado = (nombre: string) => agente.resultados.filter((r) => r.nombre === nombre).map((r) => r.resultado as Record<string, unknown>);
  return { vistos, de, resultado };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("turno del cliente reenviado por el worker (x-atiende-call-turn)", () => {
  it("cotizar y confirmar en el MISMO turno del cliente: el servidor rechaza confirmar (confirmacion_mismo_turno)", async () => {
    const r = await llamar([
      { cliente: "Sí, autorizo que se grabe la llamada", agente: [{ dice: "Gracias. ¿Qué desea pedir?" }] },
      { cliente: "Seis tacos de bistec, a domicilio por el Centro", agente: [buscar, cotizar, confirmar, resumen] },
    ]);
    const cot = r.de("/orders/quote");
    const conf = r.de("/orders/confirm");
    expect(cot).toHaveLength(1);
    expect(conf).toHaveLength(1);
    expect(cot[0]!.turno).toMatch(/^\d+$/);
    expect(conf[0]!.turno).toBe(cot[0]!.turno);
    expect(String(r.resultado("confirmar_resumen")[0]!.error)).toMatch(/todavía no contestó/);
  });

  it("cotizar en el turno N y confirmar en el N+1: el header avanza y el servidor confirma", async () => {
    const r = await llamar([
      { cliente: "Sí, autorizo que se grabe la llamada", agente: [{ dice: "Gracias. ¿Qué desea pedir?" }] },
      { cliente: "Seis tacos de bistec, a domicilio por el Centro", agente: [buscar, cotizar, resumen] },
      { cliente: "Sí, está bien", agente: [confirmar, { dice: "Perfecto." }] },
    ]);
    const cot = Number(r.de("/orders/quote")[0]!.turno);
    const conf = Number(r.de("/orders/confirm")[0]!.turno);
    expect(conf).toBe(cot + 1);
    expect(r.resultado("confirmar_resumen")[0]).toMatchObject({ confirmado: true });
    // Todas las herramientas (no solo las de pedido) llevan el turno.
    expect(r.vistos.filter((v) => v.ruta.includes("/orders/") || v.ruta.includes("/products/")).every((v) => v.turno !== null)).toBe(true);
  });

  it("el modelo no puede falsear el turno: un `turno` o la cabecera en los argumentos no cambia lo que el worker manda ni el veredicto", async () => {
    const r = await llamar([
      { cliente: "Sí, autorizo que se grabe la llamada", agente: [{ dice: "Gracias. ¿Qué desea pedir?" }] },
      {
        cliente: "Seis tacos de bistec, a domicilio por el Centro",
        agente: [buscar, cotizar, { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash(), turno: 99, turn: 99, [CABECERA]: "99", headers: { [CABECERA]: "99" } }) }, resumen],
      },
    ]);
    const cot = r.de("/orders/quote")[0]!.turno;
    const conf = r.de("/orders/confirm")[0]!.turno;
    expect(conf).toBe(cot);
    expect(conf).not.toBe("99");
    expect(String(r.resultado("confirmar_resumen")[0]!.error)).toMatch(/todavía no contestó/);
  });
});
