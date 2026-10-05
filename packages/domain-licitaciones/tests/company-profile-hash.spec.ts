// AE-08 / REQ-162: el hash del perfil de empresa cubre documentos, capacidades, experiencia, firmantes y su estado de
// aprobación; es independiente del orden y de ids/autoría.
import { describe, expect, it } from "vitest";
import { computeCompanyProfileHash } from "../src/company-profile-hash.ts";
import type { CompanyProfileSnapshot } from "../src/company-profile-hash.ts";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { sha256Hex } from "../src/types.ts";

const base: CompanyProfileSnapshot = {
  documents: [{ type: "acta", label: "Acta", expiresAt: null, approvalStatus: "aprobado" }],
  capabilities: [
    { name: "a", description: "da", evidenceDocId: null, approvalStatus: "aprobado" },
    { name: "b", description: "db", evidenceDocId: null, approvalStatus: "aprobado" },
  ],
  experience: [{ description: "obra", evidenceDocId: "d1", approvalStatus: "aprobado" }],
  signers: [
    { name: "Ana", role: "rep", authorized: true, approvalStatus: "aprobado" },
    { name: "Beto", role: "admin", authorized: true, approvalStatus: "aprobado" },
  ],
};

describe("computeCompanyProfileHash", () => {
  it("es determinista y no depende del orden de las listas", () => {
    const reordered: CompanyProfileSnapshot = { ...base, capabilities: [...base.capabilities].reverse(), signers: [...base.signers].reverse() };
    expect(computeCompanyProfileHash(reordered)).toBe(computeCompanyProfileHash(base));
  });

  it("cambiar un firmante, una capacidad o la experiencia cambia el hash", () => {
    const h = computeCompanyProfileHash(base);
    expect(computeCompanyProfileHash({ ...base, signers: [{ ...base.signers[0]!, name: "Ana María" }, base.signers[1]!] })).not.toBe(h);
    expect(computeCompanyProfileHash({ ...base, signers: [{ ...base.signers[0]!, authorized: false }, base.signers[1]!] })).not.toBe(h);
    expect(computeCompanyProfileHash({ ...base, capabilities: [{ ...base.capabilities[0]!, description: "otra" }, base.capabilities[1]!] })).not.toBe(h);
    expect(computeCompanyProfileHash({ ...base, experience: [{ ...base.experience[0]!, description: "otra obra" }] })).not.toBe(h);
  });

  it("agregar o quitar un elemento, o cambiar un documento, cambia el hash", () => {
    const h = computeCompanyProfileHash(base);
    expect(computeCompanyProfileHash({ ...base, capabilities: [base.capabilities[0]!] })).not.toBe(h);
    expect(computeCompanyProfileHash({ ...base, documents: [{ ...base.documents[0]!, expiresAt: "2027-01-01T00:00:00Z" }] })).not.toBe(h);
  });

  it("el estado de aprobación de cada elemento entra al hash", () => {
    const h = computeCompanyProfileHash(base);
    expect(computeCompanyProfileHash({ ...base, documents: [{ ...base.documents[0]!, approvalStatus: "pendiente_aprobacion" }] })).not.toBe(h);
    expect(computeCompanyProfileHash({ ...base, signers: [{ ...base.signers[0]!, approvalStatus: "rechazado" }, base.signers[1]!] })).not.toBe(h);
  });

  it("un firmante sin approvalStatus (base sin migrar) vale igual que uno 'aprobado'", () => {
    const legacy: CompanyProfileSnapshot = { ...base, signers: base.signers.map(({ approvalStatus: _omit, ...rest }) => rest) };
    expect(computeCompanyProfileHash(legacy)).toBe(computeCompanyProfileHash(base));
  });
});

describe("InMemoryLicitacionesRepository.computeCurrentInputsHash -- companyProfileHash real (AE-08)", () => {
  const ORG = "org-1";
  const TENDER_ID = "tender-1";
  async function setup() {
    const repo = new InMemoryLicitacionesRepository();
    repo.seedTender({ id: TENDER_ID, organizationId: ORG, title: "T", submissionDeadline: "2026-12-01T18:00:00-06:00", updatedAt: "2026-01-01T00:00:00Z" });
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const hash = async () => (await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id)).hash;
    return { repo, hash };
  }

  it("cambiar un firmante después de aprobar el expediente cambia el hash (invalida la aprobación)", async () => {
    const { repo, hash } = await setup();
    const signer = await repo.createCompanySigner(ORG, { name: "Ana", role: "rep", authorized: true, actorId: "u1" });
    const before = await hash();
    await repo.updateCompanySigner(ORG, signer.id, { name: "Ana María", actorId: "u1" });
    expect(await hash()).not.toBe(before);
  });

  it("cambiar una capacidad o la experiencia cambia el hash", async () => {
    const { repo, hash } = await setup();
    const cap = await repo.createCompanyCapability(ORG, { name: "c", description: "d", actorId: "u1" });
    const doc = await repo.createCompanyDocument(ORG, { type: "t", label: "l", expiresAt: null, actorId: "u1" });
    const exp = await repo.createCompanyExperience(ORG, { description: "e", evidenceDocId: doc.id, actorId: "u1" });
    const h0 = await hash();
    await repo.updateCompanyCapability(ORG, cap.id, { description: "d2", actorId: "u1" });
    const h1 = await hash();
    expect(h1).not.toBe(h0);
    await repo.updateCompanyExperience(ORG, exp.id, { description: "e2", actorId: "u1" });
    expect(await hash()).not.toBe(h1);
  });

  it("aprobar un dato de empresa también cambia el hash (el estado de aprobación entra)", async () => {
    const { repo, hash } = await setup();
    const cap = await repo.createCompanyCapability(ORG, { name: "c", description: "d", actorId: "u1" });
    const before = await hash();
    await repo.decideCompanyItem(ORG, { kind: "capability", itemId: cap.id, decision: "aprobado", actorId: "u2", actorRole: "owner" });
    expect(await hash()).not.toBe(before);
  });

  it("el hash ya no es la constante de la Fase 1", async () => {
    const { repo } = await setup();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const { raw } = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect((raw as { companyProfileHash: string }).companyProfileHash).not.toBe(sha256Hex("licitaciones:fase1:company-profile-fijo"));
  });
});
