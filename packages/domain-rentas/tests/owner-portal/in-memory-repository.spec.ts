// Test real (sin mocks) de InMemoryRentasOwnerPortalRepository -- incluye el test
// crítico del diseño Fase 3 §0: "un owner NUNCA puede ver datos de una organización
// donde no tiene presencia real", verificado directamente contra la lógica de
// filtrado por ownerId (el mismo criterio que la policy RLS real `owner_id =
// auth.uid()` de la migración 006).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasOwnerPortalRepository } from "../../src/owner-portal/in-memory-repository.ts";
import { generateInviteToken, hashInviteToken } from "../../src/owner-portal/invite-token.ts";

function seedDosOrganizacionesDosOwners(repo: InMemoryRentasOwnerPortalRepository) {
  const orgA = randomUUID();
  const orgB = randomUUID();
  const propertyA = randomUUID();
  const propertyB = randomUUID();
  const ownerA = randomUUID(); // presencia SOLO en orgA
  const ownerB = randomUUID(); // presencia SOLO en orgB

  repo.seedOrganization({ id: orgA, name: "Gestora Playa del Carmen", slug: "gestora-playa" });
  repo.seedOrganization({ id: orgB, name: "Gestora Ciudad de México", slug: "gestora-cdmx" });

  repo.seedOwner({ id: ownerA, name: "Propietario A", email: "propietario-a@ejemplo.mx" });
  repo.seedOwner({ id: ownerB, name: "Propietario B", email: "propietario-b@ejemplo.mx" });

  repo.seedOwnerOrganizacion(ownerA, orgA);
  repo.seedOwnerOrganizacion(ownerB, orgB);

  const unidadA = randomUUID();
  const unidadB = randomUUID();
  repo.seedUnidad({ id: unidadA, name: "Depa Centro 301", propertyId: propertyA, organizationId: orgA, ownerId: ownerA });
  repo.seedUnidad({ id: unidadB, name: "Loft Roma Norte", propertyId: propertyB, organizationId: orgB, ownerId: ownerB });

  const statementA = randomUUID();
  const statementB = randomUUID();
  repo.seedOwnerStatement({
    id: statementA,
    ownerId: ownerA,
    propertyId: propertyA,
    organizationId: orgA,
    periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
    version: 1,
    moneda: "MXN",
    totales: { ingresosBrutosCentavos: 100000, comisionCanalCentavos: 0, comisionGestorCentavos: 20000, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 80000 },
    lineas: [{ ocupacionId: "ocup-a", tipo: "ingreso", descripcion: "Reserva A", montoCentavos: 100000 }],
    motivoVersion: null,
    generadoEn: new Date().toISOString(),
  });
  repo.seedOwnerStatement({
    id: statementB,
    ownerId: ownerB,
    propertyId: propertyB,
    organizationId: orgB,
    periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
    version: 1,
    moneda: "MXN",
    totales: { ingresosBrutosCentavos: 50000, comisionCanalCentavos: 0, comisionGestorCentavos: 10000, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 40000 },
    lineas: [{ ocupacionId: "ocup-b", tipo: "ingreso", descripcion: "Reserva B", montoCentavos: 50000 }],
    motivoVersion: null,
    generadoEn: new Date().toISOString(),
  });

  return { orgA, orgB, propertyA, propertyB, ownerA, ownerB, unidadA, unidadB, statementA, statementB };
}

