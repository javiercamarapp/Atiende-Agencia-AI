// Decisiones de negocio de voz (sin costo): ordenes de 2/5 y agregados a un pedido ya enviado, iguales en voz y WhatsApp.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTRUCCION_CAMBIO_HORA_SUCURSAL, MENSAJE_CAMBIO_PEDIDO_ENVIADO } from "../src/agent-tools/registry.ts";
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
});
