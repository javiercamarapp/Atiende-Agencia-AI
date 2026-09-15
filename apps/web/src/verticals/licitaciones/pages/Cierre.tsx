// Cierre del expediente (Fase 14) — cierra el hallazgo ALTA de auditoría:
// "cierre del flujo central tras propuesta técnica+económica (ya
// construidas). checklist.ts expone POST .../checklist/run [...]; cierre.ts
// expone POST .../expediente/approval (DECISION_ROLES), POST
// .../proposal/sections/:sectionKey/approval, POST .../package/assemble, GET
// .../package/latest y GET .../package/download" -- ninguno tenía cliente ni
// página.
//
// Alcance DELIBERADAMENTE acotado a esto (mismo criterio de "porción" que
// PropuestaTecnica.tsx): a partir de la propuesta técnica/económica YA
// generadas, (1) correr el checklist de integridad ejecutable declarando
// metadatos REALES de los archivos que se subirán al portal (nunca
// inventados -- salen de `<input type="file">`, filename/extensión/tamaño
// reales del `File` elegido), firmas y anexos presentes; (2) aprobar el
// expediente completo (DECISION_ROLES, el único gate real hacia "ready") o
// una sección concreta para revisión granular; (3) ensamblar el paquete
// final contra el estado vivo del expediente y (4) descargarlo. "ready"
// SIEMPRE lo deriva `PackageAssembler` server-side (ver cabecera de
// cierre.ts) -- esta pantalla nunca lo calcula ni lo asume, solo refleja lo
// que el servidor acaba de recalcular.
//
// Fuera de esta pieza a propósito (post-adjudicación, alcance de rondas
// futuras -- ver README de este vertical): declarar que el expediente YA se
// presentó ante el portal (`GET`/`POST .../submission[/declare]`), contratos,
// cobranza e inconformidades.
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchRequirementItems } from "../lib/requirements-client.ts";
import type { RequirementItemRecord } from "../lib/requirements-client.ts";
import { fetchChecklist, runChecklist } from "../lib/checklist-client.ts";
import type { ChecklistFileArtifact, ChecklistSignatureRequirement, ChecklistSummary } from "../lib/checklist-client.ts";
import {
  approveExpediente,
  approveProposalSection,
  assemblePackage,
  downloadPackage,
  fetchLatestPackage,
  PackageDownloadConflictError,
} from "../lib/cierre-client.ts";
import type { ApprovalResult, PackageStatusResult } from "../lib/cierre-client.ts";
import { formatComplianceResult, formatDate } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que el resto del vertical (WRITE_ROLES de
// `@atiende/domain-licitaciones::roles.ts`) -- cosmético, oculta acciones que
// el servidor rechazaría igual (`assertVerticalRole(c, WRITE_ROLES)` en
// checklist.ts::run y cierre.ts::package/assemble); el enforcement real es
// siempre server-side.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

// DECISION_ROLES EXACTO de roles.ts (más estricto que WRITE_ROLES: sin
// "writer"/"reviewer") -- oculta la aprobación del expediente/sección a quien
// el servidor rechazaría igual (`assertVerticalRole(c, DECISION_ROLES)` en
// cierre.ts).
const DECISION_ROLES = new Set(["owner", "admin", "analyst"]);

/**
 * Alcances de sección conocidos server-side (`technicalProposal.ts::SECTION_LABEL_BY_KEY`,
 * prefijo `"technical:"`, y `proposalEconomic.ts`/`in-memory-repository.ts::saveEconomicGeneration`,
 * `"economic:carta"`/`"economic:anexo"`) -- no existe un `GET` que liste las
 * secciones realmente persistidas para esta convocatoria, así que se ofrecen
 * los 6 alcances posibles tal cual el servidor los nombra. Aprobar un
 * `sectionKey` que esta convocatoria en particular nunca llegó a generar es
 * inofensivo (queda una aprobación de una sección sin documento -- el
 * ensamblado solo consume aprobaciones de alcance "expediente", ver
 * `cierre-client.ts::approveProposalSection`).
 */
const KNOWN_SECTION_KEYS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "technical:tecnica", label: "Técnica — Propuesta técnica" },
  { value: "technical:legal", label: "Técnica — Cumplimiento legal" },
  { value: "technical:administrativa", label: "Técnica — Cumplimiento administrativo" },
  { value: "technical:anexos", label: "Técnica — Anexos" },
  { value: "economic:carta", label: "Económica — Carta de proposición" },
  { value: "economic:anexo", label: "Económica — Anexo económico" },
];

