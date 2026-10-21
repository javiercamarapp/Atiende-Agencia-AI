// Cola local de «Entregado»: conserva la llave original, expira, y no rompe sin almacenamiento.
import { describe, expect, it } from "vitest";
import { VIGENCIA_PENDIENTE_MS, encolarEntrega, leerPendientes, quitarPendiente } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";
import type { AlmacenLocal } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";

function memoria(): AlmacenLocal & { datos: Map<string, string> } {
  const datos = new Map<string, string>();
  return { datos, getItem: (k) => datos.get(k) ?? null, setItem: (k, v) => void datos.set(k, v), removeItem: (k) => void datos.delete(k) };
}
const T0 = 1_000_000;

describe("cola de entregas pendientes", () => {
  it("encola, lee y quita; al vaciar borra la clave", () => {
    const a = memoria();
    encolarEntrega(a, "p1", { orderId: "o1", llave: "k1", cobradoMonto: 708, en: T0 });
    expect(leerPendientes(a, "p1", T0)).toHaveLength(1);
    expect(quitarPendiente(a, "p1", "o1", T0)).toHaveLength(0);
    expect(a.datos.size).toBe(0);
  });

  it("un segundo toque al mismo pedido conserva la llave original (nunca dos llaves para una entrega)", () => {
    const a = memoria();
    encolarEntrega(a, "p1", { orderId: "o1", llave: "k1", cobradoMonto: null, en: T0 });
    const lista = encolarEntrega(a, "p1", { orderId: "o1", llave: "k2", cobradoMonto: 100, en: T0 + 5 });
    expect(lista).toEqual([{ orderId: "o1", llave: "k1", cobradoMonto: null, en: T0 }]);
  });

  it("separa por sucursal y descarta lo de mas de 12 h", () => {
    const a = memoria();
    encolarEntrega(a, "p1", { orderId: "o1", llave: "k1", cobradoMonto: null, en: T0 });
    expect(leerPendientes(a, "p2", T0)).toHaveLength(0);
    expect(leerPendientes(a, "p1", T0 + VIGENCIA_PENDIENTE_MS)).toHaveLength(0);
  });

  it("sin almacenamiento o con datos corruptos devuelve vacio sin lanzar", () => {
    expect(leerPendientes(null, "p1", T0)).toEqual([]);
    expect(encolarEntrega(null, "p1", { orderId: "o1", llave: "k", cobradoMonto: null, en: T0 })).toHaveLength(1);
    const a = memoria();
    a.setItem("atiende.chofer.entregas-pendientes.p1", "{no es json");
    expect(leerPendientes(a, "p1", T0)).toEqual([]);
    const lanza: AlmacenLocal = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => undefined };
    expect(leerPendientes(lanza, "p1", T0)).toEqual([]);
    expect(() => encolarEntrega(lanza, "p1", { orderId: "o1", llave: "k", cobradoMonto: null, en: T0 })).not.toThrow();
  });
});
