// paridad3 L-P3-11 -- auditor y mensajero deterministas del expediente, por HTTP real (checklist/run) sobre el repositorio en
// memoria: avisa SOLO al pasar de "con bloqueos" a "sin bloqueos" (una vez), avisa cuando un cambio de insumo invalida una
// aprobacion vigente, NO aprueba nada solo y un fallo del auditor jamas rompe la escritura de negocio.
import { describe, expect, it, vi } from "vitest";
import { sealInputs } from "@atiende/domain-licitaciones";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const VERDE = {
  files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
  formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
  requiredSignatures: [],
  presentAnnexRefs: [],
};
// Un archivo con extension no permitida deja el checklist en rojo (bloqueo).
const ROJO = { ...VERDE, files: [{ filename: "virus.exe", extension: "exe", sizeBytes: 1000 }] };

async function armar() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: "dueno@example.com", fullName: "Dueno" });
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal`, authedJson(ctx.staff.writer.token));
  // Sin propuesta economica el checklist queda en rojo (calculos_economicos): se genera una real para poder llegar a "sin bloqueos".
  ctx.repo.seedApprovedRates(ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
  const economica = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/proposal/economic/generate`, authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-1" }));
  expect(economica.status).toBe(200);
  let n = 0;
  const correrChecklist = (body: unknown) => app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/checklist/run`, authedJson(ctx.staff.writer.token, body, { "idempotency-key": `k-${++n}` }));
  const tipos = (e: string) => emisiones.filter((x) => x.evento === e);
  return { ctx, emisiones, correrChecklist, tipos };
}

describe("auditor del expediente (L-P3-11)", () => {
  it("con bloqueos no avisa; al quedar sin bloqueos avisa UNA vez (campana + correo) y NO aprueba nada", async () => {
    const t = await armar();
    expect((await t.correrChecklist(ROJO)).status).toBe(200);
    expect(t.tipos("licitaciones.expediente.listo_para_aprobar")).toHaveLength(0);
    const proposal = (await t.ctx.repo.findProposal(t.ctx.organizationId, t.ctx.tenderId))!;
    expect((await t.ctx.repo.getExpedienteAuditoria(t.ctx.organizationId, proposal.id)).registro).toMatchObject({ estado: "con_bloqueos" });

    expect((await t.correrChecklist(VERDE)).status).toBe(200);
    const [aviso] = t.tipos("licitaciones.expediente.listo_para_aprobar");
    expect(aviso).toMatchObject({ organizationId: t.ctx.organizationId, severidad: "atencion", roles: ["analyst"], enlace: `/licitaciones/{orgSlug}/convocatorias/${t.ctx.tenderId}/cierre` });
    expect(aviso!.titulo + (aviso!.cuerpo ?? "")).not.toMatch(/\$|MXN/);
    expect((await t.ctx.repo.getExpedienteAuditoria(t.ctx.organizationId, proposal.id)).registro).toMatchObject({ estado: "sin_bloqueos", bloqueos: 0 });
    const correos = t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "expediente.listo_para_aprobar");
    expect(correos).toHaveLength(1);
    expect(correos[0]!.payload).toMatchObject({ to: "dueno@example.com" });

    // nada se aprobo solo
    expect(await t.ctx.repo.activeApprovalsCovering(t.ctx.organizationId, proposal.id, "expediente")).toHaveLength(0);

    // repetir sin bloqueos no avisa otra vez
    await t.correrChecklist(VERDE);
    expect(t.tipos("licitaciones.expediente.listo_para_aprobar")).toHaveLength(1);
    expect(t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "expediente.listo_para_aprobar")).toHaveLength(1);
  });

  it("si vuelve a quedar con bloqueos y luego sin bloqueos con los MISMOS insumos, la clave de dedupe evita el aviso doble", async () => {
    const t = await armar();
    await t.correrChecklist(VERDE);
    await t.correrChecklist(ROJO);
    await t.correrChecklist(VERDE);
    expect(t.tipos("licitaciones.expediente.listo_para_aprobar")).toHaveLength(2); // la campana recibe ambos intentos...
    const claves = new Set(t.tipos("licitaciones.expediente.listo_para_aprobar").map((e) => e.dedupeKey));
    expect(claves.size).toBe(1); // ...pero con la MISMA clave: la base los deduplica (un solo aviso real)
    expect(t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "expediente.listo_para_aprobar")).toHaveLength(1); // y el outbox tambien
  });

  it("un cambio de insumo que invalida una aprobacion vigente avisa (campana + correo) a quienes pueden aprobar", async () => {
    const t = await armar();
    const proposal = (await t.ctx.repo.findProposal(t.ctx.organizationId, t.ctx.tenderId))!;
    // aprobacion dada sobre OTROS insumos: el hash vivo ya no coincide -> el choke point la invalida
    await t.ctx.repo.approve(t.ctx.organizationId, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: t.ctx.staff.owner.id, actorRole: "owner", inputsHash: sealInputs({ tenderVersionHash: "otro", companyProfileHash: "otro", companyDocuments: [], rates: [], templates: [] }) });
    expect(await t.ctx.repo.activeApprovalsCovering(t.ctx.organizationId, proposal.id, "expediente")).toHaveLength(1);

    await t.correrChecklist(VERDE);

    expect(await t.ctx.repo.activeApprovalsCovering(t.ctx.organizationId, proposal.id, "expediente")).toHaveLength(0);
    const [aviso] = t.tipos("licitaciones.expediente.aprobacion_invalidada");
    expect(aviso).toMatchObject({ organizationId: t.ctx.organizationId, roles: ["analyst"], severidad: "atencion" });
    expect(t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "expediente.aprobacion_invalidada")).toHaveLength(1);
  });

  it("un fallo del auditor NUNCA rompe la escritura de negocio (el checklist responde 200 y queda guardado)", async () => {
    const t = await armar();
    vi.spyOn(t.ctx.repo, "computeCurrentInputsHash").mockRejectedValue(new Error("hash caido"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await t.correrChecklist(VERDE);
    expect(res.status).toBe(200);
    const proposal = (await t.ctx.repo.findProposal(t.ctx.organizationId, t.ctx.tenderId))!;
    expect((await t.ctx.repo.listComplianceItems(t.ctx.organizationId, proposal.id)).length).toBeGreaterThan(0);
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
  });

  it("base sin la migracion 039: no se emite listo_para_aprobar ni su correo (vacio honesto) y el checklist responde 200", async () => {
    const t = await armar();
    vi.spyOn(t.ctx.repo, "getExpedienteAuditoria").mockResolvedValue({ disponible: false, registro: null });
    vi.spyOn(t.ctx.repo, "saveExpedienteAuditoria").mockResolvedValue(false);
    expect((await t.correrChecklist(VERDE)).status).toBe(200);
    expect(t.tipos("licitaciones.expediente.listo_para_aprobar")).toHaveLength(0);
    expect(t.ctx.repo.getMessagingOutbox().filter((o) => o.eventType === "expediente.listo_para_aprobar")).toHaveLength(0);
  });
});
