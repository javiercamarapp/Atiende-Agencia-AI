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
//
// Visual (UNI-C gestion): PageHeader, DataTable, StatCard, FormDialog con FormField para capturar y para el detalle, y
// useConfirm antes de registrar una respuesta o de ejecutar/descartar una accion sugerida (Cancelar/Escape nunca escriben).
import { useEffect, useState } from "react";
import { Gauge, MessageCircle, MessageSquare, Plus, Smile, Star } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EstadoCargando,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatCard,
  StatusBadge,
  statusTone,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  EstadoError,
  notify,
  useConfirm,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
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
import { SENTIMIENTO_TONES } from "../lib/status-tones.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const SENTIMENT_FILTERS: ReadonlyArray<GuestReviewSentiment | "todas"> = ["todas", "muy_negativo", "negativo", "neutral", "positivo", "muy_positivo"];

export function ReputacionPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [tab, setTab] = useState<"resenas" | "metricas">("resenas");
  const [filter, setFilter] = useState<GuestReviewSentiment | "todas">("todas");
  const [reviews, setReviews] = useState<readonly GuestReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GuestReviewDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirmar, dialogo } = useConfirm();

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
    setDetailError(null);
    setRespuestaTexto("");
    try {
      setDetail(await fetchGuestReviewDetail(fetch, apiBaseUrl, token, propertyId, reviewId));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "No se pudo cargar el detalle de la reseña.");
    }
  }

  async function handleCreate() {
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
      notify.success(acciones.length > 0 ? `Reseña capturada: ${acciones.length} acción(es) generada(s).` : "Reseña capturada.");
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

  async function handleRespond() {
    if (!selectedId || respuestaTexto.trim().length === 0) return;
    const ok = await confirmar({
      titulo: "Registrar la respuesta",
      descripcion: "La respuesta queda guardada en la reseña y no se puede editar después.",
      confirmar: "Responder",
      cancelar: "Volver",
    });
    if (!ok) return;
    setBusy(true);
    setDetailError(null);
    try {
      await respondToGuestReview(fetch, apiBaseUrl, token, propertyId, selectedId, respuestaTexto.trim());
      setRespuestaTexto("");
      notify.success("Respuesta registrada.");
      await loadDetail(selectedId);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "No se pudo enviar la respuesta.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveAction(actionId: string, status: "ejecutada" | "descartada") {
    if (!selectedId) return;
    const ok = await confirmar({
      titulo: status === "ejecutada" ? "Ejecutar la acción sugerida" : "Descartar la acción sugerida",
      descripcion: status === "ejecutada" ? "Se ejecuta ahora (si crea un ticket de mantenimiento, se crea de verdad)." : "La acción queda descartada y no se vuelve a sugerir.",
      tono: status === "descartada" ? "danger" : "default",
      confirmar: status === "ejecutada" ? "Ejecutar" : "Descartar",
      cancelar: "Volver",
    });
    if (!ok) return;
    setBusy(true);
    setDetailError(null);
    try {
      await resolveGuestReviewAction(fetch, apiBaseUrl, token, propertyId, actionId, status);
      await loadDetail(selectedId);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "No se pudo resolver la acción.");
    } finally {
      setBusy(false);
    }
  }

  const columnas: DataTableColumna<GuestReview>[] = [
    {
      id: "resena",
      encabezado: "Reseña",
      principal: true,
      celda: (r) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground line-clamp-2">{r.texto}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {REVIEW_SOURCE_LABELS[r.source]} · {fechaHoraEsMx(r.createdAt)} {r.calificacion ? `· ${r.calificacion}/5` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "sentimiento",
      encabezado: "Sentimiento",
      celda: (r) => <StatusBadge tone={statusTone(SENTIMIENTO_TONES, r.sentiment)}>{SENTIMENT_LABELS[r.sentiment]}</StatusBadge>,
    },
    {
      id: "temas",
      encabezado: "Temas",
      celda: (r) =>
        r.topics.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {r.topics.map((t) => (
              <StatusBadge key={t.topic} tone="neutral" dot={false} className="text-2xs">
                {t.topic}
              </StatusBadge>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (r) => (
        <Button type="button" variant="outline" size="sm" iconLeft={<MessageCircle className="size-3.5" strokeWidth={1.75} />} onClick={() => void loadDetail(r.id)}>
          Ver detalle / responder
        </Button>
      ),
    },
  ];

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Reputación"
        descripcion="Reseñas y encuestas del hotel: captura manual, clasificación automática y acciones sugeridas."
        acciones={
          tab === "resenas" ? (
            <Button
              type="button"
              iconLeft={<Plus className="size-4" strokeWidth={1.75} />}
              onClick={() => {
                setFormError(null);
                setShowForm(true);
              }}
            >
              Capturar reseña
            </Button>
          ) : undefined
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "resenas" | "metricas")}>
        <TabsList>
          <TabsTrigger value="resenas">Reseñas</TabsTrigger>
          <TabsTrigger value="metricas">Métricas</TabsTrigger>
        </TabsList>

        <TabsContent value="resenas" className="flex flex-col gap-4 mt-4">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as GuestReviewSentiment | "todas")}>
            <TabsList>
              {SENTIMENT_FILTERS.map((f) => (
                <TabsTrigger key={f} value={f}>
                  {f === "todas" ? "Todas" : SENTIMENT_LABELS[f]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={filter} className="mt-4">
              <DataTable
                etiqueta="Reseñas"
                columnas={columnas}
                filas={reviews ?? []}
                obtenerId={(r) => r.id}
                estado={error ? "error" : !reviews ? "loading" : reviews.length === 0 ? "empty" : "ok"}
                error={{ titulo: "Ocurrió un problema", mensaje: error ?? undefined, onReintentar: () => void loadReviews() }}
                vacio={{ mensaje: "No hay reseñas en este filtro." }}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="metricas" className="flex flex-col gap-4 mt-4">
          {indiceError && <EstadoError titulo="Ocurrió un problema" mensaje={indiceError} onReintentar={() => setTab("metricas")} />}
          {!indice && !indiceError && <EstadoCargando etiqueta="Cargando métricas…" />}
          {indice && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCard icon={MessageSquare} label="Reseñas totales" value={String(indice.totalResenas)} />
                <StatCard icon={Gauge} label="Índice de reputación" value={indice.puntajeIndice !== null ? indice.puntajeIndice.toFixed(0) : "—"} />
                <StatCard icon={Star} label="Calificación promedio" value={indice.promedioCalificacion !== null ? indice.promedioCalificacion.toFixed(1) : "—"} />
                <StatCard icon={Smile} label="Sentimiento promedio" value={indice.promedioSentimiento !== null ? indice.promedioSentimiento.toFixed(2) : "—"} />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Distribución de sentimiento</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-3">
                  {(Object.keys(SENTIMENT_LABELS) as GuestReviewSentiment[]).map((s) => (
                    <div key={s} className="flex flex-col gap-1">
                      <StatusBadge tone={statusTone(SENTIMIENTO_TONES, s)}>{SENTIMENT_LABELS[s]}</StatusBadge>
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
                        <div key={t.topic} className="flex justify-between text-sm border-b border-line2 pb-1">
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

      <FormDialog
        open={showForm}
        onOpenChange={(abierto) => {
          if (!abierto && !busy) setShowForm(false);
        }}
        titulo="Capturar reseña/encuesta"
        subtitulo="Captura manual: el texto se clasifica solo (sentimiento y temas)."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleCreate()}
        guardando={busy}
        textoBotonGuardar="Capturar y clasificar"
        bloquearCierre={busy}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {formError && <Callout tone="danger" className="sm:col-span-3">{formError}</Callout>}
          <FormField label="Texto" required className="sm:col-span-3">
            <Textarea id="resena-texto" className="min-h-[100px]" value={formTexto} onChange={(e) => setFormTexto(e.target.value)} maxLength={4000} />
          </FormField>
          <FormField label="Calificación (1-5, opcional)">
            <Input id="resena-calificacion" type="number" min={1} max={5} value={formCalificacion} onChange={(e) => setFormCalificacion(e.target.value)} />
          </FormField>
          <FormField label="Fuente">
            <NativeSelect id="resena-source" value={formSource} onChange={(e) => setFormSource(e.target.value as GuestReviewSource)}>
              {Object.entries(REVIEW_SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Estado de la estancia">
            <NativeSelect id="resena-stay" value={formStayState} onChange={(e) => setFormStayState(e.target.value as GuestReviewStayState)}>
              <option value="desconocido">Desconocido</option>
              <option value="en_estancia">En estancia</option>
              <option value="post_estancia">Post-estancia</option>
            </NativeSelect>
          </FormField>
        </div>
      </FormDialog>

      <FormDialog
        open={selectedId !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !busy) {
            setSelectedId(null);
            setDetail(null);
          }
        }}
        titulo="Detalle de la reseña"
        subtitulo={detail ? detail.resena.texto : undefined}
        anchoClase="max-w-3xl"
        footer={
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
            }}
            disabled={busy}
          >
            Cerrar
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {detailError && <Callout tone="danger">{detailError}</Callout>}
          {!detail && !detailError && <EstadoCargando etiqueta="Cargando detalle…" />}
          {detail && (
            <>
              {detail.acciones.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-foreground">Acciones sugeridas</h3>
                  {detail.acciones.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2 text-xs bg-canvas border border-border rounded-lg p-2">
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
                        <StatusBadge tone="neutral" dot={false}>{ACTION_STATUS_LABELS[a.status]}</StatusBadge>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-foreground">Respuestas</h3>
                {detail.respuestas.length === 0 && <p className="text-xs text-muted-foreground">Todavía no hay ninguna respuesta.</p>}
                {detail.respuestas.map((resp) => (
                  <p key={resp.id} className="text-xs bg-canvas border border-border rounded-lg p-2">
                    {resp.texto}
                    <span className="block text-2xs text-muted-foreground mt-1">{fechaHoraEsMx(resp.createdAt)}</span>
                  </p>
                ))}
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleRespond();
                  }}
                >
                  <FormField label="Respuesta" className="flex-1">
                    <Input value={respuestaTexto} onChange={(e) => setRespuestaTexto(e.target.value)} placeholder="Escribe una respuesta…" maxLength={2000} />
                  </FormField>
                  <Button type="submit" loading={busy} disabled={respuestaTexto.trim().length === 0}>
                    Responder
                  </Button>
                </form>
              </div>
            </>
          )}
        </div>
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
