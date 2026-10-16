// Revisión del expediente (paridad3 L-P3-07): editor humano por sección + hilo de comentarios + solicitud de revisión.
//  - Guardar una sección registra la autoría (quien edita no puede aprobar esa sección ni el expediente, AE-11).
//  - Si el texto cambió se invalidan las aprobaciones vigentes de esa sección y del expediente (AE-02); con el mismo texto no.
//  - Los comentarios son solo de adición (autor y rol visibles) y "Pedir revisión" avisa a los revisores por la campana.
// Todo llama a la API real; con la base sin la migración 037 el hilo dice "no disponible aún" en vez de simularse.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { MessageSquarePlus, Send } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Label, NativeSelect, StatusBadge, Textarea } from "@atiende/ui";
import { addReviewComment, editProposalSection, fetchProposalSections, fetchReviewComments, requestReview } from "../lib/revision-client.ts";
import type { CommentsResult, ProposalSection, ReviewComment } from "../lib/revision-client.ts";
import { formatDateTime } from "../lib/format.ts";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);
// Mismo conjunto que SUBMITTER_ROLES del servidor (quién puede enviar a revisión); cosmético: el servidor decide.
const SUBMITTER_ROLES = new Set(["owner", "admin", "analyst", "writer"]);

function scopeLabel(c: ReviewComment, sections: readonly ProposalSection[]): string {
  if (c.scope === "expediente") return "Expediente";
  const key = c.scopeRef.replace(/^seccion:/, "");
  return sections.find((s) => s.sectionKey === key)?.label ?? key;
}

export interface RevisionExpedienteProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly role: string;
  /** Se llama tras guardar una sección (p. ej. para recargar la propuesta de la pantalla). */
  readonly onSectionSaved?: () => void;
}

