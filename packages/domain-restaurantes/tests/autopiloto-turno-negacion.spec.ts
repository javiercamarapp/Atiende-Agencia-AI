// La cancelacion automatica del agente no se ejecuta con un mensaje que NIEGA la cancelacion (el clasificador de guards.ts no entiende la negacion).
import { describe, expect, it, vi } from "vitest";
import { intentarCancelacionConAutopiloto, negacionDeCancelacion } from "../src/whatsapp/autopiloto-turno.ts";
import type { AutopilotoTurnoHooks } from "../src/whatsapp/autopiloto-turno.ts";

const repo = { runWithRowSavepoint: async <T>(fn: () => Promise<T>) => fn() };
const args = { organizationId: "o1", phone: "9991230000", ahora: new Date("2026-10-04T18:00:00Z") };

function hooks() {
  const solicitarCancelacion = vi.fn(async () => ({ resultado: "cancelado" as const, mensaje: "Listo, su pedido quedó cancelado." }));
  const h: AutopilotoTurnoHooks = { cancelacionActiva: async () => true, solicitarCancelacion, registrarQueja: async () => undefined };
  return { h, solicitarCancelacion };
}

describe("negacion de la cancelacion", () => {
  it.each(["no cancelen mi pedido", "mi pedido ya llegó, no hace falta cancelar", "No quiero cancelar el pedido", "ya no cancelen el pedido por favor", "sin cancelar nada"])("%s => negacion", (t) => {
    expect(negacionDeCancelacion(t)).toBe(true);
  });
  it.each(["quiero cancelar mi pedido", "cancela el pedido por favor", "cancelen mi pedido ya"])("%s => no es negacion", (t) => {
    expect(negacionDeCancelacion(t)).toBe(false);
  });

  it("con negacion NO se llama a solicitarCancelacion y el turno sigue por el camino anterior (null)", async () => {
    const { h, solicitarCancelacion } = hooks();
    expect(await intentarCancelacionConAutopiloto(repo, h, { ...args, texto: "no cancelen mi pedido" })).toBeNull();
    expect(solicitarCancelacion).not.toHaveBeenCalled();
  });

  it("una cancelacion afirmativa sigue resolviendose", async () => {
    const { h, solicitarCancelacion } = hooks();
    expect(await intentarCancelacionConAutopiloto(repo, h, { ...args, texto: "quiero cancelar mi pedido" })).toEqual({ reply: "Listo, su pedido quedó cancelado." });
    expect(solicitarCancelacion).toHaveBeenCalledOnce();
  });
});
