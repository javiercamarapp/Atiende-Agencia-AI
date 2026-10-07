// QA-citas-R1-agentes-05: la llave del cliente distingue el pais. Mexico sigue siendo los ultimos 10 digitos (llave con la que ya estan
// guardados los clientes); un numero de otro pais conserva su codigo y ya no se confunde con uno mexicano de los mismos 10 digitos.
import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/appointments.ts";
import { canonicalizarTelefonoCitas } from "../src/voz/telefono.ts";

describe("normalizePhone: pais", () => {
  it.each([
    ["+5215512345678", "5512345678"],
    ["+525512345678", "5512345678"],
    ["52 1 55 1234 5678", "5512345678"],
    ["5512345678", "5512345678"],
    ["(55) 1234-5678", "5512345678"],
    ["015512345678", "5512345678"],
    ["0445512345678", "5512345678"],
    ["1234567", "1234567"],
  ])("mexicano %s -> %s", (entrada, esperado) => {
    expect(normalizePhone(entrada)).toBe(esperado);
  });

  it("un numero de EE. UU. con los mismos 10 digitos NO es el mismo cliente que el mexicano", () => {
    expect(normalizePhone("+15512345678")).toBe("15512345678");
    expect(normalizePhone("+1 (551) 234-5678")).not.toBe(normalizePhone("+52 55 1234 5678"));
  });

  it("otros paises conservan su codigo", () => {
    expect(normalizePhone("+34 612 345 678")).toBe("34612345678");
    expect(normalizePhone("+44 7911 123456")).toBe("447911123456");
  });

  it("texto que no es telefono se devuelve recortado", () => {
    expect(normalizePhone("  hola ")).toBe("hola");
  });

  it("voz: el llamante de EE. UU. no se canoniza al mexicano", () => {
    expect(canonicalizarTelefonoCitas("+15512345678")).toBe("15512345678");
    expect(canonicalizarTelefonoCitas("+525512345678")).toBe("5512345678");
  });
});
