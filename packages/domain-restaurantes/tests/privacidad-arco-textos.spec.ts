// Textos de la respuesta ARCO alineados con el informe legal (inv-privacidad-2026, §1.3): dias HABILES contados desde la RECEPCION; la cancelacion pasa por bloqueo y
// luego supresion (no se promete borrado inmediato); trato de usted; sin datos personales en el texto.
import { describe, expect, it } from "vitest";
import { ARCO_MENU_APENDICE, ARCO_MENU_REPLY, ARCO_THIRD_PARTY_REPLY, arcoConfirmedReply, arcoConjeturaReply, arcoPendingConfirmationReply } from "../src/privacidad/data-rights.ts";

const ID = "11111111-2222-3333-4444-555555555555";

describe("plazo en la confirmacion", () => {
  const conFechas = arcoConfirmedReply("acceso", ID, "2026-10-20T15:00:00.000Z", "2026-11-04T15:00:00.000Z", "America/Mexico_City");
  const sinFechas = arcoConfirmedReply("acceso", ID, null, null, "America/Mexico_City");

  it("dice 20 dias HABILES contados desde que se RECIBIO la solicitud (con y sin fechas)", () => {
    for (const t of [conFechas, sinFechas]) {
      expect(t).toMatch(/20 días hábiles/);
      expect(t).toMatch(/desde que recibió su solicitud/);
      expect(t).toMatch(/15 días hábiles siguientes a esa respuesta/);
    }
  });
  it("la fecha del sistema se presenta como referencia interna, no como el plazo legal", () => {
    expect(conFechas).toContain("20 de octubre de 2026");
    expect(conFechas).toMatch(/referencia interna/);
    expect(conFechas).not.toMatch(/20 días\)/); // ya no se afirma «20 dias» a secas
  });
  it("cancelacion: bloqueo y luego supresion, con el periodo notificado, sin prometer borrado inmediato", () => {
    const t = arcoConfirmedReply("cancelacion", ID, "2026-10-20T15:00:00.000Z", "2026-11-04T15:00:00.000Z", "America/Mexico_City");
    expect(t).toContain("se bloquean primero");
    expect(t).toMatch(/periodo de bloqueo que el restaurante le notificará/);
    expect(t).toMatch(/No se borran de inmediato/);
    expect(t).not.toMatch(/\b(borrados|eliminados|suprimidos) (ya|ahora|de inmediato)\b/);
  });
  it("no se envian datos personales por el chat", () => {
    expect(conFechas).toContain("no envío datos personales");
  });
});

describe("tono y marcas", () => {
  const todos = [ARCO_MENU_REPLY, ARCO_MENU_APENDICE, ARCO_THIRD_PARTY_REPLY, arcoPendingConfirmationReply("acceso", ID), arcoConjeturaReply("acceso", ID)];
  it("trato de usted en todos los textos", () => {
    for (const t of todos) expect(t).not.toMatch(/\b(tu|tus|te|dime|puedes|quieres)\b/i);
  });
  it("la solicitud pendiente aclara que el pedido sigue disponible y que sin CONFIRMO no avanza", () => {
    const t = arcoPendingConfirmationReply("cancelacion", ID);
    expect(t).toMatch(/su pedido o su factura/);
    expect(t).toContain("la solicitud no avanza si no responde CONFIRMO");
  });
  it("el menu numerado lista los cuatro derechos con numero y deja seguir con el pedido", () => {
    for (const n of ["1. Acceso", "2. Rectificación", "3. Cancelación", "4. Oposición"]) expect(ARCO_MENU_REPLY).toContain(n);
    expect(ARCO_MENU_REPLY).toMatch(/no se pierde nada/);
  });
  it("la conjetura nombra el derecho, el folio y no promete que una persona esta en linea", () => {
    const t = arcoConjeturaReply("acceso", ID);
    expect(t).toContain("acceso");
    expect(t).toContain("folio 11111111");
    expect(t).toMatch(/una persona del equipo la revisará/);
  });
  it("ningun texto lleva el telefono ni datos personales", () => {
    for (const t of todos) expect(t).not.toMatch(/\+?\d{10,}/);
  });
});
