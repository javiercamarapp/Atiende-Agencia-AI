// QA-PM-R4-reglas-05 (RW28): una colonia cubierta por T7 y T1, escrita por el chat de T7, mandaba al cliente a T1 y luego volvia a T7. Si la sucursal de entrada cubre la colonia, se asigna esa.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignBranch } from "../src/branch-assignment.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";

function mundo() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const t1 = randomUUID();
  const t7 = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({ propertyId: t1, organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active", phone: null, address: null, lat: 21.028, lng: -89.61 });
  repo.seedBranch({ propertyId: t7, organizationId, name: "García Lavín", slug: "garcia-lavin", status: "active", phone: null, address: null, lat: 21.0205, lng: -89.615 });
  const montecristo = randomUUID();
  repo.seedKnownZone({ id: montecristo, organizationId, name: "Montecristo", lat: null, lng: null });
  repo.seedBranchDeliveryZones(t1, [montecristo]);
  repo.seedBranchDeliveryZones(t7, [montecristo]);
  return { repo, organizationId, t1, t7 };
}

describe("doble cobertura: gana la sucursal por la que entro el cliente", () => {
  it("entrando por T1 se asigna T1; entrando por T7 se asigna T7; sin sucursal de entrada el orden estable de siempre", async () => {
    const { repo, organizationId, t1, t7 } = await mundo();
    expect(await assignBranch(repo, { organizationId, colonia: "Montecristo", sucursalDeEntregaPreferidaPropertyId: t1 })).toMatchObject({ estado: "asignada", branchSlug: "prol-montejo", dobleCobertura: true });
    expect(await assignBranch(repo, { organizationId, colonia: "Montecristo", sucursalDeEntregaPreferidaPropertyId: t7 })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", dobleCobertura: true });
    expect(await assignBranch(repo, { organizationId, colonia: "Montecristo" })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin" });
  });
  it("si la sucursal de entrada NO cubre la colonia no se impone", async () => {
    const { repo, organizationId, t1 } = await mundo();
    const otra = randomUUID();
    repo.seedBranch({ propertyId: otra, organizationId, name: "Pensiones", slug: "pensiones", status: "active", phone: null, address: null, lat: 21.0, lng: -89.65 });
    expect(await assignBranch(repo, { organizationId, colonia: "Montecristo", sucursalDeEntregaPreferidaPropertyId: otra })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin" });
    expect(t1).toBeTruthy();
  });
});
