// Doble en memoria del perfil completo: mismas reglas que la migracion 040 (nace pendiente, editar regresa a pendiente, uno por
// organizacion, aprobacion con autor distinto) y procedencia ATOMICA con el dato.
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { computeCompanyProfileHash } from "../src/company-profile-hash.ts";

const ORG = "org-1";
const A = "user-a";
const B = "user-b";

describe("perfil general", () => {
  it("uno por organizacion: la segunda llamada edita; editar un dato aprobado lo regresa a pendiente con el nuevo autor", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const creado = await repo.upsertCompanyProfile(ORG, { legalName: "Acme", taxId: "ACM010101AB1", employeeCount: 10, actorId: A });
    expect(creado).toMatchObject({ approvalStatus: "pendiente_aprobacion", proposedBy: A });
    expect(await repo.decideCompanyItem(ORG, { kind: "profile", itemId: creado.id, decision: "aprobado", actorId: B, actorRole: "analyst" })).toBe("ok");
    expect((await repo.getCompanyProfile(ORG))!.approvalStatus).toBe("aprobado");
    // sin cambio real: sigue aprobado
    const igual = await repo.upsertCompanyProfile(ORG, { legalName: "Acme", taxId: "ACM010101AB1", employeeCount: 10, actorId: A });
    expect(igual.id).toBe(creado.id);
    expect(igual.approvalStatus).toBe("aprobado");
    const editado = await repo.upsertCompanyProfile(ORG, { legalName: "Acme", taxId: "ACM010101AB1", employeeCount: 11, actorId: A });
    expect(editado).toMatchObject({ id: creado.id, approvalStatus: "pendiente_aprobacion", approvedBy: null, proposedBy: A });
  });
});

describe("aprobacion de los tipos nuevos", () => {
  it("autor distinto del aprobador, rol de decision, conflicto en la segunda decision y bitacora", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const socio = await repo.createCompanyStakeholder(ORG, { kind: "socio", fullName: "Ana", participationPct: "50.00", actorId: A });
    const input = { kind: "stakeholder", itemId: socio.id, decision: "aprobado", actorId: A, actorRole: "analyst" } as const;
    expect(await repo.decideCompanyItem(ORG, input)).toBe("autor");
    expect(await repo.decideCompanyItem(ORG, { ...input, actorId: B, actorRole: "writer" })).toBe("rol");
    expect(await repo.decideCompanyItem(ORG, { ...input, actorId: B })).toBe("ok");
    expect(await repo.decideCompanyItem(ORG, { ...input, actorId: B })).toBe("conflict");
    expect(await repo.decideCompanyItem(ORG, { ...input, itemId: "otro", actorId: B })).toBe("not_found");
    expect(repo.companyDataAudit).toHaveLength(1);
    expect(repo.companyDataAudit[0]).toMatchObject({ kind: "stakeholder", decision: "aprobado", actorId: B });
  });
});

