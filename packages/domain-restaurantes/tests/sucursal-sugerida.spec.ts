// Sucursal sugerida (seccion 4): por colonia (misma cobertura que el agente), por ubicacion (distancia en memoria) y casos honestos.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MENSAJE_COLONIA_NO_RECONOCIDA, MENSAJE_SIN_SUCURSAL, sugerirSucursalPorColonia, sugerirSucursalPorUbicacion } from "../src/sucursal-sugerida.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function mundo() {
  const f = buildRestaurantFixture();
  // fixture: "Francisco de Montejo" en (21.0186, -89.6708). Se agregan una sucursal norte y una de playa.
  const norte = randomUUID();
  const playa = randomUUID();
  const base = { organizationId: f.organizationId, phone: null, address: null } as const;
  f.repo.seedBranch({ ...base, propertyId: norte, name: "Norte", slug: "norte", status: "active", lat: 21.05, lng: -89.6 });
  f.repo.seedBranch({ ...base, propertyId: playa, name: "Playa", slug: "playa", status: "inactive", lat: 21.29, lng: -89.6 });
  const zonaCerca = randomUUID();
  const zonaLejos = randomUUID();
  f.repo.seedKnownZone({ id: zonaCerca, organizationId: f.organizationId, name: "Montebello", lat: 21.045, lng: -89.605, createdAt: "2026-01-01T00:00:00Z" });
  f.repo.seedKnownZone({ id: zonaLejos, organizationId: f.organizationId, name: "Cholul", lat: 21.1, lng: -89.55, createdAt: "2026-01-02T00:00:00Z" });
  return { ...f, norte, playa, zonaCerca, zonaLejos };
}

describe("por colonia", () => {
  it("la sucursal activa mas cercana que reparte ahi (sin cobertura configurada reparte en general)", async () => {
    const m = mundo();
    const r = await sugerirSucursalPorColonia(m.repo, m.organizationId, "montebello");
    expect(r).toMatchObject({ tipo: "reparte", sucursal: { slug: "norte" }, zona: "Montebello" });
  });

  it("salta a otra sucursal si la mas cercana tiene cobertura configurada que no incluye la zona", async () => {
    const m = mundo();
    m.repo.seedBranchDeliveryZones(m.norte, [m.zonaLejos]);
    const r = await sugerirSucursalPorColonia(m.repo, m.organizationId, "Montebello");
    expect(r).toMatchObject({ tipo: "reparte", sucursal: { slug: "fco-montejo" } });
  });

  it("una sucursal solo recoger no reparte: se salta", async () => {
    const m = mundo();
    m.repo.seedBranchPolicy(m.norte, { aceptaDomicilio: false });
    const r = await sugerirSucursalPorColonia(m.repo, m.organizationId, "Montebello");
    expect(r).toMatchObject({ tipo: "reparte", sucursal: { slug: "fco-montejo" } });
  });

  it("si ninguna reparte ahi: 'esa colonia no esta en nuestras zonas; puede recoger en ...'", async () => {
    const m = mundo();
    m.repo.seedBranchDeliveryZones(m.norte, [m.zonaCerca]);
    m.repo.seedBranchDeliveryZones(m.propertyId, [m.zonaCerca]);
    const r = await sugerirSucursalPorColonia(m.repo, m.organizationId, "Cholul");
    expect(r.tipo).toBe("solo_recoger");
    expect(r.mensaje).toBe(`Esa colonia no está en nuestras zonas de reparto; puede recoger en ${(r as { sucursal: { name: string } }).sucursal.name}.`);
  });

  it("colonia desconocida o vacia: sin_resultado con el mensaje honesto, nunca una sucursal inventada", async () => {
    const m = mundo();
    expect(await sugerirSucursalPorColonia(m.repo, m.organizationId, "Atlantida")).toEqual({ tipo: "sin_resultado", mensaje: MENSAJE_COLONIA_NO_RECONOCIDA });
    expect(await sugerirSucursalPorColonia(m.repo, m.organizationId, "   ")).toEqual({ tipo: "sin_resultado", mensaje: MENSAJE_COLONIA_NO_RECONOCIDA });
  });

  it("nunca sugiere una sucursal inactiva ni de otra organizacion", async () => {
    const m = mundo();
    const r = await sugerirSucursalPorColonia(m.repo, m.organizationId, "Cholul");
    expect((r as { sucursal: { slug: string } }).sucursal.slug).not.toBe("playa");
    const otra = await sugerirSucursalPorColonia(m.repo, randomUUID(), "Montebello");
    expect(otra.tipo).toBe("sin_resultado");
  });
});

describe("por ubicacion", () => {
  it("la sucursal activa mas cercana con su distancia; sin guardar ni devolver las coordenadas", async () => {
    const m = mundo();
    const r = await sugerirSucursalPorUbicacion(m.repo, m.organizationId, { lat: 21.049, lng: -89.601 });
    expect(r).toMatchObject({ tipo: "cercana", sucursal: { slug: "norte" } });
    expect(JSON.stringify(r)).not.toContain("21.049");
    expect(JSON.stringify(r)).not.toContain("89.601");
  });

  it("coordenadas invalidas o sin sucursales con ubicacion: sin_resultado", async () => {
    const m = mundo();
    expect(await sugerirSucursalPorUbicacion(m.repo, m.organizationId, { lat: 200, lng: 0 })).toEqual({ tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL });
    expect(await sugerirSucursalPorUbicacion(m.repo, m.organizationId, { lat: Number.NaN, lng: 0 })).toEqual({ tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL });
    expect(await sugerirSucursalPorUbicacion(m.repo, randomUUID(), { lat: 21, lng: -89 })).toEqual({ tipo: "sin_resultado", mensaje: MENSAJE_SIN_SUCURSAL });
  });
});
