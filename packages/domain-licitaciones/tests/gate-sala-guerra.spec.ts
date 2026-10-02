// L-25 -- evaluarGateSalaGuerra (funcion pura, reloj fijo) y verifyZipAgainstStoredManifest (bytes reales).
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { evaluarGateSalaGuerra, PackageAssembler, verifyZipAgainstStoredManifest } from "../src/index.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ChecklistReport, GateSalaGuerraInput } from "../src/index.ts";

const VERDE: ChecklistReport = { items: [{ dimension: "formatos", status: "verde", detail: "ok", evidence: [] }], overallStatus: "verde" };
const AHORA = "2026-10-05T12:00:00.000Z";
const CIERRE_LEJANO = "2026-10-09T18:00:00.000Z";

function base(over: Partial<GateSalaGuerraInput> = {}): GateSalaGuerraInput {
  return {
    checklist: VERDE,
    paquete: { generatedAt: "2026-10-04T10:00:00.000Z", storedStatus: "ready", vigenteStatus: "ready", draftReasons: [] },
    zip: { state: "ok", documentos: 3 },
    aprobaciones: { mode: "doble", complete: true, missing: [] },
    fechaCierre: CIERRE_LEJANO,
    ahora: AHORA,
    zonaHoraria: "America/Mexico_City",
    ...over,
  };
}
const color = (r: ReturnType<typeof evaluarGateSalaGuerra>, id: string) => r.condiciones.find((c) => c.id === id)!.color;

