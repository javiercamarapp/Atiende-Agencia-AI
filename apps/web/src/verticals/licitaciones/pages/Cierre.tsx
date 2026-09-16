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
// presentó ante el portal (`GET`/`POST .../submission[/declare]`), y el alta
// del contrato mismo con sus documentos/autopsia del fallo/radar de
// renovaciones. Cobranza del contrato e inconformidades ya tienen pantalla
// propia (Fase 15, `pages/PostAdjudicacion.tsx`, enlazada arriba).
//
// Fase "sistema de diseño real" (contenido) — los tres bloques (checklist /
// aprobación / paquete) pasan a `Tabs` sobre `Card`, los pills de resultado y
// de estatus del paquete a `Badge`, y todos los inputs/botones a
// `Input`/`Label`/`Button` de @atiende/ui. Cero cambios de lógica ni de red.
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Download, ListChecks, Package, Plus, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
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

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Mismo ámbar de antes, sin hex sueltos: `outline` + tokens de Tailwind. */
const AMBAR = "border-amber-500/60 text-amber-600 dark:text-amber-400";

const RESULT_BADGE: Record<string, { variant: BadgeVariant; className?: string }> = {
  verde: { variant: "default" },
  ambar: { variant: "outline", className: AMBAR },
  rojo: { variant: "destructive" },
};

function ResultDot({ result }: { result: string }) {
  const cfg = RESULT_BADGE[result] ?? { variant: "secondary" as const };
  return (
    <Badge variant={cfg.variant} className={cfg.className ? `${cfg.className} whitespace-nowrap` : "whitespace-nowrap"}>
      {formatComplianceResult(result)}
    </Badge>
  );
}

function StatusPill({ status }: { status: "draft" | "ready" }) {
  return (
    <Badge variant={status === "ready" ? "default" : "outline"} className={status === "ready" ? "whitespace-nowrap" : `${AMBAR} whitespace-nowrap`}>
      {status === "ready" ? "Listo" : "Borrador"}
    </Badge>
  );
}

/** `<select>` sigue siendo nativo (el sistema no exporta un primitivo propio):
 * solo se restila con los tokens reales. */
