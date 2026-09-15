// Calendario de reservas y bloqueos (Fase 13) — cierra el hallazgo de auditoría
// "Calendario de reservas y bloqueos: backend completo sin UI": reservas.ts (Fase 1)
// y bloqueos.ts (Fase 4) ya exponían crear/modificar/cancelar reservas y crear/
// listar/liberar bloqueos, pero ningún cliente web los consumía. Vista real (lista
// por fecha, no un calendario visual con drag-and-drop — fuera de alcance de este
// hallazgo, ver el brief): unidad seleccionada -> lista unificada de sus ocupaciones
// (reserva de canal Y bloqueo, GET .../ocupaciones, calendario-client.ts) con
// crear/cancelar reserva, crear/cancelar bloqueo y modificar fechas de una reserva
// directa -- las 3 acciones reales que el backend ya soportaba sin UI.
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  cancelarBloqueo,
  cancelarReserva,
  crearBloqueo,
  createReserva,
  ESTADO_LABELS,
  fetchOcupaciones,
  fetchUnidades,
  modificarFechasReserva,
  RAZON_LABELS,
  RAZONES_BLOQUEO,
} from "../lib/calendario-client.ts";
import type { OcupacionCalendario, RazonBloqueo, UnidadOption } from "../lib/calendario-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const inputStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const labelStyle: CSSProperties = { fontSize: 13 };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" };
const secondaryButtonStyle: CSSProperties = { padding: "5px 12px", borderRadius: 8, border: "1px solid #6b7280", background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer" };
const dangerButtonStyle: CSSProperties = { padding: "5px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" };

/** Solo las reservas SIN canal externo (o canal 'manual') aceptan modificar fechas —
 * mismo guardia que ya aplica el servidor en `PATCH .../reservas/:id`
 * ("reserva_no_directa" si `canalOrigenId` no es null/manual, ver reservas.ts). Esto
 * solo evita ofrecer un botón que el servidor rechazaría; el servidor SIEMPRE
 * re-valida. */
function esReservaDirecta(o: OcupacionCalendario): boolean {
  return o.capa === "reserva" && (o.canalCodigo === null || o.canalCodigo === "manual");
}

function badgeColorFor(o: OcupacionCalendario): { bg: string; fg: string } {
  if (o.estado === "cancelado") return { bg: "#f3f4f6", fg: "#6b7280" };
  if (o.capa === "reserva") return { bg: "#dbeafe", fg: "#1e40af" };
  return { bg: "#fef3c7", fg: "#92400e" };
}

export function CalendarioPage({ apiBaseUrl, token, propertyId }: RentasShellContext) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [ocupaciones, setOcupaciones] = useState<readonly OcupacionCalendario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showReservaForm, setShowReservaForm] = useState(false);
  const [reservaInicio, setReservaInicio] = useState("");
  const [reservaFin, setReservaFin] = useState("");
  const [huespedNombre, setHuespedNombre] = useState("");
  const [huespedContacto, setHuespedContacto] = useState("");
  const [creandoReserva, setCreandoReserva] = useState(false);
  const [reservaFormError, setReservaFormError] = useState<string | null>(null);

  const [showBloqueoForm, setShowBloqueoForm] = useState(false);
  const [bloqueoInicio, setBloqueoInicio] = useState("");
  const [bloqueoFin, setBloqueoFin] = useState("");
  const [bloqueoRazon, setBloqueoRazon] = useState<RazonBloqueo>("MANTENIMIENTO");
  const [creandoBloqueo, setCreandoBloqueo] = useState(false);
  const [bloqueoFormError, setBloqueoFormError] = useState<string | null>(null);

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [editInicio, setEditInicio] = useState("");
  const [editFin, setEditFin] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [guardandoEdit, setGuardandoEdit] = useState(false);

  // Hallazgo de auditoría (severidad ALTA, "cancelar la reserva de un huésped ejecuta
  // con un solo clic sin confirmación") -- el primer clic solo marca CUÁL ocupación
  // está pidiendo confirmación (mismo patrón de 2 pasos que ya usa Aprobaciones.tsx
  // para "Rechazar" -> "Confirmar rechazo"); la llamada real al servidor
  // (`handleCancelar`) solo ocurre en el SEGUNDO clic, explícito ("Sí, cancelar").
  const [confirmandoCancelarId, setConfirmandoCancelarId] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  async function loadOcupaciones(uid: string) {
    setError(null);
    try {
      const list = await fetchOcupaciones(fetch, apiBaseUrl, token, propertyId, uid);
      setOcupaciones(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el calendario de esta unidad.");
    }
  }

  useEffect(() => {
    if (!unidadId) return;
    setOcupaciones(null);
    void loadOcupaciones(unidadId);
  }, [apiBaseUrl, token, propertyId, unidadId]);

  async function handleCrearReserva(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReservaFormError(null);
    if (!reservaInicio || !reservaFin) return setReservaFormError("Check-in y check-out son requeridos.");
    setCreandoReserva(true);
    try {
      const resultado = await createReserva(fetch, apiBaseUrl, token, propertyId, unidadId, {
        rango: { inicio: reservaInicio, fin: reservaFin },
        huespedNombre: huespedNombre.trim() || undefined,
        huespedContacto: huespedContacto.trim() || undefined,
      });
      setReservaInicio("");
      setReservaFin("");
      setHuespedNombre("");
      setHuespedContacto("");
      setShowReservaForm(false);
      setNotice(
        resultado.conflictosCapaCruzada > 0
          ? `Reserva creada — se detectó ${resultado.conflictosCapaCruzada} conflicto(s) con un bloqueo existente en estas fechas, revisa el calendario.`
          : "Reserva creada.",
      );
      await loadOcupaciones(unidadId);
    } catch (err) {
      setReservaFormError(err instanceof Error ? err.message : "No se pudo crear la reserva.");
    } finally {
      setCreandoReserva(false);
    }
  }

  async function handleCrearBloqueo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBloqueoFormError(null);
    if (!bloqueoInicio || !bloqueoFin) return setBloqueoFormError("Inicio y fin son requeridos.");
    setCreandoBloqueo(true);
    try {
      const resultado = await crearBloqueo(fetch, apiBaseUrl, token, propertyId, unidadId, { rango: { inicio: bloqueoInicio, fin: bloqueoFin }, razon: bloqueoRazon });
      setBloqueoInicio("");
      setBloqueoFin("");
      setBloqueoRazon("MANTENIMIENTO");
      setShowBloqueoForm(false);
      setNotice(
        resultado.conflictosCapaCruzada > 0
          ? `Bloqueo creado — se detectó ${resultado.conflictosCapaCruzada} conflicto(s) con una ocupación existente en estas fechas, revisa el calendario.`
          : "Bloqueo creado.",
      );
      await loadOcupaciones(unidadId);
    } catch (err) {
      setBloqueoFormError(err instanceof Error ? err.message : "No se pudo crear el bloqueo.");
    } finally {
      setCreandoBloqueo(false);
    }
  }

  function startEdit(o: OcupacionCalendario) {
    setEditandoId(o.id);
    setEditInicio(o.rango.inicio);
    setEditFin(o.rango.fin);
    setEditError(null);
  }

  async function handleGuardarEdit(o: OcupacionCalendario) {
    setEditError(null);
    if (!editInicio || !editFin) return setEditError("Inicio y fin son requeridos.");
    setGuardandoEdit(true);
    try {
      await modificarFechasReserva(fetch, apiBaseUrl, token, propertyId, unidadId, o.id, { inicio: editInicio, fin: editFin });
      setEditandoId(null);
      setNotice("Fechas actualizadas.");
      await loadOcupaciones(unidadId);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "No se pudieron actualizar las fechas.");
    } finally {
      setGuardandoEdit(false);
    }
  }

  async function handleCancelar(o: OcupacionCalendario) {
    setConfirmandoCancelarId(null);
    setBusyId(o.id);
    setError(null);
    try {
      if (o.capa === "reserva") {
        await cancelarReserva(fetch, apiBaseUrl, token, propertyId, unidadId, o.id);
        setNotice("Reserva cancelada.");
      } else {
        await cancelarBloqueo(fetch, apiBaseUrl, token, propertyId, unidadId, o.id);
        setNotice("Bloqueo liberado.");
      }
      await loadOcupaciones(unidadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la cancelación.");
    } finally {
      setBusyId(null);
    }
  }

  if (unidades && unidades.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Calendario</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta propiedad todavía no tiene ninguna unidad configurada.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Calendario</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              setShowBloqueoForm(false);
              setShowReservaForm((v) => !v);
            }}
            style={{ ...primaryButtonStyle, background: showReservaForm ? "#fff" : "#111827", color: showReservaForm ? "#111827" : "#fff" }}
          >
            {showReservaForm ? "Cancelar" : "+ Nueva reserva"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowReservaForm(false);
              setShowBloqueoForm((v) => !v);
            }}
            style={{ ...primaryButtonStyle, background: showBloqueoForm ? "#fff" : "#fff", color: "#111827" }}
          >
            {showBloqueoForm ? "Cancelar" : "+ Nuevo bloqueo"}
          </button>
        </div>
      </header>

      <label style={{ ...labelStyle, maxWidth: 320 }}>
        Unidad
        <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} style={inputStyle} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </select>
      </label>

      {showReservaForm && (
        <form onSubmit={handleCrearReserva} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Nueva reserva directa</h2>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ ...labelStyle, flex: 1 }}>
              Check-in
              <input type="date" value={reservaInicio} onChange={(e) => setReservaInicio(e.target.value)} required style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, flex: 1 }}>
              Check-out
              <input type="date" value={reservaFin} onChange={(e) => setReservaFin(e.target.value)} required style={inputStyle} />
            </label>
          </div>
          <label style={labelStyle}>
            Huésped (opcional)
            <input value={huespedNombre} onChange={(e) => setHuespedNombre(e.target.value)} style={inputStyle} placeholder="Nombre" />
          </label>
          <label style={labelStyle}>
            Contacto del huésped (opcional)
            <input value={huespedContacto} onChange={(e) => setHuespedContacto(e.target.value)} style={inputStyle} placeholder="Correo o teléfono" />
          </label>
          {reservaFormError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {reservaFormError}
            </p>
          )}
          <button type="submit" disabled={creandoReserva} style={{ ...primaryButtonStyle, fontWeight: 600 }}>
            {creandoReserva ? "Creando…" : "Crear reserva"}
          </button>
        </form>
      )}

      {showBloqueoForm && (
        <form onSubmit={handleCrearBloqueo} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Nuevo bloqueo</h2>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ ...labelStyle, flex: 1 }}>
              Inicio
              <input type="date" value={bloqueoInicio} onChange={(e) => setBloqueoInicio(e.target.value)} required style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, flex: 1 }}>
              Fin
              <input type="date" value={bloqueoFin} onChange={(e) => setBloqueoFin(e.target.value)} required style={inputStyle} />
            </label>
          </div>
          <label style={labelStyle}>
            Razón
            <select value={bloqueoRazon} onChange={(e) => setBloqueoRazon(e.target.value as RazonBloqueo)} style={inputStyle}>
              {RAZONES_BLOQUEO.map((r) => (
                <option key={r} value={r}>
                  {RAZON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {bloqueoFormError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {bloqueoFormError}
            </p>
          )}
          <button type="submit" disabled={creandoBloqueo} style={{ ...primaryButtonStyle, fontWeight: 600 }}>
            {creandoBloqueo ? "Creando…" : "Crear bloqueo"}
          </button>
        </form>
      )}

      {notice && (
        <p style={{ margin: 0, fontSize: 13, color: "#065f46", background: "#d1fae5", padding: "8px 12px", borderRadius: 8 }}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!ocupaciones && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {ocupaciones && ocupaciones.length === 0 && <p style={{ color: "#6b7280" }}>Esta unidad no tiene ninguna reserva ni bloqueo registrado.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ocupaciones?.map((o) => {
          const colors = badgeColorFor(o);
          const puedeEditar = esReservaDirecta(o) && o.estado === "confirmado";
          const puedeCancelar = o.estado !== "cancelado" && (o.capa === "bloqueo" || o.capa === "reserva");
          return (
            <div key={o.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>
                    {o.rango.inicio} → {o.rango.fin}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                    {RAZON_LABELS[o.razon]}
                    {o.capa === "reserva" && o.canalCodigo ? ` · canal: ${o.canalCodigo}` : ""}
                    {o.huespedNombre ? ` · huésped: ${o.huespedNombre}` : ""}
                    {o.huespedContacto ? ` (${o.huespedContacto})` : ""}
                  </p>
                </div>
                <span style={{ alignSelf: "flex-start", fontSize: 12, padding: "3px 10px", borderRadius: 999, background: colors.bg, color: colors.fg }}>
                  {ESTADO_LABELS[o.estado]}
                </span>
              </div>

              {editandoId === o.id ? (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
                  <label style={{ ...labelStyle, flex: 1, minWidth: 120 }}>
                    Nuevo check-in
                    <input type="date" value={editInicio} onChange={(e) => setEditInicio(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ ...labelStyle, flex: 1, minWidth: 120 }}>
                    Nuevo check-out
                    <input type="date" value={editFin} onChange={(e) => setEditFin(e.target.value)} style={inputStyle} />
                  </label>
                  <button type="button" onClick={() => void handleGuardarEdit(o)} disabled={guardandoEdit} style={secondaryButtonStyle}>
                    {guardandoEdit ? "Guardando…" : "Guardar"}
                  </button>
                  <button type="button" onClick={() => setEditandoId(null)} style={secondaryButtonStyle}>
                    Cancelar
                  </button>
                  {editError && (
                    <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 12, width: "100%" }}>
                      {editError}
                    </p>
                  )}
                </div>
              ) : confirmandoCancelarId === o.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <p role="alert" style={{ margin: 0, fontSize: 13, color: "#b91c1c" }}>
                    {o.capa === "reserva" ? "¿Seguro que quieres cancelar esta reserva?" : "¿Seguro que quieres liberar este bloqueo?"} Esta acción no se puede
                    deshacer.
                  </p>
                  <button type="button" onClick={() => void handleCancelar(o)} disabled={busyId === o.id} style={dangerButtonStyle}>
                    {busyId === o.id ? "…" : o.capa === "reserva" ? "Sí, cancelar reserva" : "Sí, liberar bloqueo"}
                  </button>
                  <button type="button" onClick={() => setConfirmandoCancelarId(null)} disabled={busyId === o.id} style={secondaryButtonStyle}>
                    No, mantenerla
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {puedeEditar && (
                    <button type="button" onClick={() => startEdit(o)} disabled={busyId === o.id} style={secondaryButtonStyle}>
                      Modificar fechas
                    </button>
                  )}
                  {puedeCancelar && (
                    <button type="button" onClick={() => setConfirmandoCancelarId(o.id)} disabled={busyId === o.id} style={dangerButtonStyle}>
                      {o.capa === "reserva" ? "Cancelar reserva" : "Liberar bloqueo"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
