// Paquete B: cuando la zona es de OTRA sucursal el agente deriva con el telefono de CONFIGURACION (branch.phone), nunca de memoria ni del prompt.
// Si la sucursal no tiene telefono cargado, el mensaje lo dice y manda a decir que la sucursal confirma (no inventa). Datos inventados. Sin LLM.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignBranch } from "../src/branch-assignment.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { fraseTelefonoSucursal } from "../src/nearest-branch.ts";

function mundo(telefonoNorte: string | null) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const sur = randomUUID();
  const norte = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "taqueria-ficticia", name: "Taquería Ficticia" });
  repo.seedBranch({ propertyId: sur, organizationId, name: "Sucursal Sur", slug: "sur", status: "active", phone: "999 000 0101", address: null, lat: 21.0, lng: -89.6 });
  repo.seedBranch({ propertyId: norte, organizationId, name: "Sucursal Norte", slug: "norte", status: "active", phone: telefonoNorte, address: null, lat: 21.1, lng: -89.6 });
  const residencial = randomUUID();
  repo.seedKnownZone({ id: residencial, organizationId, name: "Residencial Los Cedros", lat: null, lng: null });
  repo.seedBranchDeliveryZones(norte, [residencial]);
  return { repo, organizationId };
}

describe("fraseTelefonoSucursal", () => {
  it("con telefono: lo da tal cual viene de configuracion", () => {
    expect(fraseTelefonoSucursal({ slug: "norte", nombre: "Sucursal Norte", kmAprox: null, telefono: "999 000 0202" })).toContain("999 000 0202");
  });
  it("sin telefono: dice que NO lo invente y que la sucursal confirma", () => {
    const f = fraseTelefonoSucursal({ slug: "norte", nombre: "Sucursal Norte", kmAprox: null, telefono: null });
    expect(f).toMatch(/no (?:lo )?invente/i);
    expect(f).toMatch(/confirm/i);
    expect(f).not.toMatch(/\d{3}\s?\d{3}\s?\d{4}/);
  });
});

describe("assignBranch: la sucursal asignada trae su telefono de configuracion", () => {
  it("colonia de otra sucursal: el mensaje incluye el telefono cargado", async () => {
    const { repo, organizationId } = mundo("999 000 0202");
    const r = await assignBranch(repo, { organizationId, colonia: "Residencial Los Cedros" });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "norte" });
    expect(r.message).toContain("999 000 0202");
  });
  it("sin telefono cargado: no se inventa ninguno", async () => {
    const { repo, organizationId } = mundo(null);
    const r = await assignBranch(repo, { organizationId, colonia: "Residencial Los Cedros" });
    expect(r.message).toMatch(/no (?:lo )?invente/i);
    expect(r.message).not.toMatch(/\d{3}\s?\d{3}\s?\d{4}/);
  });
  it("con pin: la sucursal asignada por distancia trae su telefono", async () => {
    const { repo, organizationId } = mundo("999 000 0202");
    const r = await assignBranch(repo, { organizationId, lat: 21.099, lng: -89.6 });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "norte" });
    expect(r.message).toContain("999 000 0202");
  });
  it("fuera de zona: nombra la mas cercana con su telefono y ofrece recoger", async () => {
    const { repo, organizationId } = mundo("999 000 0202");
    const r = await assignBranch(repo, { organizationId, lat: 21.5, lng: -89.6 });
    expect(r.estado).toBe("fuera_de_zona");
    expect(r.message).toContain("999 000 0202");
    expect(r.message).toMatch(/recoger/i);
  });
});
