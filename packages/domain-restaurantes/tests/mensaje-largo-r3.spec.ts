// QA-PM-R3-whatsapp-12 (P3): un mensaje de 6,000 caracteres ("quiero tacos por favor por favor ...") se quedaba sin respuesta. El mensaje se acota antes de guardarlo y de llegar al modelo.
import { describe, expect, it } from "vitest";
import { MENSAJE_CLIENTE_MAX_CARACTERES, limitarLargoDelMensaje } from "../src/whatsapp/inbound.ts";

describe("limitarLargoDelMensaje", () => {
  it("un mensaje normal queda igual", () => {
    expect(limitarLargoDelMensaje("quiero 4 tacos de pastor para recoger")).toBe("quiero 4 tacos de pastor para recoger");
    const justo = "a".repeat(MENSAJE_CLIENTE_MAX_CARACTERES);
    expect(limitarLargoDelMensaje(justo)).toBe(justo);
  });
  it("uno de 6,000 caracteres conserva el inicio (donde esta la peticion) y se marca como recortado", () => {
    const largo = `quiero tacos ${"por favor ".repeat(600)}`;
    const r = limitarLargoDelMensaje(largo);
    expect(r.length).toBeLessThanOrEqual(MENSAJE_CLIENTE_MAX_CARACTERES + 4);
    expect(r.startsWith("quiero tacos por favor")).toBe(true);
    expect(r.endsWith("[…]")).toBe(true);
  });
});
