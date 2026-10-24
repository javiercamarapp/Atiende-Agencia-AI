// Ficha de un período de cierre (Fase 9) — el checklist real: GET .../periodos/:id
// (periodo + tareas + estado agregado, cierre-mensual.ts), completar una tarea
// (POST .../tareas/:id/completar — el motor `completarTarea` en
// @atiende/domain-despachos bloquea completar si alguna dependencia sigue sin
// terminar, mismo orden que la plantilla real del despacho) y cerrar el período
// (POST .../cerrar — `CERRAR_PERIODO_ROLES = ["admin"]`: acción irreversible en
// esta fase, sin reapertura implementada, ver roles.ts). El reporte de cierre
// (GET .../reporte) se trae bajo demanda para no pedirlo en cada carga de la
// página. paridad3: el detalle trae las validaciones calculadas en el servidor
// (bloquean el cierre; un admin puede forzar con motivo), y al cerrar los
// entregables pre-generados (XML de contabilidad electrónica) y la entrega al cliente.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Download, FileBarChart, Lock } from "lucide-react";
import { Button, Callout, Card, CardContent, ConfirmDialog, EstadoCargando, EstadoError, FormDialog, Input, Label, PageContainer, Separator, StatusBadge, Textarea, statusTone } from "@atiende/ui";
import { cerrarPeriodoCierre, completarTareaCierre, descargarArtefactoCierre, ETIQUETA_ARTEFACTO, fetchPeriodoDetalle, fetchReporteCierre, motivoForzadoValido, textoPosCierre } from "../lib/cierre-mensual-client.ts";
import type { ArtefactoCierre, CloseTask, PeriodoDetalle, PosCierre, ReporteCierre } from "../lib/cierre-mensual-client.ts";
import { formatDate, formatPeriodStatus, formatPeriodo, formatTaskCategory, formatTaskStatus } from "../lib/format.ts";
import { TAREA_STATUS_TONES } from "../lib/status-tones.ts";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);
const CERRAR_ROLES = new Set(["admin"]);

// Misma carga semántica de siempre (gris = pendiente, azul = en curso, rojo = bloqueada, verde = hecha, gris tenue = omitida).
function TaskStatusBadge({ status }: { status: CloseTask["status"] }) {
  return <StatusBadge tone={statusTone(TAREA_STATUS_TONES, status)}>{formatTaskStatus(status)}</StatusBadge>;
}

