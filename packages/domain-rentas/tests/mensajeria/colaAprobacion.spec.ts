import { describe, expect, it } from "vitest";
import { AprobacionRequeridaError, aprobarBorrador, intentarEnvioAutomatico, marcarEnviadoTrasAprobacion, rechazarBorrador, TransicionBorradorInvalidaError } from "../../src/mensajeria/colaAprobacion.ts";
import type { BorradorEstado } from "../../src/mensajeria/colaAprobacion.ts";
import type { EstadoBorrador } from "../../src/mensajeria/tipos.ts";

function borrador(estado: EstadoBorrador): BorradorEstado {
  return { id: "b-1", estado };
}

describe("colaAprobacion — máquina de estados", () => {
  it("pendiente_aprobacion -> aprobado exige un aprobadoPor humano", () => {
    const resultado = aprobarBorrador(borrador("pendiente_aprobacion"), "usuario-1");
    expect(resultado).toEqual({ estado: "aprobado", aprobadoPor: "usuario-1", aprobadoEn: expect.any(String) });
  });

  it("no se puede aprobar un borrador que no está pendiente_aprobacion", () => {
    expect(() => aprobarBorrador(borrador("aprobado"), "u1")).toThrow(TransicionBorradorInvalidaError);
    expect(() => aprobarBorrador(borrador("enviado"), "u1")).toThrow(TransicionBorradorInvalidaError);
    expect(() => aprobarBorrador(borrador("rechazado"), "u1")).toThrow(TransicionBorradorInvalidaError);
  });

  it("pendiente_aprobacion -> rechazado exige motivo no vacío", () => {
    const resultado = rechazarBorrador(borrador("pendiente_aprobacion"), "usuario-1", "tono inapropiado");
    expect(resultado.estado).toBe("rechazado");
    expect(resultado.motivo).toBe("tono inapropiado");
  });

  it("rechazar sin motivo (vacío o solo espacios) lanza TransicionBorradorInvalidaError", () => {
    expect(() => rechazarBorrador(borrador("pendiente_aprobacion"), "u1", "")).toThrow(TransicionBorradorInvalidaError);
    expect(() => rechazarBorrador(borrador("pendiente_aprobacion"), "u1", "   ")).toThrow(TransicionBorradorInvalidaError);
  });

  it("marcarEnviadoTrasAprobacion SOLO transiciona desde aprobado", () => {
    expect(marcarEnviadoTrasAprobacion(borrador("aprobado"))).toEqual({ estado: "enviado" });
  });

  it("marcarEnviadoTrasAprobacion desde pendiente_aprobacion lanza AprobacionRequeridaError — nunca hay un salto directo pendiente->enviado", () => {
    expect(() => marcarEnviadoTrasAprobacion(borrador("pendiente_aprobacion"))).toThrow(AprobacionRequeridaError);
  });

  it("marcarEnviadoTrasAprobacion desde rechazado o enviado también lanza", () => {
    expect(() => marcarEnviadoTrasAprobacion(borrador("rechazado"))).toThrow(AprobacionRequeridaError);
    expect(() => marcarEnviadoTrasAprobacion(borrador("enviado"))).toThrow(AprobacionRequeridaError);
  });
});

describe("intentarEnvioAutomatico — D-006: sin ruta de envío directo para procesos automáticos", () => {
  it("SIEMPRE lanza AprobacionRequeridaError para pendiente_aprobacion", () => {
    expect(() => intentarEnvioAutomatico(borrador("pendiente_aprobacion"))).toThrow(AprobacionRequeridaError);
  });

  it("SIEMPRE lanza, incluso si el borrador YA está en estado aprobado — la regla es más estricta que 'requiere aprobación previa'", () => {
    expect(() => intentarEnvioAutomatico(borrador("aprobado"))).toThrow(AprobacionRequeridaError);
  });

  it("SIEMPRE lanza para rechazado y enviado también — ningún estado guardado habilita un envío sin un humano presionando el botón en ese instante", () => {
    expect(() => intentarEnvioAutomatico(borrador("rechazado"))).toThrow(AprobacionRequeridaError);
    expect(() => intentarEnvioAutomatico(borrador("enviado"))).toThrow(AprobacionRequeridaError);
  });

  it("el error tipado lleva el id y el estado actual, para el punto de auditoría", () => {
    let capturado: unknown;
    try {
      intentarEnvioAutomatico(borrador("aprobado"));
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(AprobacionRequeridaError);
    expect((capturado as AprobacionRequeridaError).borradorId).toBe("b-1");
    expect((capturado as AprobacionRequeridaError).estadoActual).toBe("aprobado");
  });
});
