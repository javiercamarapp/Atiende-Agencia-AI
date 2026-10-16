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
// L-26 (REQ-044): la aprobación del expediente es DOBLE (técnico-legal 1/2 y
// económica 2/2, dos personas distintas, cada una con step-up TOTP) --
// `components/AprobacionExpediente.tsx`. L-28: la pestaña "Presentación"
// (`components/PresentacionPortal.tsx`) registra que el expediente YA se
// presentó ante el portal (`GET`/`POST .../submission[/declare]`); Atiende
// nunca envía la oferta. El alta del contrato mismo con sus documentos/autopsia
// del fallo/radar de renovaciones es post-adjudicación. Cobranza del contrato e
// inconformidades ya tienen pantalla propia (Fase 15, `pages/PostAdjudicacion.tsx`,
// enlazada arriba).
//
// Fase "sistema de diseño real" (contenido) — los tres bloques (checklist /
// aprobación / paquete) pasan a `Tabs` sobre `Card`, los pills de resultado y
// de estatus del paquete a `Badge`, y todos los inputs/botones a
// `Input`/`Label`/`Button` de @atiende/ui. Cero cambios de lógica ni de red.
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, ListChecks, Package, Plus, X } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import { PAQUETE_CIERRE_TONES, RESULTADO_CUMPLIMIENTO_TONES } from "../lib/status-tones.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchRequirementItems } from "../lib/requirements-client.ts";
import type { RequirementItemRecord } from "../lib/requirements-client.ts";
import { fetchChecklist, runChecklist } from "../lib/checklist-client.ts";
import type { ChecklistFileArtifact, ChecklistSignatureRequirement, ChecklistSummary } from "../lib/checklist-client.ts";
import {
  approveProposalSection,
  assemblePackage,
  downloadPackage,
  fetchExpedienteApprovals,
  fetchLatestPackage,
  PackageDownloadConflictError,
} from "../lib/cierre-client.ts";
import { EXPEDIENTE_STAGE_LABELS } from "../lib/cierre-client.ts";
import type { ApprovalResult, ExpedienteApprovalsState, PackageStatusResult } from "../lib/cierre-client.ts";
import { AprobacionExpediente } from "../components/AprobacionExpediente.tsx";
import { fetchProposalSections } from "../lib/revision-client.ts";
import { PresentacionPortal } from "../components/PresentacionPortal.tsx";
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

function ResultDot({ result }: { result: string }) {
  return (
    <StatusBadge tone={statusTone(RESULTADO_CUMPLIMIENTO_TONES, result)} className="whitespace-nowrap">
      {formatComplianceResult(result)}
    </StatusBadge>
  );
}

function StatusPill({ status }: { status: "draft" | "ready" }) {
  return (
    <StatusBadge tone={statusTone(PAQUETE_CIERRE_TONES, status)} className="whitespace-nowrap">
      {status === "ready" ? "Listo" : "Borrador"}
    </StatusBadge>
  );
}

