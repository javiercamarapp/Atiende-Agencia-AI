// Falla del asistente DESPUES de crear un apartado (pre-reserva): el huesped debe leer que el apartado SI existe (para no pedirlo de nuevo) y recepcion no recibe un
// segundo aviso `falla_sistema`. El "fallo" es agotar las vueltas del turno justo despues de la herramienta.
import { describe, expect, it } from "vitest";
import { QUOTED_TOTAL, STAY, makeWorld, tool } from "./support.ts";

const holdArgs = (doble: string) => ({ tipo_habitacion_id: doble, ...STAY, huespedes: 2, total_cotizado_centavos: QUOTED_TOTAL, nombre_huesped: "Ana" });

describe("falla despues de crear un apartado", () => {
  it("nombra el apartado, no registra un contacto falla_sistema y pide un solo handoff", async () => {
    const w = makeWorld();
    const { reply, handoff } = await w.run([tool("crear_pre_reserva", { tipo_habitacion_id: w.doble, ...STAY, huespedes: 2, total_cotizado_centavos: QUOTED_TOTAL, nombre_huesped: "Ana" })], { maxToolUseTurns: 1 });
    expect(w.reservas.allHolds()).toHaveLength(1);
    expect(reply).toMatch(/tu solicitud de pre-reserva sí quedó registrada/i);
    expect(reply).toMatch(/todavía no es una reserva confirmada/i);
    expect(reply).toMatch(/no lo repitas/i);
    expect(reply).not.toMatch(/\$|MXN/);
    expect(w.handoffs.filter((h) => /^falla_sistema/.test(h.reason))).toHaveLength(0);
    expect(handoff).toEqual({ motivo: "falla_sistema" });
  });

  it("control: sin apartado creado (herramienta desconocida), la falla registra su aviso normal", async () => {
    const w = makeWorld();
    const { reply, handoff } = await w.run([tool("no_existe", {})], { maxToolUseTurns: 1 });
    expect(reply).not.toMatch(/apartado/i);
    expect(w.handoffs.filter((h) => /^falla_sistema: loop_agotado/.test(h.reason))).toHaveLength(1);
    expect(handoff?.motivo).toBe("falla_sistema");
  });

  it("el modelo ya pidio una persona (derivar_a_humano) y luego falla: UN solo contacto (el de la herramienta) y handoff agente_derivo exacto", async () => {
    const w = makeWorld();
    const { reply, handoff } = await w.run([tool("derivar_a_humano", { motivo: "quiere hablar con alguien", resumen: "pide una persona" })], { maxToolUseTurns: 1 });
    expect(w.handoffs.map((h) => h.reason)).toEqual(["reservas: quiere hablar con alguien"]);
    expect(handoff).toEqual({ motivo: "agente_derivo" });
    expect(reply).toMatch(/ya avisé al equipo del hotel/i);
  });

  it("una herramienta de reservas que deriva por error (estadia_muy_larga) y luego falla: tampoco se duplica el contacto y el handoff es agente_derivo", async () => {
    const w = makeWorld();
    const { handoff } = await w.run([tool("consultar_disponibilidad", { fecha_llegada: "2031-06-10", fecha_salida: "2031-06-25" })], { maxToolUseTurns: 1 });
    expect(w.handoffs.filter((h) => /^falla_sistema/.test(h.reason))).toHaveLength(0);
    expect(w.handoffs.filter((h) => h.reason.includes("estadia_muy_larga"))).toHaveLength(1);
    expect(handoff).toEqual({ motivo: "agente_derivo" });
  });

  it("el apartado y un ticket de mantenimiento en el mismo turno se nombran los dos; sin precios", async () => {
    const w = makeWorld();
    const { reply } = await w.run([{ tools: [{ name: "crear_pre_reserva", args: holdArgs(w.doble) }, { name: "crear_ticket_mantenimiento", args: { titulo: "Aire", descripcion: "No enfría", habitacion: "410", severidad: "media" } }] }], { maxToolUseTurns: 1 });
    expect(reply).toMatch(/tu reporte de mantenimiento sí quedó registrado/i);
    expect(reply).toMatch(/tu solicitud de pre-reserva sí quedó registrada/i);
    expect(reply).not.toMatch(/\$|MXN/);
  });

  it("con un pedido de F&B y un apartado en el mismo turno gana el pedido, pero el apartado tambien se nombra (sin contacto extra)", async () => {
    const w = makeWorld();
    const { reply } = await w.run([{ tools: [{ name: "crear_ticket_huesped_fnb", args: { mensaje: "Un club sandwich", habitacion: "305", alergia_declarada: false } }, { name: "crear_pre_reserva", args: holdArgs(w.doble) }] }], { maxToolUseTurns: 1 });
    expect(reply).toMatch(/ya registramos tu pedido/i);
    expect(reply).toMatch(/tu solicitud de pre-reserva sí quedó registrada/i);
    expect(w.handoffs.filter((h) => /^falla_sistema/.test(h.reason))).toHaveLength(0);
  });
});
