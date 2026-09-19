// Motor puro de sugerencias -- ver `../src/superadmin-acciones/sugerencias.ts`.
// Sin I/O: cada caso construye su propio input.
import { describe, expect, it } from "vitest";
import type { OutboxDeadMessageRow } from "@atiende/db";
import { calcularSugerencias } from "../src/superadmin-acciones/sugerencias.ts";

const AHORA = new Date("2026-09-19T12:00:00.000Z");

function mensajeMuerto(overrides: Partial<OutboxDeadMessageRow> = {}): OutboxDeadMessageRow {
  return {
    queueName: "hoteles",
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-000000000002",
    organizationName: "Hotel Demo",
    channel: "whatsapp",
    eventType: "confirmacion",
    error: "permanent_failure",
    createdAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("calcularSugerencias", () => {
  it("sin datos -> sin sugerencias", () => {
    expect(calcularSugerencias({ mensajesMuertos: [], prospectosNecesitanSeguimiento: [], ahora: AHORA })).toEqual([]);
  });

  it("un mensaje muerto -> una sugerencia de reencolar_mensaje_muerto con el payload precargado", () => {
    const m = mensajeMuerto();
    const sugerencias = calcularSugerencias({ mensajesMuertos: [m], prospectosNecesitanSeguimiento: [], ahora: AHORA });
    expect(sugerencias).toHaveLength(1);
    expect(sugerencias[0]).toMatchObject({
      tipoAccion: "reencolar_mensaje_muerto",
      payloadSugerido: { queue: "hoteles", mensajeId: m.id },
    });
    expect(sugerencias[0]?.titulo).toContain("1 mensaje muerto en hoteles");
  });

  it("3 mensajes muertos en la MISMA cola -> 3 sugerencias, cada título menciona el total agregado", () => {
    const mensajes = [mensajeMuerto({ id: "a" }), mensajeMuerto({ id: "b" }), mensajeMuerto({ id: "c" })];
    const sugerencias = calcularSugerencias({ mensajesMuertos: mensajes, prospectosNecesitanSeguimiento: [], ahora: AHORA });
    expect(sugerencias).toHaveLength(3);
    for (const s of sugerencias) {
      expect(s.titulo).toBe("3 mensajes muertos en hoteles: revisar y reencolar");
    }
    // Cada sugerencia sigue apuntando a SU mensaje concreto (un intent de un
    // clic exige un mensaje puntual, nunca un lote).
    expect(new Set(sugerencias.map((s) => s.payloadSugerido.mensajeId)).size).toBe(3);
  });

  it("mensajes muertos en colas distintas -> cada una cuenta por separado", () => {
    const mensajes = [mensajeMuerto({ queueName: "hoteles", id: "a" }), mensajeMuerto({ queueName: "citas", id: "b" })];
    const sugerencias = calcularSugerencias({ mensajesMuertos: mensajes, prospectosNecesitanSeguimiento: [], ahora: AHORA });
    expect(sugerencias.map((s) => s.titulo).sort()).toEqual(["1 mensaje muerto en citas: revisar y reencolar", "1 mensaje muerto en hoteles: revisar y reencolar"]);
  });

  it("un prospecto sin movimiento -> una sugerencia de cerrar_prospecto con los días calculados", () => {
    const sugerencias = calcularSugerencias({
      mensajesMuertos: [],
      prospectosNecesitanSeguimiento: [{ id: "p1", empresa: "Acme", vertical: "hoteles", necesitaSeguimientoDesde: "2026-08-29T12:00:00.000Z" }],
      ahora: AHORA,
    });
    expect(sugerencias).toHaveLength(1);
    expect(sugerencias[0]?.tipoAccion).toBe("cerrar_prospecto");
    expect(sugerencias[0]?.payloadSugerido).toEqual({ prospectoId: "p1", estado: "perdido" });
    expect(sugerencias[0]?.titulo).toContain('Prospecto "Acme" lleva 21 día(s) sin movimiento');
  });

  it("una sugerencia jamás incluye una acción ya ejecutada -- el payload SIEMPRE apunta a un tipoAccion válido del catálogo con intent", () => {
    const sugerencias = calcularSugerencias({
      mensajesMuertos: [mensajeMuerto()],
      prospectosNecesitanSeguimiento: [{ id: "p1", empresa: "Acme", vertical: "hoteles", necesitaSeguimientoDesde: AHORA.toISOString() }],
      ahora: AHORA,
    });
    for (const s of sugerencias) {
      expect(["reencolar_mensaje_muerto", "cerrar_prospecto"]).toContain(s.tipoAccion);
    }
  });
});
