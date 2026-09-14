// Fase 8 — pruebas de dominio (InMemoryCitasRepository) del CRUD real agregado en
// esta fase: alta/edición de proveedores/servicios, el checkbox real de
// provider_services, y la edición de citas.tenant_config (rubro/timezone/teléfono
// de aviso). Mismo criterio que packages/domain-restaurantes/tests/admin-backoffice.spec.ts
// (Fase 5 restaurantes): esta suite cubre la lógica de negocio del repositorio en
// sí, acotada por organización — las pruebas HTTP end-to-end (auth/roles/404) viven
// en apps/api/tests/citas-admin.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCitasFixture } from "./fixtures.ts";

describe("Proveedores — CRUD real (Fase 8)", () => {
  it("crea un proveedor nuevo con los defaults reales", async () => {
    const { repo, organizationId } = buildCitasFixture();
    const created = await repo.createProvider({ organizationId, displayName: "Dr. Juan Pérez" });
    expect(created.displayName).toBe("Dr. Juan Pérez");
    expect(created.roleLabel).toBe("Proveedor");
    expect(created.propertyId).toBeNull();
    expect(created.isActive).toBe(true);

    const found = await repo.findProvider(organizationId, created.id);
    expect(found).toEqual(created);
  });

  it("edita un proveedor real — un campo ausente del patch no toca la columna", async () => {
    const { repo, organizationId, providerId } = buildCitasFixture();
    const updated = await repo.updateProvider(organizationId, providerId, { roleLabel: "Odontóloga" });
    expect(updated?.roleLabel).toBe("Odontóloga");
    expect(updated?.displayName).toBe("Dra. Fernanda López"); // no tocado por el patch
  });

  it("propertyId: null explícito SÍ desasigna la sucursal", async () => {
    const { repo, organizationId } = buildCitasFixture();
    const propertyId = randomUUID();
    const created = await repo.createProvider({ organizationId, displayName: "Barbero", propertyId });
    expect(created.propertyId).toBe(propertyId);

    const updated = await repo.updateProvider(organizationId, created.id, { propertyId: null });
    expect(updated?.propertyId).toBeNull();
  });

  it("editar un proveedor de OTRA organización devuelve null (nunca a ciegas)", async () => {
    const { repo, organizationId } = buildCitasFixture();
    const otherOrgId = randomUUID();
    const foreign = await repo.createProvider({ organizationId: otherOrgId, displayName: "De otro negocio" });

    const result = await repo.updateProvider(organizationId, foreign.id, { displayName: "hackeado" });
    expect(result).toBeNull();
    expect((await repo.findProvider(otherOrgId, foreign.id))?.displayName).toBe("De otro negocio");
  });

  it("setProviderServiceOffering — checkbox real sobre provider_services, idempotente en ambos sentidos", async () => {
    const { repo, providerId, serviceId } = buildCitasFixture();
    // El fixture ya lo ofrece — quitarlo dos veces seguidas no debe tronar.
    expect(await repo.providerOffersService(providerId, serviceId)).toBe(true);
    await repo.setProviderServiceOffering(providerId, serviceId, false);
    expect(await repo.providerOffersService(providerId, serviceId)).toBe(false);
    await repo.setProviderServiceOffering(providerId, serviceId, false);
    expect(await repo.providerOffersService(providerId, serviceId)).toBe(false);

    // Reasignarlo — insertarlo dos veces seguidas tampoco debe tronar (mismo
    // criterio que el "on conflict do nothing" real de Postgres).
    await repo.setProviderServiceOffering(providerId, serviceId, true);
    await repo.setProviderServiceOffering(providerId, serviceId, true);
    expect(await repo.providerOffersService(providerId, serviceId)).toBe(true);
  });
});

describe("Servicios — CRUD real (Fase 8)", () => {
  it("crea un servicio nuevo con los defaults reales", async () => {
    const { repo, organizationId } = buildCitasFixture();
    const created = await repo.createService({ organizationId, name: "Limpieza dental", durationMinutes: 45 });
    expect(created.durationMinutes).toBe(45);
    expect(created.bufferMinutesBefore).toBe(0);
    expect(created.bufferMinutesAfter).toBe(0);
    expect(created.priceCents).toBeNull();
    expect(created.isActive).toBe(true);
  });

  it("edita un servicio real — priceCents:null explícito SÍ quita el precio fijo", async () => {
    const { repo, organizationId, serviceId } = buildCitasFixture();
    const cleared = await repo.updateService(organizationId, serviceId, { priceCents: null });
    expect(cleared?.priceCents).toBeNull();
    expect(cleared?.durationMinutes).toBe(30); // no tocado por el patch

    const priced = await repo.updateService(organizationId, serviceId, { priceCents: 75000 });
    expect(priced?.priceCents).toBe(75000);
  });

  it("editar un servicio de OTRA organización devuelve null", async () => {
    const { repo, organizationId } = buildCitasFixture();
    const otherOrgId = randomUUID();
    const foreign = await repo.createService({ organizationId: otherOrgId, name: "De otro negocio", durationMinutes: 20 });

    const result = await repo.updateService(organizationId, foreign.id, { name: "hackeado" });
    expect(result).toBeNull();
  });
});

describe("citas.tenant_config — edición real (Fase 8)", () => {
  it("upsert crea la fila con defaults reales cuando todavía no existe", async () => {
    const { repo, organizationId } = buildCitasFixture();
    expect(await repo.findTenantConfig(organizationId)).toBeNull();

    const created = await repo.upsertTenantConfig(organizationId, { rubro: "dental" });
    expect(created).toEqual({ organizationId, rubro: "dental", defaultTimezone: "America/Mexico_City", ownerNotificationPhone: null });
  });

  it("un patch parcial sobre una fila existente conserva los campos ausentes", async () => {
    const { repo, organizationId } = buildCitasFixture();
    await repo.upsertTenantConfig(organizationId, { rubro: "medico", defaultTimezone: "America/Merida", ownerNotificationPhone: "5599998888" });

    const updated = await repo.upsertTenantConfig(organizationId, { defaultTimezone: "America/Tijuana" });
    expect(updated.rubro).toBe("medico"); // no tocado
    expect(updated.ownerNotificationPhone).toBe("5599998888"); // no tocado
    expect(updated.defaultTimezone).toBe("America/Tijuana");
  });

  it("ownerNotificationPhone: null explícito sí lo quita", async () => {
    const { repo, organizationId } = buildCitasFixture();
    await repo.upsertTenantConfig(organizationId, { ownerNotificationPhone: "5599998888" });
    const cleared = await repo.upsertTenantConfig(organizationId, { ownerNotificationPhone: null });
    expect(cleared.ownerNotificationPhone).toBeNull();
  });

  it("editar el rubro cambia de inmediato qué guardrail/FAQs aplican (mismo campo que lee runCrisisGuardrail)", async () => {
    const { repo, organizationId } = buildCitasFixture();
    await repo.upsertTenantConfig(organizationId, { rubro: "psicologo" });
    expect((await repo.findTenantConfig(organizationId))?.rubro).toBe("psicologo");
  });
});
