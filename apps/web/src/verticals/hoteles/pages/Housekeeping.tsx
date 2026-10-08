// Housekeeping (H-04) -- tablero de limpieza por habitacion, tareas (iniciar/terminar/
// inspeccionar), habitaciones fuera de servicio y reporte diario. Consume
// apps/api/.../hoteles/housekeeping.ts (bloque "H-04"). Los botones se muestran segun el
// rol de la sesion (cosmetico: el servidor es la unica barrera real, 403). Contra una base
// sin la migracion 033 el tablero degrada a solo-estado de habitacion y avisa (sin 500).
import { useCallback, useEffect, useState } from "react";
import { BedDouble, Camera, ClipboardCheck, Shuffle, Sparkles } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useConfirm,
} from "@atiende/ui";
import {
  HABITACION_ESTADO_LABELS,
  HK_OUT_OF_SERVICE_ROLES,
  HK_TASK_ROLES,
  TAREA_ESTADO_LABELS,
  TAREA_TIPO_LABELS,
  accionTarea,
  accionesDisponibles,
  fetchCamaristas,
  fetchReporte,
  fetchTablero,
  generarDia,
  inhabilitar,
  marcarSucia,
  rehabilitar,
} from "../lib/limpieza-client.ts";
import type { Camarista, ReporteDiario, Tablero, TableroHabitacion, TareaAccion } from "../lib/limpieza-client.ts";
import { HK_AUTO_ASSIGN_ROLES, asignacionAutomatica } from "../lib/housekeeping-residual-client.ts";
import { HABITACION_ESTADO_TONES } from "../lib/status-tones.ts";
import { BlancosPanel, ConfiguracionHkPanel, FotosDialog, OptOutPanel } from "./HousekeepingResidual.tsx";
import { TurnosPanel } from "./TurnosPanel.tsx";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ACCION_LABELS: Record<TareaAccion, string> = {
  iniciar: "Iniciar",
  terminar: "Terminar",
  inspeccionar: "Inspeccionar",
  asignar: "Asignar",
  cancelar: "Cancelar tarea",
};

