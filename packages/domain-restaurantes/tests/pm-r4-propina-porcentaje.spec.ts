// QA-PM-R4-whatsapp-03 (R4W24): la propina dicha en porcentaje que el modelo no manda a crear_pedido la completa el servidor.
import { describe, expect, it } from "vitest";
import { porcentajePropinaDichoPorElCliente } from "../src/whatsapp/guards.ts";

describe("porcentajePropinaDichoPorElCliente", () => {
  it.each([
    [["si, con tarjeta; de propina 10%"], 10],
    [["Propina del 15 por ciento por favor"], 15],
    [["ok", "dejo 12.5% de propina", "gracias"], 12.5],
    [["de propina 10%", "mejor 20% de propina"], 20],
  ])("%j -> %s", (mensajes, esperado) => {
    expect(porcentajePropinaDichoPorElCliente(mensajes)).toBe(esperado);
  });
  it.each([[["sin propina"], null], [["quiero 10% de descuento"], null], [["la propina la doy en terminal"], null], [["propina de 500%"], null], [[], null]] as const)("%j -> sin porcentaje", (mensajes, esperado) => {
    expect(porcentajePropinaDichoPorElCliente(mensajes)).toBe(esperado);
  });
});