describe("evaluarGateSalaGuerra", () => {
  it("todo en verde con holgura >= 24 h -> listo, sin motivos ni alerta", () => {
    const r = evaluarGateSalaGuerra(base());
    expect(r.veredicto).toBe("listo");
    expect(r.listo).toBe(true);
    expect(r.condiciones.every((c) => c.color === "verde")).toBe(true);
    expect(r.motivos).toEqual([]);
    expect(r.alerta24h).toBe(false);
  });

  it("ZIP alterado -> rojo con el motivo 'el ZIP no coincide con el manifiesto' y NO listo", () => {
    const r = evaluarGateSalaGuerra(base({ zip: { state: "no_coincide", documentos: ["tecnica"], faltantes: [] } }));
    expect(color(r, "zip_manifiesto")).toBe("rojo");
    expect(r.listo).toBe(false);
    expect(r.motivos.join(" ")).toContain("El ZIP no coincide con el manifiesto");
  });

  it("sin paquete -> no listo (paquete y zip en rojo)", () => {
    const r = evaluarGateSalaGuerra(base({ paquete: null, zip: null }));
    expect(r.listo).toBe(false);
    expect(color(r, "paquete")).toBe("rojo");
    expect(color(r, "zip_manifiesto")).toBe("rojo");
  });

  it("paquete guardado 'ready' pero ya no vigente contra el expediente vivo -> rojo con el motivo", () => {
    const r = evaluarGateSalaGuerra(base({ paquete: { generatedAt: AHORA, storedStatus: "ready", vigenteStatus: "draft", draftReasons: ["La aprobación ya no cubre los insumos."] } }));
    expect(color(r, "paquete")).toBe("rojo");
    expect(r.motivos.join(" ")).toContain("ya no está vigente");
  });

  it("paquete en borrador -> rojo", () => {
    const r = evaluarGateSalaGuerra(base({ paquete: { generatedAt: AHORA, storedStatus: "draft", vigenteStatus: "draft", draftReasons: ["Falta el documento X."] } }));
    expect(color(r, "paquete")).toBe("rojo");
    expect(r.motivos.join(" ")).toContain("borrador");
  });

  it("checklist con rojos o nunca corrido -> rojo; con ambar -> ambar (no bloquea)", () => {
    expect(color(evaluarGateSalaGuerra(base({ checklist: null })), "checklist")).toBe("rojo");
    expect(color(evaluarGateSalaGuerra(base({ checklist: { items: [], overallStatus: "rojo" } })), "checklist")).toBe("rojo");
    const rojo: ChecklistReport = { items: [{ dimension: "firmas", status: "rojo", detail: "x", evidence: [] }], overallStatus: "rojo" };
    expect(evaluarGateSalaGuerra(base({ checklist: rojo })).listo).toBe(false);
    const ambar: ChecklistReport = { items: [{ dimension: "firmas", status: "ambar", detail: "x", evidence: [] }], overallStatus: "ambar" };
    const r = evaluarGateSalaGuerra(base({ checklist: ambar }));
    expect(color(r, "checklist")).toBe("ambar");
    expect(r.listo).toBe(true);
    expect(r.motivos).toHaveLength(1);
  });

  it("doble aprobacion incompleta -> rojo y nombra lo que falta; misma persona -> rojo", () => {
    const r = evaluarGateSalaGuerra(base({ aprobaciones: { mode: "doble", complete: false, missing: ["economica"] } }));
    expect(color(r, "aprobaciones")).toBe("rojo");
    expect(r.motivos.join(" ")).toContain("aprobación económica (2/2)");
    expect(evaluarGateSalaGuerra(base({ aprobaciones: { mode: "doble", complete: false, missing: [], sameApprover: true } })).motivos.join(" ")).toContain("personas distintas");
  });

  it("base sin migrar (aprobacion unica): vigente -> ambar declarado; sin aprobar -> rojo", () => {
    const ok = evaluarGateSalaGuerra(base({ aprobaciones: { mode: "legacy", complete: true, missing: [] } }));
    expect(color(ok, "aprobaciones")).toBe("ambar");
    expect(ok.motivos.join(" ")).toContain("migración 033");
    expect(color(evaluarGateSalaGuerra(base({ aprobaciones: { mode: "legacy", complete: false, missing: ["tecnica_legal", "economica"] } })), "aprobaciones")).toBe("rojo");
    expect(color(evaluarGateSalaGuerra(base({ aprobaciones: { mode: "sin_propuesta", complete: false, missing: [] } })), "aprobaciones")).toBe("rojo");
  });

  describe("holgura y cuenta regresiva", () => {
    it("exactamente 24 h es verde; 23 h 59 min es ambar y se ve en el motivo", () => {
      const cierre24 = new Date(Date.parse(AHORA) + 24 * 3_600_000).toISOString();
      expect(color(evaluarGateSalaGuerra(base({ fechaCierre: cierre24 })), "holgura")).toBe("verde");
      const cierre23 = new Date(Date.parse(AHORA) + (24 * 60 - 1) * 60_000).toISOString();
      const r = evaluarGateSalaGuerra(base({ fechaCierre: cierre23 }));
      expect(color(r, "holgura")).toBe("ambar");
      expect(r.motivos.join(" ")).toContain("23 h 59 min");
      expect(r.listo).toBe(true);
      expect(r.alerta24h).toBe(false);
    });

    it("alerta a menos de 24 h con el paquete NO listo; sin alerta si ya se presento o si ya vencio", () => {
      const cierre = new Date(Date.parse(AHORA) + 5 * 3_600_000).toISOString();
      const malo = base({ fechaCierre: cierre, paquete: null, zip: null });
      expect(evaluarGateSalaGuerra(malo).alerta24h).toBe(true);
      expect(evaluarGateSalaGuerra({ ...malo, presentado: true }).alerta24h).toBe(false);
      const vencido = evaluarGateSalaGuerra({ ...malo, fechaCierre: new Date(Date.parse(AHORA) - 60_000).toISOString() });
      expect(vencido.alerta24h).toBe(false);
      expect(color(vencido, "holgura")).toBe("rojo");
      expect(vencido.cuentaRegresiva.estado).toBe("vencido");
      expect(vencido.listo).toBe(false);
    });

    it("sin fecha de cierre -> ambar y cuenta 'sin_fecha'", () => {
      const r = evaluarGateSalaGuerra(base({ fechaCierre: null }));
      expect(color(r, "holgura")).toBe("ambar");
      expect(r.cuentaRegresiva).toMatchObject({ estado: "sin_fecha", msRestantes: null, fechaCierreLocal: null });
      expect(r.holguraHoras).toBeNull();
    });

    it("cruce 23:xx America/Mexico_City: el cierre 23:30 locales (05:30Z del dia siguiente) es el dia civil de Mexico, no el UTC", () => {
      const r = evaluarGateSalaGuerra(base({ fechaCierre: "2026-10-10T05:30:00.000Z", ahora: "2026-10-09T03:00:00.000Z" }));
      expect(r.cuentaRegresiva.fechaCierreLocal).toBe("2026-10-09");
      expect(r.cuentaRegresiva.horaCierreLocal).toBe("23:30");
      expect(r.cuentaRegresiva).toMatchObject({ dias: 1, horas: 2, minutos: 30 });
    });

    it("misma instantanea en otra zona del cliente cambia la fecha civil; una zona invalida cae al default de Mexico", () => {
      const cierre = "2026-10-10T05:30:00.000Z";
      expect(evaluarGateSalaGuerra(base({ fechaCierre: cierre, zonaHoraria: "Asia/Tokyo" })).cuentaRegresiva.fechaCierreLocal).toBe("2026-10-10");
      const r = evaluarGateSalaGuerra(base({ fechaCierre: cierre, zonaHoraria: "No/Existe" }));
      expect(r.cuentaRegresiva.zonaHoraria).toBe("America/Mexico_City");
      expect(r.cuentaRegresiva.fechaCierreLocal).toBe("2026-10-09");
    });
  });

  it("los motivos van primero los rojos, luego los ambar", () => {
    const ambar: ChecklistReport = { items: [{ dimension: "firmas", status: "ambar", detail: "x", evidence: [] }], overallStatus: "ambar" };
    const r = evaluarGateSalaGuerra(base({ checklist: ambar, zip: { state: "ilegible" } }));
    expect(r.motivos[0]).toContain("No se pudo leer el ZIP");
    expect(r.motivos[1]).toContain("ámbar");
  });
});

