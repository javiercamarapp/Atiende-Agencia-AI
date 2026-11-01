// F4c (1) -- borrar producto: elimina de verdad sin historial, archiva con historial; mensaje de confirmacion honesto.
import { describe, expect, it } from "vitest";
import { InMemoryProductoBajaRepository, ParidadNoDisponibleError, mensajeConfirmacionBaja, tipoDeBaja } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTRA = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-0000000000p1".replace("p", "a");
const P2 = "00000000-0000-4000-8000-0000000000b2";

describe("tipoDeBaja y mensaje", () => {
  it("0 pedidos = eliminar; 1 o mas = archivar", () => {
    expect(tipoDeBaja(0)).toBe("eliminar");
    expect(tipoDeBaja(1)).toBe("archivar");
    expect(mensajeConfirmacionBaja({ nombre: "Platillo de prueba", tipo: "eliminar", pedidosConHistorial: 0 })).toMatch(/definitiva/);
    expect(mensajeConfirmacionBaja({ nombre: "Platillo de prueba", tipo: "archivar", pedidosConHistorial: 3 })).toMatch(/3 pedido\(s\).*archivara/);
  });
});

describe("InMemoryProductoBajaRepository", () => {
  function armar() {
    const r = new InMemoryProductoBajaRepository();
    r.sembrar(ORG, P1, "Sin historial", 0);
    r.sembrar(ORG, P2, "Con historial", 4);
    return r;
  }
  it("sin historial: se elimina", async () => {
    const r = armar();
    expect(await r.ejecutar(ORG, P1)).toMatchObject({ estado: "eliminado", pedidosConHistorial: 0 });
    expect(r.eliminados).toEqual([P1]);
    expect(await r.evaluar(ORG, P1)).toBeNull();
  });
  it("con historial: se archiva (sigue existiendo, ya no se lista)", async () => {
    const r = armar();
    expect(await r.ejecutar(ORG, P2)).toMatchObject({ estado: "archivado", pedidosConHistorial: 4 });
    expect(await r.listarArchivados(ORG)).toEqual(new Set([P2]));
    expect(await r.evaluar(ORG, P2)).toMatchObject({ yaArchivado: true, tipo: "archivar" });
  });
  it("otra organizacion no ve ni toca el producto", async () => {
    const r = armar();
    expect(await r.evaluar(OTRA, P1)).toBeNull();
    expect(await r.ejecutar(OTRA, P2)).toBeNull();
    expect((await r.listarArchivados(OTRA)).size).toBe(0);
  });
  it("base sin la 180: borrar sin historial funciona, archivar da 503 y la lista de archivados queda vacia", async () => {
    const r = armar();
    r.migrada = false;
    await expect(r.ejecutar(ORG, P2)).rejects.toBeInstanceOf(ParidadNoDisponibleError);
    expect(await r.ejecutar(ORG, P1)).toMatchObject({ estado: "eliminado" });
    expect((await r.listarArchivados(ORG)).size).toBe(0);
  });
});
