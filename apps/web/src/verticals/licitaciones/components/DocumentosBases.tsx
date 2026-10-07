// Bóveda de documentos de la convocatoria (paridad3 L-P3-05): bases, anexos, actas de junta, modificaciones y fallo.
// Sube el archivo al servidor (que valida su CONTENIDO: un ZIP, un ejecutable o un PDF incompleto se rechazan), muestra el
// estado de extracción (extracted / requires_ocr / failed, con motivo) y permite re-extraer los requisitos de lo ya guardado
// sin volver a subir. Una versión nueva de un documento conserva el historial. Todo llama a la API real; con la base sin la
// migración 037 muestra un estado honesto "no disponible aún" en vez de simular la bóveda.
import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { FileUp, RefreshCw, Upload } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoVacio, Input, Label, NativeSelect, StatusBadge, statusTone } from "@atiende/ui";
import { extractRequirementsFromDocuments, TENDER_DOCUMENT_TYPES, TENDER_DOCUMENT_TYPE_LABELS, uploadTenderDocument } from "../lib/documents-client.ts";
import type { TenderDocument, TenderDocumentType } from "../lib/documents-client.ts";
import { MAX_UPLOAD_FILE_BYTES } from "../lib/requirements-client.ts";
import type { SkippedDocument } from "../lib/requirements-client.ts";
import { EXTRACCION_DOCUMENTO_TONES } from "../lib/status-tones.ts";
import { formatDateTime } from "../lib/format.ts";

const EXTRACCION_LABEL: Record<string, string> = { extracted: "Texto extraído", requires_ocr: "Requiere OCR", failed: "No se pudo leer" };

export interface DocumentosBasesProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly canWrite: boolean;
  /** `false` = la base no tiene la migración 037. */
  readonly disponible: boolean;
  readonly documents: readonly TenderDocument[];
  /** Recarga documentos y requisitos tras subir o re-extraer. */
  readonly onChanged: () => Promise<void>;
  readonly onSkipped: (skipped: readonly SkippedDocument[]) => void;
}

