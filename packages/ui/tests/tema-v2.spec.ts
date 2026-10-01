// PR-1 de diseno-ux: mecanica de la bandera visual <html data-theme="v2">.
// Sin parametro ni valor recordado NO se activa (produccion intacta).
import { describe, expect, it } from "vitest";
import {
  CLAVE_TEMA_V2,
  activarTemaV2,
  desactivarTemaV2,
  inicializarTemaV2,
  temaV2Activo,
} from "../src/lib/tema-v2.ts";

function raizFalsa() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
}
function almacenFalso(inicial: Record<string, string> = {}) {
  const m = new Map(Object.entries(inicial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("bandera data-theme=v2", () => {
  it("activar / desactivar", () => {
    const raiz = raizFalsa();
    expect(temaV2Activo(raiz)).toBe(false);
    activarTemaV2(raiz);
    expect(raiz.attrs.get("data-theme")).toBe("v2");
    expect(temaV2Activo(raiz)).toBe(true);
    desactivarTemaV2(raiz);
    expect(temaV2Activo(raiz)).toBe(false);
  });

  it("sin parametro ni valor guardado no se activa (produccion intacta)", () => {
    const raiz = raizFalsa();
    expect(inicializarTemaV2({ busqueda: "", almacen: almacenFalso(), raiz })).toBe(false);
    expect(temaV2Activo(raiz)).toBe(false);
  });

  it("?ds=v2 la activa y la recuerda; ?ds=off la apaga y la olvida", () => {
    const raiz = raizFalsa();
    const almacen = almacenFalso();
    expect(inicializarTemaV2({ busqueda: "?ds=v2", almacen, raiz })).toBe(true);
    expect(almacen.m.get(CLAVE_TEMA_V2)).toBe("v2");
    expect(inicializarTemaV2({ busqueda: "", almacen, raiz })).toBe(true);
    expect(inicializarTemaV2({ busqueda: "?ds=off", almacen, raiz })).toBe(false);
    expect(almacen.m.has(CLAVE_TEMA_V2)).toBe(false);
    expect(temaV2Activo(raiz)).toBe(false);
  });

  it("un localStorage que lanza no rompe el arranque", () => {
    const raiz = raizFalsa();
    const roto = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
      removeItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(inicializarTemaV2({ busqueda: "?ds=v2", almacen: roto, raiz })).toBe(true);
    expect(temaV2Activo(raiz)).toBe(true);
  });
});
