// Reservas — recepción (Fase 7): crear/listar/transicionar/cancelar reservas reales
// contra la máquina de estados de @atiende/domain-hoteles (reservationStateMachine.ts,
// ver reservas-client.ts). El servidor SIEMPRE re-valida cada transición — los
// botones ofrecidos aquí son solo un espejo de NEXT_GENERIC_STATUS para no mostrar
// una acción que el servidor rechazaría (mismo criterio que PedidosPage de
// restaurantes).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  cancelReservation,
  createReservation,
  fetchReservations,
  isCancellable,
  NEXT_GENERIC_STATUS,
  RESERVATION_STATUS_LABELS,
  transitionReservation,
} from "../lib/reservas-client.ts";
import type { ReservationStatus, ReservationSummary } from "../lib/reservas-client.ts";
import { fetchFoliosByReservation } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FILTERS: ReadonlyArray<ReservationStatus | "todas"> = ["todas", "confirmada", "check_in", "en_estancia", "check_out", "cerrada", "cancelada"];

export function ReservasPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ReservationStatus | "todas">("todas");
  const [reservations, setReservations] = useState<readonly ReservationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [roomTypeId, setRoomTypeId] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [guestId, setGuestId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const list = await fetchReservations(fetch, apiBaseUrl, token, propertyId);
      setReservations([...list].sort((a, b) => b.creadaEn.localeCompare(a.creadaEn)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!roomTypeId.trim()) return setFormError("roomTypeId es requerido.");
    if (!checkInDate || !checkOutDate) return setFormError("Check-in y check-out son requeridos.");
    setCreating(true);
    try {
      await createReservation(
        fetch,
        apiBaseUrl,
        token,
        propertyId,
        { roomTypeId: roomTypeId.trim(), checkInDate, checkOutDate, guestId: guestId.trim() || undefined },
        newIdempotencyKey(),
      );
      setRoomTypeId("");
      setCheckInDate("");
      setCheckOutDate("");
      setGuestId("");
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear la reserva.");
    } finally {
      setCreating(false);
    }
  }

  async function handleTransition(reservation: ReservationSummary, toStatus: ReservationStatus) {
    setBusyId(reservation.id);
    setError(null);
    try {
      await transitionReservation(fetch, apiBaseUrl, token, propertyId, reservation.id, toStatus);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado de la reserva.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(reservation: ReservationSummary) {
    setBusyId(reservation.id);
    setError(null);
    try {
      await cancelReservation(fetch, apiBaseUrl, token, propertyId, reservation.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar la reserva.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerFolio(reservation: ReservationSummary) {
    setBusyId(reservation.id);
    setError(null);
    try {
      const folios = await fetchFoliosByReservation(fetch, apiBaseUrl, token, propertyId, reservation.id);
      const primary = folios.find((f) => f.esPrincipal) ?? folios[0];
      if (!primary) {
        setError("Esta reserva todavía no tiene ningún folio.");
        return;
      }
      navigate(`folios/${primary.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir el folio de esta reserva.");
    } finally {
      setBusyId(null);
    }
  }

  const visible = reservations?.filter((r) => filter === "todas" || r.estado === filter) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Reservas</h1>
        <button onClick={() => setShowForm((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", fontSize: 13, cursor: "pointer" }}>
          {showForm ? "Cancelar" : "+ Nueva reserva"}
        </button>
      </header>

      {showForm && (
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420 }}>
          <label style={{ fontSize: 13 }}>
            Tipo de habitación (roomTypeId)
            <input value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ fontSize: 13, flex: 1 }}>
              Check-in
              <input type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
            </label>
            <label style={{ fontSize: 13, flex: 1 }}>
              Check-out
              <input type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
            </label>
          </div>
          <label style={{ fontSize: 13 }}>
            Huésped (guestId, opcional)
            <input value={guestId} onChange={(e) => setGuestId(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>
          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={creating} style={{ padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" }}>
            {creating ? "Creando…" : "Crear reserva"}
          </button>
        </form>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid #d1d5db", background: filter === f ? "#111827" : "#fff", color: filter === f ? "#fff" : "#111827", fontSize: 12, cursor: "pointer" }}
          >
            {f === "todas" ? "Todas" : RESERVATION_STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!visible && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {visible && visible.length === 0 && <p style={{ color: "#6b7280" }}>No hay reservas en este filtro.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {visible?.map((r) => {
          const next = NEXT_GENERIC_STATUS[r.estado];
          const cancelable = isCancellable(r.estado);
          return (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>
                    {r.checkInDate} → {r.checkOutDate} · {formatMoney(r.montoTotal)}
                  </p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                    Tipo de habitación: {r.roomTypeId} · {r.guestId ? `Huésped: ${r.guestId}` : "Sin huésped asignado"}
                  </p>
                </div>
                <span style={{ alignSelf: "flex-start", fontSize: 12, padding: "3px 10px", borderRadius: 999, background: r.estado === "cancelada" ? "#fee2e2" : "#f3f4f6", color: r.estado === "cancelada" ? "#991b1b" : "#374151" }}>
                  {RESERVATION_STATUS_LABELS[r.estado]}
                </span>
              </div>
              {r.penalizacionCancelacion != null && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#b91c1c" }}>Penalización de cancelación: {formatMoney(r.penalizacionCancelacion)}</p>}
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                <button onClick={() => void handleVerFolio(r)} disabled={busyId === r.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #6b7280", background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer" }}>
                  Ver folio
                </button>
                {next && (
                  <button onClick={() => void handleTransition(r, next)} disabled={busyId === r.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}>
                    {busyId === r.id ? "…" : `Marcar ${RESERVATION_STATUS_LABELS[next]}`}
                  </button>
                )}
                {cancelable && (
                  <button onClick={() => void handleCancel(r)} disabled={busyId === r.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}>
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
