// Falla del asistente DESPUES de crear un apartado (pre-reserva): el huesped debe leer que el apartado SI existe (para no pedirlo de nuevo) y recepcion no recibe un
// segundo aviso `falla_sistema`. El "fallo" es agotar las vueltas del turno justo despues de la herramienta.
import { describe, expect, it } from "vitest";
import { QUOTED_TOTAL, STAY, makeWorld, tool } from "./support.ts";

describe("falla despues de crear un apartado", () => {
  it("nombra el apartado, no registra un contacto falla_sistema y pide un solo handoff", async () => {
    const w = makeWorld();
    const { reply, handoff } = await w.run([tool("crear_pre_reserva", { tipo_habitacion_id: w.doble, ...STAY, huespedes: 2, total_cotizado_centavos: QUOTED_TOTAL, nombre_huesped: "Ana" })], { maxToolUseTurns: 1 });
    expect(w.reservas.allHolds()).toHaveLength(1);
    expect(reply).toMatch(/tu apartado de reserva sí quedó registrado/i);
    expect(reply).toMatch(/no lo repitas/i);
    expect(reply).not.toMatch(/confirmad[ao]|\$/i);
    expect(w.handoffs.filter((h) => /^falla_sistema/.test(h.reason))).toHaveLength(0);
    expect(handoff?.motivo).toMatch(/^(falla_sistema|agente_derivo)$/);
  });

  it("control: sin apartado creado (herramienta desconocida), la falla registra su aviso normal", async () => {
    const w = makeWorld();
    const { reply, handoff } = await w.run([tool("no_existe", {})], { maxToolUseTurns: 1 });
    expect(reply).not.toMatch(/apartado/i);
    expect(w.handoffs.filter((h) => /^falla_sistema: loop_agotado/.test(h.reason))).toHaveLength(1);
    expect(handoff?.motivo).toBe("falla_sistema");
  });
});
