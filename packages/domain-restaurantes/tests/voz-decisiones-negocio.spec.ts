// Decisiones de negocio de voz (sin costo): ordenes de 2/5 y agregados a un pedido ya enviado, iguales en voz y WhatsApp.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTRUCCION_CAMBIO_HORA_SUCURSAL, INSTRUCCION_CANCELACION_SUCURSAL, MENSAJE_CAMBIO_PEDIDO_ENVIADO, MENSAJE_CANCELACION_PEDIDO_ENVIADO, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { REGLAS_VIVAS_VOZ } from "../src/voz/perfil-voz-pm.ts";
import { ESCENARIOS_PARIDAD, correrEscenario } from "../src/voz/simulador/guiones-paridad.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("decisiones de negocio de voz", () => {
  it("el prompt trae la frase de ordenes y la de agregados", () => {
    expect(REGLAS_VIVAS_VOZ).toContain("Las gringas se venden por órdenes, y cada orden trae dos. ¿Cuántas órdenes le anoto?");
    expect(REGLAS_VIVAS_VOZ).toContain(MENSAJE_CAMBIO_PEDIDO_ENVIADO.replace(/\.$/, ""));
  });
  it("la frase de agregados no promete minutos y es la misma para ambos canales", () => {
    expect(MENSAJE_CAMBIO_PEDIDO_ENVIADO).not.toMatch(/\d|minuto/i);
    expect(INSTRUCCION_CAMBIO_HORA_SUCURSAL).toContain(MENSAJE_CAMBIO_PEDIDO_ENVIADO);
  });
  it("por voz, escalar un cambio devuelve la frase decidida y el pedido original queda unico", async () => {
    const esc = ESCENARIOS_PARIDAD.find((e) => e.guion.id === "P16-agregado-a-pedido-ya-enviado")!;
    vi.setSystemTime(new Date(esc.ahora));
    const { llamada } = await correrEscenario(esc);
    const r = llamada.tools.find((t) => t.nombre === "escalar_a_humano")!.resultado as { mensaje_al_cliente: string; instruccion: string };
    expect(r.mensaje_al_cliente).toBe(MENSAJE_CAMBIO_PEDIDO_ENVIADO);
    expect(r.instruccion).toContain("NO dé minutos");
    expect(llamada.tools.filter((t) => t.nombre === "crear_pedido")).toHaveLength(1);
  });

  it("cancelar tiene frase PROPIA (no la de agregados): se avisa a la sucursal y ella confirma si todavia se puede cancelar", () => {
    expect(MENSAJE_CANCELACION_PEDIDO_ENVIADO).not.toBe(MENSAJE_CAMBIO_PEDIDO_ENVIADO);
    expect(MENSAJE_CANCELACION_PEDIDO_ENVIADO).toMatch(/avis[ée] a la sucursal/);
    expect(MENSAJE_CANCELACION_PEDIDO_ENVIADO).toMatch(/si todavía se puede cancelar/);
    expect(MENSAJE_CANCELACION_PEDIDO_ENVIADO).not.toMatch(/alcanza a salir|\d|minuto/i);
    expect(INSTRUCCION_CANCELACION_SUCURSAL).toContain(MENSAJE_CANCELACION_PEDIDO_ENVIADO);
    expect(INSTRUCCION_CANCELACION_SUCURSAL).toMatch(/NO diga que ya quedó cancelado/);
    expect(REGLAS_VIVAS_VOZ).toContain(MENSAJE_CANCELACION_PEDIDO_ENVIADO.replace(/\.$/, ""));
  });
  it("por voz, cancelar devuelve la frase de cancelacion (y no la de agregados); un agregado sigue con la suya", async () => {
    const esc = ESCENARIOS_PARIDAD.find((e) => e.guion.id === "P06-cancelar-pasa-a-una-persona")!;
    vi.setSystemTime(new Date(esc.ahora));
    const { llamada } = await correrEscenario(esc);
    const r = llamada.tools.find((t) => t.nombre === "escalar_a_humano")!.resultado as { mensaje_al_cliente: string; instruccion: string };
    expect(r.mensaje_al_cliente).toBe(MENSAJE_CANCELACION_PEDIDO_ENVIADO);
    expect(r.instruccion).toContain(INSTRUCCION_CANCELACION_SUCURSAL);
    expect(r.instruccion).not.toContain("alcanza a salir");
  });
  it.each(["whatsapp", "voz"] as const)("%s: la misma regla en la herramienta (cancelar -> frase de cancelacion; agregar -> frase de agregados)", async (channel) => {
    const f = buildRestaurantFixture();
    const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
    const escalar = async (resumen: string, sufijo: string) =>
      (await invokeAgentTool(f.repo, { ...ctx, sourceEventId: `e-${channel}-${sufijo}` }, "escalar_a_humano", { customer_name: "Ana", motivo: "cancelacion_modificacion", resumen })).result as { instruccion?: string; mensaje_al_cliente?: string };
    const cancela = await escalar("El cliente quiere cancelar su pedido.", "c");
    expect(cancela.instruccion).toContain(MENSAJE_CANCELACION_PEDIDO_ENVIADO);
    if (channel === "voz") expect(cancela.mensaje_al_cliente).toBe(MENSAJE_CANCELACION_PEDIDO_ENVIADO);
    const agrega = await escalar("Quiere agregar una horchata.", "a");
    expect(agrega.instruccion).toContain(MENSAJE_CAMBIO_PEDIDO_ENVIADO);
    expect(agrega.instruccion).not.toContain(MENSAJE_CANCELACION_PEDIDO_ENVIADO);
  });
});
