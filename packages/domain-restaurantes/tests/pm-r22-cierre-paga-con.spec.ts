// PM R22 (causa 4 / R2): el resumen canonico imprimia «paga con $total» en vez del billete que dio el cliente (SIM 093, 341, NU-1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("R22: «paga con» muestra el billete del cliente", () => {
  it("el cliente dijo «Pagaré con $500» y el modelo mandó el total: el resumen dice $500", async () => {
    const s = setup();
    await s.quote({ payment_method: "efectivo", efectivo_con: undefined });
    const total = await s.total();
    s.cliente("Pagaré con $500");
    await s.quote({ payment_method: "efectivo", efectivo_con: total });
    const c = await s.canonico();
    expect(c).toContain("Pago: efectivo (paga con $500)");
    expect(c).not.toContain(`paga con $${total}`);
  });

  it("si el cliente no dio billete, no se inventa uno (sin «paga con» cuando el modelo tampoco lo manda)", async () => {
    const s = setup();
    s.cliente("Va en efectivo");
    await s.quote({ payment_method: "efectivo", efectivo_con: undefined });
    expect(await s.canonico()).not.toContain("paga con");
  });

  it("sin billete en el mensaje, se respeta el efectivo_con del modelo", async () => {
    const s = setup();
    s.cliente("Con efectivo");
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 });
    expect(await s.canonico()).toContain("paga con $500");
  });
});

describe("R22 (revisión): solo un billete EXPLÍCITO cuenta; números sueltos, negados o viejos no", () => {
  async function conMensaje(mensajes: string[], modelo: number | undefined = 40) {
    const s = setup();
    for (const m of mensajes) { if (m.startsWith("A:")) s.asistente(m.slice(2)); else s.cliente(m); }
    await s.quote({ payment_method: "efectivo", efectivo_con: modelo });
    return s.canonico();
  }
  it.each(["mi tel 9991234567", "Calle 60 numero 500", "folio 450", "calle 21 x 12 y 14 col 600", "a las 500", "si, 5000"])("«%s» no es billete: queda el del modelo", async (m) => {
    const c = await conMensaje(["efectivo", m], 500);
    expect(c).toContain("paga con $500");
    const c2 = await conMensaje([m], 40);
    expect(c2).not.toMatch(/paga con \$(9991234567|9,991,234,567|60|450|600|5000|14)\b/);
  });
  it("«no tengo billete de 500, solo de 200»: no cuenta el 500", async () => {
    const c = await conMensaje(["Pagaré con $500", "no tengo billete de 500, solo de 200"], 200);
    expect(c).toContain("paga con $200");
    expect(c).not.toContain("paga con $500");
  });
  it("un billete viejo antes de «mejor pago exacto» no resucita", async () => {
    const c = await conMensaje(["Pagaré con $500", "mejor pago exacto"], 90);
    expect(c).toContain("paga con $90");
  });
  it("un resumen mostrado con OTRO total invalida el billete anterior", async () => {
    const c = await conMensaje(["Pagaré con $500", "A:Resumen\nTotal a pagar: $300\n¿Está correcto?", "agrego unas cocas"], 90);
    expect(c).toContain("paga con $90");
  });
  it("billete implausible (> 10x el total y > 5000) no cuenta", async () => {
    const c = await conMensaje(["pago con 99999"], 100);
    expect(c).toContain("paga con $100");
  });
});