export function HousekeepingPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [fecha, setFecha] = useState<string | undefined>(undefined);
  const [tablero, setTablero] = useState<Tablero | null>(null);
  const [reporte, setReporte] = useState<ReporteDiario | null>(null);
  const [camaristas, setCamaristas] = useState<readonly Camarista[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"tablero" | "reporte" | "turnos" | "blancos" | "optout" | "config">("tablero");
  const [fotosDe, setFotosDe] = useState<{ taskId: string; habitacion: string } | null>(null);

  const puedeOperar = HK_TASK_ROLES.has(role);
  const puedeInhabilitar = HK_OUT_OF_SERVICE_ROLES.has(role);
  const puedeAsignarAuto = HK_AUTO_ASSIGN_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await fetchTablero(fetch, apiBaseUrl, token, propertyId, fecha);
      setTablero(t);
      setReporte(await fetchReporte(fetch, apiBaseUrl, token, propertyId, t.fecha));
      if (puedeOperar) setCamaristas(await fetchCamaristas(fetch, apiBaseUrl, token, propertyId).catch(() => []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el tablero de housekeeping.");
    }
  }, [apiBaseUrl, token, propertyId, fecha, puedeOperar]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage?: string) {
    setBusy(key);
    setError(null);
    setAviso(null);
    try {
      await fn();
      if (okMessage) setAviso(okMessage);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  function nombre(id: string | null): string {
    if (!id) return "Sin asignar";
    return camaristas.find((c) => c.id === id)?.nombre ?? "Otro responsable";
  }

  async function handleAccion(h: TableroHabitacion, accion: TareaAccion) {
    const tarea = h.tarea;
    if (!tarea) return;
    if (accion === "inspeccionar") {
      // Antes: window.confirm "Aceptar = aprobada, Cancelar = rechazada" + window.prompt para la nota.
      const aprobada = await confirmar({ titulo: `Inspección de la habitación ${h.codigo}`, descripcion: "¿La habitación pasó la inspección?", confirmar: "Aprobada", cancelar: "Rechazada" });
      const nota = await pedirTexto({
        titulo: aprobada ? `Aprobar la habitación ${h.codigo}` : `Rechazar la habitación ${h.codigo}`,
        confirmar: aprobada ? "Aprobar" : "Rechazar",
        campo: aprobada ? { etiqueta: "Nota (opcional)", requerido: false, multilinea: true } : { etiqueta: "Qué debe corregirse", multilinea: true },
      });
      if (nota === null) return;
      return void run(tarea.id, () => accionTarea(fetch, apiBaseUrl, token, propertyId, tarea.id, "inspeccionar", { aprobada, nota: nota.trim() || undefined }));
    }
    if (accion === "asignar") {
      const lista = camaristas.map((c, i) => `${i + 1}. ${c.nombre}`).join("\n");
      const elegido = await pedirTexto({
        titulo: `Asignar la habitación ${h.codigo}`,
        descripcion: <span className="whitespace-pre-line">{`Escribe el número de la camarista:\n${lista}`}</span>,
        confirmar: "Asignar",
        campo: { etiqueta: "Número", validar: (v) => (camaristas[Number(v) - 1] ? null : "Escribe un número de la lista.") },
      });
      const camarista = elegido ? camaristas[Number(elegido) - 1] : undefined;
      if (!camarista) return;
      return void run(tarea.id, () => accionTarea(fetch, apiBaseUrl, token, propertyId, tarea.id, "asignar", { asignadoA: camarista.id }));
    }
    if (accion === "cancelar") {
      const ok = await confirmar({ titulo: `Cancelar la tarea de la habitación ${h.codigo}`, tono: "danger", confirmar: "Cancelar tarea", cancelar: "Volver" });
      if (!ok) return;
    }
    void run(tarea.id, () => accionTarea(fetch, apiBaseUrl, token, propertyId, tarea.id, accion));
  }

  async function handleInhabilitar(h: TableroHabitacion) {
    const motivo = await pedirTexto({
      titulo: `Inhabilitar la habitación ${h.codigo}`,
      confirmar: "Continuar",
      campo: { etiqueta: "Motivo", minLength: 3, maxLength: 300, multilinea: true },
    });
    if (!motivo) return;
    // Antes: window.confirm "Aceptar = fuera de orden (falla). Cancelar = fuera de servicio (decisión operativa)."
    const falla = await confirmar({ titulo: `Tipo de baja de la habitación ${h.codigo}`, descripcion: "¿Es una falla (fuera de orden) o una decisión operativa (fuera de servicio)?", confirmar: "Fuera de orden (falla)", cancelar: "Fuera de servicio" });
    void run(h.roomId, () => inhabilitar(fetch, apiBaseUrl, token, propertyId, { roomId: h.roomId, tipo: falla ? "fuera_de_orden" : "fuera_de_servicio", motivo: motivo.trim() }), `Habitacion ${h.codigo} inhabilitada.`);
  }

  const conteo = (estado: TableroHabitacion["estado"]) => tablero?.habitaciones.filter((h) => h.estado === estado).length ?? 0;

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Housekeeping"
        descripcion="Tablero de limpieza, inspección y fuera de servicio de las habitaciones."
        acciones={
        <div className="flex items-end gap-2 flex-wrap">
          <FormField label="Fecha">
            <Input type="date" value={tablero?.fecha ?? fecha ?? ""} onChange={(e) => setFecha(e.target.value || undefined)} />
          </FormField>
          {puedeAsignarAuto && tablero?.tareasDisponibles && (
            <Button
              type="button"
              variant="outline"
              loading={busy === "asignar-auto"}
              disabled={busy === "asignar-auto"}
              onClick={() =>
                void run("asignar-auto", async () => {
                  const r = await asignacionAutomatica(fetch, apiBaseUrl, token, propertyId, tablero.fecha);
                  setAviso(
                    r.sinCamaristas
                      ? "No hay camaristas con acceso a esta propiedad para asignar."
                      : `${r.asignadas} tarea(s) asignada(s)${r.sinAsignar > 0 ? `; ${r.sinAsignar} sin cupo en ninguna jornada` : ""}.`,
                  );
                })
              }
            >
              <Shuffle className="w-4 h-4" strokeWidth={1.75} />
              Asignar automáticamente
            </Button>
          )}
          {puedeOperar && tablero?.tareasDisponibles && (
            <Button
              type="button"
              loading={busy === "generar"}
              disabled={busy === "generar"}
              onClick={() => void run("generar", async () => { const r = await generarDia(fetch, apiBaseUrl, token, propertyId, tablero.fecha); setAviso(`${r.creadas} tarea(s) creada(s).`); })}
            >
              <Sparkles className="w-4 h-4" strokeWidth={1.75} />
              Generar tareas del día
            </Button>
          )}
        </div>
        }
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {!tablero && !error && <EstadoCargando etiqueta="Cargando tablero…" />}

      {tablero && !tablero.tareasDisponibles && (
        <Callout tone="info">
          Las tareas de limpieza, la inspección y fuera de servicio aún no están activas en esta base de datos. Aquí ves solo el estado actual de cada habitación; el resto se activa cuando se aplique la actualización pendiente.
        </Callout>
      )}

      {tablero && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="tablero">Tablero</TabsTrigger>
            <TabsTrigger value="reporte">Reporte diario</TabsTrigger>
            <TabsTrigger value="turnos">Turnos</TabsTrigger>
            <TabsTrigger value="blancos">Blancos</TabsTrigger>
            <TabsTrigger value="optout">Sin limpieza</TabsTrigger>
            <TabsTrigger value="config">Configuración</TabsTrigger>
          </TabsList>

          <TabsContent value="tablero" className="flex flex-col gap-4 mt-4">
            <p className="text-sm text-muted-foreground">
              {conteo("sucia")} sucias · {conteo("ocupada")} ocupadas · {conteo("disponible")} disponibles · {conteo("fuera_de_servicio") + conteo("mantenimiento")} fuera de servicio
            </p>
            {tablero.habitaciones.length === 0 && <EstadoVacio mensaje="Esta propiedad aún no tiene habitaciones registradas." />}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tablero.habitaciones.map((h) => (
                <Card key={h.roomId}>
                  <CardContent className="p-4 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground flex items-center gap-1.5">
                          <BedDouble className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
                          Habitación {h.codigo}
                        </p>
                        <p className="text-xs text-muted-foreground">{h.tipoHabitacion}</p>
                      </div>
                      <StatusBadge tone={statusTone(HABITACION_ESTADO_TONES, h.estado)}>{HABITACION_ESTADO_LABELS[h.estado]}</StatusBadge>
                    </div>

                    {h.fueraDeServicio && (
                      <p className="text-xs text-foreground">
                        {h.fueraDeServicio.tipo === "fuera_de_orden" ? "Fuera de orden" : "Fuera de servicio"}: {h.fueraDeServicio.motivo}
                        {h.fueraDeServicio.regresoEstimado ? ` · regreso estimado ${h.fueraDeServicio.regresoEstimado}` : ""}
                      </p>
                    )}

                    {h.tarea && (
                      <p className="text-xs text-foreground flex items-center gap-1.5">
                        <ClipboardCheck className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
                        {TAREA_TIPO_LABELS[h.tarea.tipo]} · {TAREA_ESTADO_LABELS[h.tarea.estado]}
                        {h.tarea.prioridad === "alta" ? " · prioridad alta" : ""} · {nombre(h.tarea.asignadoA)}
                        {h.tarea.rechazos > 0 ? ` · ${h.tarea.rechazos} rechazo(s)` : ""}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2 mt-1">
                      {puedeOperar && h.tarea && !h.fueraDeServicio &&
                        accionesDisponibles(h.tarea.estado).map((a) => (
                          <Button key={a} type="button" size="sm" variant={a === "cancelar" ? "outline" : "default"} disabled={busy === h.tarea?.id} onClick={() => void handleAccion(h, a)}>
                            {ACCION_LABELS[a]}
                          </Button>
                        ))}
                      {h.tarea && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setFotosDe({ taskId: h.tarea!.id, habitacion: h.codigo })}>
                          <Camera className="w-3.5 h-3.5" strokeWidth={1.75} />
                          Fotos
                        </Button>
                      )}
                      {puedeOperar && tablero.tareasDisponibles && (h.estado === "disponible" || h.estado === "ocupada") && (
                        <Button type="button" size="sm" variant="outline" disabled={busy === h.roomId} onClick={() => void run(h.roomId, () => marcarSucia(fetch, apiBaseUrl, token, propertyId, h.roomId))}>
                          Marcar sucia
                        </Button>
                      )}
                      {puedeInhabilitar && tablero.tareasDisponibles && !h.fueraDeServicio && h.estado !== "ocupada" && (
                        <Button type="button" size="sm" variant="outline" disabled={busy === h.roomId} onClick={() => void handleInhabilitar(h)}>
                          Inhabilitar
                        </Button>
                      )}
                      {puedeInhabilitar && h.fueraDeServicio && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy === h.roomId}
                          onClick={() => void run(h.roomId, () => rehabilitar(fetch, apiBaseUrl, token, propertyId, h.fueraDeServicio!.id), `Habitación ${h.codigo} rehabilitada: debe limpiarse e inspeccionarse.`)}
                        >
                          Rehabilitar
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="blancos" className="mt-4">
            <BlancosPanel apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} role={role} fecha={tablero.fecha} />
          </TabsContent>

          <TabsContent value="optout" className="mt-4">
            <OptOutPanel apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} role={role} fecha={tablero.fecha} habitaciones={tablero.habitaciones} />
          </TabsContent>

          <TabsContent value="config" className="mt-4">
            <ConfiguracionHkPanel apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} role={role} />
          </TabsContent>

          <TabsContent value="turnos" className="mt-4">
            <TurnosPanel apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} role={role} hoy={tablero.fecha} camaristas={camaristas} />
          </TabsContent>

          <TabsContent value="reporte" className="flex flex-col gap-4 mt-4">
            {!reporte && <EstadoCargando etiqueta="Cargando reporte…" />}
            {reporte && (
              <>
                {!reporte.tareasDisponibles && <EstadoVacio mensaje="Sin tareas registradas: el reporte por responsable estará disponible cuando se active housekeeping completo." />}
                <Card>
                  <CardContent className="p-4 text-sm text-foreground">
                    <p className="font-medium">Resumen del {reporte.fecha}</p>
                    <p className="mt-1">
                      {reporte.totales.total} tareas · {reporte.totales.pendientes} pendientes · {reporte.totales.enProgreso} en progreso · {reporte.totales.porInspeccionar} por inspeccionar · {reporte.totales.inspeccionadas} inspeccionadas · {reporte.totales.rechazos} rechazo(s)
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Habitaciones: {reporte.habitacionesPorEstado.sucia} sucias · {reporte.habitacionesPorEstado.ocupada} ocupadas · {reporte.habitacionesPorEstado.disponible} disponibles · {reporte.fueraDeServicioActivas} fuera de servicio
                    </p>
                  </CardContent>
                </Card>
                {reporte.porResponsable.map((r) => (
                  <Card key={r.assignedTo ?? "sin-asignar"}>
                    <CardContent className="p-4 text-sm text-foreground">
                      <p className="font-medium">{nombre(r.assignedTo)}</p>
                      <p className="mt-1">
                        {r.total} tareas · {r.inspeccionadas} inspeccionadas · {r.porInspeccionar} por inspeccionar · {r.rechazos} rechazo(s)
                        {r.minutosPromedio !== null ? ` · ${r.minutosPromedio} min promedio` : ""}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
      {fotosDe && (
        <FotosDialog apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} role={role} taskId={fotosDe.taskId} habitacion={fotosDe.habitacion} open onOpenChange={(o) => !o && setFotosDe(null)} />
      )}
      {dialogo}
    </PageContainer>
  );
}
