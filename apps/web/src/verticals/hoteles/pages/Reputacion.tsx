// Reputación/CRM (Fase 11/13, REQ-CRM-002/003) — primer panel real: captura
// manual + clasificación automática (sin LLM), listado/detalle, responder una
// reseña, resolver una acción reglada (crea el ticket de mantenimiento REAL para
// ticket_mantenimiento), e índice agregado (métricas). Captura MANUAL siempre
// -- este panel NUNCA se conecta a Google/Booking/TripAdvisor (sin credenciales
// reales en este repo, ver reputacion-client.ts).
//
// Gate: REPUTACION_SUBMIT_ROLES/REPUTACION_VIEW_ROLES/REPUTACION_ACTION_RESOLVE_ROLES
// (domain-hoteles/src/roles.ts) — mismo criterio "cosmético, nunca la única
// barrera" que el resto del panel: un rol sin acceso que intente una acción ve el
// 403/404/409 real del servidor como mensaje de error.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { MessageCircle, Plus } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@atiende/ui";
import {
  ACTION_STATUS_LABELS,
  ACTION_TYPE_LABELS,
  REVIEW_SOURCE_LABELS,
  SENTIMENT_LABELS,
  createGuestReview,
  fetchGuestReviewDetail,
  fetchGuestReviews,
  fetchReputacionIndice,
  resolveGuestReviewAction,
  respondToGuestReview,
} from "../lib/reputacion-client.ts";
import type {
  GuestReview,
  GuestReviewDetail,
  GuestReviewSentiment,
  GuestReviewSource,
  GuestReviewStayState,
  IndiceReputacion,
} from "../lib/reputacion-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const SENTIMENT_FILTERS: ReadonlyArray<GuestReviewSentiment | "todas"> = ["todas", "muy_negativo", "negativo", "neutral", "positivo", "muy_positivo"];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

function sentimentBadgeVariant(s: GuestReviewSentiment): "default" | "destructive" | "secondary" {
  if (s === "muy_negativo" || s === "negativo") return "destructive";
  if (s === "muy_positivo" || s === "positivo") return "default";
  return "secondary";
}

