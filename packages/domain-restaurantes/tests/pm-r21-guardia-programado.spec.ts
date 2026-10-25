// PM Ronda 21 (A19, P0): «lo dejé programado» / «quedó programado» sin pedido creado ni «sí» del cliente es una afirmacion falsa. Datos 100 % sinteticos, sin LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afirmaPedidoProgramado, quitarAfirmacionDePedidoRegistrado } from "../src/whatsapp/guards.ts";
import { MARTES_14H, nuevoViaje, pedidosDe } from "./qa-viaje/arnes-viaje.ts";

describe("afirmaPedidoProgramado", () => {
  it.each([
    "Como la sucursal está cerrada, no es posible a esa hora; lo dejé programado para la apertura, a las 12:00 p.",
    "Su pedido quedó programado para las 12:00 del día.",
    "Ya quedó programado para mañana.",
    "Ya lo programé para las 12.",
    "Lo programamos para la apertura.",
    "Ya lo agendé para las 7 pm.",
    "Se programó para el miércoles.",
    "La dejamos agendada para las 12.",
  ])("afirma: %s", (t) => {
    expect(afirmaPedidoProgramado(t)).toBe(true);
  });

  it.each([
    "¿Quiere que lo deje programado para las 12:00?",
    "Puedo programarlo para las 12:00 p. m.",
    "Si confirma, lo dejo programado para la apertura.",
    "Cuando confirme, queda programado para las 12.",
    "Todavía no queda programado; necesito su sí.",
    "No lo dejé programado, falta su confirmación.",
    "No quedó programado.",
    "Lo dejaré programado en cuanto me confirme.",
    "Le repito su pedido: 2 tacos. Total $84.00. ¿Está correcto?",
    "La sucursal abre a las 12:00 p. m.; si quiere, el pedido se puede programar.",
    "Para que lo deje programado necesito su sí.",
    "Su pedido anterior quedó programado para las 12:00.",
    "Programar un pedido es posible hasta con 7 días de anticipación.",
    "",
  ])("no afirma: %s", (t) => {
    expect(afirmaPedidoProgramado(t)).toBe(false);
  });

  it("quita solo la frase falsa y conserva el resumen para el «sí»", () => {
    const r = "No es posible a esa hora; lo dejé programado para la apertura. Le repito su pedido: 2 tacos. Total $84.00. ¿Está correcto? Responda sí para confirmar.";
    const limpio = quitarAfirmacionDePedidoRegistrado(r, undefined, afirmaPedidoProgramado);
    expect(limpio).not.toMatch(/dejé programado/);
    expect(limpio).toContain("Le repito su pedido");
  });
});

describe("A19 en el turno: sin pedido creado ni «sí», el servidor quita «lo dejé programado»", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it("el modelo afirma que quedó programado y no hay pedido: la respuesta al cliente ya no lo dice, y no se crea pedido", async () => {
    const v = await nuevoViaje();
    v.guion([{ texto: "A esa hora no es posible; lo dejé programado para la apertura, a las 12:00 p. m. Le repito su pedido: 2 tacos. Total $84.00. ¿Está correcto? Responda sí." }]);
    const r = await v.escribe("quiero 2 tacos para recoger a las 3 de la mañana");
    expect(r.reply).not.toMatch(/dej[eé] programado/i);
    expect(r.reply).toMatch(/Le repito su pedido/);
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});
