// Composición del resumen legible del intent -- ver
// `../src/superadmin-acciones/resumen.ts`. Sin I/O.
import { describe, expect, it } from "vitest";
import type { OutboxDeadMessageDetailRow } from "@atiende/db";
import { construirResumenCerrarProspecto, construirResumenEjecutarMantenimientoAhora, construirResumenReencolarMensajeMuerto, enmascararDestinatario } from "../src/superadmin-acciones/resumen.ts";

describe("enmascararDestinatario", () => {
  it("correo -> conserva primer/último caracter del local-part y el dominio completo", () => {
    expect(enmascararDestinatario({ to: "huesped@example.com" })).toBe("h***d@example.com");
  });

  it("teléfono -> conserva solo los últimos 4 dígitos", () => {
    expect(enmascararDestinatario({ to: "+525599990000" })).toBe("*********0000");
  });

  it("sin ninguna clave reconocida en el payload -> 'destinatario desconocido', NUNCA inventa un valor", () => {
    expect(enmascararDestinatario({ algoIrrelevante: "x" })).toBe("destinatario desconocido");
  });

  it("prueba varias claves comunes en orden (telefono/phone/destinatario/recipient/correo)", () => {
    expect(enmascararDestinatario({ telefono: "5599990000" })).toContain("0000");
    expect(enmascararDestinatario({ correo: "a@b.com" })).toContain("@b.com");
  });
});

describe("construirResumenReencolarMensajeMuerto", () => {
  it("incluye canal, vertical (queueName), organización, destinatario enmascarado y el error", () => {
    const detalle: OutboxDeadMessageDetailRow = {
      queueName: "hoteles",
      id: "m1",
      organizationId: "o1",
      organizationName: "Hotel Demo",
      channel: "whatsapp",
      eventType: "confirmacion",
      payload: { to: "+525599990000" },
      error: "permanent_failure: número inválido",
      createdAt: "2026-09-18T10:00:00.000Z",
    };
    const resumen = construirResumenReencolarMensajeMuerto(detalle);
    expect(resumen).toContain("envío real por whatsapp");
    expect(resumen).toContain("Hotel Demo");
    expect(resumen).toContain("hoteles");
    expect(resumen).toContain("confirmacion");
    expect(resumen).toContain("permanent_failure: número inválido");
    expect(resumen).not.toContain("+525599990000"); // nunca el dato crudo completo
  });

  it("sin error registrado -> lo dice explícito, nunca lo omite en silencio", () => {
    const detalle: OutboxDeadMessageDetailRow = {
      queueName: "despachos",
      id: "m2",
      organizationId: "o2",
      organizationName: "Despacho Demo",
      channel: "email",
      eventType: "recordatorio",
      payload: {},
      error: null,
      createdAt: "2026-09-18T10:00:00.000Z",
    };
    expect(construirResumenReencolarMensajeMuerto(detalle)).toContain("sin detalle de error registrado");
  });
});

describe("construirResumenCerrarProspecto", () => {
  it("es explícito sobre que no contacta a nadie", () => {
    const resumen = construirResumenCerrarProspecto("Acme", "contactado", "perdido");
    expect(resumen).toContain('"Acme"');
    expect(resumen).toContain('"contactado"');
    expect(resumen).toContain('"perdido"');
    expect(resumen).toContain("No contacta a nadie");
  });
});

describe("construirResumenEjecutarMantenimientoAhora", () => {
  it("menciona las dos automatizaciones y que no envía nada", () => {
    const resumen = construirResumenEjecutarMantenimientoAhora();
    expect(resumen).toContain("desatascar outbox");
    expect(resumen).toContain("marcar prospectos");
    expect(resumen).toContain("No envía nada");
  });
});
