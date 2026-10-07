// Carga de documentos de bases + requisitos extraídos (Fase 11 pieza acotada) —
// cierra el prerrequisito compartido que checklist-client.ts/README de este
// vertical documentaban como pendiente: "no hay pantalla de carga de
// documentos, aunque el backend ya extrae texto de PDF nativo"
// (`technicalProposal.ts::GET .../requirements` + `POST .../requirements/extract`,
// `@atiende/domain-licitaciones::extractDocumentText`, motor real `pdfjs-dist`).
//
// Alcance DELIBERADAMENTE acotado a esto: subir uno o más PDF (o texto plano)
// de las bases de una convocatoria, ver los requisitos que el extractor sacó
// de su texto real, y los documentos que se excluyeron por no tener texto
// extraíble (nunca se inventa contenido, REQ-166). La generación de la
// propuesta técnica/económica, el mapeo de cumplimiento
// (`PUT .../requirement-mappings/:topicKey`), aprobaciones y el ZIP de cierre
// quedan FUERA de esta pieza -- son alcance de rondas futuras (ver README de
// este vertical).
//
// Fase "sistema de diseño real" (contenido) — el formulario de carga pasa a
// `Card` + `Input`/`Label`/`Button`, la tabla de requisitos a `Table`, los
// pills de estatus a `Badge` y los estados de carga/error/vacío a
// `EstadoCargando`/`EstadoError`/`EstadoVacio`. Cero cambios de lógica.
// paridad3 (L-P3-05/06): pestañas Requisitos / Documentos / Conflictos. Documentos = bóveda real (subir, estado de extracción,
// versión nueva, re-extraer sin volver a subir); Conflictos = persistidos, con Resolver (notas obligatorias); la tabla de
// requisitos edita responsable, estado, asignado y causa de desechamiento (REQ-101) contra la API, filtra por causa de
// desechamiento, muestra los retirados y abre el visor de la cita (página y extracto).
import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileUp, X } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import {
  extractRequirements,
  fetchRequirementAssignees,
  fetchRequirementConflicts,
  fetchRequirementMatrix,
  fileToBase64,
  MAX_UPLOAD_FILE_BYTES,
  updateRequirement,
} from "../lib/requirements-client.ts";
import { fetchTenderDocuments } from "../lib/documents-client.ts";
import type { TenderDocument } from "../lib/documents-client.ts";
import { DocumentosBases } from "../components/DocumentosBases.tsx";
import { ConflictosRequisitos } from "../components/ConflictosRequisitos.tsx";
import { VisorCita } from "../components/VisorCita.tsx";
import { REQUISITO_STATUS_TONES } from "../lib/status-tones.ts";
import type { ExtractDocumentInput, PersistedRequirementConflict, RequirementAssignee, RequirementMatrixItem, RequirementPatch, SkippedDocument } from "../lib/requirements-client.ts";
import { formatDate, formatObligatoriedad, formatRequirementKind, formatRequirementStatus } from "../lib/format.ts";
import { AvisoIa } from "../components/AvisoIa.tsx";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que Convocatorias.tsx/ConvocatoriaDetalle.tsx (WRITE_ROLES
// de `@atiende/domain-licitaciones::roles.ts`) -- cosmético, para ocultar el
// formulario de carga a quien el servidor rechazaría igual (`assertVerticalRole`
// en `technicalProposal.ts`); el enforcement real es siempre server-side.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

function todayLocalDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface PendingFile {
  readonly key: string;
  readonly file: File;
  documentLabel: string;
  publishedAt: string; // yyyy-mm-dd, se convierte a ISO al enviar
  readonly tooLarge: boolean;
}

function RequirementStatusBadge({ status }: { status: string }) {
  return (
    <StatusBadge tone={statusTone(REQUISITO_STATUS_TONES, status)} className="whitespace-nowrap">
      {formatRequirementStatus(status)}
    </StatusBadge>
  );
}

export function RequisitosConvocatoriaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [items, setItems] = useState<readonly RequirementMatrixItem[] | null>(null);
  const [migrated, setMigrated] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [soloDesechamiento, setSoloDesechamiento] = useState(false);
  const [assignees, setAssignees] = useState<readonly RequirementAssignee[]>([]);
  const [conflicts, setConflicts] = useState<readonly PersistedRequirementConflict[]>([]);
  const [conflictsDisponible, setConflictsDisponible] = useState(false);
  const [documents, setDocuments] = useState<readonly TenderDocument[]>([]);
  const [documentsDisponible, setDocumentsDisponible] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [visor, setVisor] = useState<{ documentId: string; page: number; clause: string | null; extracto: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pendingFiles, setPendingFiles] = useState<readonly PendingFile[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [lastSkipped, setLastSkipped] = useState<readonly SkippedDocument[]>([]);

  async function load(id: string, retired: boolean = includeRetired) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, matrix] = await Promise.all([fetchTender(fetch, apiBaseUrl, token, propertyId, id), fetchRequirementMatrix(fetch, apiBaseUrl, token, propertyId, id, retired)]);
      setTender(tenderData);
      setItems(matrix.items);
      setMigrated(matrix.migrated);
      // Lo nuevo (bóveda, conflictos, asignables) nunca tumba la pantalla: una base sin la migración 037 los deja "no disponibles".
      const [docs, confs, people] = await Promise.allSettled([
        fetchTenderDocuments(fetch, apiBaseUrl, token, propertyId, id),
        fetchRequirementConflicts(fetch, apiBaseUrl, token, propertyId, id),
        fetchRequirementAssignees(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setDocuments(docs.status === "fulfilled" ? docs.value.documents : []);
      setDocumentsDisponible(docs.status === "fulfilled" && docs.value.disponible);
      setConflicts(confs.status === "fulfilled" ? confs.value.conflicts : []);
      setConflictsDisponible(confs.status === "fulfilled" && confs.value.disponible);
      setAssignees(people.status === "fulfilled" ? people.value : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
    }
  }

  async function handleEdit(item: RequirementMatrixItem, patch: RequirementPatch) {
    if (!tenderId) return;
    setRowError(null);
    setRowBusyId(item.id);
    try {
      const updated = await updateRequirement(fetch, apiBaseUrl, token, propertyId, tenderId, item.id, patch);
      setItems((prev) => (prev ? prev.map((x) => (x.id === item.id ? { ...x, ...updated } : x)) : prev));
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setRowBusyId(null);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
    // eslint: mismo criterio que el resto del panel (este proyecto no tiene
    // eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId, tenderId]);

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const nextFiles: PendingFile[] = Array.from(files).map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      documentLabel: file.name,
      publishedAt: todayLocalDate(),
      tooLarge: file.size > MAX_UPLOAD_FILE_BYTES,
    }));
    setPendingFiles((prev) => [...prev, ...nextFiles]);
    // Permite volver a elegir el mismo archivo dos veces seguidas (el evento
    // "change" de <input type="file"> no dispara si el value no cambia).
    event.target.value = "";
  }

  function removePendingFile(key: string) {
    setPendingFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function updatePendingFile(key: string, patch: Partial<Pick<PendingFile, "documentLabel" | "publishedAt">>) {
    setPendingFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  async function handleExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId) return;
    setExtractError(null);
    setLastSkipped([]);

    const uploadable = pendingFiles.filter((f) => !f.tooLarge);
    if (uploadable.length === 0) {
      setExtractError("Selecciona al menos un archivo de bases (PDF o texto) de menos de 22MB.");
      return;
    }
    const withoutLabel = uploadable.find((f) => f.documentLabel.trim().length === 0);
    if (withoutLabel) {
      setExtractError("Todos los documentos necesitan una etiqueta (nombre) para identificarlos.");
      return;
    }

    setExtracting(true);
    try {
      const documents: ExtractDocumentInput[] = await Promise.all(
        uploadable.map(async (f) => ({
          documentId: crypto.randomUUID(),
          documentLabel: f.documentLabel.trim(),
          publishedAt: new Date(`${f.publishedAt}T00:00:00`).toISOString(),
          contentBase64: await fileToBase64(f.file),
          mimeType: f.file.type || null,
          filename: f.file.name,
        })),
      );
      const result = await extractRequirements(fetch, apiBaseUrl, token, propertyId, tenderId, documents);
      setLastSkipped(result.skippedDocuments);
      setPendingFiles([]);
      await load(tenderId);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "No se pudo extraer los requisitos.");
    } finally {
      setExtracting(false);
    }
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando requisitos…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  const canUpload = WRITE_ROLES.has(role);
  // L-33: solo se declara IA cuando la API devolvió requisitos extraídos por el modelo; los extraídos por reglas no la llevan.
  const extraidosConIa = (items ?? []).filter((item) => item.extractedBy === "llm").length;
  const abiertos = conflicts.filter((c) => c.status === "abierto").length;
  const visibles = (items ?? []).filter((i) => (soloDesechamiento ? i.disqualifying === true : true));
  const activos = (items ?? []).filter((i) => !i.retiredAt).length;
  const roleOptions = (current: string) => [...new Set(["licitador", "legal", "finanzas", "tecnico", "administrativo", current])];
  const editable = (item: RequirementMatrixItem) => canUpload && !item.retiredAt;

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title}
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">Requisitos de las bases</h1>
        <p className="text-sm text-muted-foreground">
          Sube el PDF (o texto plano) de las bases de esta convocatoria para extraer sus requisitos automáticamente. Solo lectura del resto del expediente: la propuesta técnica/económica y el cierre no viven en esta pantalla todavía.
        </p>
      </div>

      {canUpload && !documentsDisponible ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cargar bases</CardTitle>
            <CardDescription>PDF nativo o texto plano — un PDF escaneado sin capa de texto se excluye y se reporta, nunca se inventa contenido.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleExtract} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="requisitos-archivos">Documentos de bases (PDF o .txt)</Label>
                <Input
                  id="requisitos-archivos"
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain"
                  multiple
                  onChange={handleFilesSelected}
                  className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer file:rounded-full file:bg-muted file:px-3 file:py-1 file:text-xs file:font-semibold"
                />
              </div>

              {pendingFiles.length > 0 && (
                <div className="flex flex-col gap-2">
                  {pendingFiles.map((f) => (
                    <div key={f.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2">
                      <span className="min-w-[140px] text-xs text-muted-foreground">
                        {f.file.name} · {(f.file.size / 1024 / 1024).toFixed(1)}MB
                      </span>
                      <Input
                        value={f.documentLabel}
                        onChange={(e) => updatePendingFile(f.key, { documentLabel: e.target.value })}
                        placeholder="Etiqueta del documento"
                        aria-label={`Etiqueta de ${f.file.name}`}
                        className="h-9 min-w-[160px] flex-1"
                      />
                      <Input
                        type="date"
                        value={f.publishedAt}
                        onChange={(e) => updatePendingFile(f.key, { publishedAt: e.target.value })}
                        aria-label={`Fecha de publicación de ${f.file.name}`}
                        className="h-9 w-auto"
                      />
                      <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removePendingFile(f.key)}>
                        <X />
                        Quitar
                      </Button>
                      {f.tooLarge && (
                        <p role="alert" className="w-full text-xs text-destructive">
                          Este archivo pesa más de 22MB -- no se enviará (límite del backend).
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {extractError && (
                <p role="alert" className="text-sm text-destructive">
                  {extractError}
                </p>
              )}

              <Button type="submit" size="sm" className="self-start" disabled={extracting || pendingFiles.length === 0}>
                <FileUp />
                {extracting ? "Extrayendo…" : "Extraer requisitos"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {!canUpload && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede subir documentos de bases ni editar requisitos -- solo lectura.</p>}

      {lastSkipped.length > 0 && (
        <Callout tone="warning" titulo={`${lastSkipped.length} documento(s) no produjeron texto extraíble y se excluyeron de esta extracción:`}>
          <ul className="mt-1.5 list-disc pl-5 text-xs">
            {lastSkipped.map((s) => (
              <li key={s.documentId}>
                "{s.documentLabel}" -- {s.status === "requires_ocr" ? "PDF escaneado sin capa de texto (no hay OCR de imagen disponible)" : "formato no soportado o archivo corrupto"}
                {s.detail ? `: ${s.detail}` : ""}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {extraidosConIa > 0 && (
        <AvisoIa proposito={`${extraidosConIa === 1 ? "1 requisito fue extraído" : `${extraidosConIa} requisitos fueron extraídos`} de las bases con inteligencia artificial (columna Origen: LLM); el resto se extrajo con reglas.`} />
      )}

      <Tabs defaultValue="requisitos" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="requisitos">Requisitos ({activos})</TabsTrigger>
          <TabsTrigger value="documentos">Documentos ({documents.length})</TabsTrigger>
          <TabsTrigger value="conflictos">Conflictos ({abiertos})</TabsTrigger>
        </TabsList>

        <TabsContent value="requisitos" className="flex flex-col gap-4">
          {abiertos > 0 && (
            <Callout tone="warning" titulo={`${abiertos} conflicto(s) entre documentos sin resolver`}>
              Mientras estén abiertos, el checklist del expediente queda en rojo. Resuélvelos en la pestaña Conflictos.
            </Callout>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Requisitos extraídos ({activos})</CardTitle>
              <CardDescription>
                {migrated ? "Edita responsable, estado, asignado y causa de desechamiento: una re-extracción los conserva. Lo que desaparece de las bases queda retirado, nunca se borra." : "Esta base aún no tiene la migración 037: la edición de asignado y causa de desechamiento no está disponible."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {migrated && <Checkbox label="Solo causa de desechamiento" checked={soloDesechamiento} onChange={(e) => setSoloDesechamiento(e.target.checked)} />}
                {migrated && (
                  <Checkbox
                    label="Ver retirados"
                    checked={includeRetired}
                    onChange={(e) => {
                      setIncludeRetired(e.target.checked);
                      if (tenderId) void load(tenderId, e.target.checked);
                    }}
                  />
                )}
              </div>
              {rowError && (
                <p role="alert" className="text-sm text-destructive">
                  {rowError}
                </p>
              )}
              {visor && tenderId && <VisorCita apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} tenderId={tenderId} documentId={visor.documentId} page={visor.page} clause={visor.clause} extracto={visor.extracto} onClose={() => setVisor(null)} />}
              {items && visibles.length === 0 && <EstadoVacio mensaje={soloDesechamiento ? "Ningún requisito está marcado como causa de desechamiento." : "Todavía no hay requisitos extraídos para esta convocatoria -- sube un documento de bases."} />}
              {items && items.length > 0 && (
                <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`} className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-foreground no-underline hover:underline">
                  Generar propuesta técnica y mapear requisitos →
                </Link>
              )}
              {items && visibles.length > 0 && (
                <DataTable
                  etiqueta="Requisitos extraídos"
                  obtenerId={(item) => item.id}
                  filas={visibles}
                  paginacion={false}
                  atributosFila={(item) => ({ "data-requisito": item.id })}
                  columnas={[
                    {
                      id: "requisito",
                      encabezado: "Requisito",
                      principal: true,
                      className: "max-w-80",
                      celda: (item) => (
                        <>
                          <p className={item.retiredAt ? "font-normal text-muted-foreground line-through" : "font-normal text-foreground"}>{item.text}</p>
                          {item.requiredEvidence.length > 0 && <p className="mt-1 text-xs font-normal text-muted-foreground">Evidencia requerida: {item.requiredEvidence.join(", ")}</p>}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.disqualifying && <StatusBadge tone="danger" dot={false}>Causa de desechamiento</StatusBadge>}
                            {item.retiredAt && <StatusBadge tone="neutral" dot={false}>Retirado{item.retiredInVersion ? ` (v${item.retiredInVersion})` : ""}</StatusBadge>}
                          </div>
                        </>
                      ),
                    },
                    { id: "tipo", encabezado: "Tipo", celda: (item) => <span className="text-muted-foreground">{formatRequirementKind(item.requirementKind)}</span> },
                    { id: "obligatoriedad", encabezado: "Obligatoriedad", celda: (item) => <span className="text-muted-foreground">{formatObligatoriedad(item.obligatoriedad)}</span> },
                    {
                      id: "estatus",
                      encabezado: "Estatus",
                      celda: (item) =>
                        editable(item) && item.status !== "bloqueado" ? (
                          <NativeSelect aria-label={`Estatus de: ${item.text.slice(0, 40)}`} value={item.status} disabled={rowBusyId === item.id} onChange={(e) => void handleEdit(item, { status: e.target.value as RequirementPatch["status"] })} className="h-9 min-w-[130px]">
                            {(["pendiente", "en_progreso", "cumplido", "no_evaluable"] as const).map((st) => (
                              <option key={st} value={st}>
                                {formatRequirementStatus(st)}
                              </option>
                            ))}
                          </NativeSelect>
                        ) : (
                          <RequirementStatusBadge status={item.status} />
                        ),
                    },
                    {
                      id: "responsable",
                      encabezado: "Responsable",
                      celda: (item) =>
                        editable(item) ? (
                          <div className="flex min-w-[140px] flex-col gap-1.5">
                            <NativeSelect aria-label={`Rol responsable de: ${item.text.slice(0, 40)}`} value={item.responsibleRole} disabled={rowBusyId === item.id} onChange={(e) => void handleEdit(item, { responsibleRole: e.target.value })} className="h-9">
                              {roleOptions(item.responsibleRole).map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </NativeSelect>
                            {migrated && assignees.length > 0 && (
                              <NativeSelect aria-label={`Persona asignada a: ${item.text.slice(0, 40)}`} value={item.assignedTo ?? ""} disabled={rowBusyId === item.id} onChange={(e) => void handleEdit(item, { assignedTo: e.target.value === "" ? null : e.target.value })} className="h-9">
                                <option value="">Sin asignar</option>
                                {assignees.map((a) => (
                                  <option key={a.userId} value={a.userId}>
                                    {a.nombre}
                                  </option>
                                ))}
                              </NativeSelect>
                            )}
                            {migrated && <Checkbox label="Causa de desechamiento" checked={item.disqualifying === true} disabled={rowBusyId === item.id} onChange={(e) => void handleEdit(item, { disqualifying: e.target.checked })} />}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {item.responsibleRole}
                            {item.assignedTo ? ` · ${assignees.find((a) => a.userId === item.assignedTo)?.nombre ?? "asignado"}` : ""}
                          </span>
                        ),
                    },
                    { id: "fecha", encabezado: "Fecha límite", celda: (item) => <span className="text-muted-foreground">{item.deadline ? formatDate(item.deadline) : "—"}</span> },
                    {
                      id: "origen",
                      encabezado: "Origen",
                      celda: (item) => (
                        <span className="text-xs text-muted-foreground">
                          {item.page && item.documentId ? (
                            <Button type="button" size="sm" variant="ghost" className="h-auto px-1 py-0 text-xs underline" onClick={() => setVisor({ documentId: item.documentId!, page: item.page!, clause: item.clause, extracto: item.text })}>
                              Ver cita · pág. {item.page}
                            </Button>
                          ) : item.page ? (
                            `pág. ${item.page}`
                          ) : (
                            "—"
                          )}
                          {item.clause ? ` · ${item.clause}` : ""}
                          <br />
                          {item.extractedBy === "llm" ? "LLM" : "reglas"}
                          {typeof item.confidence === "number" ? ` (${Math.round(item.confidence * 100)}%)` : ""}
                        </span>
                      ),
                    },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documentos">
          <DocumentosBases
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            tenderId={tenderId}
            canWrite={canUpload}
            disponible={documentsDisponible}
            documents={documents}
            onChanged={() => load(tenderId)}
            onSkipped={setLastSkipped}
          />
        </TabsContent>

        <TabsContent value="conflictos">
          <ConflictosRequisitos apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} tenderId={tenderId} canWrite={canUpload} disponible={conflictsDisponible} conflicts={conflicts} onResolved={() => load(tenderId)} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
