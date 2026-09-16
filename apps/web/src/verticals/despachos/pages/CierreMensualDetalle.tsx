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
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileBarChart, Lock } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EstadoCargando,
  EstadoError,
  Input,
  Label,
  Separator,
} from "@atiende/ui";
import { cerrarPeriodoCierre, completarTareaCierre, fetchPeriodoDetalle, fetchReporteCierre } from "../lib/cierre-mensual-client.ts";
import type { CloseTask, PeriodoDetalle, ReporteCierre } from "../lib/cierre-mensual-client.ts";
import { formatDate, formatPeriodStatus, formatPeriodo, formatTaskCategory, formatTaskStatus } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);
const CERRAR_ROLES = new Set(["admin"]);

// Misma carga semántica que las píldoras inline originales (gris = pendiente,
// azul = en curso, rojo = bloqueada, verde = hecha, gris tenue = omitida), ahora
// sobre el `Badge` real de @atiende/ui.
const TASK_STATUS_BADGE: Record<CloseTask["status"], { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  pending: { variant: "outline", className: "border-transparent bg-muted text-muted-foreground" },
  in_progress: { variant: "secondary" },
  blocked: { variant: "destructive" },
  done: { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
  skipped: { variant: "outline", className: "border-transparent bg-muted text-muted-foreground/70" },
};

function TaskStatusBadge({ status }: { status: CloseTask["status"] }) {
  const { variant, className } = TASK_STATUS_BADGE[status];
  return (
    <Badge variant={variant} className={className}>
      {formatTaskStatus(status)}
    </Badge>
  );
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
  const [textoConfirmacion, setTextoConfirmacion] = useState("");

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

  async function handleCerrar() {
    if (!periodoId) return;
    setActionError(null);
    setCerrando(true);
    try {
      await cerrarPeriodoCierre(fetch, apiBaseUrl, token, propertyId, periodoId, textoConfirmacion.trim());
      setConfirmando(false);
      setTextoConfirmacion("");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo cerrar el período.");
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

  if (!periodoId) return <p role="alert" className="text-destructive text-sm">Período no especificado.</p>;
  if (loading && !detalle) return <EstadoCargando etiqueta="Cargando período de cierre…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!detalle) return null;

  const { periodo, tareas, estado } = detalle;
  const periodoTexto = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;

  return (
    <div className="flex max-w-4xl flex-col gap-4 px-1">
      <div>
        <Link to={`/despachos/${orgSlug}/cierre-mensual`} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Cierre mensual
        </Link>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">{formatPeriodo(periodo.year, periodo.month)}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {formatPeriodStatus(periodo.status)} · Abierto {formatDate(periodo.openedAt)}
            {periodo.closedAt && ` · Cerrado ${formatDate(periodo.closedAt)}`}
          </p>
        </div>
        {periodo.status !== "closed" && CERRAR_ROLES.has(role) && !confirmando && (
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:border-destructive"
            onClick={() => {
              setActionError(null);
              setTextoConfirmacion("");
              setConfirmando(true);
            }}
          >
            <Lock />
            Cerrar período
          </Button>
        )}
      </header>

      {/* Hallazgo de auditoría (severidad ALTA, "cierre-mensual es irreversible y
          ejecuta con un clic sin confirmación ni reapertura"): un solo clic ya NO
          cierra nada -- hay que teclear el período exacto que se ve en pantalla y
          dar un segundo clic. El servidor exige el mismo texto de todas formas
          (cierre-mensual.ts), así que esto no es solo un candado cosmético.
          Presentación: el panel inline pasó al `Dialog` real (la forma de este
          bloque siempre fue la de un confirm modal); el estado `confirmando` y
          las mismas condiciones de render no cambian. */}
      {periodo.status !== "closed" && CERRAR_ROLES.has(role) && confirmando && (
        <Dialog
          open
          onOpenChange={(abierto) => {
            if (abierto || cerrando) return;
            setConfirmando(false);
            setTextoConfirmacion("");
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                Confirmar cierre de {formatPeriodo(periodo.year, periodo.month)}
              </DialogTitle>
              <DialogDescription>
                Esta acción es <strong className="text-destructive">irreversible</strong> — no hay forma de reabrir el período desde el producto. Bloquea la edición de todos los movimientos de{" "}
                {formatPeriodo(periodo.year, periodo.month)}.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmar-cierre">
                Escribe exactamente <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{periodoTexto}</code> para confirmar
              </Label>
              <Input
                id="confirmar-cierre"
                autoFocus
                value={textoConfirmacion}
                onChange={(e) => setTextoConfirmacion(e.target.value)}
                placeholder={periodoTexto}
                className="max-w-56"
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmando(false);
                  setTextoConfirmacion("");
                }}
                disabled={cerrando}
              >
                Cancelar
              </Button>
              <Button variant="destructive" onClick={handleCerrar} disabled={cerrando || textoConfirmacion.trim() !== periodoTexto}>
                {cerrando ? "Cerrando…" : "Confirmar cierre irreversible"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="mb-1.5 flex justify-between text-[13px] text-foreground">
            <span>
              Avance: {estado.done + estado.skipped} de {estado.totalTasks} tareas
            </span>
            <strong className="tabular-nums">{estado.progressPercent}%</strong>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={estado.progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full ${periodo.status === "overdue" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${estado.progressPercent}%` }} />
          </div>
          {estado.overdue.length > 0 && <p className="mt-2 text-xs text-destructive">{estado.overdue.length} tarea(s) vencida(s).</p>}
          {estado.blocked.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{estado.blocked.length} tarea(s) bloqueada(s) por dependencias.</p>}
        </CardContent>
      </Card>

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
                    <strong className="text-[13px] text-foreground">{t.title}</strong>
                    <TaskStatusBadge status={t.status} />
                    <span className="text-[11px] text-muted-foreground">{formatTaskCategory(t.category)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                  {t.category === "electronica" && (
                    <Link to={`/despachos/${orgSlug}/contabilidad-electronica`} className="inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-2">
                      Ir a Contabilidad electrónica
                      <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
                    </Link>
                  )}
                  {t.completedAt && <p className="mt-1 text-[11px] text-muted-foreground">Completada {formatDate(t.completedAt)}</p>}
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
          <div className="mt-3 flex flex-col gap-1.5 text-[13px] text-foreground">
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
    </div>
  );
}
