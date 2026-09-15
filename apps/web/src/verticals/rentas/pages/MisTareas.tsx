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
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  asignarTarea,
  completarChecklistItem,
  completarTarea,
  ESTADO_TAREA_LABELS,
  fetchInventario,
  fetchTareaDetalle,
  fetchTareas,
  fetchUnidades,
  PRIORIDAD_LABELS,
  reportarIncidencia,
  SEVERIDAD_LABELS,
  TIPO_TAREA_LABELS,
} from "../lib/limpieza-client.ts";
import type { ItemInventario, SeveridadIncidencia, TareaOperativa, TareaOperativaDetalle, UnidadOption } from "../lib/limpieza-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const LIMPIEZA_OPERACION_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "limpieza"]);

const sectionStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const inputStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const labelStyle: CSSProperties = { fontSize: 13 };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const secondaryButtonStyle: CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" };
const noticeStyle: CSSProperties = { margin: 0, fontSize: 12, color: "#065f46", background: "#d1fae5", padding: "6px 10px", borderRadius: 8 };
const warnStyle: CSSProperties = { margin: 0, fontSize: 12, color: "#92400e", background: "#fef3c7", padding: "6px 10px", borderRadius: 8 };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };
const cardStyle = (activo: boolean): CSSProperties => ({
  border: activo ? "2px solid #111827" : "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 10,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  background: "#fff",
});

function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  return iso.length <= 10 ? iso : new Date(iso).toLocaleString("es-MX");
}

function TareaCard({ tarea, activo, onClick, accion }: { tarea: TareaOperativa; activo: boolean; onClick: () => void; accion?: React.ReactNode }) {
  const vencida = tarea.slaVenceEn !== null && new Date(tarea.slaVenceEn).getTime() < Date.now() && tarea.estado !== "completada" && tarea.estado !== "cancelada";
  return (
    <div style={cardStyle(activo)} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>
          {TIPO_TAREA_LABELS[tarea.tipo]} — {tarea.unidadNombre}
        </strong>
        <span style={{ fontSize: 11, color: vencida ? "#b91c1c" : "#6b7280", fontWeight: vencida ? 700 : 400 }}>{vencida ? "SLA vencido" : ESTADO_TAREA_LABELS[tarea.estado]}</span>
      </div>
      <span style={{ fontSize: 12, color: "#6b7280" }}>
        Programada: {tarea.programadaPara} · Prioridad: {PRIORIDAD_LABELS[tarea.prioridad]}
      </span>
      {accion}
    </div>
  );
}

