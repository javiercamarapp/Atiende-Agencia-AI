// Mis tareas (Fase 17) — cierra el hallazgo de auditoría ALTA "el rol `limpieza`
// sigue sin ninguna vista funcional": primera pantalla operativa real para ese rol
// (tareas/checklist/inventario/incidencias, packages/domain-rentas/src/limpieza/*,
// Fase 8) — el motor transaccional completo llevaba desde entonces sin un solo HTTP
// route ni cliente web que lo usara.
//
// Dos colas ("Mis tareas" = asignadoA=me, "Sin asignar" = cola disponible con botón
// "Asignarme") + detalle de la tarea seleccionada con checklist accionable
// (clic = POST .../completar, nunca un checkbox puramente visual) + completar tarea
// (con consumo de inventario opcional) + reportar incidencia por unidad. Mismo
// criterio de "gate en el cliente solo por UX, el servidor SIEMPRE re-valida vía
// assertVerticalRole" que Precios.tsx/Finanzas.tsx — visible para cualquier rol en la
// nav, el contenido real solo tiene sentido para quien puede operar el módulo
// (LIMPIEZA_OPERACION_ROLES: admin_gestora/operador:acceso_total/
// operador:calendario_mensajeria/limpieza).
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Badge/Input/
// Label/EstadoCargando/EstadoVacio/EstadoError + clases de token en vez de los
// `style={{...}}` hechos a mano. El formulario "Nueva tarea manual" pasa a
// <FormDialog> (mismo submit, mismas validaciones locales, mismo
// `handleSeleccionar` tras crear). CERO cambios de lógica ni de gates de rol; la
// tarjeta de tarea conserva su accesibilidad de teclado exacta (role=button +
// tabIndex + onKeyDown con el guardia `e.target !== e.currentTarget`).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, ClipboardList, Plus } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone, Textarea, cn, useConfirm } from "@atiende/ui";
import {
  asignarTarea,
  completarChecklistItem,
  completarTarea,
  crearTareaManual,
  ESTADO_TAREA_LABELS,
  fetchAsignables,
  fetchInventario,
  fetchTareaDetalle,
  fetchTareas,
  fetchUnidades,
  PRIORIDAD_LABELS,
  confirmarBloqueoIncidencia,
  fetchIncidencias,
  reportarIncidencia,
  SEVERIDAD_LABELS,
  TIPO_TAREA_LABELS,
} from "../lib/limpieza-client.ts";
import type { AsignableLimpieza, IncidenciaMantenimiento, ItemInventario, PrioridadTareaOperativa, SeveridadIncidencia, TareaOperativa, TareaOperativaDetalle, TipoTareaOperativa, UnidadOption } from "../lib/limpieza-client.ts";
import { ESTADO_TAREA_TONES } from "../lib/status-tones.ts";
import { TareasSemana } from "../components/TareasSemana.tsx";
import type { RentasShellContext } from "../RentasShell.tsx";

const LIMPIEZA_OPERACION_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "limpieza"]);
// Espejo de LIMPIEZA_CREACION_MANUAL_ROLES (packages/domain-rentas/src/roles.ts) --
// crear una tarea ad-hoc es una decisión de gestión, NUNCA abierta al rol `limpieza`
// (que sí puede operar la tarea una vez creada). Mismo criterio de "gate en el
// cliente solo por UX" que el resto del archivo: el servidor siempre re-valida.
const LIMPIEZA_CREACION_MANUAL_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);
// Espejo de LIMPIEZA_ASIGNAR_A_OTROS_ROLES (paridad3): repartir el trabajo y ver el tablero de turnos del equipo es de gestión; el rol
// `limpieza` solo se asigna a sí mismo (el servidor responde 403 con cualquier otra persona).
const LIMPIEZA_ASIGNAR_A_OTROS_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);
// Espejo de LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES (Rn-05): quien reporta (limpieza) nunca confirma el bloqueo.
const LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);
// Incidencias graves cuyo bloqueo de mantenimiento aún no se confirmó ni se cerró.
const ESTADOS_BLOQUEO_PENDIENTE = new Set(["abierta", "en_revision", "bloqueo_propuesto"]);

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  return iso.length <= 10 ? iso : new Date(iso).toLocaleString("es-MX");
}