describe("verifyZipAgainstStoredManifest (bytes reales)", () => {
  async function paquete() {
    const assembler = new PackageAssembler();
    const docs = [
      { documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "tecnica.txt", version: 1, content: "contenido tecnico" },
      { documentId: "economica", label: "Propuesta económica", required: true, filename: "economica.txt", version: 1, content: "contenido economico" },
    ];
    const sealed = sealInputs({ tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] });
    const out = await assembler.assemble({ expedienteId: "exp-1", documents: docs, checklist: VERDE, approvals: [], currentInputsHash: sealed });
    return out;
  }

  it("un ZIP intacto coincide con el manifiesto guardado", async () => {
    const out = await paquete();
    const r = await verifyZipAgainstStoredManifest(out.zip, { status: out.manifest.status, manifest: out.manifest });
    expect(r).toEqual({ state: "ok", documentos: 2 });
  });

  it("alterar un documento dentro del ZIP (aunque se reescriba el manifiesto interno) -> no_coincide contra el manifiesto guardado", async () => {
    const out = await paquete();
    const zip = await JSZip.loadAsync(out.zip);
    const prefix = out.manifest.status === "draft" ? "BORRADOR_" : "";
    zip.file(`${prefix}tecnica.txt`, "contenido ALTERADO");
    const alterado = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyZipAgainstStoredManifest(alterado, { status: out.manifest.status, manifest: out.manifest });
    expect(r).toMatchObject({ state: "no_coincide", documentos: ["tecnica"], faltantes: [] });
  });

  it("un documento ausente del ZIP se reporta como faltante; bytes que no son un ZIP o manifiesto sin forma -> ilegible", async () => {
    const out = await paquete();
    const zip = await JSZip.loadAsync(out.zip);
    const prefix = out.manifest.status === "draft" ? "BORRADOR_" : "";
    zip.remove(`${prefix}economica.txt`);
    const sinDoc = await zip.generateAsync({ type: "uint8array" });
    expect(await verifyZipAgainstStoredManifest(sinDoc, { status: out.manifest.status, manifest: out.manifest })).toMatchObject({ state: "no_coincide", faltantes: ["economica"] });
    expect(await verifyZipAgainstStoredManifest(new Uint8Array([1, 2, 3]), { status: out.manifest.status, manifest: out.manifest })).toEqual({ state: "ilegible" });
    expect(await verifyZipAgainstStoredManifest(out.zip, { status: "ready", manifest: { nada: true } })).toEqual({ state: "ilegible" });
  });
});