export function DocumentosBases({ apiBaseUrl, token, propertyId, tenderId, canWrite, disponible, documents, onChanged, onSkipped }: DocumentosBasesProps) {
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<TenderDocumentType>("bases");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const versionInput = useRef<HTMLInputElement | null>(null);
  const [versionFor, setVersionFor] = useState<TenderDocument | null>(null);

  if (!disponible) {
    return (
      <Callout tone="warning" titulo="Bóveda de documentos: no disponible aún">
        Esta base de datos todavía no tiene la migración 037 (bóveda de bases). Mientras tanto, sube las bases en la pestaña Requisitos: se extraen al momento pero no se guardan.
      </Callout>
    );
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setError("Este archivo pesa más de 22MB; el servidor no lo acepta.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy("subir");
    try {
      const doc = await uploadTenderDocument(fetch, apiBaseUrl, token, propertyId, tenderId, { file, documentType, title: title.trim() || null, replacesDocumentId: null });
      setNotice(doc.extractionStatus === "extracted" ? "Documento guardado y texto extraído." : `Documento guardado, pero ${EXTRACCION_LABEL[doc.extractionStatus ?? "failed"]?.toLowerCase()}: ${doc.extractionDetail ?? "sin detalle"}`);
      setFile(null);
      setTitle("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo subir el documento.");
    } finally {
      setBusy(null);
    }
  }

  function askNewVersion(doc: TenderDocument) {
    setVersionFor(doc);
    versionInput.current?.click();
  }

  async function handleVersionPicked(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    const previous = versionFor;
    setVersionFor(null);
    if (!picked || !previous) return;
    setError(null);
    setNotice(null);
    setBusy(`version-${previous.id}`);
    try {
      const doc = await uploadTenderDocument(fetch, apiBaseUrl, token, propertyId, tenderId, { file: picked, documentType: previous.documentType, title: previous.title, replacesDocumentId: previous.id });
      setNotice(`Versión ${doc.version} guardada. Re-extrae los requisitos para actualizar la matriz.`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo subir la versión nueva.");
    } finally {
      setBusy(null);
    }
  }

  async function reExtract(ids: readonly string[], label: string) {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      const result = await extractRequirementsFromDocuments(fetch, apiBaseUrl, token, propertyId, tenderId, ids);
      onSkipped(result.skippedDocuments);
      const m = (result as { matrix?: { created: number; updated: number; retired: number } }).matrix;
      setNotice(m ? `Requisitos actualizados: ${m.created} nuevos, ${m.updated} actualizados, ${m.retired} retirados. Se conservaron responsables y estados asignados.` : "Requisitos actualizados.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron extraer los requisitos.");
    } finally {
      setBusy(null);
    }
  }

  const vigentes = documents.filter((d) => d.latest && d.extractionStatus === "extracted");

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subir un documento</CardTitle>
            <CardDescription>PDF con texto o texto plano. Se guarda el original con su huella (SHA-256); un ZIP, un ejecutable o un PDF incompleto se rechazan.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpload} className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <div className="flex flex-[1_1_200px] flex-col gap-1.5">
                  <Label htmlFor="boveda-tipo">Tipo</Label>
                  <NativeSelect id="boveda-tipo" value={documentType} onChange={(e) => setDocumentType(e.target.value as TenderDocumentType)}>
                    {TENDER_DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TENDER_DOCUMENT_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-[2_1_240px] flex-col gap-1.5">
                  <Label htmlFor="boveda-titulo">Título (opcional)</Label>
                  <Input id="boveda-titulo" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Ej. Acta de la primera junta" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="boveda-archivo">Archivo (PDF o .txt)</Label>
                <Input
                  id="boveda-archivo"
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer file:rounded-full file:bg-muted file:px-3 file:py-1 file:text-xs file:font-semibold"
                />
              </div>
              <Button type="submit" size="sm" className="self-start" disabled={busy !== null || !file}>
                <Upload />
                {busy === "subir" ? "Subiendo…" : "Subir a la bóveda"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Documentos ({documents.length})</CardTitle>
            <CardDescription>Cada versión nueva conserva las anteriores; solo la vigente alimenta la matriz.</CardDescription>
          </div>
          {canWrite && (
            <Button type="button" size="sm" variant="outline" disabled={busy !== null || vigentes.length === 0} onClick={() => void reExtract(vigentes.map((d) => d.id), "todos")}>
              <RefreshCw />
              {busy === "todos" ? "Extrayendo…" : "Extraer requisitos de todos"}
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {canWrite && <input ref={versionInput} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" className="hidden" aria-label="Archivo de la versión nueva" onChange={(e) => void handleVersionPicked(e)} />}
          {documents.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay documentos en la bóveda. Sube las bases de esta convocatoria arriba." />
          ) : (
            <DataTable
              etiqueta="Documentos de la convocatoria"
              obtenerId={(d) => d.id}
              filas={documents}
              paginacion={false}
              columnas={[
                {
                  id: "documento",
                  encabezado: "Documento",
                  principal: true,
                  className: "max-w-72",
                  celda: (d) => (
                    <>
                      <p className="font-normal text-foreground">{d.title ?? d.filename ?? "Sin nombre"}</p>
                      <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                        {TENDER_DOCUMENT_TYPE_LABELS[d.documentType]}
                        {d.filename && d.title ? ` · ${d.filename}` : ""}
                      </p>
                    </>
                  ),
                },
                { id: "version", encabezado: "Versión", celda: (d) => <span className="text-muted-foreground">v{d.version}{d.latest ? "" : " (anterior)"}</span> },
                { id: "paginas", encabezado: "Páginas", celda: (d) => <span className="text-muted-foreground">{d.pageCount ?? "—"}</span> },
                {
                  id: "extraccion",
                  encabezado: "Extracción",
                  celda: (d) => (
                    <div className="flex flex-col gap-0.5">
                      <StatusBadge tone={statusTone(EXTRACCION_DOCUMENTO_TONES, d.extractionStatus ?? "")} className="w-fit whitespace-nowrap">
                        {d.extractionStatus ? EXTRACCION_LABEL[d.extractionStatus] : "Sin información"}
                      </StatusBadge>
                      {d.extractionDetail && <span className="max-w-60 text-xs font-normal text-muted-foreground">{d.extractionDetail}</span>}
                    </div>
                  ),
                },
                { id: "subido", encabezado: "Subido", celda: (d) => <span className="text-xs text-muted-foreground">{formatDateTime(d.createdAt)}</span> },
                {
                  id: "acciones",
                  encabezado: "Acciones",
                  celda: (d) =>
                    canWrite && d.latest ? (
                      <div className="flex flex-wrap gap-1.5">
                        <Button type="button" size="sm" variant="outline" disabled={busy !== null || d.extractionStatus !== "extracted"} onClick={() => void reExtract([d.id], `extraer-${d.id}`)}>
                          <RefreshCw />
                          {busy === `extraer-${d.id}` ? "Extrayendo…" : "Re-extraer"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => askNewVersion(d)}>
                          <FileUp />
                          {busy === `version-${d.id}` ? "Subiendo…" : "Nueva versión"}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
