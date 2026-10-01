// Corre la suite de contrato reutilizable contra el adaptador FALSO. El adaptador
// real debe correr esta misma suite (ver src/softrestaurant/contract.ts).
import { describe, expect, it } from "vitest";
import { runSoftRestaurantPortContract } from "../src/softrestaurant/contract.ts";
import { FakeSoftRestaurantAdapter, SoftRestaurantNoConfiguradoPort } from "../src/softrestaurant/fake-adapter.ts";
import { SoftRestaurantNoDisponibleError } from "../src/softrestaurant/types.ts";

runSoftRestaurantPortContract("FakeSoftRestaurantAdapter", () => {
  const fake = new FakeSoftRestaurantAdapter({ ahora: () => new Date("2026-09-30T18:00:00.000Z") });
  return {
    port: fake,
    codigoValido: { producto: "FAKE-001", modificador: "FAKE-MOD-001" },
    fallas: {
      timeout: () => fake.inyectarFalla("crearComanda", { tipo: "timeout" }),
      http5xx: () => fake.inyectarFalla("crearComanda", { tipo: "http_5xx" }),
      duplicado: () => fake.inyectarFalla("crearComanda", { tipo: "duplicado" }),
      productoInexistente: () => fake.inyectarFalla("crearComanda", { tipo: "producto_inexistente" }),
    },
  };
});

describe("FakeSoftRestaurantAdapter: comportamiento propio", () => {
  it("es determinista: folios por sucursal consecutivos y reloj inyectado", async () => {
    const fake = new FakeSoftRestaurantAdapter({ ahora: () => new Date("2026-09-30T18:00:00.000Z") });
    const base = { tipo: "recoger", cliente: { nombre: "A", telefono: "9991112233" }, formaPago: "efectivo", items: [{ codigo: "FAKE-003", cantidad: 1, modificadores: [] }] } as const;
    const a = await fake.crearComanda({ ...base, idempotencyKey: "k1", sucursal: "T1" });
    const b = await fake.crearComanda({ ...base, idempotencyKey: "k2", sucursal: "T1" });
    const c = await fake.crearComanda({ ...base, idempotencyKey: "k3", sucursal: "T8" });
    expect(a).toMatchObject({ status: "creada", folio: "T1-000001" });
    expect(b).toMatchObject({ status: "creada", folio: "T1-000002" });
    expect(c).toMatchObject({ status: "creada", folio: "T8-000001" });
    expect(fake.comandas[0]!.creadaEn).toBe("2026-09-30T18:00:00.000Z");
  });

  it("las fallas inyectadas se consumen en orden FIFO y se pueden limpiar", async () => {
    const fake = new FakeSoftRestaurantAdapter();
    fake.inyectarFalla("crearComanda", { tipo: "timeout" }, 2);
    const input = { idempotencyKey: "k", sucursal: "T2", tipo: "recoger", cliente: { nombre: "A", telefono: "1" }, formaPago: "efectivo", items: [{ codigo: "FAKE-003", cantidad: 1, modificadores: [] }] } as const;
    expect((await fake.crearComanda(input)).status).toBe("no_disponible");
    fake.limpiarFallas();
    expect((await fake.crearComanda(input)).status).toBe("creada");
  });

  it("los metodos de lectura lanzan SoftRestaurantNoDisponibleError cuando se inyecta falla", async () => {
    const fake = new FakeSoftRestaurantAdapter();
    fake.inyectarFalla("syncCatalog", { tipo: "http_5xx" });
    await expect(fake.syncCatalog("T1")).rejects.toBeInstanceOf(SoftRestaurantNoDisponibleError);
    fake.inyectarFalla("obtenerHistorialPorTelefono", { tipo: "timeout" });
    await expect(fake.obtenerHistorialPorTelefono({ telefono: "1", limite: 1 })).rejects.toMatchObject({ causa: "timeout" });
  });

  it("salud se puede forzar a caida", async () => {
    const fake = new FakeSoftRestaurantAdapter();
    fake.forzarSalud(false);
    expect((await fake.salud()).ok).toBe(false);
  });
});

describe("SoftRestaurantNoConfiguradoPort", () => {
  it("nunca devuelve folio: crearComanda => no_disponible/no_configurado; salud no ok", async () => {
    const port = new SoftRestaurantNoConfiguradoPort();
    expect(port.esReal).toBe(false);
    const r = await port.crearComanda();
    expect(r).toEqual({ status: "no_disponible", causa: "no_configurado" });
    expect((await port.salud()).ok).toBe(false);
    await expect(port.syncCatalog()).rejects.toBeInstanceOf(SoftRestaurantNoDisponibleError);
  });
});