const SELECT_NATIVO =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
/** Panel de advertencia (antes ámbar #fffbeb hardcodeado). */
const PANEL_ALERTA = "rounded-xl border border-amber-500/40 bg-amber-500/10 p-3";
const TEXTO_ALERTA = "text-amber-700 dark:text-amber-400";

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

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando expediente…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link
          to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`}
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title} · propuesta técnica/económica
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Cierre del expediente</h1>
        <p className="text-[13px] text-muted-foreground">
          Corre el checklist de integridad, aprueba el expediente y ensambla/descarga el paquete final antes de presentarlo ante el portal oficial. La declaración de que YA se presentó no vive en esta pantalla todavía.
        </p>
        <Link
          to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/post-adjudicacion`}
          className="mt-2 inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-foreground no-underline hover:underline"
        >
          Cobranza del contrato e inconformidades (post-adjudicación) →
        </Link>
      </div>

      <Tabs defaultValue="checklist" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="aprobacion">Aprobación</TabsTrigger>
          <TabsTrigger value="paquete">Paquete final</TabsTrigger>
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
                    <div key={item.id} className="flex justify-between gap-3 border-b border-border pb-1.5 text-[13px]">
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
                          <label className="flex items-center gap-2 text-xs text-foreground">
                            <input
                              type="checkbox"
                              checked={s.userConfirmedSigned}
                              onChange={(e) => updateSignatureRow(index, { userConfirmedSigned: e.target.checked })}
                              className="h-4 w-4 accent-[hsl(var(--primary))]"
                            />
                            Ya se firmó (fuera del sistema)
                          </label>
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
                            <label key={item.id} className="flex items-start gap-2 text-xs text-foreground">
                              <input
                                type="checkbox"
                                checked={presentAnnexRefs.has(ref)}
                                onChange={() => toggleAnnexPresent(ref)}
                                className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                              />
                              <span>{item.text}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {checklistError && (
                    <p role="alert" className="text-[13px] text-destructive">
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Aprobación del expediente</CardTitle>
              <CardDescription>
                Único gate real hacia "listo" (DECISION_ROLES: owner/admin/analyst). El hash de insumos aprobado siempre se recalcula en vivo -- nunca se acepta uno propuesto desde aquí. Quien haya redactado contenido de cualquier sección no puede autoaprobarse.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {canApprove ? (
                <Button type="button" size="sm" className="self-start" onClick={() => void handleApproveExpediente()} disabled={approvingExpediente}>
                  <CheckCircle2 />
                  {approvingExpediente ? "Aprobando…" : "Aprobar expediente completo"}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede aprobar el expediente -- solo DECISION_ROLES (owner/admin/analyst).</p>
              )}

              {expedienteApprovalError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {expedienteApprovalError}
                </p>
              )}
              {expedienteApprovalResult && (
                <p role="status" className="text-xs font-medium text-green-600 dark:text-green-500">
                  Aprobado {formatDate(expedienteApprovalResult.decidedAt)} · estatus {expedienteApprovalResult.status}.
                </p>
              )}

              {canApprove && (
                <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                  <div className="flex flex-[1_1_260px] flex-col gap-1.5">
                    <Label htmlFor="cierre-seccion">Aprobación granular por sección (revisión incremental, no gatea "listo")</Label>
                    <select id="cierre-seccion" value={sectionKeyToApprove} onChange={(e) => setSectionKeyToApprove(e.target.value)} className={SELECT_NATIVO}>
                      {KNOWN_SECTION_KEYS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleApproveSection()} disabled={approvingSection}>
                    {approvingSection ? "Aprobando…" : "Aprobar sección"}
                  </Button>
                </div>
              )}
              {sectionApprovalError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {sectionApprovalError}
                </p>
              )}
              {sectionApprovalResult && (
                <p role="status" className="text-xs font-medium text-green-600 dark:text-green-500">
                  Sección "{sectionApprovalResult.scopeRef}" aprobada {formatDate(sectionApprovalResult.decidedAt)}.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="paquete">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Package className="h-4 w-4 text-muted-foreground" />
                Paquete final {latestPackage && <StatusPill status={latestPackage.status} />}
              </CardTitle>
              <CardDescription>
                El ensamblado recalcula el estado contra el expediente vivo cada vez -- "listo" solo si el checklist está en verde, hay una aprobación de expediente vigente y ningún documento requerido falta. La presentación y firma las realiza el usuario; el sistema no envía ofertas.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {latestPackage === null && <EstadoVacio mensaje="Todavía no se ha ensamblado ningún paquete para este expediente." />}

              {latestPackage && latestPackage.status === "draft" && latestPackage.draftReasons.length > 0 && (
                <div className={PANEL_ALERTA}>
                  <p className={`mb-1.5 text-[13px] font-semibold ${TEXTO_ALERTA}`}>Motivos por los que sigue en borrador:</p>
                  <ul className={`list-disc pl-5 text-xs ${TEXTO_ALERTA}`}>
                    {latestPackage.draftReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  {latestPackage.missing.length > 0 && <p className={`mt-1.5 text-xs ${TEXTO_ALERTA}`}>Faltan: {latestPackage.missing.join(", ")}.</p>}
                </div>
              )}

              {latestPackage && latestPackage.status === "ready" && (
                <p className="text-xs font-medium text-green-600 dark:text-green-500">
                  Generado {formatDate(latestPackage.generatedAt)}. {latestPackage.notice}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {canAssemble ? (
                  <Button type="button" size="sm" onClick={() => void handleAssemble()} disabled={assembling}>
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

              {assembleError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {assembleError}
                </p>
              )}
              {downloadError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {downloadError}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