export function RevisionExpediente({ apiBaseUrl, token, propertyId, tenderId, role, onSectionSaved }: RevisionExpedienteProps) {
  const [sections, setSections] = useState<readonly ProposalSection[] | null>(null);
  const [comments, setComments] = useState<CommentsResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [sectionMsg, setSectionMsg] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});
  const [scopeKey, setScopeKey] = useState<string>("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState<"comentar" | "revision" | null>(null);
  const [threadMsg, setThreadMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const canWrite = WRITE_ROLES.has(role);
  const canRequest = SUBMITTER_ROLES.has(role);

  async function load() {
    setLoadError(null);
    try {
      const [secs, thread] = await Promise.all([fetchProposalSections(fetch, apiBaseUrl, token, propertyId, tenderId), fetchReviewComments(fetch, apiBaseUrl, token, propertyId, tenderId)]);
      setSections(secs);
      setComments(thread);
      setDrafts({});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la revisión.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function saveSection(section: ProposalSection) {
    const content = drafts[section.sectionKey];
    if (content === undefined) return;
    setSavingKey(section.sectionKey);
    setSectionMsg((m) => ({ ...m, [section.sectionKey]: { tone: "ok", text: "" } }));
    try {
      const result = await editProposalSection(fetch, apiBaseUrl, token, propertyId, tenderId, section.sectionKey, content);
      const text = !result.changed
        ? "Sin cambios: el texto es idéntico al vigente, no se invalidó ninguna aprobación."
        : result.invalidatedApprovals > 0
          ? `Guardado (versión ${result.section.version}). Se invalidaron ${result.invalidatedApprovals} aprobación(es) vigente(s); hay que aprobar de nuevo, y no puedes hacerlo tú porque editaste la sección.`
          : `Guardado (versión ${result.section.version}). Ya eres autor de esta sección: no podrás aprobarla ni aprobar el expediente.`;
      setSectionMsg((m) => ({ ...m, [section.sectionKey]: { tone: "ok", text } }));
      await load();
      onSectionSaved?.();
    } catch (err) {
      setSectionMsg((m) => ({ ...m, [section.sectionKey]: { tone: "error", text: err instanceof Error ? err.message : "No se pudo guardar la sección." } }));
    } finally {
      setSavingKey(null);
    }
  }

  async function post(kind: "comentar" | "revision", event?: FormEvent) {
    event?.preventDefault();
    if (kind === "comentar" && body.trim().length === 0) {
      setThreadMsg({ tone: "error", text: "Escribe el comentario." });
      return;
    }
    setPosting(kind);
    setThreadMsg(null);
    try {
      const sectionKey = scopeKey === "" ? null : scopeKey;
      if (kind === "comentar") await addReviewComment(fetch, apiBaseUrl, token, propertyId, tenderId, { sectionKey, body: body.trim() });
      else await requestReview(fetch, apiBaseUrl, token, propertyId, tenderId, { sectionKey, note: body.trim() });
      setBody("");
      setThreadMsg({ tone: "ok", text: kind === "comentar" ? "Comentario agregado." : "Revisión solicitada: los revisores recibieron el aviso en la campana. Quien la pide no puede aprobar ese alcance." });
      await load();
    } catch (err) {
      setThreadMsg({ tone: "error", text: err instanceof Error ? err.message : "No se pudo completar la acción." });
    } finally {
      setPosting(null);
    }
  }

  if (!sections && !loadError) return <EstadoCargando etiqueta="Cargando la revisión…" />;
  if (loadError) {
    // Sin propuesta todavía: no es un fallo, es el orden natural del flujo.
    return /Genere primero la propuesta/.test(loadError) ? (
      <Callout tone="info" titulo="Revisión del expediente">
        Genera la propuesta técnica para poder editar y revisar sus secciones.
      </Callout>
    ) : (
      <EstadoError mensaje={loadError} onReintentar={() => void load()} />
    );
  }

  const list = sections ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Secciones de la propuesta ({list.length})</CardTitle>
          <CardDescription>Edita el texto de una sección. Si cambia, se invalidan las aprobaciones vigentes de esa sección y del expediente; quien edita no puede aprobarla.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {list.length === 0 && <EstadoVacio mensaje="Todavía no hay secciones: genera la propuesta técnica o la económica." />}
          {list.map((s) => {
            const draft = drafts[s.sectionKey] ?? s.content;
            const dirty = draft !== s.content;
            const msg = sectionMsg[s.sectionKey];
            return (
              <div key={s.sectionKey} className="flex flex-col gap-2 rounded-xl border border-border p-3" data-seccion={s.sectionKey}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{s.label}</span>
                  <span className="text-xs text-muted-foreground">v{s.version}</span>
                  {s.approved && <StatusBadge tone="success" dot={false}>Aprobada</StatusBadge>}
                  {s.authoredByViewer && <StatusBadge tone="info" dot={false}>Tú la redactaste: no puedes aprobarla</StatusBadge>}
                </div>
                <Label htmlFor={`seccion-${s.sectionKey}`} className="sr-only">
                  Contenido de {s.label}
                </Label>
                <Textarea id={`seccion-${s.sectionKey}`} value={draft} readOnly={!canWrite} rows={6} maxLength={200000} onChange={(e) => setDrafts((d) => ({ ...d, [s.sectionKey]: e.target.value }))} />
                {canWrite && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" disabled={!dirty || savingKey !== null || draft.trim().length === 0} onClick={() => void saveSection(s)}>
                      {savingKey === s.sectionKey ? "Guardando…" : "Guardar sección"}
                    </Button>
                    {dirty && (s.approved || s.expedienteApproved) && <span className="text-xs font-medium text-foreground">Al guardar se invalidará la aprobación vigente{s.approved && s.expedienteApproved ? " de la sección y del expediente" : s.approved ? " de la sección" : " del expediente"}.</span>}
                  </div>
                )}
                {msg?.text && (
                  <p role={msg.tone === "error" ? "alert" : "status"} className={msg.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                    {msg.text}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revisión y comentarios ({comments?.comments.length ?? 0})</CardTitle>
          <CardDescription>Hilo de solo adición: nadie edita ni borra comentarios. Pedir revisión avisa a los revisores.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {comments && !comments.disponible && <Callout tone="warning" titulo="Comentarios: no disponible aún">Esta base todavía no tiene la migración 037 (comentarios de revisión).</Callout>}
          {comments?.disponible && comments.comments.length === 0 && <EstadoVacio mensaje="Todavía no hay comentarios." />}
          {comments?.disponible &&
            comments.comments.map((c) => (
              <div key={c.id} className="flex flex-col gap-0.5 rounded-xl border border-border p-3" data-comentario={c.kind}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{c.esTuyo ? "Tú" : (c.authorName ?? "Alguien del equipo")}</span>
                  <span>· {c.authorRole}</span>
                  <span>· {scopeLabel(c, list)}</span>
                  <span>· {formatDateTime(c.createdAt)}</span>
                  {c.kind === "solicitud_revision" && <StatusBadge tone="warning" dot={false}>Solicitud de revisión</StatusBadge>}
                </div>
                <p className="whitespace-pre-wrap text-sm text-foreground">{c.body}</p>
              </div>
            ))}

          {comments?.disponible && canWrite && (
            <form onSubmit={(e) => void post("comentar", e)} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revision-alcance">Alcance</Label>
                <NativeSelect id="revision-alcance" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
                  <option value="">Todo el expediente</option>
                  {list.map((s) => (
                    <option key={s.sectionKey} value={s.sectionKey}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revision-texto">Comentario o nota para el revisor</Label>
                <Textarea id="revision-texto" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={posting !== null}>
                  <MessageSquarePlus />
                  {posting === "comentar" ? "Enviando…" : "Comentar"}
                </Button>
                {canRequest && (
                  <Button type="button" size="sm" variant="outline" disabled={posting !== null} onClick={() => void post("revision")}>
                    <Send />
                    {posting === "revision" ? "Enviando…" : "Pedir revisión"}
                  </Button>
                )}
              </div>
            </form>
          )}
          {threadMsg && (
            <p role={threadMsg.tone === "error" ? "alert" : "status"} className={threadMsg.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
              {threadMsg.text}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
