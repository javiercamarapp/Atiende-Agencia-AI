// paridad3 L-P3-08 -- el barrido de descubrimiento con fuentes FALSAS (sin red): crea la linea base, detecta el cambio de bases de una
// convocatoria conocida (version + cascada de invalidacion + cambio en el resultado), es idempotente al reprocesar y deja
// intacta la invalidacion aunque despues falle el canal de aviso (el aviso lo emite la API; aqui se prueba que la version
// y la cascada ya estan persistidas ANTES de cualquier aviso).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryLicitacionesRepository, LICITACIONES_CONNECTOR_REGISTRY, sealInputs } from "@atiende/domain-licitaciones";
import type { LicitacionesSourceConnector, SourceConnectorId, TenderSourceIngestCandidate } from "@atiende/domain-licitaciones";
import { runDiscoverTendersForOrganization } from "../src/jobs/licitaciones/discover-tenders.ts";

const SOURCE: SourceConnectorId = "yucatan_ocds";

function conector(candidates: () => TenderSourceIngestCandidate[]): LicitacionesSourceConnector {
  return {
    id: SOURCE,
    async *discover() {
      for (const c of candidates()) yield c;
    },
    fetchDetail: () => Promise.reject(new Error("n/a")),
  };
}

function usarFuente(candidates: () => TenderSourceIngestCandidate[]) {
  const real = LICITACIONES_CONNECTOR_REGISTRY.all();
  vi.spyOn(LICITACIONES_CONNECTOR_REGISTRY, "all").mockReturnValue(real.map((d) => (d.id === SOURCE ? { ...d, connector: conector(candidates) } : { ...d, connector: undefined })));
}

const candidato = (over: Partial<TenderSourceIngestCandidate> = {}): TenderSourceIngestCandidate => ({
  externalId: "ocds-1",
  title: "Servicio de limpieza",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  contractingBody: "Municipio",
  cpvCodes: [],
  budgetAmount: 100_000,
  currency: "MXN",
  state: "Yucatan",
  procedureTypeRaw: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("discover-tenders: vigilante de cambios (L-P3-08)", () => {
  async function armar() {
    const repo = new InMemoryLicitacionesRepository();
    const org = randomUUID();
    repo.seedOrganization({ id: org, slug: "org-vig", name: "Org" });
    return { repo, org };
  }

  it("linea base la primera vez; si la fuente cambia el plazo crea la version 2, invalida la aprobacion y lo reporta; reprocesar no hace nada", async () => {
    const { repo, org } = await armar();
    let actual = candidato();
    usarFuente(() => [actual]);

    const [primera] = await runDiscoverTendersForOrganization((fn) => fn(repo), org);
    expect(primera).toMatchObject({ state: "ok", created: 1, updated: 0, basesModificadas: [] });
    expect(primera!.createdTenders).toHaveLength(1);
    const tenderId = primera!.createdTenders[0]!.id;

    const proposal = await repo.getOrCreateProposal(org, tenderId, "user-1", "Propuesta");
    await repo.approve(org, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "owner-1", actorRole: "owner", inputsHash: sealInputs({ tenderVersionHash: "x", companyProfileHash: "y", companyDocuments: [], rates: [], templates: [] }) });

    actual = candidato({ submissionDeadline: "2026-12-30T18:00:00-06:00" });
    const [segunda] = await runDiscoverTendersForOrganization((fn) => fn(repo), org);
    expect(segunda).toMatchObject({ state: "ok", created: 0, updated: 1, createdTenders: [] });
    expect(segunda!.basesModificadas).toEqual([{ tenderId, tenderTitle: "Servicio de limpieza", version: 2, changedFieldNames: ["submissionDeadline"], invalidatedApprovals: 1, invalidatedApproverIds: ["owner-1"] }]);
    // la version y la cascada YA estan persistidas: un fallo posterior del canal de aviso no las revierte
    expect(await repo.listTenderVersions(org, tenderId)).toHaveLength(2);
    expect(await repo.activeApprovalsCovering(org, proposal.id, "expediente")).toHaveLength(0);

    const [tercera] = await runDiscoverTendersForOrganization((fn) => fn(repo), org);
    expect(tercera!.basesModificadas).toEqual([]);
    expect(await repo.listTenderVersions(org, tenderId)).toHaveLength(2);
  });

  it("una fuente que falla no deja createdTenders ni basesModificadas (nunca un cambio fantasma)", async () => {
    const { repo, org } = await armar();
    usarFuente(() => {
      throw new Error("fuente caida");
    });
    const [r] = await runDiscoverTendersForOrganization((fn) => fn(repo), org);
    expect(r!.state).not.toBe("ok");
    expect(r).toMatchObject({ createdTenders: [], basesModificadas: [] });
  });
});
