// Contrato post-adjudicación (Fase 15 pieza acotada) — cierra la primera
// porción del hallazgo ALTA de auditoría "Post-adjudicación completa
// (contratos, documentos, cobranza, inconformidades, autopsia, renovaciones)
// = 22 rutas sin UI": SOLO contratos + documentos del contrato aquí
// (contracts.ts + contractDocuments.ts, ver lib/contract-client.ts). El
// flujo central (documentos de bases -> propuesta técnica -> propuesta
// económica -> checklist -> aprobaciones -> paquete final) ya tiene pantalla
// propia (pages/Cierre.tsx); esta es la fase SIGUIENTE, para cuando la
// convocatoria ya se ganó -- se llega aquí desde ConvocatoriaDetalle.tsx
// cuando `tender.status === "won"`.
//
// Deliberadamente FUERA de esta pieza (alcance de otro agente en paralelo o
// de rondas futuras, ver README de este vertical): cobranza del contrato,
// inconformidades, autopsia y renovaciones -- esas rutas siguen sin cliente
// ni página, a propósito.
//
// Tres bloques independientes, mismo criterio que el resto del panel (nunca
// se inventa una relación de orden que el backend no exige):
//  1. Alta + metadatos administrativos del contrato (PATCH, sin historial).
//  2. Máquina de estados: transición con motivo obligatorio (+evidencia
//     opcional) e historial append-only completo. Las transiciones sensibles
//     (rescindir/penalizar/marcar en inconformidad/modificar) exigen
//     DECISION_ROLES en el servidor -- este cliente oculta esos botones a
//     quien el servidor rechazaría igual, nunca es la única barrera.
//  3. Documentos del contrato firmado: sube bytes reales (mismo
//     `fileToBase64`/límite que RequisitosConvocatoria.tsx), ve los campos
//     que el extractor determinista encontró (TODOS entran como
//     "sugerido") y confírmalos o corrígelos uno por uno -- ninguno se da
//     por válido sin esa confirmación explícita.
//
// Fase "sistema de diseño real" (contenido) — las tres secciones pasan a
// `Card`, los pills de estatus/campo a `Badge`, inputs y botones a
// `Input`/`Label`/`Button` de @atiende/ui, y la lista de documentos subidos a
// botones reales con estado seleccionado por tokens. Cero cambios de lógica.
import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Check, FileUp, Pencil } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, cn } from "@atiende/ui";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import {
  CONTRACT_DECISION_TRANSITIONS,
  CONTRACT_TRANSITIONS,
  addContractDocument,
  confirmContractExtractedField,
  createContract,
  fetchContract,
  fetchContractDocumentFields,
  fetchContractDocuments,
  fetchContractHistory,
  fileToBase64,
  MAX_UPLOAD_FILE_BYTES,
  transitionContract,
  updateContractMetadata,
} from "../lib/contract-client.ts";
import type { ContractDocumentRecord, ContractExtractedFieldRecord, ContractRecord, ContractStatus, ContractStatusHistoryRecord } from "../lib/contract-client.ts";
import { formatContractFieldKey, formatContractFieldStatus, formatContractStatus, formatDate } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que el resto del vertical (WRITE_ROLES de
// `@atiende/domain-licitaciones::roles.ts`) -- cosmético, oculta lo que el
// servidor rechazaría igual (`assertVerticalRole(c, WRITE_ROLES)` en
// `contracts.ts`/`contractDocuments.ts`).
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

// DECISION_ROLES EXACTO de `@atiende/domain-licitaciones::roles.ts` (más
// estricto que WRITE_ROLES: sin "writer"/"reviewer") -- oculta las
// transiciones sensibles a quien el servidor rechazaría igual
// (`assertVerticalRole(c, DECISION_ROLES)` en `contract/transition`).
const DECISION_ROLES = new Set(["owner", "admin", "analyst"]);

/** `<select>`/`<textarea>` siguen siendo nativos (el sistema no exporta un
 * primitivo propio): solo se restilan con los tokens reales. */
const CAMPO_NATIVO =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const CONTRACT_ALERT_STATES = new Set(["penalizado", "rescindido", "en_inconformidad", "cerrado"]);

function StatusBadge({ status }: { status: ContractStatus }) {
  const alert = CONTRACT_ALERT_STATES.has(status);
  return <Badge variant={alert ? "destructive" : "secondary"}>{formatContractStatus(status)}</Badge>;
}

export function ContratoPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [contract, setContract] = useState<ContractRecord | null>(null);
  const [history, setHistory] = useState<readonly ContractStatusHistoryRecord[]>([]);
  const [documents, setDocuments] = useState<readonly ContractDocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Metadatos administrativos (PATCH) -- inicializado desde `contract` cada
  // vez que se recarga, editado localmente hasta que se guarda.
  const [endDate, setEndDate] = useState("");
  const [contractNumber, setContractNumber] = useState("");
  const [hasRenewalOption, setHasRenewalOption] = useState(false);
  const [renewalOptionNotes, setRenewalOptionNotes] = useState("");
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataSaved, setMetadataSaved] = useState(false);

  // Transición de estado.
  const [toStatus, setToStatus] = useState<ContractStatus | "">("");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Documentos del contrato.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [documentLabel, setDocumentLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [fields, setFields] = useState<readonly ContractExtractedFieldRecord[] | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [confirmingFieldId, setConfirmingFieldId] = useState<string | null>(null);

  function applyContract(c: ContractRecord) {
    setContract(c);
    setEndDate(c.endDate ?? "");
    setContractNumber(c.contractNumber ?? "");
    setHasRenewalOption(c.hasRenewalOption);
    setRenewalOptionNotes(c.renewalOptionNotes ?? "");
  }

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const tenderData = await fetchTender(fetch, apiBaseUrl, token, propertyId, id);
      setTender(tenderData);
      const contractData = await fetchContract(fetch, apiBaseUrl, token, propertyId, id);
      if (contractData) {
        applyContract(contractData);
        const [historyData, documentsData] = await Promise.all([
          fetchContractHistory(fetch, apiBaseUrl, token, propertyId, id),
          fetchContractDocuments(fetch, apiBaseUrl, token, propertyId, id),
        ]);
        setHistory(historyData);
        setDocuments(documentsData);
      } else {
        setContract(null);
        setHistory([]);
        setDocuments([]);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar el contrato.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  useEffect(() => {
    if (!tenderId || !selectedDocumentId) {
      setFields(null);
      return;
    }
    let cancelado = false;
    setFieldsLoading(true);
    setFieldsError(null);
    fetchContractDocumentFields(fetch, apiBaseUrl, token, propertyId, tenderId, selectedDocumentId)
      .then((data) => {
        if (!cancelado) setFields(data);
      })
      .catch((err) => {
        if (!cancelado) setFieldsError(err instanceof Error ? err.message : "No se pudieron cargar los campos extraídos.");
      })
      .finally(() => {
        if (!cancelado) setFieldsLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, tenderId, selectedDocumentId]);

  async function handleCreateContract() {
    if (!tenderId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const c = await createContract(fetch, apiBaseUrl, token, propertyId, tenderId);
      applyContract(c);
      await load(tenderId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "No se pudo registrar el contrato.");
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId) return;
    setSavingMetadata(true);
    setMetadataError(null);
    setMetadataSaved(false);
    try {
      const updated = await updateContractMetadata(fetch, apiBaseUrl, token, propertyId, tenderId, {
        endDate: endDate.trim().length > 0 ? endDate : null,
        contractNumber: contractNumber.trim().length > 0 ? contractNumber.trim() : null,
        hasRenewalOption,
        renewalOptionNotes: renewalOptionNotes.trim().length > 0 ? renewalOptionNotes.trim() : null,
      });
      applyContract(updated);
      setMetadataSaved(true);
    } catch (err) {
      setMetadataError(err instanceof Error ? err.message : "No se pudo actualizar el contrato.");
    } finally {
      setSavingMetadata(false);
    }
  }

  async function handleTransition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId || !toStatus) return;
    if (reason.trim().length === 0) {
      setTransitionError("Escribe el motivo de la transición.");
      return;
    }
    setTransitioning(true);
    setTransitionError(null);
    try {
      const updated = await transitionContract(fetch, apiBaseUrl, token, propertyId, tenderId, {
        toStatus,
        reason: reason.trim(),
        evidenceRef: evidenceRef.trim().length > 0 ? evidenceRef.trim() : null,
      });
      applyContract(updated);
      setToStatus("");
      setReason("");
      setEvidenceRef("");
      const historyData = await fetchContractHistory(fetch, apiBaseUrl, token, propertyId, tenderId);
      setHistory(historyData);
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : "No se pudo aplicar la transición.");
    } finally {
      setTransitioning(false);
    }
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setPendingFile(file);
    if (file && documentLabel.trim().length === 0) setDocumentLabel(file.name);
  }

  async function handleUploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId || !pendingFile) {
      setUploadError("Selecciona el archivo del contrato firmado (PDF o texto).");
      return;
    }
    if (pendingFile.size > MAX_UPLOAD_FILE_BYTES) {
      setUploadError("Este archivo pesa más de 22MB -- no se enviará (límite del backend).");
      return;
    }
    if (documentLabel.trim().length === 0) {
      setUploadError("El documento necesita una etiqueta para identificarlo.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const contentBase64 = await fileToBase64(pendingFile);
      const result = await addContractDocument(fetch, apiBaseUrl, token, propertyId, tenderId, {
        documentLabel: documentLabel.trim(),
        contentBase64,
        mimeType: pendingFile.type || null,
        filename: pendingFile.name,
      });
      setPendingFile(null);
      setDocumentLabel("");
      const documentsData = await fetchContractDocuments(fetch, apiBaseUrl, token, propertyId, tenderId);
      setDocuments(documentsData);
      setSelectedDocumentId(result.document.id);
      setFields(result.fields);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "No se pudo subir el documento.");
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirmField(field: ContractExtractedFieldRecord, action: "confirm" | "correct") {
    if (!tenderId) return;
    const draft = (correctionDrafts[field.id] ?? "").trim();
    if (action === "correct" && draft.length === 0) return;
    const correctedValue = action === "correct" ? draft : null;
    setConfirmingFieldId(field.id);
    setFieldsError(null);
    try {
      const updated = await confirmContractExtractedField(fetch, apiBaseUrl, token, propertyId, tenderId, field.id, { action, correctedValue });
      setFields((prev) => (prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev));
      setCorrectionDrafts((prev) => {
        const next = { ...prev };
        delete next[field.id];
        return next;
      });
    } catch (err) {
      setFieldsError(err instanceof Error ? err.message : "No se pudo confirmar el campo.");
    } finally {
      setConfirmingFieldId(null);
    }
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando contrato…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  const canWrite = WRITE_ROLES.has(role);
  const canDecide = DECISION_ROLES.has(role);
  const allowedNextStates = contract ? (CONTRACT_TRANSITIONS[contract.status] ?? []) : [];

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Contrato</h1>
        <p className="text-[13px] text-muted-foreground">
          Contratos + documentos del contrato firmado -- post-adjudicación. Cobranza, inconformidades, autopsia y renovaciones no viven en esta pantalla todavía.
        </p>
      </div>

      {!contract ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <p className="text-[13px] text-foreground">Todavía no se ha registrado ningún contrato para esta convocatoria.</p>
            {canWrite ? (
              <div>
                <Button type="button" size="sm" onClick={() => void handleCreateContract()} disabled={creating}>
                  {creating ? "Registrando…" : "Registrar contrato"}
                </Button>
                {createError && (
                  <p role="alert" className="mt-2 text-[13px] text-destructive">
                    {createError}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede registrar el contrato.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0">
              <CardTitle className="text-base">Estatus</CardTitle>
              <StatusBadge status={contract.status} />
              <span className="text-[11px] text-muted-foreground">Actualizado {formatDate(contract.updatedAt)}</span>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void handleSaveMetadata(e)} className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="contrato-fin">Fecha de fin</Label>
                  <Input id="contrato-fin" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={!canWrite} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="contrato-numero">Número de contrato</Label>
                  <Input id="contrato-numero" value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} disabled={!canWrite} placeholder="Sin declarar" />
                </div>
                <label className="flex items-center gap-2 self-end text-[13px] text-foreground sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={hasRenewalOption}
                    onChange={(e) => setHasRenewalOption(e.target.checked)}
                    disabled={!canWrite}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  Tiene opción de renovación
                </label>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="contrato-notas">Notas de renovación</Label>
                  <textarea id="contrato-notas" value={renewalOptionNotes} onChange={(e) => setRenewalOptionNotes(e.target.value)} disabled={!canWrite} rows={2} className={CAMPO_NATIVO} />
                </div>
                {canWrite && (
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <Button type="submit" size="sm" disabled={savingMetadata}>
                      {savingMetadata ? "Guardando…" : "Guardar metadatos"}
                    </Button>
                    {metadataSaved && <span className="text-xs font-medium text-green-600 dark:text-green-500">Guardado.</span>}
                  </div>
                )}
                {metadataError && (
                  <p role="alert" className="text-[13px] text-destructive sm:col-span-2">
                    {metadataError}
                  </p>
                )}
                {!canWrite && <p className="text-xs text-muted-foreground sm:col-span-2">Tu rol ({role}) no puede editar los metadatos del contrato.</p>}
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transición de estado</CardTitle>
              <CardDescription>Motivo obligatorio e historial append-only — el servidor revalida cada transición.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {allowedNextStates.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">"{formatContractStatus(contract.status)}" es un estado terminal -- no hay transiciones disponibles.</p>
              ) : (
                <form onSubmit={(e) => void handleTransition(e)} className="flex max-w-[520px] flex-col gap-2.5">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="contrato-nuevo-estado">Nuevo estado</Label>
                    <select id="contrato-nuevo-estado" value={toStatus} onChange={(e) => setToStatus(e.target.value as ContractStatus)} className={`${CAMPO_NATIVO} h-11`}>
                      <option value="">Selecciona…</option>
                      {allowedNextStates.map((s) => {
                        const requiresDecision = CONTRACT_DECISION_TRANSITIONS.includes(s);
                        const disabled = requiresDecision && !canDecide;
                        return (
                          <option key={s} value={s} disabled={disabled}>
                            {formatContractStatus(s)}
                            {requiresDecision ? " (requiere rol de decisión)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="contrato-motivo">Motivo (obligatorio)</Label>
                    <textarea id="contrato-motivo" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={CAMPO_NATIVO} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="contrato-evidencia">Referencia de evidencia (opcional)</Label>
                    <Input id="contrato-evidencia" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="Folio, acta, oficio…" />
                  </div>
                  {transitionError && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {transitionError}
                    </p>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    className="self-start"
                    disabled={transitioning || !toStatus || !canWrite || (toStatus.length > 0 && CONTRACT_DECISION_TRANSITIONS.includes(toStatus as ContractStatus) && !canDecide)}
                  >
                    {transitioning ? "Aplicando…" : "Aplicar transición"}
                  </Button>
                  {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede transicionar el contrato.</p>}
                </form>
              )}

              <div>
                <h3 className="mb-2 text-[13px] font-semibold text-foreground">Historial ({history.length})</h3>
                {history.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Sin historial todavía.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {history
                      .slice()
                      .reverse()
                      .map((h) => (
                        <div key={h.id} className="rounded-xl border border-border p-2 text-xs">
                          <div className="flex justify-between gap-2">
                            <strong className="text-foreground">
                              {h.fromStatus ? `${formatContractStatus(h.fromStatus)} → ` : ""}
                              {formatContractStatus(h.toStatus)}
                            </strong>
                            <span className="text-muted-foreground">{formatDate(h.createdAt)}</span>
                          </div>
                          <p className="mt-1 text-foreground">{h.reason}</p>
                          {h.evidenceRef && <p className="mt-0.5 text-muted-foreground">Evidencia: {h.evidenceRef}</p>}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documentos del contrato</CardTitle>
              <CardDescription>Todo campo extraído entra como "sugerido": nada se da por válido sin una confirmación explícita.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {canWrite ? (
                <form onSubmit={(e) => void handleUploadDocument(e)} className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="contrato-archivo">Contrato firmado (PDF o .txt)</Label>
                    <Input
                      id="contrato-archivo"
                      type="file"
                      accept=".pdf,.txt,.md,application/pdf,text/plain"
                      onChange={handleFileSelected}
                      className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer file:rounded-full file:bg-muted file:px-3 file:py-1 file:text-xs file:font-semibold"
                    />
                  </div>
                  {pendingFile && (
                    <Input value={documentLabel} onChange={(e) => setDocumentLabel(e.target.value)} placeholder="Etiqueta del documento" aria-label="Etiqueta del documento" />
                  )}
                  {uploadError && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {uploadError}
                    </p>
                  )}
                  <Button type="submit" size="sm" className="self-start" disabled={uploading || !pendingFile}>
                    <FileUp />
                    {uploading ? "Subiendo…" : "Subir y extraer campos"}
                  </Button>
                </form>
              ) : (
                <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede subir documentos del contrato.</p>
              )}

              <div>
                <h3 className="mb-2 text-[13px] font-semibold text-foreground">Documentos subidos ({documents.length})</h3>
                {documents.length === 0 ? (
                  <EstadoVacio mensaje="Todavía no se ha subido ningún documento del contrato." />
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {documents.map((doc) => (
                      <button
                        key={doc.id}
                        type="button"
                        onClick={() => setSelectedDocumentId(doc.id)}
                        aria-pressed={doc.id === selectedDocumentId}
                        className={cn(
                          "flex justify-between gap-2 rounded-xl border p-2.5 text-left text-[13px] transition-colors",
                          doc.id === selectedDocumentId ? "border-primary bg-muted" : "border-border bg-card hover:bg-muted/50",
                        )}
                      >
                        <span className="text-foreground">
                          {doc.documentLabel} <span className="text-muted-foreground">· {doc.pageCount} pág.</span>
                        </span>
                        <span className="text-[11px] text-muted-foreground">{formatDate(doc.createdAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selectedDocumentId && (
                <div>
                  <h3 className="mb-2 text-[13px] font-semibold text-foreground">Campos extraídos</h3>
                  {fieldsLoading && <EstadoCargando lineas={2} etiqueta="Cargando campos extraídos…" />}
                  {fieldsError && (
                    <p role="alert" className="text-[13px] text-destructive">
                      {fieldsError}
                    </p>
                  )}
                  {fields && fields.length === 0 && <EstadoVacio mensaje="El extractor no encontró ningún campo reconocible en este documento." />}
                  {fields && fields.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {fields.map((field) => (
                        <div key={field.id} className="rounded-xl border border-border p-2.5 text-[13px]">
                          <div className="flex flex-wrap justify-between gap-2">
                            <strong className="text-foreground">{formatContractFieldKey(field.fieldKey)}</strong>
                            <Badge
                              variant={field.status === "sugerido" ? "outline" : "default"}
                              className={field.status === "sugerido" ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : undefined}
                            >
                              {formatContractFieldStatus(field.status)}
                            </Badge>
                          </div>
                          <p className="mt-1.5 text-foreground">{field.extractedValue}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {field.sourcePage ? `pág. ${field.sourcePage}` : "página no determinada"}
                            {field.sourceClause ? ` · ${field.sourceClause}` : ""} · confianza {Math.round(field.confidence * 100)}%
                          </p>

                          {field.status === "sugerido" && canWrite ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Button type="button" variant="outline" size="sm" onClick={() => void handleConfirmField(field, "confirm")} disabled={confirmingFieldId === field.id}>
                                <Check />
                                Confirmar valor
                              </Button>
                              <Input
                                value={correctionDrafts[field.id] ?? ""}
                                onChange={(e) => setCorrectionDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
                                placeholder="Valor corregido"
                                aria-label={`Valor corregido de ${formatContractFieldKey(field.fieldKey)}`}
                                className="h-9 min-w-[140px] flex-1"
                              />
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void handleConfirmField(field, "correct")}
                                disabled={confirmingFieldId === field.id || (correctionDrafts[field.id] ?? "").trim().length === 0}
                              >
                                <Pencil />
                                {confirmingFieldId === field.id ? "Guardando…" : "Corregir"}
                              </Button>
                            </div>
                          ) : field.status !== "sugerido" ? (
                            <p className="mt-1.5 text-[11px] text-muted-foreground">
                              {field.status === "corregido" ? `Corregido a "${field.confirmedValue}"` : "Confirmado tal cual"} por {field.confirmedBy} el {field.confirmedAt ? formatDate(field.confirmedAt) : "—"}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
