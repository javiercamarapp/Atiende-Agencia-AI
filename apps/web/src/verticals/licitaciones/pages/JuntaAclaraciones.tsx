// Preguntas de la junta de aclaraciones (L-04): captura con aviso de duplicados y
// prioridad sugerida, borrador asistido por IA (siempre queda en borrador), estados
// borrador -> aprobada -> enviada -> respondida (o descartada), fecha limite de envio con
// semaforo y recordatorios, y vinculo a la respuesta del acta.
//
// Honestidad: esta pantalla NO envia nada a ningun portal. "Marcar como enviada" registra que
// una persona ya presento la pregunta por el canal oficial; la respuesta del acta tambien la
// captura una persona. Aprobar exige rol de decision (owner/admin/analyst) en el servidor.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, NativeSelect, StatusBadge, statusTone, Textarea } from "@atiende/ui";
import {
  acknowledgeJuntaReminder,
  captureJuntaQuestion,
  draftJuntaQuestions,
  fetchJunta,
  saveJuntaConfig,
  transitionJuntaQuestion,
  updateJuntaQuestion,
} from "../lib/sala-guerra-client.ts";
import type { CaptureResult, DraftResult, JuntaQuestion, JuntaQuestionPriority, JuntaQuestionStatus, JuntaQuestionTopic, JuntaResponse, TransitionInput } from "../lib/sala-guerra-client.ts";
import { PREGUNTA_JUNTA_TONES } from "../lib/status-tones.ts";
import { textoDiasHabiles } from "../lib/dias-inhabiles-client.ts";
import { DATE_TIME, semaphoreTone, WRITE_ROLES, isoToLocalInput, localToIso, semaphoreLabel } from "./SalaGuerra.tsx";

const DECISION_ROLES = new Set(["owner", "admin", "analyst"]);

const STATUS_LABEL: Record<JuntaQuestionStatus, string> = { borrador: "Borrador", aprobada: "Aprobada", enviada: "Enviada", respondida: "Respondida", descartada: "Descartada" };
const TOPIC_LABEL: Record<JuntaQuestionTopic, string> = { administrativo: "Administrativo", legal: "Legal", tecnico: "Técnico", economico: "Económico", otro: "Otro" };
const PRIORITY_LABEL: Record<JuntaQuestionPriority, string> = { alta: "Alta", media: "Media", baja: "Baja" };

export interface JuntaAclaracionesSectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly role: string;
}

type PendingAction = { readonly questionId: string; readonly to: "enviada" | "respondida" | "descartada" } | null;

