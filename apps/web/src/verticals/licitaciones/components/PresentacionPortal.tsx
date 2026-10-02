// L-28 -- "Presentacion ante el portal": declarar que el expediente YA se presento ante el portal oficial.
//
// Atiende NUNCA envia la oferta al portal (REQ-046 / REQ-LIC-011): la presenta y firma la persona usuaria
// en el portal oficial; esta seccion solo REGISTRA esa declaracion (fecha y hora, notas y, opcionalmente, el
// acuse) sobre `GET/POST .../submission[/declare]`. Una declaracion queda visible al recargar, es idempotente
// (misma clave en el reintento del mismo formulario) y no se puede deshacer desde aqui (la API es append-only).
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { FileCheck2 } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label, StatusBadge, Textarea, useConfirm } from "@atiende/ui";
import { declareSubmission, fetchSubmission, instantToLocalInput, localInputToIso, MAX_ACKNOWLEDGEMENT_BYTES, readFileAsBase64 } from "../lib/cierre-client.ts";
import type { PackageStatus, SubmissionRecord } from "../lib/cierre-client.ts";
import { formatDateTime } from "../lib/format.ts";

const MAX_NOTES_LENGTH = 2000;

export interface PresentacionPortalProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  /** WRITE_ROLES (cosmetico: el servidor decide). */
  readonly canDeclare: boolean;
  readonly role: string;
  /** Estado del ultimo paquete (`null` = nunca se ensamblo): solo para advertir, nunca bloquea la declaracion. */
  readonly packageStatus: PackageStatus | null;
}

export function PresentacionPortal({ apiBaseUrl, token, propertyId, tenderId, canDeclare, role, packageStatus }: PresentacionPortalProps) {
  const { confirmar, dialogo } = useConfirm();
  const [submission, setSubmission] = useState<SubmissionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [submittedAtText, setSubmittedAtText] = useState(() => instantToLocalInput(new Date()));
  const [notes, setNotes] = useState("");
  const [acknowledgement, setAcknowledgement] = useState<File | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Un reintento del MISMO formulario reutiliza la clave (el servidor responde igual, sin duplicar); si el
  // formulario cambia se genera otra (la misma clave con otro cuerpo es un 422 del servidor).
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const rotateKey = () => {
    idempotencyKey.current = crypto.randomUUID();
  };

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      setSubmission(await fetchSubmission(fetch, apiBaseUrl, token, propertyId, tenderId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo consultar la presentación.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (sin eslint-plugin-react-hooks configurado).
  }, [apiBaseUrl, token, propertyId, tenderId]);

  function handleAcknowledgementSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setFormError(null);
    if (file && file.size > MAX_ACKNOWLEDGEMENT_BYTES) {
      setAcknowledgement(null);
      event.target.value = "";
      setFormError(`El acuse pesa ${(file.size / 1024 / 1024).toFixed(1)} MB; el máximo es ${MAX_ACKNOWLEDGEMENT_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setAcknowledgement(file);
    rotateKey();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const submittedAt = localInputToIso(submittedAtText);
    if (!submittedAt) {
      setFormError("Indica la fecha y la hora en que presentaste el expediente en el portal.");
      return;
    }
    // Cancelar / Escape no escriben nada.
    const ok = await confirmar({
      titulo: "Declarar la presentación ante el portal",
      descripcion: (
        <>
          Vas a registrar que <strong>ya presentaste</strong> el expediente en el portal oficial. Atiende no envía nada al portal: solo guarda tu declaración
          {acknowledgement ? " y el acuse adjunto" : ""}. Queda en el historial y no se puede deshacer desde aquí.
        </>
      ),
      confirmar: "Declarar presentación",
    });
    if (!ok) return;

    setDeclaring(true);
    try {
      const acknowledgementContentBase64 = acknowledgement ? await readFileAsBase64(acknowledgement) : null;
      const created = await declareSubmission(fetch, apiBaseUrl, token, propertyId, tenderId, { submittedAt, notes: notes.trim().length > 0 ? notes.trim() : null, acknowledgementContentBase64 }, idempotencyKey.current);
      setSubmission(created);
      rotateKey();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar la presentación.");
    } finally {
      setDeclaring(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileCheck2 className="h-4 w-4 text-muted-foreground" />
          Presentación ante el portal
          {submission && (
            <StatusBadge tone="success" className="whitespace-nowrap">
              Declarada
            </StatusBadge>
          )}
        </CardTitle>
        <CardDescription>
          Atiende nunca envía tu oferta al portal: la presentas y firmas tú, en el portal oficial. Aquí solo registras que ya la presentaste (fecha y hora, notas y, si lo tienes, el acuse) para dejar constancia en el expediente.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && <EstadoCargando etiqueta="Consultando la presentación…" />}
        {!loading && loadError && <EstadoError mensaje={loadError} onReintentar={() => void load()} />}

        {!loading && !loadError && submission && (
          <div className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm" data-testid="presentacion-declarada">
            <p className="font-semibold text-foreground">Presentación declarada</p>
            <p className="text-muted-foreground">Presentada en el portal el {formatDateTime(submission.submittedAt)}.</p>
            <p className="text-xs text-muted-foreground">Registrada en Atiende el {formatDateTime(submission.createdAt)}.</p>
            {submission.notes && <p className="whitespace-pre-wrap text-foreground">{submission.notes}</p>}
            <p className="text-xs text-muted-foreground">
              {submission.acknowledgementFileHash ? `Acuse adjunto (huella SHA-256 ${submission.acknowledgementFileHash.slice(0, 12)}…).` : "Sin acuse adjunto."}
            </p>
          </div>
        )}

        {!loading && !loadError && !submission && (
          <>
            {packageStatus !== "ready" && (
              <p className="rounded-xl border border-warning/30 bg-warning-tint p-3 text-xs font-medium text-foreground">
                {packageStatus === null ? "Todavía no ensamblaste ningún paquete." : "El último paquete sigue en borrador."} Puedes declarar la presentación igual (es un hecho que ya ocurrió), pero revisa que lo que presentaste sea el expediente aprobado.
              </p>
            )}
            {canDeclare ? (
              <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="presentacion-fecha">Fecha y hora de la presentación</Label>
                  <Input
                    id="presentacion-fecha"
                    type="datetime-local"
                    value={submittedAtText}
                    onChange={(e) => {
                      setSubmittedAtText(e.target.value);
                      rotateKey();
                    }}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="presentacion-notas">Notas (opcional)</Label>
                  <Textarea
                    id="presentacion-notas"
                    rows={3}
                    maxLength={MAX_NOTES_LENGTH}
                    value={notes}
                    onChange={(e) => {
                      setNotes(e.target.value);
                      rotateKey();
                    }}
                    placeholder="Folio del portal, quién presentó, incidencias…"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="presentacion-acuse">Acuse del portal (opcional, máx. {MAX_ACKNOWLEDGEMENT_BYTES / 1024 / 1024} MB)</Label>
                  <Input id="presentacion-acuse" type="file" onChange={handleAcknowledgementSelected} className="h-auto cursor-pointer py-2 file:mr-3 file:cursor-pointer file:rounded-full file:bg-muted file:px-3 file:py-1 file:text-xs file:font-semibold" />
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-destructive">
                    {formError}
                  </p>
                )}
                <Button type="submit" size="sm" className="self-start" disabled={declaring}>
                  <FileCheck2 />
                  {declaring ? "Registrando…" : "Declarar presentación"}
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">Tu rol ({role}) no puede declarar la presentación -- solo lectura.</p>
            )}
          </>
        )}
      </CardContent>
      {dialogo}
    </Card>
  );
}
