// Sala de guerra de una convocatoria (L-04). Dos pestanas sobre la misma convocatoria:
//  - Tablero de preparación: checklist de requisitos, tareas y riesgos con responsable,
//    fecha límite con semaforo y estado; bitácora de decisiones y comentarios; la ultima
//    decision go/no-go YA registrada (solo lectura, se decide en la convocatoria).
//  - Junta de aclaraciones: ver JuntaAclaraciones.tsx.
// Los controles que el servidor rechazaria por rol se ocultan (cosmetico: el servidor es
// la unica barrera real). Si la base aún no tiene la migración 029, el tablero lo dice y
// sigue mostrando los requisitos y las decisiones go/no-go existentes; nunca finge datos.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { StatusTone } from "@atiende/ui";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, NativeSelect, PageContainer, StatusBadge, statusTone, Textarea } from "@atiende/ui";
import { addWarRoomEntry, createWarRoomItem, fetchWarRoom, importWarRoomRequirements, updateWarRoomItem } from "../lib/sala-guerra-client.ts";
import { SEMAFORO_TONES } from "../lib/status-tones.ts";
import type { DeadlineSemaphore, SemaphoreColor, WarRoomBoardResponse, WarRoomItem, WarRoomItemKind, WarRoomItemStatus, WarRoomSeverity } from "../lib/sala-guerra-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";
import { JuntaAclaracionesSection } from "./JuntaAclaraciones.tsx";

// Espejos cosmeticos de WRITE_ROLES / GO_NO_GO_ROLES (domain-licitaciones/roles.ts).
export const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);
const DECISION_ENTRY_ROLES = new Set(["owner", "admin", "analyst", "reviewer"]);

export const DATE_TIME = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

/** Tono de <StatusBadge> de un color de semáforo (rojo/amarillo/verde/gris), compartido con la junta de aclaraciones. */
export function semaphoreTone(color: SemaphoreColor): StatusTone {
  return statusTone(SEMAFORO_TONES, color);
}
export const SEMAPHORE_TEXT: Record<SemaphoreColor, string> = { rojo: "Rojo", amarillo: "Amarillo", verde: "Verde", gris: "Sin urgencia" };

export function semaphoreLabel(s: DeadlineSemaphore): string {
  switch (s.state) {
    case "vencido":
      return "Vencido";
    case "vence_hoy":
      return "Vence en menos de 24 h";
    case "vence_pronto":
      return "Vence en menos de 72 h";
    case "en_tiempo":
      return "En tiempo";
    case "cerrado":
      return "Cerrado";
    default:
      return "Sin fecha";
  }
}

/** `<input type="datetime-local">` no trae offset: se agrega el del navegador (nunca se asume UTC). */
export function localToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABEL: Record<WarRoomItemKind, string> = { requisito: "Requisito", tarea: "Tarea", riesgo: "Riesgo" };
const STATUS_LABEL: Record<WarRoomItemStatus, string> = { pendiente: "Pendiente", en_curso: "En curso", listo: "Listo", bloqueado: "Bloqueado", descartado: "Descartado" };
const SEVERITY_LABEL: Record<WarRoomSeverity, string> = { baja: "Baja", media: "Media", alta: "Alta", critica: "Crítica" };
const ENTRY_LABEL = { decision: "Decisión", comentario: "Comentario", evento: "Evento" } as const;

type Tab = "tablero" | "junta";

