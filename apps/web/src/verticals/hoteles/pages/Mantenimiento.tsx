// Mantenimiento — tickets correctivos (Fase 7, REQ-HK-011): crear/listar/cerrar
// tickets reales contra housekeeping.ts. Los turnos de camaristas/lavandería
// (REQ-HK-008, LFT) no están en esta página — ver housekeeping-client.ts.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { closeTicket, createTicket, fetchTickets, TICKET_SEVERITY_LABELS, TICKET_STATUS_LABELS } from "../lib/housekeeping-client.ts";
import type { MaintenanceTicketSeverity, MaintenanceTicketStatus, MaintenanceTicketSummary } from "../lib/housekeeping-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const FILTERS: ReadonlyArray<MaintenanceTicketStatus | "todos"> = ["todos", "abierto", "en_progreso", "cerrado", "cancelado"];
const SEVERITIES: readonly MaintenanceTicketSeverity[] = ["alta", "media", "baja"];

export function MantenimientoPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [filter, setFilter] = useState<MaintenanceTicketStatus | "todos">("abierto");
  const [tickets, setTickets] = useState<readonly MaintenanceTicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [severidad, setSeveridad] = useState<MaintenanceTicketSeverity>("media");
  const [roomId, setRoomId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setTickets(await fetchTickets(fetch, apiBaseUrl, token, propertyId, filter === "todos" ? undefined : filter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los tickets.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, filter]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!titulo.trim() || !descripcion.trim()) return setFormError("Título y descripción son requeridos.");
    setCreating(true);
    try {
      await createTicket(fetch, apiBaseUrl, token, propertyId, { titulo: titulo.trim(), descripcion: descripcion.trim(), severidad, roomId: roomId.trim() || undefined });
      setTitulo("");
      setDescripcion("");
      setRoomId("");
      setSeveridad("media");
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el ticket.");
    } finally {
      setCreating(false);
    }
  }

  async function handleClose(ticket: MaintenanceTicketSummary) {
    const costStr = window.prompt(`Costo real de cerrar "${ticket.titulo}" (MXN):`, String(ticket.costoEstimado));
    if (costStr === null) return;
    const actualCost = Number(costStr);
    if (!Number.isFinite(actualCost) || actualCost < 0) {
      setError("El costo real debe ser un número >= 0.");
      return;
    }
    const nota = window.prompt("Nota de resolución (opcional):") ?? undefined;
    setBusyId(ticket.id);
    setError(null);
    try {
      await closeTicket(fetch, apiBaseUrl, token, propertyId, ticket.id, actualCost, nota || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cerrar el ticket.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Mantenimiento</h1>
        <button onClick={() => setShowForm((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", fontSize: 13, cursor: "pointer" }}>
          {showForm ? "Cancelar" : "+ Nuevo ticket"}
        </button>
      </header>

      {showForm && (
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 420 }}>
          <label style={{ fontSize: 13 }}>
            Título
            <input value={titulo} onChange={(e) => setTitulo(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 13 }}>
            Descripción
            <textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4, minHeight: 70 }} />
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ fontSize: 13, flex: 1 }}>
              Severidad
              <select value={severidad} onChange={(e) => setSeveridad(e.target.value as MaintenanceTicketSeverity)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_SEVERITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13, flex: 1 }}>
              Habitación (opcional)
              <input value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
            </label>
          </div>
          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={creating} style={{ padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" }}>
            {creating ? "Creando…" : "Crear ticket"}
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
            {f === "todos" ? "Todos" : TICKET_STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!tickets && !error && <EstadoCargando etiqueta="Cargando tickets…" />}
      {tickets && tickets.length === 0 && <EstadoVacio mensaje="No hay tickets en este filtro." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tickets?.map((t) => (
          <div key={t.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{t.titulo}</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  {t.roomId ? `Habitación ${t.roomId}` : "Sin habitación"} · Origen: {t.origen} · Estimado: ${t.costoEstimado.toLocaleString("es-MX")}
                </p>
              </div>
              <span style={{ alignSelf: "flex-start", fontSize: 12, padding: "3px 10px", borderRadius: 999, background: t.severidad === "alta" ? "#fee2e2" : "#f3f4f6", color: t.severidad === "alta" ? "#991b1b" : "#374151" }}>
                {TICKET_SEVERITY_LABELS[t.severidad]} · {TICKET_STATUS_LABELS[t.estado]}
              </span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#374151" }}>{t.descripcion}</p>
            {t.notaResolucion && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>Resolución: {t.notaResolucion}</p>}
            {(t.estado === "abierto" || t.estado === "en_progreso") && (
              <div style={{ marginTop: 10 }}>
                <button onClick={() => void handleClose(t)} disabled={busyId === t.id} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}>
                  {busyId === t.id ? "…" : "Cerrar ticket"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
