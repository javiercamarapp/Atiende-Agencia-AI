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