describe("procedencia (REQ-142)", () => {
  it("cada alta y edicion registra quien y como: '*' mas los campos escritos", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const loc = await repo.createCompanyLocation(ORG, { kind: "matriz", name: "Matriz", state: "Yucatán", actorId: A });
    await repo.updateCompanyLocation(ORG, loc.id, { name: "Matriz Mérida", actorId: B });
    const filas = (await repo.listFieldProvenance(ORG)).filter((p) => p.entityId === loc.id);
    expect(filas.map((p) => p.field).sort()).toEqual(["*", "kind", "name", "state"]);
    const estrella = filas.find((p) => p.field === "*")!;
    expect(estrella).toMatchObject({ entity: "location", ownerUserId: B, source: "manual" });
    expect(filas.find((p) => p.field === "name")!.ownerUserId).toBe(B);
    expect(filas.find((p) => p.field === "state")!.ownerUserId).toBe(A);
  });

  it("tambien para los datos anteriores: documento, tarifa, capacidad, experiencia y firmante", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const doc = await repo.createCompanyDocument(ORG, { type: "acta", label: "Acta", expiresAt: null, actorId: A });
    const rate = await repo.createApprovedRate(ORG, { concept: "hora", unitPrice: "10.00", actorId: A });
    const cap = await repo.createCompanyCapability(ORG, { name: "cap", description: "d", actorId: A });
    const exp = await repo.createCompanyExperience(ORG, { description: "obra", evidenceDocId: doc.id, actorId: A });
    const sig = await repo.createCompanySigner(ORG, { name: "Ana", role: "rep", actorId: A });
    const entidades = new Set((await repo.listFieldProvenance(ORG)).filter((p) => p.field === "*").map((p) => `${p.entity}:${p.entityId}`));
    for (const [entity, id] of [["document", doc.id], ["rate", rate.id], ["capability", cap.id], ["experience", exp.id], ["signer", sig.id]]) expect(entidades.has(`${entity}:${id}`), String(entity)).toBe(true);
  });

  it("si la procedencia falla, el dato NO queda (alta, edicion, firmante, documento): misma transaccion", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const loc = await repo.createCompanyLocation(ORG, { kind: "matriz", name: "Matriz", state: "Yucatán", actorId: A });
    const sig = await repo.createCompanySigner(ORG, { name: "Ana", role: "rep", actorId: A });
    repo.companyProfile.provenanceFailure = new Error("procedencia caida");

    await expect(repo.createCompanyLocation(ORG, { kind: "sucursal", name: "Otra", state: "Jalisco", actorId: A })).rejects.toThrow("procedencia caida");
    await expect(repo.updateCompanyLocation(ORG, loc.id, { name: "Cambiada", actorId: A })).rejects.toThrow("procedencia caida");
    await expect(repo.upsertCompanyProfile(ORG, { legalName: "X", taxId: "ACM010101AB1", actorId: A })).rejects.toThrow("procedencia caida");
    await expect(repo.createCompanySigner(ORG, { name: "Beto", role: "rep", actorId: A })).rejects.toThrow("procedencia caida");
    await expect(repo.updateCompanySigner(ORG, sig.id, { authorized: true, actorId: A })).rejects.toThrow("procedencia caida");
    await expect(repo.createCompanyDocument(ORG, { type: "acta", label: "x", expiresAt: null, actorId: A })).rejects.toThrow("procedencia caida");

    expect(await repo.listCompanyLocations(ORG)).toHaveLength(1);
    expect((await repo.listCompanyLocations(ORG))[0]!.name).toBe("Matriz");
    expect(await repo.getCompanyProfile(ORG)).toBeNull();
    expect(await repo.listCompanySigners(ORG)).toHaveLength(1);
    expect((await repo.listCompanySigners(ORG))[0]!.authorized).toBe(false);
    expect(await repo.listCompanyDocuments(ORG, "2026-01-01T00:00:00Z")).toHaveLength(0);
  });
});

describe("bajas y hash del perfil", () => {
  it("deleteCompanyProfileItem: true si existia, false si no", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const p = await repo.createCompanyProductService(ORG, { kind: "servicio", name: "Consultoría", actorId: A });
    expect(await repo.deleteCompanyProfileItem(ORG, "product", p.id)).toBe(true);
    expect(await repo.deleteCompanyProfileItem(ORG, "product", p.id)).toBe(false);
    expect(await repo.listCompanyProductsServices(ORG)).toEqual([]);
  });

  it("el hash del expediente incluye el perfil nuevo: agregar un socio lo cambia; sin datos nuevos es el de antes", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const base = computeCompanyProfileHash({ documents: [], capabilities: [], experience: [], signers: [] });
    expect(computeCompanyProfileHash({ documents: [], capabilities: [], experience: [], signers: [], profile: null, stakeholders: [] })).toBe(base);
    const socio = await repo.createCompanyStakeholder(ORG, { kind: "socio", fullName: "Ana", actorId: A });
    expect(computeCompanyProfileHash({ documents: [], capabilities: [], experience: [], signers: [], stakeholders: [socio] })).not.toBe(base);
  });
});