export function MisTareasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeOperar = org ? LIMPIEZA_OPERACION_ROLES.has(org.rol) : false;

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

  const cargarDetalle = useCallback(
    async (tareaId: string) => {
      setDetalleError(null);
      setAviso(null);
      try {
        const t = await fetchTareaDetalle(fetch, apiBaseUrl, token, propertyId, tareaId);
        setDetalle(t);
        setConsumos([]);
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

  async function handleAsignarme(tareaId: string) {
    setAccionEnCurso(true);
    setListaError(null);
    try {
      await asignarTarea(fetch, apiBaseUrl, token, propertyId, tareaId, {});
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
      setAviso(
        resultado.alertasStockBajo.length > 0
          ? `Tarea completada. Aviso: ${resultado.alertasStockBajo.length} ítem(s) de inventario cruzaron su umbral mínimo.`
          : "Tarea completada.",
      );
      await cargarListas();
      await cargarDetalle(tareaSeleccionadaId);
    } catch (err) {
      // El 409 real de "checklist_incompleto" (o cualquier otro error del servidor)
      // se muestra tal cual — nunca se silencia ni se finge éxito.
      setDetalleError(err instanceof Error ? err.message : "No se pudo completar la tarea.");
    } finally {
      setAccionEnCurso(false);
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
          ? "Incidencia registrada como GRAVE — puede requerir confirmar un bloqueo de mantenimiento (lo hace admin_gestora/operador desde el calendario)."
          : "Incidencia registrada.",
      );
      setIncTitulo("");
      setIncDescripcion("");
    } catch (err) {
      setIncError(err instanceof Error ? err.message : "No se pudo registrar la incidencia.");
    } finally {
      setIncEnviando(false);
    }
  }

  if (!puedeOperar) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Mis tareas</h1>
        <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
          Tu rol actual{org ? <> (<strong>{org.rol}</strong>)</> : ""} no opera el módulo de limpieza/mantenimiento. Roles con acceso: <strong>admin_gestora</strong>,{" "}
          <strong>operador:acceso_total</strong>, <strong>operador:calendario_mensajeria</strong> y <strong>limpieza</strong>.
        </p>
      </div>
    );
  }

  const checklistCompleto = detalle ? detalle.checklist.every((c) => c.completado) : true;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 960 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Mis tareas</h1>
        <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Tareas de limpieza/mantenimiento asignadas a ti, cola de tareas sin asignar, y reporte de incidencias.</p>
      </header>

      {listaError && <p style={errorStyle} role="alert">{listaError}</p>}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <section style={{ ...sectionStyle, flex: "1 1 320px" }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Mis tareas de hoy</h2>
          {misTareas === null && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
          {misTareas !== null && misTareas.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>No tienes tareas asignadas.</p>}
          {misTareas?.map((t) => <TareaCard key={t.id} tarea={t} activo={t.id === tareaSeleccionadaId} onClick={() => handleSeleccionar(t.id)} />)}
        </section>

        <section style={{ ...sectionStyle, flex: "1 1 320px" }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Sin asignar (tómala)</h2>
          {sinAsignar === null && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
          {sinAsignar !== null && sinAsignar.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>No hay tareas pendientes de asignar.</p>}
          {sinAsignar?.map((t) => (
            <TareaCard
              key={t.id}
              tarea={t}
              activo={t.id === tareaSeleccionadaId}
              onClick={() => handleSeleccionar(t.id)}
              accion={
                <button
                  type="button"
                  disabled={accionEnCurso}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleAsignarme(t.id);
                  }}
                  style={secondaryButtonStyle}
                >
                  Asignarme
                </button>
              }
            />
          ))}
        </section>
      </div>

      {tareaSeleccionadaId && (
        <section style={sectionStyle}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Detalle de la tarea</h2>
          {detalleError && <p style={errorStyle} role="alert">{detalleError}</p>}
          {aviso && <p style={noticeStyle}>{aviso}</p>}
          {!detalle && !detalleError && <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>}
          {detalle && (
            <>
              <p style={{ margin: 0, fontSize: 13 }}>
                <strong>{detalle.unidadNombre}</strong> · {TIPO_TAREA_LABELS[detalle.tipo]} · Programada: {detalle.programadaPara} · SLA vence: {formatFecha(detalle.slaVenceEn)}
              </p>
              <p style={{ margin: 0, fontSize: 13 }}>
                Estado: <strong>{ESTADO_TAREA_LABELS[detalle.estado]}</strong>
              </p>

              <div>
                <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>Checklist</h3>
                {detalle.checklist.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Esta tarea no tiene checklist.</p>}
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {detalle.checklist.map((item) => (
                    <li key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={item.completado}
                        disabled={item.completado || accionEnCurso || detalle.estado === "completada" || detalle.estado === "cancelada"}
                        onChange={() => void handleToggleChecklistItem(item.id)}
                      />
                      <span style={{ textDecoration: item.completado ? "line-through" : "none", color: item.completado ? "#6b7280" : "#111827" }}>{item.descripcion}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {detalle.estado !== "completada" && detalle.estado !== "cancelada" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <h3 style={{ fontSize: 13, margin: 0 }}>Consumo de inventario al completar (opcional)</h3>
                  {consumos.map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <select
                        value={c.itemInventarioId}
                        onChange={(e) => setConsumos((prev) => prev.map((x, xi) => (xi === i ? { ...x, itemInventarioId: e.target.value } : x)))}
                        style={{ ...inputStyle, marginTop: 0, flex: 2 }}
                      >
                        {inventario.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.nombre} ({item.cantidadActual} {item.unidadMedida})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        value={c.cantidad}
                        onChange={(e) => setConsumos((prev) => prev.map((x, xi) => (xi === i ? { ...x, cantidad: e.target.value } : x)))}
                        style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                      />
                      <button type="button" onClick={() => handleQuitarConsumo(i)} style={secondaryButtonStyle}>
                        Quitar
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={handleAgregarConsumo} disabled={inventario.length === 0} style={secondaryButtonStyle}>
                    {inventario.length === 0 ? "Esta unidad no tiene inventario configurado" : "+ Agregar consumo"}
                  </button>

                  {!checklistCompleto && <p style={warnStyle}>El checklist tiene ítems pendientes — completar la tarea la bloqueará hasta que termines el checklist.</p>}
                  <button type="button" onClick={() => void handleCompletarTarea()} disabled={accionEnCurso} style={primaryButtonStyle}>
                    Completar tarea
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Reportar incidencia</h2>
        {unidadesError && <p style={errorStyle} role="alert">{unidadesError}</p>}
        {incError && <p style={errorStyle} role="alert">{incError}</p>}
        {incAviso && <p style={noticeStyle}>{incAviso}</p>}
        <form onSubmit={handleReportarIncidencia} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={labelStyle}>
            Unidad
            <select value={incUnidadId} onChange={(e) => setIncUnidadId(e.target.value)} style={inputStyle}>
              <option value="">Selecciona una unidad…</option>
              {unidades.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Severidad
            <select value={incSeveridad} onChange={(e) => setIncSeveridad(e.target.value as SeveridadIncidencia)} style={inputStyle}>
              {(Object.keys(SEVERIDAD_LABELS) as SeveridadIncidencia[]).map((s) => (
                <option key={s} value={s}>
                  {SEVERIDAD_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Título
            <input type="text" value={incTitulo} onChange={(e) => setIncTitulo(e.target.value)} maxLength={200} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Descripción (opcional)
            <textarea value={incDescripcion} onChange={(e) => setIncDescripcion(e.target.value)} maxLength={4000} rows={3} style={inputStyle} />
          </label>
          <button type="submit" disabled={incEnviando} style={primaryButtonStyle}>
            {incEnviando ? "Enviando…" : "Reportar incidencia"}
          </button>
        </form>
      </section>
    </div>
  );
}
