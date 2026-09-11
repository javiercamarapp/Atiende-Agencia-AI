// Flujo 3 -- el flujo de mayor riesgo real del repo origen (AE-14: un badge
// "ready" mentiroso puede llevar a que un humano presente ante un ente
// público un expediente incompleto). Estas pruebas verifican que "ready" se
// DERIVA siempre de las 3 condiciones a la vez, y el saneamiento anti
// zip-slip.
import { describe, expect, it } from "vitest";
import { PackageAssembler, verifyManifest } from "../src/package-assembler.ts";
import type { AssembleInput } from "../src/package-assembler.ts";
import type { ChecklistReport } from "../src/integrity-checklist.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { Approval } from "../src/expediente-approval.ts";

const GREEN_CHECKLIST: ChecklistReport = { overallStatus: "verde", items: [] };
const RED_CHECKLIST: ChecklistReport = { overallStatus: "rojo", items: [{ dimension: "vigencias", status: "rojo", detail: "vencido", evidence: [] }] };

const SEALED = sealInputs({ tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] });

function validApproval(): Approval {
  return { id: "a1", scope: "expediente", scopeRef: "expediente", approvedBy: "user-1", approvedByRole: "owner", approvedAt: "2026-01-01T00:00:00Z", inputsHash: SEALED.hash, status: "vigente" };
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    expedienteId: "exp-1",
    documents: [{ documentId: "d1", label: "Carta económica", required: true, filename: "economic-carta.txt", content: "contenido real", version: 1 }],
    checklist: GREEN_CHECKLIST,
    approvals: [validApproval()],
    currentInputsHash: SEALED,
    ...overrides,
  };
}

describe("PackageAssembler.buildManifest -- 'ready' exige las 3 condiciones a la vez", () => {
  it("ready cuando checklist verde + sin faltantes + aprobación vigente con hash coincidente", () => {
    const manifest = new PackageAssembler().buildManifest(baseInput());
    expect(manifest.status).toBe("ready");
    expect(manifest.draftReasons).toEqual([]);
    expect(manifest.watermark).toBeNull();
  });

  it("draft si el checklist NO está en verde, aunque todo lo demás esté correcto", () => {
    const manifest = new PackageAssembler().buildManifest(baseInput({ checklist: RED_CHECKLIST }));
    expect(manifest.status).toBe("draft");
    expect(manifest.draftReasons).toContain("checklist_no_verde:rojo");
    expect(manifest.watermark).toBe("BORRADOR");
  });

  it("draft si falta un documento requerido", () => {
    const manifest = new PackageAssembler().buildManifest(baseInput({ documents: [{ documentId: "d1", label: "Carta", required: true, filename: "carta.txt" }] }));
    expect(manifest.status).toBe("draft");
    expect(manifest.draftReasons.some((r) => r.startsWith("documentos_faltantes:"))).toBe(true);
    expect(manifest.missing).toEqual(["d1"]);
  });

  it("draft si no hay ninguna aprobación vigente de alcance expediente", () => {
    const manifest = new PackageAssembler().buildManifest(baseInput({ approvals: [] }));
    expect(manifest.status).toBe("draft");
    expect(manifest.draftReasons).toContain("sin_aprobacion_vigente_de_alcance_expediente");
  });

  it('draft si la aprobación vigente existe pero su inputsHash NO coincide con el hash ACTUAL (AE-14: aprobación "obsoleta")', () => {
    const staleApproval: Approval = { ...validApproval(), inputsHash: sealInputs({ tenderVersionHash: "tv-OTRA-VERSION", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] }).hash };
    const manifest = new PackageAssembler().buildManifest(baseInput({ approvals: [staleApproval] }));
    expect(manifest.status).toBe("draft");
    expect(manifest.draftReasons.some((r) => r.startsWith("aprobacion_vigente_con_hash_insumos_divergente"))).toBe(true);
  });

  it("una aprobación 'invalidada' (aunque el hash coincida) nunca cuenta como válida", () => {
    const invalidated: Approval = { ...validApproval(), status: "invalidada" };
    const manifest = new PackageAssembler().buildManifest(baseInput({ approvals: [invalidated] }));
    expect(manifest.status).toBe("draft");
  });

  it("nunca acepta un currentInputsHash calculado a mano (string plano) -- lanza en vez de derivar 'ready' erróneamente", () => {
    expect(() => new PackageAssembler().buildManifest({ ...baseInput(), currentInputsHash: SEALED.hash as unknown as typeof SEALED })).toThrow();
  });
});

describe("PackageAssembler.assemble -- ZIP real + saneamiento anti Zip Slip", () => {
  it("produce un ZIP cuyo manifiesto verifica contra los bytes reales (verifyManifest)", async () => {
    const result = await new PackageAssembler().assemble(baseInput());
    expect(result.manifest.status).toBe("ready");
    const verification = await verifyManifest(result.zip);
    expect(verification.ok).toBe(true);
    expect(verification.mismatches).toEqual([]);
  });

  it('un documento con filename malicioso ("../../etc/passwd") se sanea antes de escribirse en el ZIP', async () => {
    const malicious: AssembleInput = baseInput({ documents: [{ documentId: "d1", label: "Carta", required: true, filename: "../../../etc/passwd", content: "x" }] });
    const result = await new PackageAssembler().assemble(malicious);
    expect(result.manifest.documents[0]!.filename).not.toContain("..");
    expect(result.manifest.documents[0]!.filename).not.toContain("/");
  });

  it('un paquete "draft" antepone BORRADOR_ a cada entrada del ZIP', async () => {
    const result = await new PackageAssembler().assemble(baseInput({ checklist: RED_CHECKLIST }));
    expect(result.manifest.status).toBe("draft");
    expect(result.suggestedFileName.startsWith("BORRADOR_")).toBe(true);
  });
});