const RESULT_COLORS: Record<string, { bg: string; fg: string }> = {
  verde: { bg: "#dcfce7", fg: "#166534" },
  ambar: { bg: "#fef9c3", fg: "#854d0e" },
  rojo: { bg: "#fee2e2", fg: "#991b1b" },
};

function ResultDot({ result }: { result: string }) {
  const colors = RESULT_COLORS[result] ?? { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>{formatComplianceResult(result)}</span>;
}

function StatusPill({ status }: { status: "draft" | "ready" }) {
  const colors = status === "ready" ? { bg: "#dcfce7", fg: "#166534" } : { bg: "#fef9c3", fg: "#854d0e" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>{status === "ready" ? "Listo" : "Borrador"}</span>;
}

const sectionCardStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };

interface PendingFileRow {
  readonly key: string;
  readonly file: File;
  pages: string; // texto libre -- se parsea al enviar, opcional
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : "";
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function CierrePage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();

  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [items, setItems] = useState<readonly RequirementItemRecord[] | null>(null);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(null);
  const [latestPackage, setLatestPackage] = useState<PackageStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canRunChecklist = WRITE_ROLES.has(role);
  const canApprove = DECISION_ROLES.has(role);
  const canAssemble = WRITE_ROLES.has(role);

  // ---- Formulario del checklist ----
  const [pendingFiles, setPendingFiles] = useState<readonly PendingFileRow[]>([]);
  const [allowedExtensionsText, setAllowedExtensionsText] = useState("pdf");
  const [maxFileSizeMbText, setMaxFileSizeMbText] = useState("10");
  const [maxUploadSlotsText, setMaxUploadSlotsText] = useState("20");
  const [maxPagesPerFileText, setMaxPagesPerFileText] = useState("");
  const [signatures, setSignatures] = useState<ChecklistSignatureRequirement[]>([{ role: "", userConfirmedSigned: false }]);
  const [presentAnnexRefs, setPresentAnnexRefs] = useState<ReadonlySet<string>>(new Set());
  const [checklistRunning, setChecklistRunning] = useState(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);

  // ---- Aprobaciones ----
  const [approvingExpediente, setApprovingExpediente] = useState(false);
  const [expedienteApprovalError, setExpedienteApprovalError] = useState<string | null>(null);
  const [expedienteApprovalResult, setExpedienteApprovalResult] = useState<ApprovalResult | null>(null);

  const [sectionKeyToApprove, setSectionKeyToApprove] = useState(KNOWN_SECTION_KEYS[0]!.value);
  const [approvingSection, setApprovingSection] = useState(false);
  const [sectionApprovalError, setSectionApprovalError] = useState<string | null>(null);
  const [sectionApprovalResult, setSectionApprovalResult] = useState<ApprovalResult | null>(null);

  // ---- Ensamblado / descarga ----
  const [assembling, setAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, itemsData, checklistData, packageData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchRequirementItems(fetch, apiBaseUrl, token, propertyId, id),
        fetchChecklist(fetch, apiBaseUrl, token, propertyId, id),
        fetchLatestPackage(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setTender(tenderData);
      setItems(itemsData);
      setChecklist(checklistData);
      setLatestPackage(packageData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
    // eslint: mismo criterio que el resto del panel (sin eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId, tenderId]);

  /** Mismo filtro que `listRequiredAnnexes` server-side (postgres-repository.ts): `requirementKind === "anexo" && obligatoriedad === "obligatorio"`, referencia = `topicKey ?? id` (idéntico a `checkAnexosObligatorios` en integrity-checklist.ts). */
  const requiredAnnexes = useMemo(() => (items ?? []).filter((i) => i.requirementKind === "anexo" && i.obligatoriedad === "obligatorio"), [items]);

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const rows: PendingFileRow[] = Array.from(files).map((file) => ({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`, file, pages: "" }));
    setPendingFiles((prev) => [...prev, ...rows]);
    event.target.value = "";
  }

  function removePendingFile(key: string) {
    setPendingFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function updatePendingFilePages(key: string, pages: string) {
    setPendingFiles((prev) => prev.map((f) => (f.key === key ? { ...f, pages } : f)));
  }

  function addSignatureRow() {
    setSignatures((prev) => [...prev, { role: "", userConfirmedSigned: false }]);
  }

  function removeSignatureRow(index: number) {
    setSignatures((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function updateSignatureRow(index: number, patch: Partial<ChecklistSignatureRequirement>) {
    setSignatures((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function toggleAnnexPresent(ref: string) {
    setPresentAnnexRefs((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  async function handleRunChecklist() {
    if (!tenderId) return;
    setChecklistError(null);

    if (pendingFiles.length === 0) {
      setChecklistError("Agrega al menos un archivo del paquete a subir (los mismos que irán al portal oficial).");
      return;
    }
    const allowedExtensions = allowedExtensionsText
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    if (allowedExtensions.length === 0) {
      setChecklistError("Declara al menos una extensión permitida (ej. pdf).");
      return;
    }
    const maxFileSizeMb = Number(maxFileSizeMbText);
    if (!Number.isFinite(maxFileSizeMb) || maxFileSizeMb <= 0) {
      setChecklistError("El tamaño máximo por archivo debe ser un número positivo (en MB).");
      return;
    }
    const maxUploadSlots = Number(maxUploadSlotsText);
    if (!Number.isInteger(maxUploadSlots) || maxUploadSlots <= 0) {
      setChecklistError("El número máximo de espacios de carga del portal debe ser un entero positivo.");
      return;
    }
    let maxPagesPerFile: number | undefined;
    if (maxPagesPerFileText.trim().length > 0) {
      const parsed = Number(maxPagesPerFileText);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setChecklistError("Las páginas máximas por archivo, si se declaran, deben ser un entero positivo.");
        return;
      }
      maxPagesPerFile = parsed;
    }
    const validSignatures = signatures.filter((s) => s.role.trim().length > 0);
    if (validSignatures.length === 0) {
      setChecklistError("Declara al menos una firma requerida (rol) para este expediente.");
      return;
    }
    for (const row of pendingFiles) {
      if (row.pages.trim().length > 0 && (!Number.isInteger(Number(row.pages)) || Number(row.pages) <= 0)) {
        setChecklistError(`El archivo "${row.file.name}" tiene un número de páginas inválido.`);
        return;
      }
    }

    const files: ChecklistFileArtifact[] = pendingFiles.map((row) => ({
      filename: row.file.name,
      extension: extensionOf(row.file.name),
      sizeBytes: row.file.size,
      pages: row.pages.trim().length > 0 ? Number(row.pages) : undefined,
    }));

    setChecklistRunning(true);
    try {
      const result = await runChecklist(fetch, apiBaseUrl, token, propertyId, tenderId, {
        files,
        formatLimits: { allowedExtensions, maxFileSizeBytes: Math.round(maxFileSizeMb * 1024 * 1024), maxUploadSlots, maxPagesPerFile },
        requiredSignatures: validSignatures.map((s) => ({ role: s.role.trim(), userConfirmedSigned: s.userConfirmedSigned })),
        presentAnnexRefs: [...presentAnnexRefs],
      });
      setChecklist(result);
    } catch (err) {
      setChecklistError(err instanceof Error ? err.message : "No se pudo correr el checklist.");
    } finally {
      setChecklistRunning(false);
    }
  }

  async function handleApproveExpediente() {
    if (!tenderId) return;
    setExpedienteApprovalError(null);
    setApprovingExpediente(true);
    try {
      const result = await approveExpediente(fetch, apiBaseUrl, token, propertyId, tenderId);
      setExpedienteApprovalResult(result);
    } catch (err) {
      setExpedienteApprovalError(err instanceof Error ? err.message : "No se pudo aprobar el expediente.");
    } finally {
      setApprovingExpediente(false);
    }
  }

  async function handleApproveSection() {
    if (!tenderId) return;
    setSectionApprovalError(null);
    setApprovingSection(true);
    try {
      const result = await approveProposalSection(fetch, apiBaseUrl, token, propertyId, tenderId, sectionKeyToApprove);
      setSectionApprovalResult(result);
    } catch (err) {
      setSectionApprovalError(err instanceof Error ? err.message : "No se pudo aprobar la sección.");
    } finally {
      setApprovingSection(false);
    }
  }

  async function handleAssemble() {
    if (!tenderId) return;
    setAssembleError(null);
    setAssembling(true);
    try {
      const result = await assemblePackage(fetch, apiBaseUrl, token, propertyId, tenderId);
      setLatestPackage(result);
    } catch (err) {
      setAssembleError(err instanceof Error ? err.message : "No se pudo ensamblar el paquete.");
    } finally {
      setAssembling(false);
    }
  }

  async function handleDownload() {
    if (!tenderId) return;
    setDownloadError(null);
    setDownloading(true);
    try {
      const { blob, filename } = await downloadPackage(fetch, apiBaseUrl, token, propertyId, tenderId);
      triggerBrowserDownload(blob, filename);
    } catch (err) {
      if (err instanceof PackageDownloadConflictError) {
        setDownloadError(`${err.conflict.message}${err.conflict.missing.length > 0 ? ` Faltan: ${err.conflict.missing.join(", ")}.` : ""}`);
        // El servidor ya recalculó el estado vivo al detectar el conflicto --
        // refleja ese "draft" recién derivado en vez de dejar la tarjeta de
        // estado con el "ready" viejo que acaba de dejar de serlo.
        setLatestPackage((prev) => (prev ? { ...prev, status: "draft", draftReasons: err.conflict.draftReasons, missing: err.conflict.missing } : prev));
      } else {
        setDownloadError(err instanceof Error ? err.message : "No se pudo descargar el paquete.");
      }
    } finally {
      setDownloading(false);
    }
  }

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (loadError) return <p role="alert" style={{ color: "#b91c1c" }}>{loadError}</p>;
  if (!tender) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title} · propuesta técnica/económica
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Cierre del expediente</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Corre el checklist de integridad, aprueba el expediente y ensambla/descarga el paquete final antes de presentarlo ante el portal oficial. La declaración de que YA se presentó no vive en esta pantalla todavía.
        </p>
      </div>

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>
            Checklist de integridad {checklist && <ResultDot result={checklist.overallStatus} />}
          </h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            Valida formatos, límites del portal, firmas, anexos obligatorios, vigencias de documentos, cálculos económicos y consistencia entre documentos. El sistema nunca firma ni simula firma -- solo registra tu confirmación de que la firma ya se hizo.
          </p>
        </div>

        {checklist && checklist.items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {checklist.items.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid #f3f4f6", paddingBottom: 6, fontSize: 13 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{item.dimension}</p>
                  <p style={{ margin: "2px 0 0", color: "#6b7280" }}>{item.notes}</p>
                </div>
                <ResultDot result={item.result} />
              </div>
            ))}
          </div>
        )}
        {checklist && checklist.items.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no se ha corrido el checklist de esta convocatoria.</p>}

        {canRunChecklist ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
              Archivos del paquete a subir al portal
              <input type="file" multiple onChange={handleFilesSelected} style={{ fontSize: 13 }} />
            </label>
            {pendingFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingFiles.map((f) => (
                  <div key={f.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
                    <span style={{ fontSize: 12, color: "#374151", flex: "2 1 200px" }}>
                      {f.file.name} · .{extensionOf(f.file.name) || "?"} · {(f.file.size / 1024 / 1024).toFixed(2)}MB
                    </span>
                    <input
                      type="number"
                      min="1"
                      placeholder="Páginas (opcional)"
                      value={f.pages}
                      onChange={(e) => updatePendingFilePages(f.key, e.target.value)}
                      style={{ ...inputStyle, width: 140 }}
                    />
                    <button type="button" onClick={() => removePendingFile(f.key)} style={{ border: "none", background: "transparent", color: "#b91c1c", cursor: "pointer", fontSize: 12 }}>
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 180px" }}>
                Extensiones permitidas (coma)
                <input value={allowedExtensionsText} onChange={(e) => setAllowedExtensionsText(e.target.value)} placeholder="pdf" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 140px" }}>
                Tamaño máximo por archivo (MB)
                <input type="number" min="0.1" step="any" value={maxFileSizeMbText} onChange={(e) => setMaxFileSizeMbText(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 140px" }}>
                Espacios de carga del portal
                <input type="number" min="1" step="1" value={maxUploadSlotsText} onChange={(e) => setMaxUploadSlotsText(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 140px" }}>
                Páginas máx. por archivo (opcional)
                <input type="number" min="1" step="1" value={maxPagesPerFileText} onChange={(e) => setMaxPagesPerFileText(e.target.value)} style={inputStyle} />
              </label>
            </div>

            <div>
              <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "#374151" }}>Firmas requeridas</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {signatures.map((s, index) => (
                  <div key={index} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <input value={s.role} onChange={(e) => updateSignatureRow(index, { role: e.target.value })} placeholder="representante_legal" style={{ ...inputStyle, flex: "1 1 200px" }} />
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                      <input type="checkbox" checked={s.userConfirmedSigned} onChange={(e) => updateSignatureRow(index, { userConfirmedSigned: e.target.checked })} />
                      Ya se firmó (fuera del sistema)
                    </label>
                    <button type="button" onClick={() => removeSignatureRow(index)} disabled={signatures.length <= 1} style={{ border: "none", background: "transparent", color: "#b91c1c", cursor: signatures.length <= 1 ? "not-allowed" : "pointer", fontSize: 12 }}>
                      Quitar
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addSignatureRow} style={{ alignSelf: "flex-start", padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                  + Agregar firma requerida
                </button>
              </div>
            </div>

            <div>
              <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Anexos obligatorios presentes ({presentAnnexRefs.size}/{requiredAnnexes.length})
              </p>
              {requiredAnnexes.length === 0 ? (
                <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Ningún requisito extraído está marcado como anexo obligatorio -- no hay nada que confirmar aquí.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {requiredAnnexes.map((item) => {
                    const ref = item.topicKey ?? item.id;
                    return (
                      <label key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12 }}>
                        <input type="checkbox" checked={presentAnnexRefs.has(ref)} onChange={() => toggleAnnexPresent(ref)} style={{ marginTop: 2 }} />
                        <span>{item.text}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {checklistError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {checklistError}
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleRunChecklist()}
              disabled={checklistRunning}
              style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {checklistRunning ? "Corriendo checklist…" : "Correr checklist"}
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede correr el checklist -- solo lectura del último resultado.</p>
        )}
      </section>

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Aprobación del expediente</h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            Único gate real hacia "listo" (DECISION_ROLES: owner/admin/analyst). El hash de insumos aprobado siempre se recalcula en vivo -- nunca se acepta uno propuesto desde aquí. Quien haya redactado contenido de cualquier sección no puede autoaprobarse.
          </p>
        </div>

        {canApprove ? (
          <button
            type="button"
            onClick={() => void handleApproveExpediente()}
            disabled={approvingExpediente}
            style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {approvingExpediente ? "Aprobando…" : "Aprobar expediente completo"}
          </button>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede aprobar el expediente -- solo DECISION_ROLES (owner/admin/analyst).</p>
        )}

        {expedienteApprovalError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {expedienteApprovalError}
          </p>
        )}
        {expedienteApprovalResult && (
          <p role="status" style={{ margin: 0, fontSize: 12, color: "#166534" }}>
            Aprobado {formatDate(expedienteApprovalResult.decidedAt)} · estatus {expedienteApprovalResult.status}.
          </p>
        )}

        {canApprove && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, flex: "1 1 260px" }}>
              Aprobación granular por sección (revisión incremental, no gatea "listo")
              <select value={sectionKeyToApprove} onChange={(e) => setSectionKeyToApprove(e.target.value)} style={inputStyle}>
                {KNOWN_SECTION_KEYS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void handleApproveSection()}
              disabled={approvingSection}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {approvingSection ? "Aprobando…" : "Aprobar sección"}
            </button>
          </div>
        )}
        {sectionApprovalError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {sectionApprovalError}
          </p>
        )}
        {sectionApprovalResult && (
          <p role="status" style={{ margin: 0, fontSize: 12, color: "#166534" }}>
            Sección "{sectionApprovalResult.scopeRef}" aprobada {formatDate(sectionApprovalResult.decidedAt)}.
          </p>
        )}
      </section>

      <section style={sectionCardStyle}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>
            Paquete final {latestPackage && <StatusPill status={latestPackage.status} />}
          </h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
            El ensamblado recalcula el estado contra el expediente vivo cada vez -- "listo" solo si el checklist está en verde, hay una aprobación de expediente vigente y ningún documento requerido falta. La presentación y firma las realiza el usuario; el sistema no envía ofertas.
          </p>
        </div>

        {latestPackage === null && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no se ha ensamblado ningún paquete para este expediente.</p>}

        {latestPackage && latestPackage.status === "draft" && latestPackage.draftReasons.length > 0 && (
          <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: 12 }}>
            <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600, color: "#92400e" }}>Motivos por los que sigue en borrador:</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
              {latestPackage.draftReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {latestPackage.missing.length > 0 && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#92400e" }}>Faltan: {latestPackage.missing.join(", ")}.</p>}
          </div>
        )}

        {latestPackage && latestPackage.status === "ready" && (
          <p style={{ margin: 0, fontSize: 12, color: "#166534" }}>Generado {formatDate(latestPackage.generatedAt)}. {latestPackage.notice}</p>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canAssemble ? (
            <button
              type="button"
              onClick={() => void handleAssemble()}
              disabled={assembling}
              style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {assembling ? "Ensamblando…" : "Ensamblar paquete"}
            </button>
          ) : (
            <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede ensamblar el paquete.</p>
          )}
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading || latestPackage === null}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: latestPackage === null ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {downloading ? "Descargando…" : "Descargar ZIP"}
          </button>
        </div>

        {assembleError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {assembleError}
          </p>
        )}
        {downloadError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {downloadError}
          </p>
        )}
      </section>
    </div>
  );
}