describe("InMemoryRentasOwnerPortalRepository -- aislamiento entre propietarios/organizaciones", () => {
  it("un owner NUNCA ve unidades de una organización donde no tiene presencia real", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const { ownerA, ownerB, unidadA, unidadB } = seedDosOrganizacionesDosOwners(repo);

    const unidadesDeA = await repo.listUnidadesPropietario(ownerA);
    expect(unidadesDeA.map((u) => u.id)).toEqual([unidadA]);
    expect(unidadesDeA.map((u) => u.id)).not.toContain(unidadB);

    const unidadesDeB = await repo.listUnidadesPropietario(ownerB);
    expect(unidadesDeB.map((u) => u.id)).toEqual([unidadB]);
    expect(unidadesDeB.map((u) => u.id)).not.toContain(unidadA);
  });

  it("un owner NUNCA ve statements de una organización donde no tiene presencia real (lista)", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const { ownerA, ownerB, statementA, statementB } = seedDosOrganizacionesDosOwners(repo);

    const statementsDeA = await repo.listOwnerStatementsPropietario(ownerA, {});
    expect(statementsDeA.map((s) => s.id)).toEqual([statementA]);
    expect(statementsDeA.map((s) => s.id)).not.toContain(statementB);

    const statementsDeB = await repo.listOwnerStatementsPropietario(ownerB, {});
    expect(statementsDeB.map((s) => s.id)).toEqual([statementB]);
  });

  it("un owner NUNCA puede leer el DETALLE de un statement de otro owner/organización, ni conociendo su id exacto", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const { ownerA, statementB } = seedDosOrganizacionesDosOwners(repo);

    // ownerA conoce (por ejemplo, por haberlo visto en un log o adivinado un UUID) el
    // id REAL de un statement que pertenece a ownerB/orgB -- nunca debe resolver.
    const detalle = await repo.findOwnerStatementDetallePropietario(ownerA, statementB);
    expect(detalle).toBeNull();
  });

  it("el owner_organization de uno nunca contamina el de otro -- GET /me solo informa las organizaciones propias", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const { ownerA, ownerB, orgA, orgB } = seedDosOrganizacionesDosOwners(repo);

    const orgsDeA = await repo.listOwnerOrganizaciones(ownerA);
    expect(orgsDeA.map((o) => o.organizationId)).toEqual([orgA]);

    const orgsDeB = await repo.listOwnerOrganizaciones(ownerB);
    expect(orgsDeB.map((o) => o.organizationId)).toEqual([orgB]);
  });

  it("un owner con presencia en 2 organizaciones ve TODO junto, sin selector (diseño §1.5)", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const owner = randomUUID();
    repo.seedOrganization({ id: orgA, name: "Gestora A", slug: "gestora-a" });
    repo.seedOrganization({ id: orgB, name: "Gestora B", slug: "gestora-b" });
    repo.seedOwner({ id: owner, name: "Propietario Multi-Gestora", email: "multi@ejemplo.mx" });
    repo.seedOwnerOrganizacion(owner, orgA);
    repo.seedOwnerOrganizacion(owner, orgB);
    repo.seedUnidad({ id: randomUUID(), name: "Unidad en A", propertyId: randomUUID(), organizationId: orgA, ownerId: owner });
    repo.seedUnidad({ id: randomUUID(), name: "Unidad en B", propertyId: randomUUID(), organizationId: orgB, ownerId: owner });

    const unidades = await repo.listUnidadesPropietario(owner);
    expect(unidades).toHaveLength(2);
    expect(new Set(unidades.map((u) => u.organizationId))).toEqual(new Set([orgA, orgB]));
  });
});

describe("InMemoryRentasOwnerPortalRepository -- credenciales e invitación (única escritura de la fase, diseño §5)", () => {
  it("login: findOwnerCredentialByEmail solo resuelve tras haberse fijado un password_hash", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const ownerId = randomUUID();
    repo.seedOwner({ id: ownerId, name: "Propietario", email: "propietario@ejemplo.mx" });

    expect(await repo.findOwnerCredentialByEmail("propietario@ejemplo.mx")).toBeNull();

    repo.seedCredential(ownerId, "propietario@ejemplo.mx", "hash-simulado");
    const cred = await repo.findOwnerCredentialByEmail("PROPIETARIO@ejemplo.mx"); // email case-insensitive
    expect(cred).toEqual({ ownerId, email: "propietario@ejemplo.mx", passwordHash: "hash-simulado" });
  });

  it("createPortalInvite + consumePortalInvite: el token es de un solo uso y expira", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const ownerId = randomUUID();
    const staffId = randomUUID();
    repo.seedOwner({ id: ownerId, name: "Propietario", email: "propietario@ejemplo.mx" });

    const { tokenPlain, tokenHash } = generateInviteToken();
    expect(hashInviteToken(tokenPlain)).toBe(tokenHash);

    const futuro = new Date(Date.now() + 60_000).toISOString();
    await repo.createPortalInvite({ ownerId, tokenHash, expiresAt: futuro, createdBy: staffId });

    const ahora = new Date().toISOString();
    const consumido = await repo.consumePortalInvite({ tokenHash, passwordHash: "nuevo-hash", now: ahora });
    expect(consumido).toEqual({ ownerId });

    // Un solo uso: reintentar con el MISMO token ya no resuelve.
    const segundoIntento = await repo.consumePortalInvite({ tokenHash, passwordHash: "otro-hash", now: ahora });
    expect(segundoIntento).toBeNull();

    // Y ahora sí puede iniciar sesión con el password recién fijado.
    const cred = await repo.findOwnerCredentialByEmail("propietario@ejemplo.mx");
    expect(cred?.passwordHash).toBe("nuevo-hash");
  });

  it("un token expirado nunca se consume", async () => {
    const repo = new InMemoryRentasOwnerPortalRepository();
    const ownerId = randomUUID();
    repo.seedOwner({ id: ownerId, name: "Propietario", email: "propietario@ejemplo.mx" });

    const { tokenHash } = generateInviteToken();
    const pasado = new Date(Date.now() - 1000).toISOString();
    await repo.createPortalInvite({ ownerId, tokenHash, expiresAt: pasado, createdBy: randomUUID() });

    const resultado = await repo.consumePortalInvite({ tokenHash, passwordHash: "x", now: new Date().toISOString() });
    expect(resultado).toBeNull();
  });
});