export function ReputacionPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [tab, setTab] = useState<"resenas" | "metricas">("resenas");
  const [filter, setFilter] = useState<GuestReviewSentiment | "todas">("todas");
  const [reviews, setReviews] = useState<readonly GuestReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GuestReviewDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const [indice, setIndice] = useState<IndiceReputacion | null>(null);
  const [indiceError, setIndiceError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formTexto, setFormTexto] = useState("");
  const [formCalificacion, setFormCalificacion] = useState("");
  const [formSource, setFormSource] = useState<GuestReviewSource>("encuesta_propia");
  const [formStayState, setFormStayState] = useState<GuestReviewStayState>("desconocido");
  const [formError, setFormError] = useState<string | null>(null);

  const [respuestaTexto, setRespuestaTexto] = useState("");

  async function loadReviews() {
    setError(null);
    try {
      setReviews(await fetchGuestReviews(fetch, apiBaseUrl, token, propertyId, filter === "todas" ? undefined : filter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reseñas.");
    }
  }

  useEffect(() => {
    void loadReviews();
  }, [apiBaseUrl, token, propertyId, filter]);

  useEffect(() => {
    if (tab !== "metricas") return;
    setIndiceError(null);
    fetchReputacionIndice(fetch, apiBaseUrl, token, propertyId)
      .then(setIndice)
      .catch((err) => setIndiceError(err instanceof Error ? err.message : "No se pudo cargar el índice de reputación."));
  }, [tab, apiBaseUrl, token, propertyId]);

  async function loadDetail(reviewId: string) {
    setSelectedId(reviewId);
    setDetail(null);
    setRespuestaTexto("");
    try {
      setDetail(await fetchGuestReviewDetail(fetch, apiBaseUrl, token, propertyId, reviewId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle de la reseña.");
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (formTexto.trim().length === 0) {
      setFormError("El texto de la reseña no puede estar vacío.");
      return;
    }
    setBusy(true);
    try {
      const calificacion = formCalificacion.trim() ? Number(formCalificacion) : undefined;
      const { acciones } = await createGuestReview(fetch, apiBaseUrl, token, propertyId, {
        texto: formTexto.trim(),
        calificacion,
        source: formSource,
        stayState: formStayState,
      });
      toast.success(acciones.length > 0 ? `Reseña capturada: ${acciones.length} acción(es) generada(s).` : "Reseña capturada.");
      setFormTexto("");
      setFormCalificacion("");
      setShowForm(false);
      await loadReviews();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo capturar la reseña.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRespond(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || respuestaTexto.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await respondToGuestReview(fetch, apiBaseUrl, token, propertyId, selectedId, respuestaTexto.trim());
      setRespuestaTexto("");
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar la respuesta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveAction(actionId: string, status: "ejecutada" | "descartada") {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await resolveGuestReviewAction(fetch, apiBaseUrl, token, propertyId, actionId, status);
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resolver la acción.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground">Reputación</h1>
        {tab === "resenas" && (
          <Button type="button" onClick={() => setShowForm((v) => !v)}>
            <Plus className="w-4 h-4" strokeWidth={1.75} />
            Capturar reseña
          </Button>
        )}
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "resenas" | "metricas")}>
        <TabsList>
          <TabsTrigger value="resenas">Reseñas</TabsTrigger>
          <TabsTrigger value="metricas">Métricas</TabsTrigger>
        </TabsList>

        <TabsContent value="resenas" className="flex flex-col gap-4 mt-4">
          {showForm && (
            <Card>
              <CardHeader>
                <CardTitle>Capturar reseña/encuesta</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="flex flex-col gap-3" onSubmit={(e) => void handleCreate(e)}>
                  <Label htmlFor="resena-texto">Texto</Label>
                  <textarea
                    id="resena-texto"
                    className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formTexto}
                    onChange={(e) => setFormTexto(e.target.value)}
                    maxLength={4000}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="resena-calificacion">Calificación (1-5, opcional)</Label>
                      <Input id="resena-calificacion" type="number" min={1} max={5} value={formCalificacion} onChange={(e) => setFormCalificacion(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="resena-source">Fuente</Label>
                      <select
                        id="resena-source"
                        className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={formSource}
                        onChange={(e) => setFormSource(e.target.value as GuestReviewSource)}
                      >
                        {Object.entries(REVIEW_SOURCE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="resena-stay">Estado de la estancia</Label>
                      <select
                        id="resena-stay"
                        className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={formStayState}
                        onChange={(e) => setFormStayState(e.target.value as GuestReviewStayState)}
                      >
                        <option value="desconocido">Desconocido</option>
                        <option value="en_estancia">En estancia</option>
                        <option value="post_estancia">Post-estancia</option>
                      </select>
                    </div>
                  </div>
                  {formError && <p className="text-sm text-destructive">{formError}</p>}
                  <Button type="submit" disabled={busy} className="self-start">
                    Capturar y clasificar
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <Tabs value={filter} onValueChange={(v) => setFilter(v as GuestReviewSentiment | "todas")}>
            <TabsList>
              {SENTIMENT_FILTERS.map((f) => (
                <TabsTrigger key={f} value={f}>
                  {f === "todas" ? "Todas" : SENTIMENT_LABELS[f]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={filter} className="flex flex-col gap-4 mt-4">
              {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void loadReviews()} />}
              {!reviews && !error && <EstadoCargando etiqueta="Cargando reseñas…" />}
              {reviews && reviews.length === 0 && <EstadoVacio mensaje="No hay reseñas en este filtro." />}

              <div className="flex flex-col gap-3">
                {reviews?.map((r) => (
                  <Card key={r.id} className={selectedId === r.id ? "border-primary" : undefined}>
                    <CardContent className="p-4 flex flex-col gap-2">
                      <div className="flex justify-between gap-2 flex-wrap">
                        <div>
                          <p className="text-sm text-foreground line-clamp-2">{r.texto}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {REVIEW_SOURCE_LABELS[r.source]} · {fmtDate(r.createdAt)} {r.calificacion ? `· ${r.calificacion}/5` : ""}
                          </p>
                        </div>
                        <Badge variant={sentimentBadgeVariant(r.sentiment)} className="self-start">
                          {SENTIMENT_LABELS[r.sentiment]}
                        </Badge>
                      </div>
                      {r.topics.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.topics.map((t) => (
                            <Badge key={t.topic} variant="outline" className="text-[10px]">
                              {t.topic}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void loadDetail(r.id)}>
                        <MessageCircle className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Ver detalle / responder
                      </Button>

                      {selectedId === r.id && (
                        <div className="mt-2 border-t pt-3 flex flex-col gap-3">
                          {!detail && <EstadoCargando etiqueta="Cargando detalle…" />}
                          {detail && detail.resena.id === r.id && (
                            <>
                              {detail.acciones.length > 0 && (
                                <div className="flex flex-col gap-2">
                                  <p className="text-xs font-medium text-foreground">Acciones sugeridas</p>
                                  {detail.acciones.map((a) => (
                                    <div key={a.id} className="flex items-center justify-between gap-2 text-xs bg-muted/40 rounded-md p-2">
                                      <div>
                                        <p className="font-medium">{ACTION_TYPE_LABELS[a.actionType]}</p>
                                        <p className="text-muted-foreground">{a.reason}</p>
                                        {a.ticketId && <p className="text-muted-foreground">Ticket: {a.ticketId}</p>}
                                      </div>
                                      {a.status === "pendiente" ? (
                                        <div className="flex gap-1 shrink-0">
                                          <Button type="button" size="sm" onClick={() => void handleResolveAction(a.id, "ejecutada")} disabled={busy}>
                                            Ejecutar
                                          </Button>
                                          <Button type="button" size="sm" variant="outline" onClick={() => void handleResolveAction(a.id, "descartada")} disabled={busy}>
                                            Descartar
                                          </Button>
                                        </div>
                                      ) : (
                                        <Badge variant="secondary">{ACTION_STATUS_LABELS[a.status]}</Badge>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="flex flex-col gap-2">
                                <p className="text-xs font-medium text-foreground">Respuestas</p>
                                {detail.respuestas.length === 0 && <p className="text-xs text-muted-foreground">Todavía no hay ninguna respuesta.</p>}
                                {detail.respuestas.map((resp) => (
                                  <p key={resp.id} className="text-xs bg-muted/40 rounded-md p-2">
                                    {resp.texto}
                                    <span className="block text-[10px] text-muted-foreground mt-1">{fmtDate(resp.createdAt)}</span>
                                  </p>
                                ))}
                                <form className="flex gap-2" onSubmit={(e) => void handleRespond(e)}>
                                  <Input
                                    value={respuestaTexto}
                                    onChange={(e) => setRespuestaTexto(e.target.value)}
                                    placeholder="Escribe una respuesta…"
                                    maxLength={2000}
                                  />
                                  <Button type="submit" size="sm" disabled={busy || respuestaTexto.trim().length === 0}>
                                    Responder
                                  </Button>
                                </form>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="metricas" className="flex flex-col gap-4 mt-4">
          {indiceError && <EstadoError titulo="Ocurrió un problema" mensaje={indiceError} onReintentar={() => setTab("metricas")} />}
          {!indice && !indiceError && <EstadoCargando etiqueta="Cargando métricas…" />}
          {indice && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Reseñas totales</p>
                    <p className="text-2xl font-semibold">{indice.totalResenas}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Índice de reputación</p>
                    <p className="text-2xl font-semibold">{indice.puntajeIndice !== null ? indice.puntajeIndice.toFixed(0) : "—"}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Calificación promedio</p>
                    <p className="text-2xl font-semibold">{indice.promedioCalificacion !== null ? indice.promedioCalificacion.toFixed(1) : "—"}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Sentimiento promedio</p>
                    <p className="text-2xl font-semibold">{indice.promedioSentimiento !== null ? indice.promedioSentimiento.toFixed(2) : "—"}</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Distribución de sentimiento</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-3">
                  {(Object.keys(SENTIMENT_LABELS) as GuestReviewSentiment[]).map((s) => (
                    <div key={s} className="flex flex-col gap-1">
                      <Badge variant={sentimentBadgeVariant(s)}>{SENTIMENT_LABELS[s]}</Badge>
                      <p className="text-xs text-muted-foreground text-center">
                        {indice.distribucionSentimiento[s]} ({indice.distribucionSentimientoPct[s]}%)
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Temas críticos</CardTitle>
                </CardHeader>
                <CardContent>
                  {indice.temasCriticos.length === 0 ? (
                    <EstadoVacio mensaje="Ningún tema alcanza el umbral de crítico todavía." />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {indice.temasCriticos.map((t) => (
                        <div key={t.topic} className="flex justify-between text-sm border-b pb-1">
                          <span>{t.topic}</span>
                          <span className="text-muted-foreground">
                            {t.resenasNegativas}/{t.resenas} negativas ({t.pctNegativo.toFixed(0)}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