export function SalaGuerraPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tab, setTab] = useState<Tab>("tablero");
  const [data, setData] = useState<WarRoomBoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kind, setKind] = useState<WarRoomItemKind>("tarea");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<WarRoomSeverity>("media");
  const [due, setDue] = useState("");
  const [assignToMe, setAssignToMe] = useState(false);

  const [entryKind, setEntryKind] = useState<"comentario" | "decision">("comentario");
  const [entryBody, setEntryBody] = useState("");

  const canWrite = WRITE_ROLES.has(role);
  const canDecide = DECISION_ENTRY_ROLES.has(role);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchWarRoom(fetch, apiBaseUrl, token, propertyId, id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la sala de guerra.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage?: string) {
    if (!tenderId) return;
    setActionError(null);
    setNotice(null);
    setBusy(key);
    try {
      await fn();
      if (okMessage) setNotice(okMessage);
      await load(tenderId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(null);
    }
  }

  async function onAddItem(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    await run(
      "add-item",
      async () => {
        await createWarRoomItem(fetch, apiBaseUrl, token, propertyId, tenderId!, {
          kind,
          title,
          description: description.trim() ? description : null,
          severity: kind === "riesgo" ? severity : null,
          responsibleUserId: assignToMe ? data.viewerUserId : null,
          dueAt: localToIso(due),
        });
        setTitle("");
        setDescription("");
        setDue("");
        setAssignToMe(false);
      },
      "Item agregado al tablero.",
    );
  }

  async function onAddEntry(e: FormEvent) {
    e.preventDefault();
    await run(
      "add-entry",
      async () => {
        await addWarRoomEntry(fetch, apiBaseUrl, token, propertyId, tenderId!, { entryKind, body: entryBody });
        setEntryBody("");
      },
      entryKind === "decision" ? "Decisión registrada en la bitácora." : "Comentario agregado.",
    );
  }

  if (!tenderId) return <EstadoError mensaje="Falta el id de la convocatoria en la URL." />;
  if (loading && !data) return <EstadoCargando etiqueta="Cargando sala de guerra…" />;
  if (loadError && !data) return <EstadoError mensaje={loadError} onReintentar={() => void load(tenderId)} />;
  if (!data) return null;

  const { board } = data;
  const byKind = (k: WarRoomItemKind) => board.items.filter((i) => i.kind === k);

  function renderItem(item: WarRoomItem) {
    const closed = item.status === "listo" || item.status === "descartado";
    return (
      <div key={item.id} className="flex flex-col gap-2 rounded-xl border border-border p-3" data-testid={`item-${item.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge dot={false}>{KIND_LABEL[item.kind]}</StatusBadge>
              {item.severity && <StatusBadge tone={item.severity === "critica" || item.severity === "alta" ? "danger" : "warning"}>Severidad {SEVERITY_LABEL[item.severity].toLowerCase()}</StatusBadge>}
              <span className={closed ? "font-semibold text-muted-foreground line-through" : "font-semibold text-foreground"}>{item.title}</span>
            </div>
            {item.description && <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{item.description}</p>}
            <p className="mt-1 text-xs text-muted-foreground">
              {item.responsibleUserId ? (item.responsibleUserId === data!.viewerUserId ? "Responsable: tú" : "Responsable: otra persona del equipo") : "Sin responsable"}
              {item.dueAt ? ` · Límite: ${DATE_TIME.format(new Date(item.dueAt))}` : " · Sin fecha límite"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone={semaphoreTone(item.semaphore.color)}>{semaphoreLabel(item.semaphore)}</StatusBadge>
            <StatusBadge dot={false}>{STATUS_LABEL[item.status]}</StatusBadge>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={`Estado de ${item.title}`}
              size="sm"
              wrapperClassName="w-40"
              value={item.status}
              disabled={busy === `st-${item.id}`}
              onChange={(e) => void run(`st-${item.id}`, () => updateWarRoomItem(fetch, apiBaseUrl, token, propertyId, tenderId!, item.id, { status: e.target.value as WarRoomItemStatus }))}
            >
              {(Object.keys(STATUS_LABEL) as WarRoomItemStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
            {item.responsibleUserId === data!.viewerUserId ? (
              <Button type="button" size="sm" variant="outline" disabled={busy === `rs-${item.id}`} onClick={() => void run(`rs-${item.id}`, () => updateWarRoomItem(fetch, apiBaseUrl, token, propertyId, tenderId!, item.id, { responsibleUserId: null }))}>
                Quitarme como responsable
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" disabled={busy === `rs-${item.id}`} onClick={() => void run(`rs-${item.id}`, () => updateWarRoomItem(fetch, apiBaseUrl, token, propertyId, tenderId!, item.id, { responsibleUserId: data!.viewerUserId }))}>
                Asignarme
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const sections: { kind: WarRoomItemKind; title: string; empty: string }[] = [
    { kind: "requisito", title: "Checklist de requisitos", empty: "Aún no hay requisitos en el tablero." },
    { kind: "tarea", title: "Tareas", empty: "Aún no hay tareas." },
    { kind: "riesgo", title: "Riesgos", empty: "Aún no hay riesgos registrados." },
  ];

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      <div className="flex flex-col gap-1">
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Convocatoria
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">Sala de guerra · {data.tender.title}</h1>
        <p className="max-w-[720px] text-sm text-muted-foreground">
          Preparación de la propuesta y de la junta de aclaraciones. Esta pantalla no envía nada a ComprasMX ni a ningún portal: lo que se presenta lo presenta una persona por el canal oficial de la convocante.
        </p>
      </div>

      <div role="tablist" aria-label="Secciones de la sala de guerra" className="flex gap-2">
        <Button type="button" role="tab" aria-selected={tab === "tablero"} variant={tab === "tablero" ? "default" : "outline"} size="sm" onClick={() => setTab("tablero")}>
          Tablero de preparación
        </Button>
        <Button type="button" role="tab" aria-selected={tab === "junta"} variant={tab === "junta" ? "default" : "outline"} size="sm" onClick={() => setTab("junta")}>
          Junta de aclaraciones
        </Button>
      </div>

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

      {tab === "junta" ? (
        <JuntaAclaracionesSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} tenderId={tenderId} role={role} />
      ) : (
        <>
          {!data.available && (
            <div role="status" className="rounded-xl border border-warning/40 bg-warning-tint p-3 text-sm text-foreground">
              La sala de guerra aún no esta disponible en esta base de datos (falta aplicar la migración 029). Se muestran los requisitos de las bases y las decisiones go/no-go que ya existen; no se pueden guardar items todavia.
            </div>
          )}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Resumen">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Semáforo general</div>
                <StatusBadge tone={semaphoreTone(board.summary.semaforoGeneral)}>{SEMAPHORE_TEXT[board.summary.semaforoGeneral]}</StatusBadge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Avance</div>
                <div className="text-lg font-semibold text-foreground">{board.summary.avancePct === null ? "Sin items" : `${board.summary.avancePct}%`}</div>
                <div className="text-xs text-muted-foreground">
                  Requisitos {board.summary.requisitos.listos}/{board.summary.requisitos.total} · Tareas {board.summary.tareas.listas}/{board.summary.tareas.total}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Riesgos abiertos</div>
                <div className="text-lg font-semibold text-foreground">{board.summary.riesgosAbiertos}</div>
                <div className="text-xs text-muted-foreground">{board.summary.riesgosAltos} alta/critica · {board.summary.sinResponsable} sin responsable</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Presentación de propuestas</div>
                <div className="text-sm font-semibold text-foreground">{board.submissionDeadline.at ? DATE_TIME.format(new Date(board.submissionDeadline.at)) : "Sin fecha declarada"}</div>
                <StatusBadge tone={semaphoreTone(board.submissionDeadline.semaphore.color)}>{semaphoreLabel(board.submissionDeadline.semaphore)}</StatusBadge>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Decisión go/no-go</CardTitle>
              <CardDescription>Se decide desde la convocatoria; aquí se muestra la ultima decision registrada.</CardDescription>
            </CardHeader>
            <CardContent>
              {board.goNoGo ? (
                <div className="flex flex-col gap-1 text-sm">
                  <div>
                    <StatusBadge tone={board.goNoGo.decision === "go" ? "success" : "danger"}>{board.goNoGo.decision === "go" ? "Go" : "No-go"}</StatusBadge>{" "}
                    <span className="text-muted-foreground">{DATE_TIME.format(new Date(board.goNoGo.decidedAt))}</span>
                  </div>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {board.goNoGo.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <EstadoVacio mensaje="Todavía no hay una decisión go/no-go registrada." />
              )}
              <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} className="mt-2 inline-block text-sm text-foreground underline">
                Ir a la convocatoria
              </Link>
            </CardContent>
          </Card>

          {canWrite && data.available && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Agregar al tablero</CardTitle>
                <CardDescription>Requisitos, tareas con responsable y fecha límite, o riesgos con severidad.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={(e) => void onAddItem(e)} className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    Tipo
                    <NativeSelect aria-label="Tipo de item" value={kind} onChange={(e) => setKind(e.target.value as WarRoomItemKind)}>
                      <option value="requisito">Requisito</option>
                      <option value="tarea">Tarea</option>
                      <option value="riesgo">Riesgo</option>
                    </NativeSelect>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Título
                    <Input aria-label="Título del item" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Recabar carta del fabricante" />
                  </label>
                  {kind === "riesgo" && (
                    <label className="flex flex-col gap-1 text-sm">
                      Severidad
                      <NativeSelect aria-label="Severidad del riesgo" value={severity} onChange={(e) => setSeverity(e.target.value as WarRoomSeverity)}>
                        {(Object.keys(SEVERITY_LABEL) as WarRoomSeverity[]).map((s) => (
                          <option key={s} value={s}>
                            {SEVERITY_LABEL[s]}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-sm">
                    Fecha límite
                    <Input aria-label="Fecha límite del item" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                    Descripción (opcional)
                    <Textarea aria-label="Descripción del item" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
                  </label>
                  <Checkbox label="Asignármelo" checked={assignToMe} onChange={(e) => setAssignToMe(e.target.checked)} />
                  <div className="sm:col-span-2">
                    <Button type="submit" disabled={busy === "add-item" || title.trim().length < 3}>
                      {busy === "add-item" ? "Agregando…" : "Agregar al tablero"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {data.importableRequirements.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Requisitos de las bases sin importar ({data.importableRequirements.length})</CardTitle>
                <CardDescription>Extraídos de las bases de la convocatoria; impórtalos para darles responsable, fecha y seguimiento.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {data.importableRequirements.slice(0, 8).map((r) => (
                    <li key={r.id}>{r.clause ? `${r.clause}: ` : ""}{r.text}</li>
                  ))}
                  {data.importableRequirements.length > 8 && <li>… y {data.importableRequirements.length - 8} más</li>}
                </ul>
                {canWrite && data.available && (
                  <Button type="button" variant="outline" className="w-fit" disabled={busy === "import"} onClick={() => void run("import", () => importWarRoomRequirements(fetch, apiBaseUrl, token, propertyId, tenderId), "Requisitos importados al tablero.")}>
                    {busy === "import" ? "Importando…" : "Importar requisitos al tablero"}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {sections.map((section) => {
            const items = byKind(section.kind);
            return (
              <Card key={section.kind}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {section.title} ({items.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {items.length === 0 && <EstadoVacio mensaje={section.empty} />}
                  {items.map(renderItem)}
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bitácora de decisiones y comentarios</CardTitle>
              <CardDescription>Registro de solo-agregar: lo escrito aquí no se edita ni se borra. Los eventos los genera el sistema.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {canWrite && data.available && (
                <form onSubmit={(e) => void onAddEntry(e)} className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <NativeSelect aria-label="Tipo de anotación" size="sm" wrapperClassName="w-44" value={entryKind} onChange={(e) => setEntryKind(e.target.value as "comentario" | "decision")}>
                      <option value="comentario">Comentario</option>
                      {canDecide && <option value="decision">Decisión</option>}
                    </NativeSelect>
                  </div>
                  <Textarea aria-label="Texto de la anotación" rows={2} value={entryBody} onChange={(e) => setEntryBody(e.target.value)} placeholder="Escribe un comentario o la decision tomada…" />
                  <Button type="submit" className="w-fit" disabled={busy === "add-entry" || entryBody.trim().length === 0}>
                    {busy === "add-entry" ? "Guardando…" : "Agregar a la bitácora"}
                  </Button>
                </form>
              )}
              {data.entries.length === 0 && <EstadoVacio mensaje="La bitácora está vacía." />}
              {data.entries.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={entry.entryKind === "decision" ? "info" : "neutral"} dot={false}>{ENTRY_LABEL[entry.entryKind]}</StatusBadge>
                    <span className="text-xs text-muted-foreground">{DATE_TIME.format(new Date(entry.createdAt))}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-foreground">{entry.body}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
