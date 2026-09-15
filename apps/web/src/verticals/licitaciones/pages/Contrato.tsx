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
import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
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

const sectionCardStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, fontFamily: "inherit" };
const primaryButtonStyle = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 };

const CONTRACT_ALERT_STATES = new Set(["penalizado", "rescindido", "en_inconformidad", "cerrado"]);

function StatusBadge({ status }: { status: ContractStatus }) {
  const alert = CONTRACT_ALERT_STATES.has(status);
  return (
    <span
      style={{
        fontSize: 12,
        padding: "3px 10px",
        borderRadius: 999,
        background: alert ? "#fee2e2" : "#dbeafe",
        color: alert ? "#991b1b" : "#1e40af",
        fontWeight: 600,
      }}
    >
      {formatContractStatus(status)}
    </span>
  );
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

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (loadError) return <p role="alert" style={{ color: "#b91c1c" }}>{loadError}</p>;
  if (!tender) return null;

  const canWrite = WRITE_ROLES.has(role);
  const canDecide = DECISION_ROLES.has(role);
  const allowedNextStates = contract ? (CONTRACT_TRANSITIONS[contract.status] ?? []) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title}
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Contrato</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Contratos + documentos del contrato firmado -- post-adjudicación. Cobranza, inconformidades, autopsia y renovaciones no viven en esta pantalla todavía.
        </p>
      </div>

      {!contract ? (
        <div style={sectionCardStyle}>
          <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>Todavía no se ha registrado ningún contrato para esta convocatoria.</p>
          {canWrite ? (
            <div>
              <button type="button" onClick={() => void handleCreateContract()} disabled={creating} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
                {creating ? "Registrando…" : "Registrar contrato"}
              </button>
              {createError && (
                <p role="alert" style={{ color: "#b91c1c", margin: "8px 0 0", fontSize: 13 }}>
                  {createError}
                </p>
              )}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede registrar el contrato.</p>
          )}
        </div>
      ) : (
        <>
          <section style={sectionCardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>Estatus</h2>
              <StatusBadge status={contract.status} />
              <span style={{ fontSize: 11, color: "#9ca3af" }}>Actualizado {formatDate(contract.updatedAt)}</span>
            </div>

            <form onSubmit={(e) => void handleSaveMetadata(e)} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Fecha de fin
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={!canWrite} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Número de contrato
                <input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} disabled={!canWrite} placeholder="Sin declarar" style={inputStyle} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, alignSelf: "end" }}>
                <input type="checkbox" checked={hasRenewalOption} onChange={(e) => setHasRenewalOption(e.target.checked)} disabled={!canWrite} />
                Tiene opción de renovación
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>
                Notas de renovación
                <textarea value={renewalOptionNotes} onChange={(e) => setRenewalOptionNotes(e.target.value)} disabled={!canWrite} rows={2} style={inputStyle} />
              </label>
              {canWrite && (
                <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
                  <button type="submit" disabled={savingMetadata} style={primaryButtonStyle}>
                    {savingMetadata ? "Guardando…" : "Guardar metadatos"}
                  </button>
                  {metadataSaved && <span style={{ fontSize: 12, color: "#166534" }}>Guardado.</span>}
                </div>
              )}
              {metadataError && (
                <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13, gridColumn: "1 / -1" }}>
                  {metadataError}
                </p>
              )}
              {!canWrite && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0, gridColumn: "1 / -1" }}>Tu rol ({role}) no puede editar los metadatos del contrato.</p>}
            </form>
          </section>

          <section style={sectionCardStyle}>
            <h2 style={{ fontSize: 15, margin: 0 }}>Transición de estado</h2>
            {allowedNextStates.length === 0 ? (
              <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>"{formatContractStatus(contract.status)}" es un estado terminal -- no hay transiciones disponibles.</p>
            ) : (
              <form onSubmit={(e) => void handleTransition(e)} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 520 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Nuevo estado
                  <select value={toStatus} onChange={(e) => setToStatus(e.target.value as ContractStatus)} style={inputStyle}>
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
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Motivo (obligatorio)
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={inputStyle} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Referencia de evidencia (opcional)
                  <input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="Folio, acta, oficio…" style={inputStyle} />
                </label>
                {transitionError && (
                  <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                    {transitionError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={transitioning || !toStatus || !canWrite || (toStatus.length > 0 && CONTRACT_DECISION_TRANSITIONS.includes(toStatus as ContractStatus) && !canDecide)}
                  style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}
                >
                  {transitioning ? "Aplicando…" : "Aplicar transición"}
                </button>
                {!canWrite && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede transicionar el contrato.</p>}
              </form>
            )}

            <div>
              <h3 style={{ fontSize: 13, margin: "4px 0 8px", color: "#374151" }}>Historial ({history.length})</h3>
              {history.length === 0 ? (
                <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin historial todavía.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {history
                    .slice()
                    .reverse()
                    .map((h) => (
                      <div key={h.id} style={{ border: "1px solid #f3f4f6", borderRadius: 8, padding: 8, fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <strong>
                            {h.fromStatus ? `${formatContractStatus(h.fromStatus)} → ` : ""}
                            {formatContractStatus(h.toStatus)}
                          </strong>
                          <span style={{ color: "#9ca3af" }}>{formatDate(h.createdAt)}</span>
                        </div>
                        <p style={{ margin: "4px 0 0", color: "#374151" }}>{h.reason}</p>
                        {h.evidenceRef && <p style={{ margin: "2px 0 0", color: "#9ca3af" }}>Evidencia: {h.evidenceRef}</p>}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </section>

          <section style={sectionCardStyle}>
            <h2 style={{ fontSize: 15, margin: 0 }}>Documentos del contrato</h2>

            {canWrite ? (
              <form onSubmit={(e) => void handleUploadDocument(e)} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
                  Contrato firmado (PDF o .txt)
                  <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" onChange={handleFileSelected} style={{ fontSize: 13 }} />
                </label>
                {pendingFile && (
                  <input value={documentLabel} onChange={(e) => setDocumentLabel(e.target.value)} placeholder="Etiqueta del documento" style={inputStyle} />
                )}
                {uploadError && (
                  <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                    {uploadError}
                  </p>
                )}
                <button type="submit" disabled={uploading || !pendingFile} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
                  {uploading ? "Subiendo…" : "Subir y extraer campos"}
                </button>
              </form>
            ) : (
              <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede subir documentos del contrato.</p>
            )}

            <div>
              <h3 style={{ fontSize: 13, margin: "4px 0 8px", color: "#374151" }}>Documentos subidos ({documents.length})</h3>
              {documents.length === 0 ? (
                <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no se ha subido ningún documento del contrato.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {documents.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => setSelectedDocumentId(doc.id)}
                      style={{
                        textAlign: "left",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        border: doc.id === selectedDocumentId ? "1px solid #111827" : "1px solid #e5e7eb",
                        background: doc.id === selectedDocumentId ? "#f9fafb" : "#fff",
                        borderRadius: 8,
                        padding: 10,
                        fontSize: 13,
                        cursor: "pointer",
                      }}
                    >
                      <span>
                        {doc.documentLabel} <span style={{ color: "#9ca3af" }}>· {doc.pageCount} pág.</span>
                      </span>
                      <span style={{ color: "#9ca3af", fontSize: 11 }}>{formatDate(doc.createdAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedDocumentId && (
              <div>
                <h3 style={{ fontSize: 13, margin: "4px 0 8px", color: "#374151" }}>Campos extraídos</h3>
                {fieldsLoading && <p style={{ fontSize: 13, color: "#6b7280" }}>Cargando…</p>}
                {fieldsError && (
                  <p role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>
                    {fieldsError}
                  </p>
                )}
                {fields && fields.length === 0 && <p style={{ fontSize: 13, color: "#6b7280" }}>El extractor no encontró ningún campo reconocible en este documento.</p>}
                {fields && fields.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {fields.map((field) => (
                      <div key={field.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, fontSize: 13 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                          <strong>{formatContractFieldKey(field.fieldKey)}</strong>
                          <span
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: field.status === "sugerido" ? "#fef9c3" : "#dcfce7",
                              color: field.status === "sugerido" ? "#854d0e" : "#166534",
                            }}
                          >
                            {formatContractFieldStatus(field.status)}
                          </span>
                        </div>
                        <p style={{ margin: "6px 0 0", color: "#374151" }}>{field.extractedValue}</p>
                        <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>
                          {field.sourcePage ? `pág. ${field.sourcePage}` : "página no determinada"}
                          {field.sourceClause ? ` · ${field.sourceClause}` : ""} · confianza {Math.round(field.confidence * 100)}%
                        </p>

                        {field.status === "sugerido" && canWrite ? (
                          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => void handleConfirmField(field, "confirm")}
                              disabled={confirmingFieldId === field.id}
                              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #166534", background: "#fff", color: "#166534", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              Confirmar valor
                            </button>
                            <input
                              value={correctionDrafts[field.id] ?? ""}
                              onChange={(e) => setCorrectionDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
                              placeholder="Valor corregido"
                              style={{ ...inputStyle, flex: 1, minWidth: 140 }}
                            />
                            <button
                              type="button"
                              onClick={() => void handleConfirmField(field, "correct")}
                              disabled={confirmingFieldId === field.id || (correctionDrafts[field.id] ?? "").trim().length === 0}
                              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              {confirmingFieldId === field.id ? "Guardando…" : "Corregir"}
                            </button>
                          </div>
                        ) : field.status !== "sugerido" ? (
                          <p style={{ margin: "6px 0 0", fontSize: 11, color: "#9ca3af" }}>
                            {field.status === "corregido" ? `Corregido a "${field.confirmedValue}"` : "Confirmado tal cual"} por {field.confirmedBy} el {field.confirmedAt ? formatDate(field.confirmedAt) : "—"}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