export function JuntaAclaracionesSection({ apiBaseUrl, token, propertyId, tenderId, role }: JuntaAclaracionesSectionProps) {
  const [data, setData] = useState<JuntaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [deadline, setDeadline] = useState("");
  const [meeting, setMeeting] = useState("");
  const [acta, setActa] = useState("");

  const [text, setText] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [topic, setTopic] = useState<JuntaQuestionTopic>("otro");
  const [priority, setPriority] = useState<"" | JuntaQuestionPriority>("");
  const [capture, setCapture] = useState<CaptureResult | null>(null);

  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState<DraftResult | null>(null);

  const [pending, setPending] = useState<PendingAction>(null);
  const [pendingText, setPendingText] = useState("");
  const [pendingRef, setPendingRef] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const canWrite = WRITE_ROLES.has(role);
  const canApprove = DECISION_ROLES.has(role);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJunta(fetch, apiBaseUrl, token, propertyId, tenderId);
      setData(next);
      setDeadline(isoToLocalInput(next.config?.questionsDeadlineAt ?? null));
      setMeeting(isoToLocalInput(next.config?.meetingAt ?? null));
      setActa(next.config?.actaReference ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la junta de aclaraciones.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function run(key: string, fn: () => Promise<void>, okMessage?: string) {
    setActionError(null);
    setNotice(null);
    setBusy(key);
    try {
      await fn();
      if (okMessage) setNotice(okMessage);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(null);
    }
  }

  async function onSaveConfig(e: FormEvent) {
    e.preventDefault();
    await run(
      "config",
      async () => {
        await saveJuntaConfig(fetch, apiBaseUrl, token, propertyId, tenderId, { questionsDeadlineAt: localToIso(deadline), meetingAt: localToIso(meeting), actaReference: acta.trim() ? acta.trim() : null });
      },
      "Fechas de la junta guardadas.",
    );
  }

  async function onCapture(e: FormEvent) {
    e.preventDefault();
    setCapture(null);
    await run(
      "capture",
      async () => {
        const result = await captureJuntaQuestion(fetch, apiBaseUrl, token, propertyId, tenderId, {
          questionText: text,
          baseReference: baseRef.trim() ? baseRef : null,
          topic,
          ...(priority ? { priority } : {}),
        });
        setCapture(result);
        setText("");
        setBaseRef("");
        setPriority("");
      },
      "Pregunta capturada como borrador.",
    );
  }

  async function onDraft(e: FormEvent) {
    e.preventDefault();
    setDraft(null);
    await run(
      "draft",
      async () => {
        const result = await draftJuntaQuestions(fetch, apiBaseUrl, token, propertyId, tenderId, { instruction });
        setDraft(result);
        setInstruction("");
      },
      "El asistente propuso borradores; revísalos antes de aprobarlos.",
    );
  }

  function transition(question: JuntaQuestion, input: TransitionInput, okMessage: string) {
    return run(`tr-${question.id}`, async () => {
      await transitionJuntaQuestion(fetch, apiBaseUrl, token, propertyId, tenderId, question.id, input);
      setPending(null);
      setPendingText("");
      setPendingRef("");
    }, okMessage);
  }

  function renderQuestion(q: JuntaQuestion) {
    const isEditing = editing?.id === q.id;
    const confirming = pending?.questionId === q.id ? pending.to : null;
    return (
      <div key={q.id} className="flex flex-col gap-2 rounded-xl border border-border p-3" data-testid={`question-${q.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={statusTone(PREGUNTA_JUNTA_TONES, q.status)}>{STATUS_LABEL[q.status]}</StatusBadge>
          <StatusBadge tone={q.priority === "alta" ? "danger" : "neutral"} dot={false}>Prioridad {PRIORITY_LABEL[q.priority].toLowerCase()}</StatusBadge>
          <StatusBadge dot={false}>{TOPIC_LABEL[q.topic]}</StatusBadge>
          {q.origin === "agente" && <StatusBadge tone="info">Borrador del asistente</StatusBadge>}
          {q.baseReference && <span className="text-xs text-muted-foreground">Bases: {q.baseReference}</span>}
        </div>
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <Textarea aria-label="Texto de la pregunta" rows={3} value={editing.text} onChange={(e) => setEditing({ id: q.id, text: e.target.value })} />
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={busy === `ed-${q.id}` || editing.text.trim().length < 10} onClick={() => void run(`ed-${q.id}`, async () => { await updateJuntaQuestion(fetch, apiBaseUrl, token, propertyId, tenderId, q.id, { questionText: editing.text }); setEditing(null); }, "Pregunta actualizada.")}>
                Guardar texto
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-line text-sm text-foreground">{q.questionText}</p>
        )}
        {q.draftMissingData.length > 0 && <p className="text-xs text-muted-foreground">Datos que le faltaron al asistente: {q.draftMissingData.join("; ")}</p>}
        {q.sentAt && (
          <p className="text-xs text-muted-foreground">
            Marcada como enviada: {DATE_TIME.format(new Date(q.sentAt))}
            {q.sentReference ? ` · ${q.sentReference}` : ""}
          </p>
        )}
        {q.status === "respondida" && (
          <div className="rounded-lg bg-muted/40 p-2 text-xs">
            <div className="font-semibold text-foreground">Respuesta del acta{q.answerActaReference ? ` (${q.answerActaReference})` : ""}</div>
            <p className="whitespace-pre-line text-muted-foreground">{q.answerText}</p>
          </div>
        )}
        {q.discardReason && q.status === "descartada" && <p className="text-xs text-muted-foreground">Motivo: {q.discardReason}</p>}

        {canWrite && !isEditing && (
          <div className="flex flex-wrap gap-2">
            {q.status === "borrador" && (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing({ id: q.id, text: q.questionText })}>
                Editar texto
              </Button>
            )}
            {q.status === "borrador" && canApprove && (
              <Button type="button" size="sm" disabled={busy === `tr-${q.id}`} onClick={() => void transition(q, { to: "aprobada" }, "Pregunta aprobada.")}>
                Aprobar
              </Button>
            )}
            {q.status === "aprobada" && (
              <Button type="button" size="sm" variant="outline" disabled={busy === `tr-${q.id}`} onClick={() => void transition(q, { to: "borrador" }, "Pregunta devuelta a borrador (la aprobación se invalida).")}>
                Devolver a borrador
              </Button>
            )}
            {q.status === "aprobada" && (
              <Button type="button" size="sm" onClick={() => { setPending({ questionId: q.id, to: "enviada" }); setPendingText(""); setPendingRef(""); }}>
                Marcar como enviada
              </Button>
            )}
            {q.status === "enviada" && (
              <Button type="button" size="sm" onClick={() => { setPending({ questionId: q.id, to: "respondida" }); setPendingText(""); setPendingRef(""); }}>
                Registrar respuesta del acta
              </Button>
            )}
            {(q.status === "borrador" || q.status === "aprobada" || q.status === "enviada") && (
              <Button type="button" size="sm" variant="outline" onClick={() => { setPending({ questionId: q.id, to: "descartada" }); setPendingText(""); setPendingRef(""); }}>
                Descartar
              </Button>
            )}
            {q.status === "descartada" && (
              <Button type="button" size="sm" variant="outline" disabled={busy === `tr-${q.id}`} onClick={() => void transition(q, { to: "borrador" }, "Pregunta restaurada como borrador.")}>
                Restaurar como borrador
              </Button>
            )}
          </div>
        )}

        {confirming && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
            {confirming === "enviada" && (
              <>
                <p className="text-xs text-muted-foreground">Confirma que ya presentaste esta pregunta por el canal oficial de la convocante. Este sistema no la envía.</p>
                <Input aria-label="Folio o acuse del envío" value={pendingText} onChange={(e) => setPendingText(e.target.value)} placeholder="Folio o acuse (opcional)" />
              </>
            )}
            {confirming === "respondida" && (
              <>
                <Textarea aria-label="Respuesta del acta" rows={3} value={pendingText} onChange={(e) => setPendingText(e.target.value)} placeholder="Texto de la respuesta, tal como aparece en el acta" />
                <Input aria-label="Referencia en el acta" value={pendingRef} onChange={(e) => setPendingRef(e.target.value)} placeholder="Referencia en el acta (pregunta, página o folio)" />
              </>
            )}
            {confirming === "descartada" && <Input aria-label="Motivo del descarte" value={pendingText} onChange={(e) => setPendingText(e.target.value)} placeholder="Motivo (obligatorio)" />}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy === `tr-${q.id}` || (confirming !== "enviada" && pendingText.trim().length === 0)}
                onClick={() =>
                  void transition(
                    q,
                    confirming === "enviada"
                      ? { to: "enviada", ...(pendingText.trim() ? { sentReference: pendingText.trim() } : {}) }
                      : confirming === "respondida"
                        ? { to: "respondida", answerText: pendingText.trim(), ...(pendingRef.trim() ? { answerActaReference: pendingRef.trim() } : {}) }
                        : { to: "descartada", discardReason: pendingText.trim() },
                    confirming === "enviada" ? "Pregunta marcada como enviada." : confirming === "respondida" ? "Respuesta del acta registrada." : "Pregunta descartada.",
                  )
                }
              >
                Confirmar
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setPending(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (loading && !data) return <EstadoCargando etiqueta="Cargando junta de aclaraciones…" />;
  if (loadError && !data) return <EstadoError mensaje={loadError} onReintentar={() => void load()} />;
  if (!data) return null;

  const activeReminders = data.reminders.filter((r) => r.acknowledgedAt === null);

  return (
    <div className="flex flex-col gap-5">
      {!data.available && (
        <div role="status" className="rounded-xl border border-warning/40 bg-warning-tint p-3 text-sm text-foreground">
          La junta de aclaraciones aún no está disponible en esta base de datos (falta aplicar la migración 029). No se pueden guardar preguntas todavía.
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-foreground">
          {notice}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fechas de la junta</CardTitle>
          <CardDescription>Captura las fechas tal como las fijan las bases; el sistema no las deduce. Recordaremos el límite de envío mientras haya preguntas sin enviar.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge tone={semaphoreTone(data.summary.questionsDeadline.semaphore.color)}>{semaphoreLabel(data.summary.questionsDeadline.semaphore)}</StatusBadge>
            <span className="text-muted-foreground">
              Límite para enviar preguntas: {data.summary.questionsDeadline.at ? DATE_TIME.format(new Date(data.summary.questionsDeadline.at)) : "sin fecha declarada"} · Junta: {data.summary.meetingAt ? DATE_TIME.format(new Date(data.summary.meetingAt)) : "sin fecha declarada"}
            </span>
          </div>
          {data.plazos?.preguntas || data.plazos?.junta ? (
            <div className="text-xs text-muted-foreground">
              {data.plazos.preguntas ? <div>Preguntas: {textoDiasHabiles(data.plazos.preguntas)}.</div> : null}
              {data.plazos.junta ? <div>Junta: {textoDiasHabiles(data.plazos.junta)}.</div> : null}
              {[...(data.plazos.preguntas?.avisos ?? []), ...(data.plazos.junta?.avisos ?? [])].map((a) => (
                <div key={a}>{a}</div>
              ))}
            </div>
          ) : null}
          {activeReminders.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs">
              <span>
                {r.message} <span className="text-muted-foreground">(faltan {r.daysRemaining} d)</span>
              </span>
              {canWrite && (
                <Button type="button" size="sm" variant="outline" disabled={busy === `rem-${r.id}`} onClick={() => void run(`rem-${r.id}`, async () => { await acknowledgeJuntaReminder(fetch, apiBaseUrl, token, propertyId, tenderId, r.id); }, "Recordatorio reconocido.")}>
                  Reconocer recordatorio
                </Button>
              )}
            </div>
          ))}
          {canWrite && data.available && (
            <form onSubmit={(e) => void onSaveConfig(e)} className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                Límite para enviar preguntas
                <Input aria-label="Límite para enviar preguntas" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Fecha de la junta
                <Input aria-label="Fecha de la junta" type="datetime-local" value={meeting} onChange={(e) => setMeeting(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Folio o referencia del acta
                <Input aria-label="Referencia del acta" value={acta} onChange={(e) => setActa(e.target.value)} placeholder="Opcional" />
              </label>
              <div className="sm:col-span-3">
                <Button type="submit" disabled={busy === "config"}>
                  {busy === "config" ? "Guardando…" : "Guardar fechas"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {canWrite && data.available && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Capturar una pregunta</CardTitle>
              <CardDescription>Si ya existe una equivalente se rechaza como duplicada; si solo se parece, se te avisa. La prioridad sugerida sale de reglas explicables y puedes cambiarla.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void onCapture(e)} className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm sm:col-span-3">
                  Pregunta
                  <Textarea aria-label="Texto de la pregunta nueva" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ej. En el numeral 6.2, ¿la fianza de cumplimiento se presenta antes de la firma del contrato?" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Numeral o cláusula de las bases
                  <Input aria-label="Referencia a las bases" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder="Opcional" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Tema
                  <NativeSelect aria-label="Tema de la pregunta" value={topic} onChange={(e) => setTopic(e.target.value as JuntaQuestionTopic)}>
                    {(Object.keys(TOPIC_LABEL) as JuntaQuestionTopic[]).map((t) => (
                      <option key={t} value={t}>
                        {TOPIC_LABEL[t]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Prioridad
                  <NativeSelect aria-label="Prioridad de la pregunta" value={priority} onChange={(e) => setPriority(e.target.value as "" | JuntaQuestionPriority)}>
                    <option value="">Sugerida por el sistema</option>
                    {(Object.keys(PRIORITY_LABEL) as JuntaQuestionPriority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <div className="sm:col-span-3">
                  <Button type="submit" disabled={busy === "capture" || text.trim().length < 10}>
                    {busy === "capture" ? "Capturando…" : "Capturar pregunta"}
                  </Button>
                </div>
              </form>
              {capture && (
                <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground" data-testid="capture-result">
                  <p>
                    Prioridad {capture.question.priority}
                    {capture.suggestion.reasons.length > 0 ? ` — ${capture.suggestion.reasons.join("; ")}` : " — sin factores de urgencia detectados"}.
                  </p>
                  {capture.similar.length > 0 && (
                    <div>
                      <p className="font-semibold text-foreground">Se parece a preguntas ya capturadas:</p>
                      <ul className="list-disc pl-5">
                        {capture.similar.map((s) => (
                          <li key={s.id}>
                            {s.questionText} ({Math.round(s.similarity * 100)}% · {STATUS_LABEL[s.status]})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Borrador asistido</CardTitle>
              <CardDescription>
                El asistente propone borradores a partir de los requisitos extraídos de las bases. No inventa cifras ni numerales: descarta cualquier pregunta con datos que no estén en las bases. Todo queda como borrador pendiente de aprobación humana.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void onDraft(e)} className="flex flex-col gap-2">
                <Input aria-label="Qué aclarar" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Ej. Aclarar garantías y plazos de entrega" />
                <Button type="submit" className="w-fit" disabled={busy === "draft" || instruction.trim().length < 5}>
                  {busy === "draft" ? "Generando…" : "Proponer borradores"}
                </Button>
              </form>
              {draft && (
                <div className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground" data-testid="draft-result">
                  <p>
                    {draft.created.length} borrador(es) creado(s), {draft.skippedDuplicates.length} omitido(s) por duplicados, {draft.rejected.length} descartado(s) por las reglas de seguridad.
                  </p>
                  {draft.rejected.map((r) => (
                    <p key={r.questionText}>Descartada: “{r.questionText}” — {r.detail}</p>
                  ))}
                  {draft.missingData.length > 0 && <p>Datos que faltaron: {draft.missingData.join("; ")}</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preguntas ({data.questions.length})</CardTitle>
          <CardDescription>
            Borrador {data.summary.counts.borrador} · Aprobada {data.summary.counts.aprobada} · Enviada {data.summary.counts.enviada} · Respondida {data.summary.counts.respondida} · Descartada {data.summary.counts.descartada}. Sin enviar: {data.summary.pendingToSend}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.questions.length === 0 && <EstadoVacio mensaje="Aún no hay preguntas para esta junta." />}
          {data.questions.map(renderQuestion)}
          {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) solo puede consultar.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
