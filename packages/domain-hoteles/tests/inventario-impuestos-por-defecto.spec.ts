// Onboarding P0 (migracion 050): espejo en memoria del trigger que siembra tax_config por defecto y de hoteles.generar_inventario.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository, TAX_CONFIG_POR_DEFECTO } from "../src/index.ts";

const hoy = () => new Date().toISOString().slice(0, 10);

describe("tax_config por defecto al crear el primer tipo de habitacion", () => {
  it("sin configuracion previa: cotizar ya no lanza (IVA 16 %, ISH 3 %, umbral 500)", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    await expect(repo.loadTaxConfig(propertyId)).rejects.toThrow();
    await repo.insertRoomType({ propertyId, organizationId: randomUUID(), name: "Doble", maxOccupancy: 2 });
    await expect(repo.loadTaxConfig(propertyId)).resolves.toEqual(TAX_CONFIG_POR_DEFECTO);
  });

  it("una configuracion ya capturada no se pisa", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    repo.seedTaxConfig(propertyId, { ivaRate: 0.16, ishRate: 0.05, discountThreshold: 0 });
    await repo.insertRoomType({ propertyId, organizationId: randomUUID(), name: "Doble", maxOccupancy: 2 });
    expect((await repo.loadTaxConfig(propertyId)).ishRate).toBe(0.05);
  });
});

describe("generarInventario (en memoria)", () => {
  it("total por tipo = habitaciones; recalcula conservando lo reservado; rango validado", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    const tipo = await repo.insertRoomType({ propertyId, organizationId, name: "Doble", maxOccupancy: 2 });
    await repo.insertRoom({ propertyId, organizationId, roomTypeId: tipo.id, code: "101" });
    expect(await repo.generarInventario({ propertyId, desde: hoy(), hasta: hoy() })).toEqual({ tipos: 1, noches: 1, filas: 1 });
    expect(await repo.generarInventario({ propertyId, desde: hoy(), hasta: hoy() })).toEqual({ tipos: 1, noches: 1, filas: 0 });
    await repo.insertRoom({ propertyId, organizationId, roomTypeId: tipo.id, code: "102" });
    expect((await repo.generarInventario({ propertyId, desde: hoy(), hasta: hoy() })).filas).toBe(1);
    await expect(repo.generarInventario({ propertyId, desde: "2020-01-01", hasta: "2020-01-02" })).rejects.toMatchObject({ code: "22023" });
  });
});

describe("generarInventario nunca deja total_rooms por debajo de booked_rooms", () => {
  it("si se borraron habitaciones con noches vendidas, el total se queda en lo vendido", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    const tipo = await repo.insertRoomType({ propertyId, organizationId, name: "Doble", maxOccupancy: 2 });
    await repo.insertRoom({ propertyId, organizationId, roomTypeId: tipo.id, code: "101" });
    repo.seedAvailability(propertyId, tipo.id, hoy(), 3, 3);
    await repo.generarInventario({ propertyId, desde: hoy(), hasta: hoy() });
    expect(repo.readAvailability(propertyId, tipo.id, hoy(), hoy()).noches[0]).toMatchObject({ totalRooms: 3, bookedRooms: 3 });
  });
});

describe("ajustarInventarioTipo (incremental, en memoria)", () => {
  const manana = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it("+1 desplaza lo capturado a mano, crea solo las noches faltantes y no toca otros tipos", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    const doble = await repo.insertRoomType({ propertyId, organizationId, name: "Doble", maxOccupancy: 2 });
    const suite = await repo.insertRoomType({ propertyId, organizationId, name: "Suite", maxOccupancy: 2 });
    repo.seedAvailability(propertyId, doble.id, hoy(), 5, 2);
    repo.seedAvailability(propertyId, suite.id, hoy(), 7, 0);
    await repo.insertRoom({ propertyId, organizationId, roomTypeId: doble.id, code: "101" });
    expect(await repo.ajustarInventarioTipo({ propertyId, roomTypeId: doble.id, delta: 1, desde: hoy(), hasta: manana() })).toEqual({ ajustadas: 1, creadas: 1 });
    expect(repo.readAvailability(propertyId, doble.id, hoy(), manana()).noches).toEqual([
      { date: hoy(), totalRooms: 6, bookedRooms: 2 },
      { date: manana(), totalRooms: 1, bookedRooms: 0 },
    ]);
    expect(repo.readAvailability(propertyId, suite.id, hoy(), manana()).noches).toEqual([{ date: hoy(), totalRooms: 7, bookedRooms: 0 }]);
  });

  it("-1 nunca baja de booked_rooms; delta, rango y tipo ajeno se rechazan", async () => {
    const repo = new InMemoryHotelesRepository();
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    const doble = await repo.insertRoomType({ propertyId, organizationId, name: "Doble", maxOccupancy: 2 });
    repo.seedAvailability(propertyId, doble.id, hoy(), 2, 2);
    expect(await repo.ajustarInventarioTipo({ propertyId, roomTypeId: doble.id, delta: -1, desde: hoy(), hasta: hoy() })).toEqual({ ajustadas: 0, creadas: 0 });
    expect(repo.readAvailability(propertyId, doble.id, hoy(), hoy()).noches[0]).toMatchObject({ totalRooms: 2, bookedRooms: 2 });
    await expect(repo.ajustarInventarioTipo({ propertyId, roomTypeId: doble.id, delta: 2 as 1, desde: hoy(), hasta: hoy() })).rejects.toMatchObject({ code: "22023" });
    await expect(repo.ajustarInventarioTipo({ propertyId, roomTypeId: doble.id, delta: 1, desde: "2020-01-01", hasta: "2020-01-02" })).rejects.toMatchObject({ code: "22023" });
    await expect(repo.ajustarInventarioTipo({ propertyId: randomUUID(), roomTypeId: doble.id, delta: 1, desde: hoy(), hasta: hoy() })).rejects.toMatchObject({ code: "P0002" });
  });
});
