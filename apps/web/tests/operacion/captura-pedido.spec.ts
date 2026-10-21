import { describe, expect, it } from "vitest";
import { esquemaCotizarPedidoOperador, esquemaCrearPedidoOperador } from "@atiende/domain-restaurantes/operacion";
import { entradaCotizar, entradaCrear, faltantes, formularioVacio, GUION_CONSENTIMIENTO, normalizarTelefono, textoAviso } from "../../src/verticals/restaurantes/lib/captura-pedido.ts";
import type { FormularioCaptura } from "../../src/verticals/restaurantes/lib/captura-pedido.ts";

const PROD = "00000000-0000-4000-8000-0000000000a1";
const PROP = "00000000-0000-4000-8000-0000000000b1";
function lleno(extra: Partial<FormularioCaptura> = {}): FormularioCaptura {
  return { ...formularioVacio(PROP), telefono: "999 123 4567", nombre: "Ana R.", direccion: "Calle 60 #320", colonia: "Centro", lineas: [{ productId: PROD, nombre: "Pastor", cantidad: 2, tortilla: "maiz", nota: "sin cebolla" }], consentimiento: true, ...extra };
}

describe("captura de pedido", () => {
  it("el guion es el acordado", () => {
    expect(GUION_CONSENTIMIENTO).toBe("Le mandamos el aviso de su pedido por WhatsApp a este número, ¿está bien?");
  });

  it("normaliza telefonos mexicanos a E.164", () => {
    expect(normalizarTelefono("999 123 4567")).toBe("+529991234567");
    expect(normalizarTelefono("(999) 123-4567")).toBe("+529991234567");
    expect(normalizarTelefono("+52 999 123 4567")).toBe("+529991234567");
    expect(normalizarTelefono("521 999 123 4567")).toBe("+529991234567");
    expect(normalizarTelefono("123")).toBeNull();
    expect(normalizarTelefono("")).toBeNull();
  });

  it("el consentimiento nunca viene por omision: sin respuesta no se puede guardar", () => {
    expect(formularioVacio(PROP).consentimiento).toBeNull();
    const f = lleno({ consentimiento: null });
    expect(faltantes(f, 708, true).join(" ")).toContain("aviso por WhatsApp");
    expect(entradaCrear(f)).toBeNull();
  });

  it("«No» es una respuesta valida y viaja como otorgado:false", () => {
    const f = lleno({ consentimiento: false });
    expect(faltantes(f, 708, true)).toEqual([]);
    expect(entradaCrear(f)?.consentimientoWhatsapp).toEqual({ otorgado: false, via: "verbal_llamada" });
  });

  it("confirmar ya viene activado y el cuerpo cumple el contrato", () => {
    expect(formularioVacio(PROP).confirmarYa).toBe(true);
    const cuerpo = entradaCrear(lleno({ forma: "efectivo", pagaCon: "1000" }));
    expect(cuerpo).not.toBeNull();
    expect(esquemaCrearPedidoOperador.validar(cuerpo).ok).toBe(true);
    expect(cuerpo?.items[0]).toEqual({ productId: PROD, cantidad: 2, modificadores: ["tortilla_maiz"], nota: "sin cebolla" });
    expect(cuerpo?.pago).toEqual({ forma: "efectivo", pagaCon: 1000 });
    expect(cuerpo?.cliente.telefono).toBe("+529991234567");
  });

  it("la cotizacion cumple el contrato y recoger no manda direccion", () => {
    const c = entradaCotizar(lleno({ canal: "recoger", direccion: "" }));
    expect(c?.direccion).toBeNull();
    expect(esquemaCotizarPedidoOperador.validar(c).ok).toBe(true);
    expect(entradaCotizar(lleno({ telefono: "12" }))).toBeNull();
    expect(entradaCotizar(lleno({ direccion: "" }))).toBeNull();
  });

  it("faltantes: domicilio sin cobertura, paga con menor al total y sin total", () => {
    expect(faltantes(lleno(), 708, false)).toContain("Dirección dentro de cobertura");
    expect(faltantes(lleno({ pagaCon: "500" }), 708, true)).toContain("«Paga con» no cubre el total");
    expect(faltantes(lleno({ pagaCon: "1000" }), 708, true)).toEqual([]);
    expect(faltantes(lleno(), null, null)).toContain("Total calculado por el sistema");
    expect(faltantes(lleno({ forma: "tarjeta", pagaCon: "1" }), 708, true)).toEqual([]);
  });

  it("explica por que quedo sin aviso", () => {
    expect(textoAviso({ estado: "encolado", motivo: null })).toContain("en camino");
    expect(textoAviso({ estado: "omitido", motivo: "sin_consentimiento" })).toContain("avísale al cliente por llamada");
  });
});