// Hallazgo de auditoría (rubro 11/UX, MEDIO, "navegación por teclado incompleta en
// componentes de acción crítica"): esta tarjeta selecciona la tarea activa de la cola
// de un rol operativo (`limpieza`) con un simple `<div onClick>` — sin `tabIndex`, sin
// `role`, sin manejador de teclado, era invisible para Tab y no se podía activar con
// Enter/Espacio. No se cambia a `<button>` real porque en la cola "Sin asignar" la
// tarjeta envuelve OTRO botón real (`accion`, "Asignarme") y anidar `<button>` dentro
// de `<button>` es HTML inválido — se usa el patrón estándar `role="button"` +
// `tabIndex={0}` + `onKeyDown` (Enter/Espacio), con `e.target !== e.currentTarget`
// para no disparar la selección dos veces cuando el foco real está en el botón
// anidado (que ya maneja su propio Enter/Espacio de forma nativa).
function TareaCard({ tarea, activo, onClick, accion }: { tarea: TareaOperativa; activo: boolean; onClick: () => void; accion?: React.ReactNode }) {
  const vencida = tarea.slaVenceEn !== null && new Date(tarea.slaVenceEn).getTime() < Date.now() && tarea.estado !== "completada" && tarea.estado !== "cancelada";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={activo}
      aria-label={`${TIPO_TAREA_LABELS[tarea.tipo]} — ${tarea.unidadNombre}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border bg-card p-2.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        activo ? "border-2 border-primary" : "border-border hover:bg-muted/50",
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex justify-between gap-2">
        <strong className="text-sm text-foreground">
          {TIPO_TAREA_LABELS[tarea.tipo]} — {tarea.unidadNombre}
        </strong>
        <span className="flex flex-wrap items-center gap-1.5">
          {tarea.esProveedorExterno && <StatusBadge tone="info">Proveedor externo</StatusBadge>}
          {vencida ? <StatusBadge tone="danger">SLA vencido</StatusBadge> : <StatusBadge tone={statusTone(ESTADO_TAREA_TONES, tarea.estado)}>{ESTADO_TAREA_LABELS[tarea.estado]}</StatusBadge>}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        Programada: {tarea.programadaPara} · Prioridad: {PRIORIDAD_LABELS[tarea.prioridad]}
      </span>
      {accion}
    </div>
  );
}

export function MisTareasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeOperar = org ? LIMPIEZA_OPERACION_ROLES.has(org.rol) : false;
  const puedeCrearManual = org ? LIMPIEZA_CREACION_MANUAL_ROLES.has(org.rol) : false;
  const puedeConfirmarBloqueo = org ? LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES.has(org.rol) : false;
  const puedeAsignarAOtros = org ? LIMPIEZA_ASIGNAR_A_OTROS_ROLES.has(org.rol) : false;
  const { confirmar, dialogo } = useConfirm();

  const [misTareas, setMisTareas] = useState<readonly TareaOperativa[] | null>(null);
  const [sinAsignar, setSinAsignar] = useState<readonly TareaOperativa[] | null>(null);
  const [listaError, setListaError] = useState<string | null>(null);

  const [tareaSeleccionadaId, setTareaSeleccionadaId] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<TareaOperativaDetalle | null>(null);
  const [inventario, setInventario] = useState<readonly ItemInventario[]>([]);
  const [detalleError, setDetalleError] = useState<string | null>(null);
  const [accionEnCurso, setAccionEnCurso] = useState(false);

  const [consumos, setConsumos] = useState<{ itemInventarioId: string; cantidad: string }[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);

  const [unidades, setUnidades] = useState<readonly UnidadOption[]>([]);
  const [unidadesError, setUnidadesError] = useState<string | null>(null);
  const [incUnidadId, setIncUnidadId] = useState("");
  const [incSeveridad, setIncSeveridad] = useState<SeveridadIncidencia>("leve");
  const [incTitulo, setIncTitulo] = useState("");
  const [incDescripcion, setIncDescripcion] = useState("");
  const [incEnviando, setIncEnviando] = useState(false);
  const [incError, setIncError] = useState<string | null>(null);
  const [incAviso, setIncAviso] = useState<string | null>(null);
  const [incidenciasGraves, setIncidenciasGraves] = useState<readonly IncidenciaMantenimiento[]>([]);
  const [rangosBloqueo, setRangosBloqueo] = useState<Record<string, { inicio: string; fin: string }>>({});
  const [bloqueoEnCurso, setBloqueoEnCurso] = useState<string | null>(null);
  const [bloqueoError, setBloqueoError] = useState<string | null>(null);
  const [bloqueoAviso, setBloqueoAviso] = useState<string | null>(null);

  // Reparto del trabajo (solo gestión): personas asignables, la elegida, "proveedor externo" y la señal de recarga del tablero.
  const [asignables, setAsignables] = useState<readonly AsignableLimpieza[]>([]);
  const [asignablesDisponible, setAsignablesDisponible] = useState(true);
  const [asignablesError, setAsignablesError] = useState<string | null>(null);
  const [asignarA, setAsignarA] = useState("");
  const [asignarProveedor, setAsignarProveedor] = useState(false);
  const [recargaSemana, setRecargaSemana] = useState(0);

  const [mostrarFormNueva, setMostrarFormNueva] = useState(false);
  const [nuevaUnidadId, setNuevaUnidadId] = useState("");
  const [nuevaTipo, setNuevaTipo] = useState<TipoTareaOperativa>("limpieza");
  const [nuevaPrioridad, setNuevaPrioridad] = useState<PrioridadTareaOperativa>("media");
  const [nuevaProgramadaPara, setNuevaProgramadaPara] = useState("");
  const [nuevaEnviando, setNuevaEnviando] = useState(false);
  const [nuevaError, setNuevaError] = useState<string | null>(null);

  const cargarListas = useCallback(async () => {
    try {
      const [mias, libres] = await Promise.all([
        fetchTareas(fetch, apiBaseUrl, token, propertyId, { asignadoA: "me" }),
        fetchTareas(fetch, apiBaseUrl, token, propertyId, { asignadoA: "sin_asignar", estados: ["pendiente"] }),
      ]);
      setMisTareas(mias);
      setSinAsignar(libres);
    } catch (err) {
      setListaError(err instanceof Error ? err.message : "No se pudieron cargar las tareas.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!puedeOperar) return;
    void cargarListas();
    setUnidadesError(null);
    fetchUnidades(fetch, apiBaseUrl, token, propertyId)
      .then((list) => {
        setUnidades(list);
        setUnidadesError(null);
      })
      .catch((err) => {
        // El formulario de incidencias solo pierde el selector de unidad -- el resto de
        // la página sigue funcionando -- pero el error real (403 de rol, red caída,
        // etc.) se muestra, nunca se traga en silencio.
        setUnidades([]);
        setUnidadesError(err instanceof Error ? err.message : "No se pudieron cargar las unidades para el selector.");
      });
  }, [puedeOperar, cargarListas, apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!puedeOperar || !puedeAsignarAOtros) return;
    let cancelado = false;
    setAsignablesError(null);
    fetchAsignables(fetch, apiBaseUrl, token, propertyId).then(
      (r) => {
        if (cancelado) return;
        setAsignables(r.asignables);
        setAsignablesDisponible(r.disponible);
      },
      (err: unknown) => {
        if (cancelado) return;
        setAsignables([]);
        setAsignablesError(err instanceof Error ? err.message : "No se pudo cargar la lista de personas del equipo.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [puedeOperar, puedeAsignarAOtros, apiBaseUrl, token, propertyId]);

  const cargarDetalle = useCallback(
    async (tareaId: string) => {
      setDetalleError(null);
      setAviso(null);
      try {
        const t = await fetchTareaDetalle(fetch, apiBaseUrl, token, propertyId, tareaId);
        setDetalle(t);
        setConsumos([]);
        setAsignarA(t.asignadoA ?? "");
        setAsignarProveedor(t.esProveedorExterno);
        const items = await fetchInventario(fetch, apiBaseUrl, token, propertyId, t.unidadId);
        setInventario(items);
      } catch (err) {
        setDetalleError(err instanceof Error ? err.message : "No se pudo cargar el detalle de la tarea.");
      }
    },
    [apiBaseUrl, token, propertyId],
  );

  function handleSeleccionar(tareaId: string) {
    setTareaSeleccionadaId(tareaId);
    void cargarDetalle(tareaId);
  }

  const nombreDe = useCallback((id: string | null): string => (id === null ? "Sin asignar" : (asignables.find((a) => a.id === id)?.nombre || "Persona asignada")), [asignables]);

  // Repartir la tarea a OTRA persona (solo gestión). Reasignar una tarea que YA tiene responsable pide confirmación: el dialogo
  // descartado (Cancelar, cerrar o Escape) nunca llama al servidor. El 403/422 del servidor (rol, persona sin acceso) se muestra tal cual.
  async function handleAsignarAOtro() {
    if (!tareaSeleccionadaId || !detalle || !asignarA) return;
    const cambiaPersona = detalle.asignadoA !== null && detalle.asignadoA !== asignarA;
    if (cambiaPersona) {
      const ok = await confirmar({
        titulo: `Reasignar la tarea de ${detalle.unidadNombre}`,
        descripcion: `Hoy la tiene ${nombreDe(detalle.asignadoA)}. Pasará a ${nombreDe(asignarA)}, que recibirá el aviso.`,
        confirmar: "Reasignar",
        cancelar: "Cancelar",
      });
      if (!ok) return;
    }
    setAccionEnCurso(true);
    setDetalleError(null);
    setAviso(null);
    try {
      const t = await asignarTarea(fetch, apiBaseUrl, token, propertyId, tareaSeleccionadaId, { asignadoA: asignarA, esProveedorExterno: asignarProveedor });
      setDetalle(t);
      setAviso(`Tarea asignada a ${nombreDe(asignarA)}.`);
      await cargarListas();
      setRecargaSemana((n) => n + 1);
    } catch (err) {
      setDetalleError(err instanceof Error ? err.message : "No se pudo asignar la tarea.");
    } finally {
      setAccionEnCurso(false);
    }
  }

  async function handleAsignarme(tareaId: string) {
    setAccionEnCurso(true);
    setListaError(null);
    try {
      await asignarTarea(fetch, apiBaseUrl, token, propertyId, tareaId, {});
      setRecargaSemana((n) => n + 1);
      await cargarListas();
      handleSeleccionar(tareaId);
    } catch (err) {
      setListaError(err instanceof Error ? err.message : "No se pudo asignar la tarea.");
    } finally {
      setAccionEnCurso(false);
    }
  }

  async function handleToggleChecklistItem(itemId: string) {
    if (!tareaSeleccionadaId) return;
    setAccionEnCurso(true);
    setDetalleError(null);
    try {
      const t = await completarChecklistItem(fetch, apiBaseUrl, token, propertyId, tareaSeleccionadaId, itemId);
      setDetalle(t);
    } catch (err) {
      setDetalleError(err instanceof Error ? err.message : "No se pudo marcar el ítem del checklist.");
    } finally {
      setAccionEnCurso(false);
    }
  }

  function handleAgregarConsumo() {
    setConsumos((prev) => [...prev, { itemInventarioId: inventario[0]?.id ?? "", cantidad: "1" }]);
  }

  function handleQuitarConsumo(index: number) {
    setConsumos((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCompletarTarea() {
    if (!tareaSeleccionadaId) return;
    setAccionEnCurso(true);
    setDetalleError(null);
    setAviso(null);
    try {
      const entradas = consumos
        .filter((c) => c.itemInventarioId && Number(c.cantidad) > 0)
        .map((c) => ({ itemInventarioId: c.itemInventarioId, cantidad: Number(c.cantidad) }));
      const resultado = await completarTarea(fetch, apiBaseUrl, token, propertyId, tareaSeleccionadaId, entradas);
      await cargarListas();
      // `cargarDetalle` limpia el aviso al empezar: el mensaje de exito se pone DESPUES de recargar (antes se borraba al instante y la
      // persona no veia ninguna confirmacion de que la tarea quedo completada).
      await cargarDetalle(tareaSeleccionadaId);
      setAviso(
        resultado.alertasStockBajo.length > 0
          ? `Tarea completada. Aviso: ${resultado.alertasStockBajo.length} ítem(s) de inventario cruzaron su umbral mínimo.`
          : "Tarea completada.",
      );
    } catch (err) {
      // El 409 real de "checklist_incompleto" (o cualquier otro error del servidor)
      // se muestra tal cual — nunca se silencia ni se finge éxito.
      setDetalleError(err instanceof Error ? err.message : "No se pudo completar la tarea.");
    } finally {
      setAccionEnCurso(false);
    }
  }

  async function handleCrearTareaManual() {
    setNuevaError(null);
    if (!nuevaUnidadId) {
      setNuevaError("Elige una unidad.");
      return;
    }
    if (!nuevaProgramadaPara) {
      setNuevaError("Elige una fecha programada.");
      return;
    }
    setNuevaEnviando(true);
    try {
      const tarea = await crearTareaManual(fetch, apiBaseUrl, token, propertyId, {
        unidadId: nuevaUnidadId,
        tipo: nuevaTipo,
        prioridad: nuevaPrioridad,
        programadaPara: nuevaProgramadaPara,
      });
      setNuevaUnidadId("");
      setNuevaProgramadaPara("");
      setMostrarFormNueva(false);
      setRecargaSemana((n) => n + 1);
      await cargarListas();
      handleSeleccionar(tarea.id);
    } catch (err) {
      setNuevaError(err instanceof Error ? err.message : "No se pudo crear la tarea.");
    } finally {
      setNuevaEnviando(false);
    }
  }

  // Rn-05: incidencias graves de la unidad elegida que esperan confirmación de bloqueo.
  const cargarIncidenciasGraves = useCallback(
    async (unidadId: string) => {
      if (!puedeConfirmarBloqueo || !unidadId) {
        setIncidenciasGraves([]);
        return;
      }
      try {
        const todas = await fetchIncidencias(fetch, apiBaseUrl, token, propertyId, unidadId);
        const pendientes = todas.filter((i) => i.severidad === "grave" && ESTADOS_BLOQUEO_PENDIENTE.has(i.estado));
        setIncidenciasGraves(pendientes);
        setRangosBloqueo((prev) => {
          const next = { ...prev };
          for (const i of pendientes) next[i.id] = next[i.id] ?? { inicio: i.propuestaBloqueoRango?.inicio ?? "", fin: i.propuestaBloqueoRango?.fin ?? "" };
          return next;
        });
      } catch (err) {
        setIncidenciasGraves([]);
        setBloqueoError(err instanceof Error ? err.message : "No se pudieron cargar las incidencias de la unidad.");
      }
    },
    [apiBaseUrl, token, propertyId, puedeConfirmarBloqueo],
  );

  useEffect(() => {
    setBloqueoError(null);
    setBloqueoAviso(null);
    void cargarIncidenciasGraves(incUnidadId);
  }, [incUnidadId, cargarIncidenciasGraves]);

  async function handleConfirmarBloqueo(incidencia: IncidenciaMantenimiento) {
    const rango = rangosBloqueo[incidencia.id] ?? { inicio: "", fin: "" };
    setBloqueoError(null);
    setBloqueoAviso(null);
    if (!rango.inicio || !rango.fin) {
      setBloqueoError("Indica las fechas de inicio y fin del bloqueo.");
      return;
    }
    setBloqueoEnCurso(incidencia.id);
    try {
      const r = await confirmarBloqueoIncidencia(fetch, apiBaseUrl, token, propertyId, incidencia.unidadId, incidencia.id, rango);
      setBloqueoAviso(
        r.conflictosCapaCruzada > 0
          ? `Bloqueo de mantenimiento confirmado. Atención: se cruza con ${r.conflictosCapaCruzada} reserva(s) -- quedaron como conflicto para tu revisión; ninguna reserva se canceló.`
          : "Bloqueo de mantenimiento confirmado.",
      );
      await cargarIncidenciasGraves(incidencia.unidadId);
    } catch (err) {
      setBloqueoError(err instanceof Error ? err.message : "No se pudo confirmar el bloqueo.");
    } finally {
      setBloqueoEnCurso(null);
    }
  }

  async function handleReportarIncidencia(e: FormEvent) {
    e.preventDefault();
    setIncError(null);
    setIncAviso(null);
    if (!incUnidadId) {
      setIncError("Elige una unidad.");
      return;
    }
    if (!incTitulo.trim()) {
      setIncError("Escribe un título para la incidencia.");
      return;
    }
    setIncEnviando(true);
    try {
      const resultado = await reportarIncidencia(fetch, apiBaseUrl, token, propertyId, incUnidadId, {
        severidad: incSeveridad,
        titulo: incTitulo.trim(),
        descripcion: incDescripcion.trim() || undefined,
      });
      setIncAviso(
        resultado.requiereConfirmacionHumana
          ? "Incidencia registrada como GRAVE — puede requerir confirmar un bloqueo de mantenimiento (lo confirma admin_gestora/operador aquí mismo, eligiendo la unidad)."
          : "Incidencia registrada.",
      );
      setIncTitulo("");
      setIncDescripcion("");
      void cargarIncidenciasGraves(incUnidadId);
    } catch (err) {
      setIncError(err instanceof Error ? err.message : "No se pudo registrar la incidencia.");
    } finally {
      setIncEnviando(false);
    }
  }

  if (!puedeOperar) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Mis tareas</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no opera el módulo de limpieza/mantenimiento. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong>,{" "}
          <strong className="text-foreground">operador:calendario_mensajeria</strong> y <strong className="text-foreground">limpieza</strong>.
        </p>
      </PageContainer>
    );
  }

  const checklistCompleto = detalle ? detalle.checklist.every((c) => c.completado) : true;

  return (
    <PageContainer padding="none" size="lg" className="gap-6 [&>*]:min-w-0">
      <header className="flex justify-between items-start gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Mis tareas</h1>
          <p className="m-0 text-sm text-muted-foreground">Tareas de limpieza/mantenimiento asignadas a ti, cola de tareas sin asignar, y reporte de incidencias.</p>
        </div>
        {puedeCrearManual && (
          <Button type="button" size="sm" onClick={() => setMostrarFormNueva((v) => !v)}>
            <Plus className="w-4 h-4" strokeWidth={1.75} />
            {mostrarFormNueva ? "Cancelar" : "+ Nueva tarea"}
          </Button>
        )}
      </header>

      {listaError && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {listaError}
        </p>
      )}

      {puedeCrearManual && (
        <FormDialog
          open={mostrarFormNueva}
          onOpenChange={(abierto) => {
            setMostrarFormNueva(abierto);
            if (!abierto) setNuevaError(null);
          }}
          titulo="Nueva tarea manual"
          subtitulo="Fuera del sweep automático de checkout — para dar de alta una tarea de limpieza/mantenimiento/inspección ad-hoc (nace sin ocupación ni bloqueo de calendario)."
          anchoClase="max-w-2xl"
          onGuardar={() => void handleCrearTareaManual()}
          guardando={nuevaEnviando}
          textoBotonGuardar="Crear tarea"
        >
          <div className="flex flex-col gap-2.5">
            {nuevaError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {nuevaError}
              </p>
            )}
            <Label className={LABEL_CLASES}>
              Unidad
              <NativeSelect value={nuevaUnidadId} onChange={(e) => setNuevaUnidadId(e.target.value)}>
                <option value="">Selecciona una unidad…</option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Tipo
              <NativeSelect value={nuevaTipo} onChange={(e) => setNuevaTipo(e.target.value as TipoTareaOperativa)}>
                {(Object.keys(TIPO_TAREA_LABELS) as TipoTareaOperativa[]).map((t) => (
                  <option key={t} value={t}>
                    {TIPO_TAREA_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Prioridad
              <NativeSelect value={nuevaPrioridad} onChange={(e) => setNuevaPrioridad(e.target.value as PrioridadTareaOperativa)}>
                {(Object.keys(PRIORIDAD_LABELS) as PrioridadTareaOperativa[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORIDAD_LABELS[p]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Programada para
              <Input type="date" value={nuevaProgramadaPara} onChange={(e) => setNuevaProgramadaPara(e.target.value)} />
            </Label>
          </div>
        </FormDialog>
      )}

      {puedeAsignarAOtros && <TareasSemana apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} recarga={recargaSemana} />}

      <div className="flex gap-4 flex-wrap">
        <Card className="flex-[1_1_320px]">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base font-semibold">Mis tareas de hoy</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-col gap-3">
            {misTareas === null && <EstadoCargando lineas={2} />}
            {misTareas !== null && misTareas.length === 0 && <EstadoVacio icon={ClipboardList} titulo="Nada asignado" mensaje="No tienes tareas asignadas." />}
            {misTareas?.map((t) => <TareaCard key={t.id} tarea={t} activo={t.id === tareaSeleccionadaId} onClick={() => handleSeleccionar(t.id)} />)}
          </CardContent>
        </Card>

        <Card className="flex-[1_1_320px]">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base font-semibold">Sin asignar (tómala)</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-col gap-3">
            {sinAsignar === null && <EstadoCargando lineas={2} />}
            {sinAsignar !== null && sinAsignar.length === 0 && <EstadoVacio icon={ClipboardList} titulo="Cola vacía" mensaje="No hay tareas pendientes de asignar." />}
            {sinAsignar?.map((t) => (
              <TareaCard
                key={t.id}
                tarea={t}
                activo={t.id === tareaSeleccionadaId}
                onClick={() => handleSeleccionar(t.id)}
                accion={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start h-8 px-3 text-xs"
                    disabled={accionEnCurso}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleAsignarme(t.id);
                    }}
                  >
                    Asignarme
                  </Button>
                }
              />
            ))}
          </CardContent>
        </Card>
      </div>

      {tareaSeleccionadaId && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base font-semibold">Detalle de la tarea</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-col gap-3">
            {detalleError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {detalleError}
              </p>
            )}
            {aviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{aviso}</p>}
            {!detalle && !detalleError && <EstadoCargando lineas={2} />}
            {detalle && (
              <>
                <p className="m-0 text-sm text-foreground">
                  <strong>{detalle.unidadNombre}</strong> · {TIPO_TAREA_LABELS[detalle.tipo]} · Programada: {detalle.programadaPara} · SLA vence: {formatFecha(detalle.slaVenceEn)}
                </p>
                <p className="m-0 text-sm text-foreground">
                  Estado: <strong>{ESTADO_TAREA_LABELS[detalle.estado]}</strong>
                  {puedeAsignarAOtros && asignablesDisponible && (
                    <>
                      {" "}
                      · Responsable: <strong>{nombreDe(detalle.asignadoA)}</strong>
                    </>
                  )}
                  {detalle.esProveedorExterno && " · Proveedor externo"}
                </p>

                {puedeAsignarAOtros && detalle.estado !== "completada" && detalle.estado !== "cancelada" && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
                    <h3 className="m-0 text-sm font-semibold text-foreground">Asignar a…</h3>
                    {asignablesError && (
                      <p role="alert" className="m-0 text-sm text-destructive">
                        {asignablesError}
                      </p>
                    )}
                    {!asignablesError && !asignablesDisponible && (
                      <p className="m-0 text-xs text-muted-foreground">No disponible aún: repartir tareas a otra persona requiere la migración 033 de rentas. Mientras tanto cada persona puede asignarse la suya.</p>
                    )}
                    {!asignablesError && asignablesDisponible && (
                      <div className="flex flex-wrap items-end gap-2">
                        <Label className={cn(LABEL_CLASES, "min-w-[14rem] flex-1")}>
                          Persona
                          <NativeSelect value={asignarA} onChange={(e) => setAsignarA(e.target.value)}>
                            <option value="">Selecciona a quién asignar…</option>
                            {asignables.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.nombre || "Persona sin nombre"}
                              </option>
                            ))}
                          </NativeSelect>
                        </Label>
                        <Checkbox checked={asignarProveedor} onChange={(e) => setAsignarProveedor(e.target.checked)} label={<span className="text-sm text-foreground">Proveedor externo</span>} />
                        <Button type="button" size="sm" disabled={accionEnCurso || !asignarA} onClick={() => void handleAsignarAOtro()}>
                          Asignar
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <h3 className="text-sm font-semibold text-foreground mt-0 mb-2">Checklist</h3>
                  {detalle.checklist.length === 0 && <p className="m-0 text-sm text-muted-foreground">Esta tarea no tiene checklist.</p>}
                  <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                    {detalle.checklist.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={item.completado}
                          disabled={item.completado || accionEnCurso || detalle.estado === "completada" || detalle.estado === "cancelada"}
                          onChange={() => void handleToggleChecklistItem(item.id)}
                          label={<span className={item.completado ? "line-through text-muted-foreground" : "text-foreground"}>{item.descripcion}</span>}
                        />
                      </li>
                    ))}
                  </ul>
                </div>

                {detalle.estado !== "completada" && detalle.estado !== "cancelada" && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold text-foreground m-0">Consumo de inventario al completar (opcional)</h3>
                    {consumos.map((c, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <NativeSelect
                          value={c.itemInventarioId}
                          onChange={(e) => setConsumos((prev) => prev.map((x, xi) => (xi === i ? { ...x, itemInventarioId: e.target.value } : x)))}
                          wrapperClassName="flex-[2]"
                        >
                          {inventario.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.nombre} ({item.cantidadActual} {item.unidadMedida})
                            </option>
                          ))}
                        </NativeSelect>
                        <Input
                          type="number"
                          min={1}
                          value={c.cantidad}
                          onChange={(e) => setConsumos((prev) => prev.map((x, xi) => (xi === i ? { ...x, cantidad: e.target.value } : x)))}
                          className="flex-1"
                        />
                        <Button type="button" variant="outline" size="sm" onClick={() => handleQuitarConsumo(i)}>
                          Quitar
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" onClick={handleAgregarConsumo} disabled={inventario.length === 0} className="self-start">
                      {inventario.length === 0 ? "Esta unidad no tiene inventario configurado" : "+ Agregar consumo"}
                    </Button>

                    {!checklistCompleto && (
                      <p className="m-0 flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.75} />
                        El checklist tiene ítems pendientes — completar la tarea la bloqueará hasta que termines el checklist.
                      </p>
                    )}
                    <Button type="button" size="sm" onClick={() => void handleCompletarTarea()} disabled={accionEnCurso} className="self-start">
                      Completar tarea
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base font-semibold">Reportar incidencia</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0 flex flex-col gap-3">
          {unidadesError && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {unidadesError}
            </p>
          )}
          {incError && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {incError}
            </p>
          )}
          {incAviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{incAviso}</p>}
          <form onSubmit={handleReportarIncidencia} className="flex flex-col gap-2.5">
            <Label className={LABEL_CLASES}>
              Unidad
              <NativeSelect value={incUnidadId} onChange={(e) => setIncUnidadId(e.target.value)}>
                <option value="">Selecciona una unidad…</option>
                {unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Severidad
              <NativeSelect value={incSeveridad} onChange={(e) => setIncSeveridad(e.target.value as SeveridadIncidencia)}>
                {(Object.keys(SEVERIDAD_LABELS) as SeveridadIncidencia[]).map((s) => (
                  <option key={s} value={s}>
                    {SEVERIDAD_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Título
              <Input type="text" value={incTitulo} onChange={(e) => setIncTitulo(e.target.value)} maxLength={200} />
            </Label>
            <Label className={LABEL_CLASES}>
              Descripción (opcional)
              <Textarea value={incDescripcion} onChange={(e) => setIncDescripcion(e.target.value)} maxLength={4000} rows={3} />
            </Label>
            <Button type="submit" size="sm" disabled={incEnviando} className="self-start">
              {incEnviando ? "Enviando…" : "Reportar incidencia"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {puedeConfirmarBloqueo && incUnidadId && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base font-semibold">Incidencias graves por bloquear</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-col gap-3">
            <p className="m-0 text-xs text-muted-foreground">
              Una incidencia grave puede requerir bloquear la unidad por mantenimiento. Confirmarlo es decisión tuya: el bloqueo nunca cancela una reserva; si se cruza con alguna, queda como conflicto
              para que lo resuelvas.
            </p>
            {bloqueoError && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {bloqueoError}
              </p>
            )}
            {bloqueoAviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{bloqueoAviso}</p>}
            {incidenciasGraves.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">No hay incidencias graves pendientes en esta unidad.</p>
            ) : (
              incidenciasGraves.map((i) => (
                <div key={i.id} className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
                  <strong className="text-sm text-foreground">{i.titulo}</strong>
                  <div className="flex flex-wrap items-end gap-2">
                    <Label className={LABEL_CLASES}>
                      Bloquear desde
                      <Input type="date" value={rangosBloqueo[i.id]?.inicio ?? ""} onChange={(e) => setRangosBloqueo((p) => ({ ...p, [i.id]: { inicio: e.target.value, fin: p[i.id]?.fin ?? "" } }))} />
                    </Label>
                    <Label className={LABEL_CLASES}>
                      Hasta (exclusivo)
                      <Input type="date" value={rangosBloqueo[i.id]?.fin ?? ""} onChange={(e) => setRangosBloqueo((p) => ({ ...p, [i.id]: { inicio: p[i.id]?.inicio ?? "", fin: e.target.value } }))} />
                    </Label>
                    <Button type="button" size="sm" disabled={bloqueoEnCurso === i.id} onClick={() => void handleConfirmarBloqueo(i)}>
                      {bloqueoEnCurso === i.id ? "Confirmando…" : "Confirmar bloqueo de mantenimiento"}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
      {dialogo}
    </PageContainer>
  );
}
