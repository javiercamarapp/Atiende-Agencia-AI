// Servicios del panel de citas — lista + ficha (Fase 5). Fase 8 cierra el gap real
// de paridad con el origen (ServiciosSection.tsx): alta/edición real de un
// servicio (ver services-client.ts). `citas.services` no tiene columnas
// `description`/`requirements` como el origen — quedan fuera de esta fase.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Scissors } from "lucide-react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { createService, fetchServiceDetail, fetchServices, updateService } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { formatMoneyFromCents } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const inputStyle = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };
const primaryButtonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" };

export function ServiciosListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newDuration, setNewDuration] = useState("30");
  const [newPrice, setNewPrice] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    setError(null);
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then(setServices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los servicios."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const duration = Number.parseInt(newDuration, 10);
    if (!newName.trim() || !Number.isFinite(duration) || duration <= 0) return;
    setCreating(true);
    setError(null);
    try {
      const priceCents = newPrice.trim() ? Math.round(Number(newPrice) * 100) : undefined;
      await createService(fetch, apiBaseUrl, token, propertyId, { name: newName.trim(), durationMinutes: duration, priceCents });
      setNewName("");
      setNewDuration("30");
      setNewPrice("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el servicio.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Servicios</h1>
      {error && <EstadoError mensaje={error} />}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Nuevo servicio</p>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Nombre (ej. Consulta general)" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} />
          <input placeholder="Duración (min)" type="number" min={1} value={newDuration} onChange={(e) => setNewDuration(e.target.value)} style={{ ...inputStyle, width: 110 }} />
          <input placeholder="Precio (opcional)" type="number" min={0} step="0.01" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} style={{ ...inputStyle, width: 130 }} />
          <button type="submit" disabled={creating} style={primaryButtonStyle}>
            {creating ? "Creando…" : "Crear servicio"}
          </button>
        </form>
      </section>

      {!services && !error && <EstadoCargando etiqueta="Cargando servicios…" />}
      {services && services.length === 0 && <EstadoVacio icon={Scissors} mensaje="Este negocio todavía no tiene servicios activos." />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {services?.map((s) => (
          <Link key={s.id} to={`/citas/${orgSlug}/servicios/${s.id}`} style={{ display: "block", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, textDecoration: "none", color: "inherit" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{s.name}</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>
              {s.durationMinutes} min · {formatMoneyFromCents(s.priceCents)}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ServicioFichaPageProps extends CitasShellContext {
  readonly serviceId: string;
}

export function ServicioFichaPage({ apiBaseUrl, token, propertyId, orgSlug, serviceId }: ServicioFichaPageProps) {
  const [service, setService] = useState<ServiceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDuration, setEditDuration] = useState("");
  const [editBufferBefore, setEditBufferBefore] = useState("");
  const [editBufferAfter, setEditBufferAfter] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(null);
    fetchServiceDetail(fetch, apiBaseUrl, token, propertyId, serviceId)
      .then((s) => {
        setService(s);
        setEditName(s.name);
        setEditDuration(String(s.durationMinutes));
        setEditBufferBefore(String(s.bufferMinutesBefore));
        setEditBufferAfter(String(s.bufferMinutesAfter));
        setEditPrice(s.priceCents !== null ? String(s.priceCents / 100) : "");
        setEditIsActive(s.isActive);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el servicio."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId, serviceId]);

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    const duration = Number.parseInt(editDuration, 10);
    if (!editName.trim() || !Number.isFinite(duration) || duration <= 0) return;
    setSaving(true);
    setError(null);
    try {
      await updateService(fetch, apiBaseUrl, token, propertyId, serviceId, {
        name: editName.trim(),
        durationMinutes: duration,
        bufferMinutesBefore: Number.parseInt(editBufferBefore, 10) || 0,
        bufferMinutesAfter: Number.parseInt(editBufferAfter, 10) || 0,
        priceCents: editPrice.trim() ? Math.round(Number(editPrice) * 100) : null,
        isActive: editIsActive,
      });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el servicio.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }}>
      <Link to={`/citas/${orgSlug}/servicios`} style={{ fontSize: 13, color: "#6b7280" }}>
        ← Volver a servicios
      </Link>
      {error && <EstadoError mensaje={error} />}
      {!service && !error && <EstadoCargando etiqueta="Cargando servicio…" />}
      {service && !editing && (
        <>
          <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>{service.name}</h1>
            <button onClick={() => setEditing(true)} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" }}>
              Editar servicio
            </button>
          </header>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 8, columnGap: 12, fontSize: 14 }}>
            <dt style={{ color: "#6b7280" }}>Duración</dt>
            <dd style={{ margin: 0 }}>{service.durationMinutes} min</dd>
            <dt style={{ color: "#6b7280" }}>Colchón antes</dt>
            <dd style={{ margin: 0 }}>{service.bufferMinutesBefore} min</dd>
            <dt style={{ color: "#6b7280" }}>Colchón después</dt>
            <dd style={{ margin: 0 }}>{service.bufferMinutesAfter} min</dd>
            <dt style={{ color: "#6b7280" }}>Precio</dt>
            <dd style={{ margin: 0 }}>{formatMoneyFromCents(service.priceCents)}</dd>
            <dt style={{ color: "#6b7280" }}>Estado</dt>
            <dd style={{ margin: 0 }}>{service.isActive ? "Activo" : "Inactivo"}</dd>
          </dl>
        </>
      )}
      {service && editing && (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
          <form onSubmit={handleSaveEdit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Nombre
              <input value={editName} onChange={(e) => setEditName(e.target.value)} style={inputStyle} />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280", flex: 1 }}>
                Duración (min)
                <input type="number" min={1} value={editDuration} onChange={(e) => setEditDuration(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280", flex: 1 }}>
                Colchón antes
                <input type="number" min={0} value={editBufferBefore} onChange={(e) => setEditBufferBefore(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280", flex: 1 }}>
                Colchón después
                <input type="number" min={0} value={editBufferAfter} onChange={(e) => setEditBufferAfter(e.target.value)} style={inputStyle} />
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Precio (vacío = sin precio fijo)
              <input type="number" min={0} step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} />
              Activo
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={saving} style={primaryButtonStyle}>
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button type="button" onClick={() => setEditing(false)} disabled={saving} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" }}>
                Cancelar
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
