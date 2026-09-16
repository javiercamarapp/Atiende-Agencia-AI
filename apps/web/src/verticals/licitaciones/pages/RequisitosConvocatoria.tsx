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
import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, FileUp, X } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
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

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pendiente: "secondary",
  en_progreso: "outline",
  cumplido: "default",
  bloqueado: "destructive",
  no_evaluable: "secondary",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANTS[status] ?? "secondary"} className="whitespace-nowrap">
      {formatRequirementStatus(status)}
    </Badge>
  );
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

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !tender) return <EstadoCargando etiqueta="Cargando requisitos…" />;
  if (loadError) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!tender) return null;

  const canUpload = WRITE_ROLES.has(role);

  return (
    <div className="flex max-w-[900px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          {tender.title}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Requisitos de las bases</h1>
        <p className="text-[13px] text-muted-foreground">
          Sube el PDF (o texto plano) de las bases de esta convocatoria para extraer sus requisitos automáticamente. Solo lectura del resto del expediente: la propuesta técnica/económica y el cierre no viven en esta pantalla todavía.
        </p>
      </div>

      {canUpload ? (
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
                <p role="alert" className="text-[13px] text-destructive">
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
      ) : (
        <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede subir documentos de bases -- solo lectura de los requisitos ya extraídos.</p>
      )}

      {lastSkipped.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {lastSkipped.length} documento(s) no produjeron texto extraíble y se excluyeron de esta extracción:
          </p>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
            {lastSkipped.map((s) => (
              <li key={s.documentId}>
                "{s.documentLabel}" -- {s.status === "requires_ocr" ? "PDF escaneado sin capa de texto (no hay OCR de imagen disponible)" : "formato no soportado o archivo corrupto"}
                {s.detail ? `: ${s.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Requisitos extraídos ({items?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items && items.length === 0 && <EstadoVacio mensaje="Todavía no hay requisitos extraídos para esta convocatoria -- sube un documento de bases arriba." />}
          {items && items.length > 0 && (
            <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/propuesta-tecnica`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-foreground no-underline hover:underline">
              Generar propuesta técnica y mapear requisitos →
            </Link>
          )}
          {items && items.length > 0 && (
            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requisito</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Obligatoriedad</TableHead>
                    <TableHead>Estatus</TableHead>
                    <TableHead>Fecha límite</TableHead>
                    <TableHead>Origen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} className="align-top">
                      <TableCell className="max-w-[320px] p-3">
                        <p className="text-foreground">{item.text}</p>
                        {item.requiredEvidence.length > 0 && (
                          <p className="mt-1 text-[11px] text-muted-foreground">Evidencia requerida: {item.requiredEvidence.join(", ")}</p>
                        )}
                      </TableCell>
                      <TableCell className="p-3 text-muted-foreground">{formatRequirementKind(item.requirementKind)}</TableCell>
                      <TableCell className="p-3 text-muted-foreground">{formatObligatoriedad(item.obligatoriedad)}</TableCell>
                      <TableCell className="p-3">
                        <StatusBadge status={item.status} />
                      </TableCell>
                      <TableCell className="p-3 text-muted-foreground">{item.deadline ? formatDate(item.deadline) : "—"}</TableCell>
                      <TableCell className="p-3 text-[11px] text-muted-foreground">
                        {item.page ? `pág. ${item.page}` : "—"}
                        {item.clause ? ` · ${item.clause}` : ""}
                        <br />
                        {item.extractedBy === "llm" ? "LLM" : "reglas"}
                        {typeof item.confidence === "number" ? ` (${Math.round(item.confidence * 100)}%)` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
