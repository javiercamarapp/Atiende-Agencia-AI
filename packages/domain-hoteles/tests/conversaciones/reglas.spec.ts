// H-20 -- reglas puras de la bandeja de conversaciones (minimizacion de PII, validacion de texto, estado de envio) y el espejo en memoria
// de las transiciones. El SQL real lo ejercita scripts/verify-hoteles-conversaciones.
import { describe, expect, it } from "vitest";
import {
  ConversacionesValidacionError,
  claveTelefonoConversacion,
  enmascararTelefono,
  estadoEnvioDeOutbox,
  mapConversacionesPgError,
  mapMensaje,
  minimizarTextoPii,
  motivoHandoffTexto,
  textoTieneDatoSensible,
  validarTextoConversacion,
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesNoEncontradaError,
  ConversacionesRechazadaError,
} from "../../src/index.ts";

function pg(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe("minimizacion de PII", () => {
  it("telefono: ultimos 4 digitos; clave de enlace: ultimos 10", () => {
    expect(enmascararTelefono("+5215511112222")).toBe("••••2222");
    expect(enmascararTelefono("12")).toBe("••••");
    expect(claveTelefonoConversacion("+52 1 55 1111 2222")).toBe("5511112222");
    expect(claveTelefonoConversacion("123")).toBeNull();
    expect(claveTelefonoConversacion(null)).toBeNull();
  });
  it("texto: oculta correos y numeros largos, deja cifras cortas (cuartos, horas)", () => {
    expect(minimizarTextoPii("Escribe a ana@example.com o llama al 55 1234 5678, cuarto 410 a las 3")).toBe("Escribe a [correo] o llama al [número], cuarto 410 a las 3");
  });
  it("detecta tarjeta/documento (13 a 19 digitos con espacios o guiones) y valida el texto", () => {
    expect(textoTieneDatoSensible("4111 1111 1111 1111")).toBe(true);
    expect(textoTieneDatoSensible("4111-1111-1111-1111")).toBe(true);
    expect(textoTieneDatoSensible("habitacion 410, 2 noches")).toBe(false);
    expect(validarTextoConversacion("  hola  ", "texto")).toBe("hola");
    for (const malo of ["", "   ", "x".repeat(1001), 5, null, "tarjeta 4111111111111111"]) expect(() => validarTextoConversacion(malo, "texto")).toThrow(ConversacionesValidacionError);
    expect(validarTextoConversacion("x".repeat(1000), "texto")).toHaveLength(1000);
  });
});

describe("estado de envio y mensajes", () => {
  it("mapea messaging_outbox.status a un estado que la UI entiende", () => {
    expect(estadoEnvioDeOutbox("pending")).toBe("pendiente_envio");
    expect(estadoEnvioDeOutbox("processing")).toBe("enviando");
    expect(estadoEnvioDeOutbox("sent")).toBe("enviado");
    expect(estadoEnvioDeOutbox("failed")).toBe("fallido");
    expect(estadoEnvioDeOutbox("dead")).toBe("fallido");
    expect(estadoEnvioDeOutbox(null)).toBeNull();
  });
  it("mapMensaje: origen huesped/agente/personal, tolera filas viejas y descarta basura", () => {
    expect(mapMensaje({ role: "user", content: "hola" })).toMatchObject({ rol: "user", origen: "huesped", envio: null, creadoEn: null });
    expect(mapMensaje({ role: "assistant", content: "ok" })).toMatchObject({ origen: "agente", envio: null });
    expect(mapMensaje({ role: "assistant", content: "ok", origen: "humano", autor_id: "u1", creado_en: "2026-12-02T18:00:00Z", envio: "sent" })).toMatchObject({ origen: "personal", autorId: "u1", envio: "enviado" });
    expect(mapMensaje({ role: "assistant", content: "ok", origen: "humano" })!.envio).toBe("pendiente_envio");
    expect(mapMensaje(null)).toBeNull();
    expect(mapMensaje({ role: "system", content: "x" })).toBeNull();
    expect(mapMensaje({ role: "user" })).toBeNull();
  });
  it("motivos de derivacion con texto claro y sin PII", () => {
    expect(motivoHandoffTexto(null)).toBeNull();
    expect(motivoHandoffTexto("agente_pausado")).toMatch(/pausado/);
    expect(motivoHandoffTexto("agente_presupuesto_agotado")).toMatch(/presupuesto/);
    expect(motivoHandoffTexto("otro_codigo")).toBe("Derivada a una persona");
  });
});

describe("traduccion de errores de Postgres", () => {
  it("SQLSTATE de las funciones 043 -> errores de dominio tipados", () => {
    expect(mapConversacionesPgError(pg("42883", "function hoteles.conversaciones_listar(uuid, text) does not exist"), "x")).toBeInstanceOf(ConversacionesNoDisponibleError);
    expect(mapConversacionesPgError(pg("42P01", "no existe"), "x")).toBeInstanceOf(ConversacionesNoDisponibleError);
    expect(mapConversacionesPgError(pg("P0002", "conversacion no encontrada"), "x")).toBeInstanceOf(ConversacionesNoEncontradaError);
    expect(mapConversacionesPgError(pg("42501", "permiso"), "x")).toBeInstanceOf(ConversacionesRechazadaError);
    expect(mapConversacionesPgError(pg("22023", "texto_con_dato_sensible: no envies tarjetas"), "x")).toMatchObject({ name: "ConversacionesValidacionError", message: "no envies tarjetas" });
    const ya = mapConversacionesPgError(pg("55000", "ya_tomada: otra persona ya tomo esta conversacion"), "x");
    expect(ya).toBeInstanceOf(ConversacionesConflictoError);
    expect((ya as ConversacionesConflictoError).codigo).toBe("ya_tomada");
    expect((mapConversacionesPgError(pg("55000", "ventana_24h: pasaron mas de 24 horas"), "x") as ConversacionesConflictoError).codigo).toBe("ventana_24h");
    expect((mapConversacionesPgError(pg("55000", "canal_no_configurado: sin numero"), "x") as ConversacionesConflictoError).codigo).toBe("canal_no_configurado");
  });
  it("un error desconocido se repropaga sin enmascarar", () => {
    const raro = pg("57014", "statement timeout");
    expect(mapConversacionesPgError(raro, "x")).toBe(raro);
    expect(mapConversacionesPgError(pg("55000", "otro estado raro"), "x")).toMatchObject({ code: "55000" });
  });
});
