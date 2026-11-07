// C3 PED-28 (cerebro v2): «dos mestizas de bistec» son 2 órdenes (2 platillos de 2 tacos). El agente contestó «2 órdenes de mestiza de bistec (4 mestizas)»; el cliente leyó que le
// cobraban 4 mestizas, lo corrigió dos veces y terminó con 1 orden ($300 en vez de $494). El «4» salía del ejemplo del paso 5 («3 órdenes de gringas, que son 6 gringas») y de
// «requested_quantity 4» del bloque del turno. Con cerebro v2 las piezas nunca se llaman gringas/mestizas: «2 órdenes de mestiza (2 tacos cada una)», sin introducir el 4.
import { describe, expect, it } from "vitest";
import { resumenCanonico } from "../src/agent-tools/cierre-maquina.ts";
import { bloqueGringasYMestizasComoOrdenes } from "../src/unidades-pm.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";

const PIDE = "Buen día, dos mestizas de bistec y dos coca light para recoger en García Lavín a las 12:45";

describe("PED-28 bloque del turno", () => {
  it("dice las órdenes con «2 tacos cada una» y prohíbe llamar mestizas a las piezas", () => {
    const b = bloqueGringasYMestizasComoOrdenes([PIDE]);
    expect(b).toMatch(/2 órdenes de mestiza de bistec \(2 tacos cada una\)/);
    expect(b).toMatch(/requested_quantity 4/);
    expect(b).toMatch(/nunca le diga al cliente.*requested_quantity/i);
    expect(b).not.toMatch(/4 mestizas/);
  });
});

describe("PED-28 prompt v2", () => {
  const base = buildPmSystemPrompt({ businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: "de 40 a 50 minutos", saludo: "buenas tardes", branches: [], entryBranch: null, customer: { isNew: true } });
  it("sin bandera el ejemplo de siempre sigue; con v2 no hay «que son 6 gringas» y se manda decir «N órdenes (2 tacos cada una)»", () => {
    expect(base).toMatch(/que son 6 gringas/);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toMatch(/que son 6 gringas/);
    expect(v2).toMatch(/2 tacos cada una/);
    expect(v2).toMatch(/nunca llame «gringas» o «mestizas» a las piezas/i);
    expect(adaptarPromptPmV2(v2)).toBe(v2);
  });
});

describe("PED-28 resumen del servidor", () => {
  const datos = { pago: "tarjeta" as const };
  it("con la marca de gringa/mestiza por platillo, el renglón dice «2 órdenes (2 tacos cada una)» y no «4 piezas»", () => {
    const r = resumenCanonico({ lineas: [{ name: "Mestiza de Bistec", quantity: 2, piezasPorOrden: 2, tacosCadaUna: true, lineTotal: 388 }], total: 494, canal: "recoger", datos });
    expect(r).toMatch(/2 órdenes \(2 tacos cada una\) de Mestiza de Bistec/);
    expect(r).not.toMatch(/4 piezas/);
  });
  it("sin la marca (sin bandera) el renglón de siempre", () => {
    const r = resumenCanonico({ lineas: [{ name: "Mestiza de Bistec", quantity: 2, piezasPorOrden: 2, lineTotal: 388 }], total: 494, canal: "recoger", datos });
    expect(r).toMatch(/2 órdenes \(4 piezas\) de Mestiza de Bistec/);
  });
});
