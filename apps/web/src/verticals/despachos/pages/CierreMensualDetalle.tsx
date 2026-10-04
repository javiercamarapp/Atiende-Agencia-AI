// Ficha de un período de cierre (Fase 9) — el checklist real: GET .../periodos/:id
// (periodo + tareas + estado agregado, cierre-mensual.ts), completar una tarea
// (POST .../tareas/:id/completar — el motor `completarTarea` en
// @atiende/domain-despachos bloquea completar si alguna dependencia sigue sin
// terminar, mismo orden que la plantilla real del despacho) y cerrar el período
// (POST .../cerrar — `CERRAR_PERIODO_ROLES = ["admin"]`: acción irreversible en
// esta fase, sin reapertura implementada, ver roles.ts). El reporte de cierre
// (GET .../reporte) se trae bajo demanda para no pedirlo en cada carga de la
// página.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Check, FileBarChart, Lock } from "lucide-react";
import { Button, Callout, Card, CardContent, ConfirmDialog, EstadoCargando, EstadoError, PageContainer, PageHeader, Separator, StatusBadge, statusTone } from "@atiende/ui";
import { cerrarPeriodoCierre, completarTareaCierre, fetchPeriodoDetalle, fetchReporteCierre } from "../lib/cierre-mensual-client.ts";
import type { CloseTask, PeriodoDetalle, ReporteCierre } from "../lib/cierre-mensual-client.ts";
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
  async function handleCerrar(texto: string) {
    if (!periodoId) return;
    setActionError(null);
    setCerrando(true);
    try {
      await cerrarPeriodoCierre(fetch, apiBaseUrl, token, propertyId, periodoId, texto);
      setConfirmando(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo cerrar el período.");
      throw err;
    } finally {
      setCerrando(false);
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

  if (!periodoId) return <EstadoError mensaje="Período no especificado." />;
  if (loading && !detalle) return <EstadoCargando etiqueta="Cargando período de cierre…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!detalle) return null;

  const { periodo, tareas, estado } = detalle;
  const periodoTexto = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        atras={{ etiqueta: "Cierre mensual", to: `/despachos/${orgSlug}/cierre-mensual` }}
        titulo={formatPeriodo(periodo.year, periodo.month)}
        descripcion={`${formatPeriodStatus(periodo.status)} · Abierto ${formatDate(periodo.openedAt)}${periodo.closedAt ? ` · Cerrado ${formatDate(periodo.closedAt)}` : ""}`}
        acciones={
          periodo.status !== "closed" && CERRAR_ROLES.has(role) && !confirmando ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setActionError(null);
                setConfirmando(true);
              }}
            >
              <Lock />
              Cerrar período
            </Button>
          ) : undefined
        }
      />

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

      {actionError && !confirmando && <Callout tone="danger">{actionError}</Callout>}

      <div className="flex flex-col gap-2">
        {tareas.map((t) => {
          const puedeCompletar = GESTIONAR_ROLES.has(role) && t.status !== "done" && t.status !== "skipped" && t.status !== "blocked";
          return (
            <Card key={t.id}>
              <CardContent className="flex items-start justify-between gap-3 p-4">
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
                  <Button className="shrink-0" onClick={() => handleCompletar(t.id)} loading={busyTaskId === t.id}>
                    <Check />
                    Completar
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div>
        <Separator className="mb-4" />
        <Button variant="outline" size="sm" onClick={handleVerReporte} loading={cargandoReporte}>
          <FileBarChart />
          {reporte ? "Actualizar reporte" : "Ver reporte de cierre"}
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