/** Panel de advertencia (tokens de advertencia del DS v2). */
const PANEL_ALERTA = "rounded-xl border border-warning/30 bg-warning-tint p-3";
const TEXTO_ALERTA = "font-medium text-foreground";

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
  // L-26: estado de la doble aprobacion (lo pinta `AprobacionExpediente`; aqui tambien gatea "Ensamblar paquete").
  const [approvals, setApprovals] = useState<ExpedienteApprovalsState | null>(null);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  // L-26: con la doble aprobacion disponible, sin el 2/2 vigente el servidor responde 409 al ensamblar: el boton lo anticipa.
  const awaitingApprovals = approvals?.mode === "doble" && !approvals.complete;

  // paridad3 (AE-11): secciones que la persona editó -- quien redacta una sección no puede aprobarla ni aprobar el expediente.
  const [authoredSections, setAuthoredSections] = useState<ReadonlySet<string>>(new Set());
  const authoredAny = authoredSections.size > 0;
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
      // El estado de las aprobaciones se pide aparte: si falla, la pantalla sigue (con el error en su pestaña).
      await loadApprovals(id);
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

  /** Pide el estado de la doble aprobacion; un fallo se queda en la pestana "Aprobacion" y no tumba el resto de la pantalla. */
  async function loadApprovals(id: string) {
    try {
      setApprovals(await fetchExpedienteApprovals(fetch, apiBaseUrl, token, propertyId, id));
      setApprovalsError(null);
    } catch (err) {
      setApprovalsError(err instanceof Error ? err.message : "No se pudo consultar el estado de las aprobaciones.");
    }
    // La autoria solo adelanta la razon del bloqueo (el servidor decide): si no se puede consultar, no se muestra nada de mas.
    try {
      const sections = await fetchProposalSections(fetch, apiBaseUrl, token, propertyId, id);
      setAuthoredSections(new Set(sections.filter((x) => x.authoredByViewer).map((x) => x.sectionKey)));
    } catch {
      setAuthoredSections(new Set());
    }
  }

  /** Tras una aprobacion cambia lo que "listo" significa: refresca aprobaciones y paquete (que el servidor re-deriva). */
  async function reloadAfterApproval() {
    if (!tenderId) return;
    await loadApprovals(tenderId);
    try {
      setLatestPackage(await fetchLatestPackage(fetch, apiBaseUrl, token, propertyId, tenderId));
    } catch {
      // el estado del paquete se vuelve a pedir al ensamblar/descargar; no se tapa la aprobacion ya registrada
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

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando expediente…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <div className="flex flex-col gap-1">
        <Link
          to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title} · propuesta técnica/económica
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">Cierre del expediente</h1>
        <p className="text-sm text-muted-foreground">
          Corre el checklist de integridad, aprueba el expediente (dos aprobaciones, por dos personas), ensambla/descarga el paquete final y, cuando lo presentes tú en el portal oficial, declara aquí la presentación. Atiende nunca envía la oferta.
        </p>
        <Link
          to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/post-adjudicacion`}
          className="mt-2 inline-flex w-fit items-center gap-1 text-sm font-semibold text-foreground no-underline hover:underline"
        >
          Cobranza del contrato e inconformidades (post-adjudicación) →
        </Link>
      </div>

      <Tabs defaultValue="checklist" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="aprobacion">Aprobación</TabsTrigger>
          <TabsTrigger value="paquete">Paquete final</TabsTrigger>
          <TabsTrigger value="presentacion">Presentación</TabsTrigger>
        </TabsList>

        <TabsContent value="checklist">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ListChecks className="h-4 w-4 text-muted-foreground" />
                Checklist de integridad {checklist && <ResultDot result={checklist.overallStatus} />}
              </CardTitle>
              <CardDescription>
                Valida formatos, límites del portal, firmas, anexos obligatorios, vigencias de documentos, cálculos económicos y consistencia entre documentos. El sistema nunca firma ni simula firma -- solo registra tu confirmación de que la firma ya se hizo.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {checklist && checklist.items.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {checklist.items.map((item) => (
                    <div key={item.id} className="flex justify-between gap-3 border-b border-border pb-1.5 text-sm">
                      <div>
                        <p className="font-semibold text-foreground">{item.dimension}</p>
                        <p className="mt-0.5 text-muted-foreground">{item.notes}</p>
                      </div>
                      <ResultDot result={item.result} />
                    </div>
                  ))}
                </div>
              )}
              {checklist && checklist.items.length === 0 && <EstadoVacio mensaje="Todavía no se ha corrido el checklist de esta convocatoria." />}

              {canRunChecklist ? (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cierre-archivos">Archivos del paquete a subir al portal</Label>
                    <Input
                      id="cierre-archivos"
                      type="file"
                      multiple
                      onChange={handleFilesSelected}
                      className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer file:rounded-full file:bg-muted file:px-3 file:py-1 file:text-xs file:font-semibold"
                    />
                  </div>
                  {pendingFiles.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {pendingFiles.map((f) => (
                        <div key={f.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2">
                          <span className="flex-[2_1_200px] text-xs text-foreground">
                            {f.file.name} · .{extensionOf(f.file.name) || "?"} · {(f.file.size / 1024 / 1024).toFixed(2)}MB
                          </span>
                          <Input
                            type="number"
                            min="1"
                            placeholder="Páginas (opcional)"
                            value={f.pages}
                            onChange={(e) => updatePendingFilePages(f.key, e.target.value)}
                            aria-label={`Páginas de ${f.file.name}`}
                            className="h-9 w-[160px]"
                          />
                          <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removePendingFile(f.key)}>
                            <X />
                            Quitar
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <div className="flex flex-[1_1_180px] flex-col gap-1.5">
                      <Label htmlFor="cierre-extensiones">Extensiones permitidas (coma)</Label>
                      <Input id="cierre-extensiones" value={allowedExtensionsText} onChange={(e) => setAllowedExtensionsText(e.target.value)} placeholder="pdf" />
                    </div>
                    <div className="flex flex-[1_1_140px] flex-col gap-1.5">
                      <Label htmlFor="cierre-max-mb">Tamaño máximo por archivo (MB)</Label>
                      <Input id="cierre-max-mb" type="number" min="0.1" step="any" value={maxFileSizeMbText} onChange={(e) => setMaxFileSizeMbText(e.target.value)} />
                    </div>
                    <div className="flex flex-[1_1_140px] flex-col gap-1.5">
                      <Label htmlFor="cierre-slots">Espacios de carga del portal</Label>
                      <Input id="cierre-slots" type="number" min="1" step="1" value={maxUploadSlotsText} onChange={(e) => setMaxUploadSlotsText(e.target.value)} />
                    </div>
                    <div className="flex flex-[1_1_140px] flex-col gap-1.5">
                      <Label htmlFor="cierre-max-paginas">Páginas máx. por archivo (opcional)</Label>
                      <Input id="cierre-max-paginas" type="number" min="1" step="1" value={maxPagesPerFileText} onChange={(e) => setMaxPagesPerFileText(e.target.value)} />
                    </div>
                  </div>

                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-foreground">Firmas requeridas</p>
                    <div className="flex flex-col gap-1.5">
                      {signatures.map((s, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                          <Input
                            value={s.role}
                            onChange={(e) => updateSignatureRow(index, { role: e.target.value })}
                            placeholder="representante_legal"
                            aria-label={`Rol de la firma ${index + 1}`}
                            className="h-9 flex-[1_1_200px]"
                          />
                          <Checkbox label="Ya se firmó (fuera del sistema)" checked={s.userConfirmedSigned} onChange={(e) => updateSignatureRow(index, { userConfirmedSigned: e.target.checked })} />
                          <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeSignatureRow(index)} disabled={signatures.length <= 1}>
                            <X />
                            Quitar
                          </Button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" className="self-start" onClick={addSignatureRow}>
                        <Plus />
                        Agregar firma requerida
                      </Button>
                    </div>
                  </div>

                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-foreground">
                      Anexos obligatorios presentes ({presentAnnexRefs.size}/{requiredAnnexes.length})
                    </p>
                    {requiredAnnexes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Ningún requisito extraído está marcado como anexo obligatorio -- no hay nada que confirmar aquí.</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {requiredAnnexes.map((item) => {
                          const ref = item.topicKey ?? item.id;
                          return (
                            <Checkbox key={item.id} label={item.text} checked={presentAnnexRefs.has(ref)} onChange={() => toggleAnnexPresent(ref)} />
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {checklistError && (
                    <p role="alert" className="text-sm text-destructive">
                      {checklistError}
                    </p>
                  )}

                  <Button type="button" size="sm" className="self-start" onClick={() => void handleRunChecklist()} disabled={checklistRunning}>
                    <ListChecks />
                    {checklistRunning ? "Corriendo checklist…" : "Correr checklist"}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede correr el checklist -- solo lectura del último resultado.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="aprobacion">
          <div className="flex flex-col gap-4">
            <AprobacionExpediente
              apiBaseUrl={apiBaseUrl}
              token={token}
              propertyId={propertyId}
              tenderId={tenderId}
              orgSlug={orgSlug}
              role={role}
              canApprove={canApprove}
              authoredByViewer={authoredAny}
              state={approvals}
              stateError={approvalsError}
              onChanged={reloadAfterApproval}
            />
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Aprobación por sección</CardTitle>
                <CardDescription>Revisión incremental: no gatea «listo» (solo el 2/2 del expediente lo hace).</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {canApprove ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-[1_1_260px] flex-col gap-1.5">
                      <Label htmlFor="cierre-seccion">Sección a aprobar</Label>
                      <NativeSelect id="cierre-seccion" value={sectionKeyToApprove} onChange={(e) => setSectionKeyToApprove(e.target.value)}>
                        {KNOWN_SECTION_KEYS.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    {authoredSections.has(sectionKeyToApprove) ? (
                      <p className="text-xs text-muted-foreground" data-testid="seccion-autor">
                        Editaste esta sección: debe aprobarla otra persona (el autor no aprueba su propio contenido).
                      </p>
                    ) : (
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleApproveSection()} disabled={approvingSection}>
                        {approvingSection ? "Aprobando…" : "Aprobar sección"}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede aprobar secciones -- solo propietario, administrador o analista.</p>
                )}
                {sectionApprovalError && (
                  <p role="alert" className="text-sm text-destructive">
                    {sectionApprovalError}
                  </p>
                )}
                {sectionApprovalResult && (
                  <p role="status" className="text-xs font-medium text-success">
                    Sección "{sectionApprovalResult.scopeRef}" aprobada {formatDate(sectionApprovalResult.decidedAt)}.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="paquete">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Package className="h-4 w-4 text-muted-foreground" />
                Paquete final {latestPackage && <StatusPill status={latestPackage.status} />}
              </CardTitle>
              <CardDescription>
                El ensamblado recalcula el estado contra el expediente vivo cada vez -- "listo" solo si el checklist está en verde, la doble aprobación del expediente (2/2) está vigente y ningún documento requerido falta. La presentación y firma las realiza el usuario; el sistema no envía ofertas.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {latestPackage === null && <EstadoVacio mensaje="Todavía no se ha ensamblado ningún paquete para este expediente." />}

              {latestPackage && latestPackage.status === "draft" && latestPackage.draftReasons.length > 0 && (
                <div className={PANEL_ALERTA}>
                  <p className={`mb-1.5 text-sm font-semibold ${TEXTO_ALERTA}`}>Motivos por los que sigue en borrador:</p>
                  <ul className={`list-disc pl-5 text-xs ${TEXTO_ALERTA}`}>
                    {latestPackage.draftReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  {latestPackage.missing.length > 0 && <p className={`mt-1.5 text-xs ${TEXTO_ALERTA}`}>Faltan: {latestPackage.missing.join(", ")}.</p>}
                </div>
              )}

              {latestPackage && latestPackage.status === "ready" && (
                <p className="text-xs font-medium text-success">
                  Generado {formatDate(latestPackage.generatedAt)}. {latestPackage.notice}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {canAssemble ? (
                  <Button type="button" size="sm" onClick={() => void handleAssemble()} disabled={assembling || awaitingApprovals}>
                    <Package />
                    {assembling ? "Ensamblando…" : "Ensamblar paquete"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede ensamblar el paquete.</p>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => void handleDownload()} disabled={downloading || latestPackage === null}>
                  <Download />
                  {downloading ? "Descargando…" : "Descargar ZIP"}
                </Button>
              </div>

              {awaitingApprovals && (
                <p className="text-xs text-muted-foreground">
                  Para ensamblar falta{approvals!.missing.length > 1 ? "n" : ""} {approvals!.missing.map((m) => EXPEDIENTE_STAGE_LABELS[m]).join(" y ")} -- ver la pestaña «Aprobación».
                </p>
              )}
              {assembleError && (
                <p role="alert" className="text-sm text-destructive">
                  {assembleError}
                </p>
              )}
              {downloadError && (
                <p role="alert" className="text-sm text-destructive">
                  {downloadError}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="presentacion">
          <PresentacionPortal
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            tenderId={tenderId}
            canDeclare={canAssemble}
            role={role}
            packageStatus={latestPackage?.status ?? null}
          />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