export function CierreMensualDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const { periodoId } = useParams<{ periodoId: string }>();
  const [detalle, setDetalle] = useState<PeriodoDetalle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [cerrando, setCerrando] = useState(false);
  const [reporte, setReporte] = useState<ReporteCierre | null>(null);
  const [cargandoReporte, setCargandoReporte] = useState(false);
  // Hallazgo de auditoría (severidad ALTA, "cierre-mensual es irreversible y
  // ejecuta con un clic sin confirmación ni reapertura"): el primer clic solo
  // abre este panel -- cerrar de verdad exige teclear el período exacto y dar
  // un SEGUNDO clic. El servidor (cierre-mensual.ts) exige el mismo texto de
  // todas formas, así que esto no es solo cosmético del lado del cliente: sin
  // él, cada intento devolvería 400.
  const [confirmando, setConfirmando] = useState(false);
  // paridad3 D-P3-15: si las validaciones derivadas fallan, un admin puede FORZAR el cierre con un motivo obligatorio (queda en el periodo).
  const [forzando, setForzando] = useState(false);
  const [motivoForzado, setMotivoForzado] = useState("");
  const [textoForzado, setTextoForzado] = useState("");
  const [posCierre, setPosCierre] = useState<PosCierre | null>(null);
  const [descargando, setDescargando] = useState<string | null>(null);

  async function load() {
    if (!periodoId) return;
    setLoading(true);
    setError(null);
    try {
      setDetalle(await fetchPeriodoDetalle(fetch, apiBaseUrl, token, propertyId, periodoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el período de cierre.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, periodoId]);

  async function handleCompletar(taskId: string) {
    if (!periodoId) return;
    setActionError(null);
    setBusyTaskId(taskId);
    try {
      await completarTareaCierre(fetch, apiBaseUrl, token, propertyId, periodoId, taskId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la tarea.");
    } finally {
      setBusyTaskId(null);
    }
  }

  // `texto` es el período que el staff tecleó en el diálogo (ya recortado). Si el servidor rechaza el cierre se
  // relanza el error: `ConfirmDialog` deja el diálogo abierto (mostrando `actionError`) en vez de cerrarlo solo.
  async function handleCerrar(texto: string, forzado?: { readonly motivo: string }) {
    if (!periodoId) return;
    setActionError(null);
    setCerrando(true);
    try {
      const cerrado = await cerrarPeriodoCierre(fetch, apiBaseUrl, token, propertyId, periodoId, texto, forzado);
      setPosCierre(cerrado.posCierre ?? null);
      setConfirmando(false);
      setForzando(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo cerrar el período.");
      // Si el servidor bloqueo el cierre por validaciones, la lista de abajo se refresca para mostrar exactamente que falta.
      await load();
      throw err;
    } finally {
      setCerrando(false);
    }
  }

  async function handleDescargar(a: ArtefactoCierre) {
    if (!periodoId) return;
    setActionError(null);
    setDescargando(a.id);
    try {
      const { blob, nombre } = await descargarArtefactoCierre(fetch, apiBaseUrl, token, propertyId, periodoId, a.id, a.nombreArchivo);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = nombre;
      enlace.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo descargar el archivo.");
    } finally {
      setDescargando(null);
    }
  }

  async function handleVerReporte() {
    if (!periodoId) return;
    setActionError(null);
    setCargandoReporte(true);
    try {
      setReporte(await fetchReporteCierre(fetch, apiBaseUrl, token, propertyId, periodoId));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo generar el reporte.");
    } finally {
      setCargandoReporte(false);
    }
  }

  if (!periodoId) return <p role="alert" className="text-destructive text-sm">Período no especificado.</p>;
  if (loading && !detalle) return <EstadoCargando etiqueta="Cargando período de cierre…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!detalle) return null;

  const { periodo, tareas, estado } = detalle;
  const periodoTexto = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;
  const validaciones = detalle.validaciones;
  const fallidas = validaciones?.items.filter((v) => v.bloqueante && !v.ok) ?? [];
  const bloqueado = validaciones?.disponible === true && !validaciones.puedeCerrar;
  const documentos = validaciones?.items.find((v) => v.clave === "solicitud_documentos");

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <div>
        <Link to={`/despachos/${orgSlug}/cierre-mensual`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Cierre mensual
        </Link>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">{formatPeriodo(periodo.year, periodo.month)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatPeriodStatus(periodo.status)} · Abierto {formatDate(periodo.openedAt)}
            {periodo.closedAt && ` · Cerrado ${formatDate(periodo.closedAt)}`}
          </p>
          {documentos && validaciones?.disponible && periodo.status !== "closed" && (
            <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              Documentos del cliente:
              <StatusBadge tone={documentos.detalle.estado === null ? "neutral" : documentos.ok ? "success" : "warning"}>{documentos.detalle.estado === null ? "Sin pedir" : documentos.ok ? "Completos" : `Faltan ${String(documentos.detalle.pendientes ?? 0)}`}</StatusBadge>
            </p>
          )}
        </div>
        {periodo.status !== "closed" && CERRAR_ROLES.has(role) && !confirmando && (
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:border-destructive"
            onClick={() => {
              setActionError(null);
              if (bloqueado) setForzando(true);
              else setConfirmando(true);
            }}
          >
            <Lock />
            {bloqueado ? "Cerrar con excepciones" : "Cerrar período"}
          </Button>
        )}
      </header>

      {/* Hallazgo de auditoría (severidad ALTA, "cierre-mensual es irreversible y
          ejecuta con un clic sin confirmación ni reapertura"): un solo clic ya NO
          cierra nada -- hay que teclear el período exacto que se ve en pantalla y
          dar un segundo clic. El servidor exige el mismo texto de todas formas
          (cierre-mensual.ts), así que esto no es solo un candado cosmético.
          Presentación: `ConfirmDialog` de @atiende/ui (DS v2) con campo de texto validado. */}
      {periodo.status !== "closed" && CERRAR_ROLES.has(role) && (
        <ConfirmDialog
          open={confirmando}
          onOpenChange={(abierto) => {
            if (!abierto && !cerrando) setConfirmando(false);
          }}
          titulo={`Confirmar cierre de ${formatPeriodo(periodo.year, periodo.month)}`}
          tono="danger"
          confirmar={cerrando ? "Cerrando…" : "Confirmar cierre irreversible"}
          descripcion={
            <>
              Esta acción es <strong className="text-destructive">irreversible</strong> — no hay forma de reabrir el período desde el producto. Bloquea la edición de todos los movimientos de{" "}
              {formatPeriodo(periodo.year, periodo.month)}.
              {actionError && (
                <span role="alert" className="mt-2 block text-destructive">
                  {actionError}
                </span>
              )}
            </>
          }
          campo={{
            etiqueta: `Escribe exactamente ${periodoTexto} para confirmar`,
            placeholder: periodoTexto,
            validar: (v) => (v === periodoTexto ? null : `Escribe exactamente ${periodoTexto}.`),
          }}
          onConfirm={(texto) => handleCerrar(texto ?? "")}
        />
      )}

      {periodo.status !== "closed" && CERRAR_ROLES.has(role) && bloqueado && (
        <FormDialog
          open={forzando}
          onOpenChange={(abierto) => !abierto && !cerrando && setForzando(false)}
          titulo={`Cerrar ${formatPeriodo(periodo.year, periodo.month)} con excepciones`}
          subtitulo="Hay validaciones sin cumplir. Cerrar es irreversible."
          anchoClase="max-w-2xl"
          bloquearCierre={cerrando}
          footer={
            <>
              <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setForzando(false)} disabled={cerrando}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="rounded-full px-6"
                disabled={cerrando || textoForzado !== periodoTexto || !motivoForzadoValido(motivoForzado)}
                onClick={() => void handleCerrar(textoForzado, { motivo: motivoForzado.trim() }).catch(() => undefined)}
              >
                {cerrando ? "Cerrando…" : "Cerrar de todos modos"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Callout tone="warning" role="status">
              Se cerrará {formatPeriodo(periodo.year, periodo.month)} aunque no se cumpla lo siguiente. El motivo queda registrado en el período y la bitácora anota qué validaciones se saltaron.
            </Callout>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
              {fallidas.map((v) => (
                <li key={v.clave}>
                  <strong>{v.titulo}:</strong> {v.mensaje}
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="motivo-forzado">Motivo (10 a 500 caracteres)</Label>
              <Textarea id="motivo-forzado" rows={3} maxLength={500} value={motivoForzado} onChange={(e) => setMotivoForzado(e.target.value)} placeholder="Por qué se cierra con estas excepciones" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="texto-forzado">Escribe exactamente {periodoTexto} para confirmar</Label>
              <Input id="texto-forzado" value={textoForzado} onChange={(e) => setTextoForzado(e.target.value.trim())} placeholder={periodoTexto} />
            </div>
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
          </div>
        </FormDialog>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="mb-1.5 flex justify-between text-sm text-foreground">
            <span>
              Avance: {estado.done + estado.skipped} de {estado.totalTasks} tareas
            </span>
            <strong className="tabular-nums">{estado.progressPercent}%</strong>
          </div>
          <BarraProgreso valor={estado.progressPercent} tono={periodo.status === "overdue" ? "danger" : "primary"} aria-label="Avance del cierre" />
          {estado.overdue.length > 0 && <p className="mt-2 text-xs text-destructive">{estado.overdue.length} tarea(s) vencida(s).</p>}
          {estado.blocked.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{estado.blocked.length} tarea(s) bloqueada(s) por dependencias.</p>}
        </CardContent>
      </Card>

      {posCierre && textoPosCierre(posCierre).length > 0 && (
        <Callout tone="info" role="status">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
            {textoPosCierre(posCierre).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </Callout>
      )}

      {validaciones?.disponible && validaciones.items.length > 0 && periodo.status !== "closed" && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold text-foreground">Validaciones del cierre</h2>
              <StatusBadge tone={validaciones.puedeCerrar ? "success" : "danger"}>{validaciones.puedeCerrar ? "Listo para cerrar" : `${fallidas.length} sin cumplir`}</StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground">Las calcula el servidor desde lo que ya está registrado; se actualizan solas cada vez que abres el período.</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {validaciones.items.map((v) => (
                <li key={v.clave} className="flex items-start gap-2 text-sm">
                  {v.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" strokeWidth={1.75} aria-label="Cumple" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" strokeWidth={1.75} aria-label="No cumple" />}
                  <span>
                    <strong className="text-foreground">{v.titulo}.</strong> <span className="text-muted-foreground">{v.mensaje}</span>
                    {v.clave === "solicitud_documentos" && !v.ok && (
                      <>
                        {" "}
                        <Link to={`/despachos/${orgSlug}/cartera`} className="text-foreground underline underline-offset-2">
                          Ver en Cartera
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {validaciones && !validaciones.disponible && periodo.status !== "closed" && (
        <Callout tone="warning" role="status">
          No disponible aún: las validaciones automáticas del cierre requieren aplicar la migración 027 en este ambiente. Mientras tanto el cierre se rige solo por las tareas.
        </Callout>
      )}

      {periodo.status === "closed" && ((detalle.artefactos?.length ?? 0) > 0 || detalle.entrega) && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <h2 className="font-display text-base font-semibold text-foreground">Entregables del cierre</h2>
            {(detalle.artefactos?.length ?? 0) > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {detalle.artefactos!.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-foreground">
                      {ETIQUETA_ARTEFACTO[a.tipo]} <span className="text-xs text-muted-foreground">· generado al cerrar, no presentado</span>
                    </span>
                    {GESTIONAR_ROLES.has(role) && (
                      <Button type="button" size="sm" variant="outline" disabled={descargando === a.id} onClick={() => void handleDescargar(a)}>
                        <Download />
                        {descargando === a.id ? "Descargando…" : "Descargar"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {detalle.entrega && (
              <p className="text-sm text-muted-foreground">
                Entrega al cliente: {detalle.entrega.archivos.length} PDF publicado(s) en su portal el {formatDate(detalle.entrega.creadaEn)}
                {detalle.entrega.correoEncoladoEn ? ` · aviso por correo enviado el ${formatDate(detalle.entrega.correoEncoladoEn)}` : " · sin aviso por correo"}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {actionError && (
        <p role="alert" className="text-destructive text-sm">
          {actionError}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {tareas.map((t) => {
          const puedeCompletar = GESTIONAR_ROLES.has(role) && t.status !== "done" && t.status !== "skipped" && t.status !== "blocked";
          return (
            <Card key={t.id}>
              <CardContent className="flex items-start justify-between gap-3 p-3">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm text-foreground">{t.title}</strong>
                    <TaskStatusBadge status={t.status} />
                    <span className="text-xs text-muted-foreground">{formatTaskCategory(t.category)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                  {t.category === "electronica" && (
                    <Link to={`/despachos/${orgSlug}/contabilidad-electronica`} className="inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-2">
                      Ir a Contabilidad electrónica
                      <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
                    </Link>
                  )}
                  {t.completedAt && <p className="mt-1 text-xs text-muted-foreground">Completada {formatDate(t.completedAt)}</p>}
                </div>
                {puedeCompletar && (
                  <Button size="sm" className="h-9 shrink-0" onClick={() => handleCompletar(t.id)} disabled={busyTaskId === t.id}>
                    <Check />
                    {busyTaskId === t.id ? "…" : "Completar"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div>
        <Separator className="mb-4" />
        <Button variant="outline" size="sm" onClick={handleVerReporte} disabled={cargandoReporte}>
          <FileBarChart />
          {cargandoReporte ? "Generando…" : reporte ? "Actualizar reporte" : "Ver reporte de cierre"}
        </Button>
        {reporte && (
          <div className="mt-3 flex flex-col gap-1.5 text-sm text-foreground">
            <p>
              {reporte.done} completadas, {reporte.skipped} omitidas, {reporte.pending} pendientes ({reporte.progressPercent}%) · {reporte.estimatedHours.toFixed(1)}h estimadas
            </p>
            {reporte.issues.length > 0 && (
              <ul className="m-0 list-disc pl-5 text-destructive">
                {reporte.issues.map((i) => (
                  <li key={i.taskId}>
                    {i.title} — {i.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
