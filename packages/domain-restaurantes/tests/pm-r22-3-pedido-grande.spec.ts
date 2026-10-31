// R22 decision 3: un pedido grande (MAS de $4,000, o mas de 5 kg; el umbral del servidor es > 4000) se toma como cualquier pedido con el total de cotizar_pedido; el aviso al gerente lo da el
// SERVIDOR al crear el pedido (`avisarPedidoGrandeASucursal`, aviso `escalada:pedido_grande`; cubierto en tests/qa/r1-pedido-grande.spec.ts).
// El agente ya NO escala antes de cotizar ni llama escalar_a_humano con ese motivo (WhatsApp y voz).
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_REGLA_CANTIDAD_ENORME, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm, REGLAS_VIVAS_VOZ } from "../src/voz/perfil-voz-pm.ts";
import { AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { evaluarPedidoGrande } from "../src/pedido-grande.ts";

const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const base = { businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches };
const wa = buildPmSystemPrompt({ ...base, saludo: "Buenas tardes", entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
const voz = comportamientoVozPm(base);

describe("R22-3 pedido grande: se toma normal y no escala antes de cotizar", () => {
  it("WhatsApp: se toma como cualquier pedido con el total de cotizar_pedido; no escala con motivo pedido_grande", () => {
    expect(wa).toMatch(/Pedido grande \([^)]*\$4,000[^)]*\): se toma como CUALQUIER pedido/);
    expect(wa).toMatch(/NO llame escalar_a_humano con motivo pedido_grande/);
    expect(wa).not.toMatch(/Antes de escalar, cotice/);
    expect(wa).not.toMatch(/tome todos los datos y escale \(pedido_grande\)/);
    expect(wa).not.toMatch(/salvo pedido grande/);
  });
  it("voz: tomarlo como cualquier pedido con el total de cotizar_pedido, sin escalar", () => {
    expect(voz).toMatch(/Pedido grande \([^)]*\$4,000[^)]*\): tómelo como cualquier pedido con el total de cotizar_pedido; no escale/);
    expect(voz).not.toMatch(/escale \(pedido_grande\)/);
    expect(REGLAS_VIVAS_VOZ).not.toMatch(/escalar_a_humano si es pedido grande/);
  });
  it("cantidad enorme (\"99999 tacos\"): el prompt ya NO manda confirmar la cantidad; se cotiza y el servidor lo retiene como pedido_grande", () => {
    expect(wa).not.toMatch(/¿son 99,999\?/);
    expect(wa).not.toMatch(/confirme la cantidad en el primer mensaje/i);
    expect(PM_REGLA_CANTIDAD_ENORME).not.toMatch(/\bconfirm/i);
    expect(PM_REGLA_CANTIDAD_ENORME).toMatch(/cotice para conocer el total y tómelo como cualquier pedido/);
    // el servidor, no el prompt, decide: 99,999 tacos de ~$20 pasan el umbral de $4,000 (y 99,999 kg el de 5 kg) -> pedido_grande
    expect(evaluarPedidoGrande({ total: 99_999 * 20, pesoKg: 0, pagaEfectivo: false, sinHistorial: false })).toBe("total");
    expect(evaluarPedidoGrande({ total: 100, pesoKg: 99_999, pagaEfectivo: false, sinHistorial: false })).toBe("peso");
  });
  it("cantidad enorme: se cotiza y sigue el flujo normal, ya no se escala", () => {
    expect(PM_REGLA_CANTIDAD_ENORME).not.toMatch(/escale con escalar_a_humano/);
    expect(PM_REGLA_CANTIDAD_ENORME).toMatch(/no escale antes de cotizar/);
    expect(wa).toMatch(/cotice para conocer el total y tómelo como cualquier pedido/);
  });
  it("si crear_pedido devuelve pedido_grande/por_aprobar se dice solo el mensaje al cliente (el aviso al gerente ya lo dejo el servidor)", () => {
    expect(wa).toMatch(/Si crear_pedido responde pedido_grande o por_aprobar, diga solo su mensaje_al_cliente/);
    expect(REGLAS_VIVAS_VOZ).toMatch(/PEDIDO GRANDE: si crear_pedido devuelve pedido_grande o por_aprobar, diga SOLO su mensaje_al_cliente/);
  });
  it("la herramienta escalar_a_humano ya no invita a usar pedido_grande", () => {
    const t = JSON.stringify(AGENT_TOOL_DEFINITIONS.find((d) => d.name === "escalar_a_humano"));
    expect(t).not.toMatch(/SOLO si pide mas de 30 piezas/);
    expect(t).toMatch(/NO lo use/);
  });
});
