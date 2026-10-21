// Cola local de «Entregado»: conserva la llave original, expira, respalda en memoria sin almacenamiento y separa a las personas.
import { beforeEach, describe, expect, it } from "vitest";
import { VIGENCIA_PENDIENTE_MS, claveCola, encolarEntrega, huellaIdentidad, leerPendientes, purgarColas, quitarPendiente } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";
import type { AlmacenLocal } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";

function memoria(): AlmacenLocal & { datos: Map<string, string> } {
  const datos = new Map<string, string>();
  return {
    datos,
    getItem: (k) => datos.get(k) ?? null,
    setItem: (k, v) => void datos.set(k, v),
    removeItem: (k) => void datos.delete(k),
    key: (i) => [...datos.keys()][i] ?? null,
    get length() {
      return datos.size;
    },
  };
}
const T0 = 1_000_000;
const P = (id = "o1", llave = "k1", cobradoMonto: number | null = null, en = T0) => ({ orderId: id, llave, cobradoMonto, en });

beforeEach(() => purgarColas(null, null)); // la cola en memoria es del modulo: cada caso empieza limpio

describe("cola de entregas pendientes", () => {
  it("encola persistida, lee y quita; al vaciar borra la clave", () => {
    const a = memoria();
    const r = encolarEntrega(a, "p1.u1", P("o1", "k1", 708));
    expect(r.persistida).toBe(true);
    expect(leerPendientes(a, "p1.u1", T0)).toHaveLength(1);
    expect(quitarPendiente(a, "p1.u1", "o1", T0)).toHaveLength(0);
    expect(a.datos.size).toBe(0);
  });

  it("un segundo toque al mismo pedido conserva la llave original", () => {
    const a = memoria();
    encolarEntrega(a, "c", P("o1", "k1"));
    const { lista } = encolarEntrega(a, "c", P("o1", "k2", 100, T0 + 5));
    expect(lista).toEqual([P("o1", "k1")]);
  });

  it("separa por clave y descarta lo de mas de 12 h", () => {
    const a = memoria();
    encolarEntrega(a, "c1", P());
    expect(leerPendientes(a, "c2", T0)).toHaveLength(0);
    expect(leerPendientes(a, "c1", T0 + VIGENCIA_PENDIENTE_MS)).toHaveLength(0);
  });

  it("sin almacenamiento (null): la entrega NO se pierde, queda en memoria y se avisa que no se persistio", () => {
    const r = encolarEntrega(null, "c", P());
    expect(r.persistida).toBe(false);
    expect(leerPendientes(null, "c", T0)).toEqual([P()]);
    expect(quitarPendiente(null, "c", "o1", T0)).toEqual([]);
  });

  it("almacenamiento que lanza o esta lleno: igual queda en memoria y persistida=false", () => {
    const lanza: AlmacenLocal = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("lleno"); }, removeItem: () => undefined, key: () => null, length: 0 };
    const r = encolarEntrega(lanza, "c", P());
    expect(r.persistida).toBe(false);
    expect(leerPendientes(lanza, "c", T0)).toEqual([P()]);
  });

  it("datos corruptos en el almacen se ignoran sin lanzar", () => {
    const a = memoria();
    a.setItem("atiende.chofer.entregas-pendientes.c", "{no es json");
    expect(leerPendientes(a, "c", T0)).toEqual([]);
  });
});

describe("celular compartido", () => {
  it("la clave distingue a las personas y no guarda el correo en claro", () => {
    expect(claveCola("p1", "ana@example.test")).not.toBe(claveCola("p1", "luis@example.test"));
    expect(claveCola("p1", "Ana@Example.test ")).toBe(claveCola("p1", "ana@example.test"));
    expect(claveCola("p1", "ana@example.test")).not.toContain("ana");
    expect(huellaIdentidad("x")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("otro chofer en el mismo celular no ve ni reenvia la entrega pendiente del anterior", () => {
    const a = memoria();
    const ana = claveCola("p1", "ana@example.test");
    const luis = claveCola("p1", "luis@example.test");
    encolarEntrega(a, ana, P("o1", "k-ana"));
    expect(leerPendientes(a, luis, T0)).toEqual([]);
  });

  it("purgar conserva solo la cola de la persona actual; con null borra todo (sesion vencida)", () => {
    const a = memoria();
    const ana = claveCola("p1", "ana@example.test");
    const luis = claveCola("p1", "luis@example.test");
    encolarEntrega(a, ana, P("o1"));
    encolarEntrega(a, luis, P("o2"));
    purgarColas(a, luis);
    expect(leerPendientes(a, ana, T0)).toEqual([]);
    expect(leerPendientes(a, luis, T0)).toHaveLength(1);
    purgarColas(a, null);
    expect(leerPendientes(a, luis, T0)).toEqual([]);
    expect(a.datos.size).toBe(0);
  });
});
