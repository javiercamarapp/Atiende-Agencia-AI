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
import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { extractRequirements, fetchRequirementItems, fileToBase64, MAX_UPLOAD_FILE_BYTES } from "../lib/requirements-client.ts";
import type { ExtractDocumentInput, RequirementItemRecord, SkippedDocument } from "../lib/requirements-client.ts";
import { formatDate, formatObligatoriedad, formatRequirementKind, formatRequirementStatus } from "../lib/format.ts";
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

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pendiente: { bg: "#f3f4f6", fg: "#4b5563" },
  en_progreso: { bg: "#dbeafe", fg: "#1e40af" },
  cumplido: { bg: "#dcfce7", fg: "#166534" },
  bloqueado: { bg: "#fee2e2", fg: "#991b1b" },
  no_evaluable: { bg: "#f3f4f6", fg: "#4b5563" },
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, whiteSpace: "nowrap" }}>{formatRequirementStatus(status)}</span>;
}

export function RequisitosConvocatoriaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [items, setItems] = useState<readonly RequirementItemRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pendingFiles, setPendingFiles] = useState<readonly PendingFile[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [lastSkipped, setLastSkipped] = useState<readonly SkippedDocument[]>([]);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, itemsData] = await Promise.all([fetchTender(fetch, apiBaseUrl, token, propertyId, id), fetchRequirementItems(fetch, apiBaseUrl, token, propertyId, id)]);
      setTender(tenderData);
      setItems(itemsData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
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

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (loadError) return <p role="alert" style={{ color: "#b91c1c" }}>{loadError}</p>;
  if (!tender) return null;

  const canUpload = WRITE_ROLES.has(role);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title}
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Requisitos de las bases</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Sube el PDF (o texto plano) de las bases de esta convocatoria para extraer sus requisitos automáticamente. Solo lectura del resto del expediente: la propuesta técnica/económica y el cierre no viven en esta pantalla todavía.
        </p>
      </div>

      {canUpload ? (
        <form onSubmit={handleExtract} style={{ display: "flex", flexDirection: "column", gap: 12, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
            Documentos de bases (PDF o .txt)
            <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" multiple onChange={handleFilesSelected} style={{ fontSize: 13 }} />
          </label>

          {pendingFiles.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {pendingFiles.map((f) => (
                <div key={f.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
                  <span style={{ fontSize: 12, color: "#6b7280", minWidth: 140 }}>
                    {f.file.name} · {(f.file.size / 1024 / 1024).toFixed(1)}MB
                  </span>
                  <input
                    value={f.documentLabel}
                    onChange={(e) => updatePendingFile(f.key, { documentLabel: e.target.value })}
                    placeholder="Etiqueta del documento"
                    style={{ flex: 1, minWidth: 160, padding: 6, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                  />
                  <input
                    type="date"
                    value={f.publishedAt}
                    onChange={(e) => updatePendingFile(f.key, { publishedAt: e.target.value })}
                    style={{ padding: 6, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                  />
                  <button type="button" onClick={() => removePendingFile(f.key)} style={{ border: "none", background: "transparent", color: "#b91c1c", cursor: "pointer", fontSize: 12 }}>
                    Quitar
                  </button>
                  {f.tooLarge && (
                    <p role="alert" style={{ width: "100%", margin: 0, fontSize: 12, color: "#b91c1c" }}>
                      Este archivo pesa más de 22MB -- no se enviará (límite del backend).
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {extractError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {extractError}
            </p>
          )}

          <button
            type="submit"
            disabled={extracting || pendingFiles.length === 0}
            style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {extracting ? "Extrayendo…" : "Extraer requisitos"}
          </button>
        </form>
      ) : (
        <p style={{ fontSize: 12, color: "#9ca3af" }}>Tu rol ({role}) no puede subir documentos de bases -- solo lectura de los requisitos ya extraídos.</p>
      )}

      {lastSkipped.length > 0 && (
        <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 10, padding: 12 }}>
          <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600, color: "#92400e" }}>
            {lastSkipped.length} documento(s) no produjeron texto extraíble y se excluyeron de esta extracción:
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#92400e" }}>
            {lastSkipped.map((s) => (
              <li key={s.documentId}>
                "{s.documentLabel}" -- {s.status === "requires_ocr" ? "PDF escaneado sin capa de texto (no hay OCR de imagen disponible)" : "formato no soportado o archivo corrupto"}
                {s.detail ? `: ${s.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Requisitos extraídos ({items?.length ?? 0})</h2>
        {items && items.length === 0 && <p style={{ fontSize: 13, color: "#6b7280" }}>Todavía no hay requisitos extraídos para esta convocatoria -- sube un documento de bases arriba.</p>}
        {items && items.length > 0 && (
          <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`} style={{ display: "inline-block", marginBottom: 12, fontSize: 13, color: "#111827", fontWeight: 600, textDecoration: "none" }}>
            Generar propuesta técnica y mapear requisitos →
          </Link>
        )}
        {items && items.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "6px 8px" }}>Requisito</th>
                  <th style={{ padding: "6px 8px" }}>Tipo</th>
                  <th style={{ padding: "6px 8px" }}>Obligatoriedad</th>
                  <th style={{ padding: "6px 8px" }}>Estatus</th>
                  <th style={{ padding: "6px 8px" }}>Fecha límite</th>
                  <th style={{ padding: "6px 8px" }}>Origen</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
                    <td style={{ padding: "8px", maxWidth: 320 }}>
                      <p style={{ margin: 0 }}>{item.text}</p>
                      {item.requiredEvidence.length > 0 && (
                        <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>Evidencia requerida: {item.requiredEvidence.join(", ")}</p>
                      )}
                    </td>
                    <td style={{ padding: "8px", color: "#374151" }}>{formatRequirementKind(item.requirementKind)}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>{formatObligatoriedad(item.obligatoriedad)}</td>
                    <td style={{ padding: "8px" }}>
                      <StatusBadge status={item.status} />
                    </td>
                    <td style={{ padding: "8px", color: "#374151" }}>{item.deadline ? formatDate(item.deadline) : "—"}</td>
                    <td style={{ padding: "8px", fontSize: 11, color: "#9ca3af" }}>
                      {item.page ? `pág. ${item.page}` : "—"}
                      {item.clause ? ` · ${item.clause}` : ""}
                      <br />
                      {item.extractedBy === "llm" ? "LLM" : "reglas"}
                      {typeof item.confidence === "number" ? ` (${Math.round(item.confidence * 100)}%)` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
