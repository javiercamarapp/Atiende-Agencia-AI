// Dashboard de cierre mensual (Fase 9) — lista los períodos ya abiertos de esta
// property (GET .../cierre-mensual/periodos, cierre-mensual.ts) con su estatus y
// avance del checklist, y permite abrir un período nuevo (POST .../periodos, Fase
// 6). Antes de esta fase el motor completo de checklist/validaciones de
// balance/bloqueo de edición YA existía en @atiende/domain-despachos pero era
// alcanzable solo vía curl — este es el primer camino real del staff para operar el
// cierre de un mes. La landing real del panel (ver App.tsx: redirect de
// `/despachos/:orgSlug`), porque el cierre mensual es la tarea operativa más
// recurrente y de mayor riesgo de un despacho (bloquea la facturación del mes
// siguiente si no se corre a tiempo).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { crearPeriodo, fetchPeriodos } from "../lib/cierre-mensual-client.ts";
import type { ClosePeriod } from "../lib/cierre-mensual-client.ts";
import { formatDate, formatPeriodStatus, formatPeriodo } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const STATUS_COLORS: Record<ClosePeriod["status"], { bg: string; fg: string }> = {
  open: { bg: "#dbeafe", fg: "#1e40af" },
  closed: { bg: "#dcfce7", fg: "#166534" },
  overdue: { bg: "#fee2e2", fg: "#991b1b" },
};

function StatusBadge({ status }: { status: ClosePeriod["status"] }) {
  const colors = STATUS_COLORS[status];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatPeriodStatus(status)}</span>;
}

const NOW = new Date();

export function CierreMensualPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const [periodos, setPeriodos] = useState<readonly ClosePeriod[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [anio, setAnio] = useState(String(NOW.getFullYear()));
  const [mes, setMes] = useState(String(NOW.getMonth() + 1));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPeriodos(await fetchPeriodos(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los períodos de cierre.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  async function handleAbrir(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const anioNum = Number(anio);
    const mesNum = Number(mes);
    if (!Number.isInteger(anioNum) || anioNum < 2000) {
      setFormError("Año inválido.");
      return;
    }
    if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
      setFormError("Mes inválido (1-12).");
      return;
    }
    setSubmitting(true);
    try {
      await crearPeriodo(fetch, apiBaseUrl, token, propertyId, { anio: anioNum, mes: mesNum });
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo abrir el período.");
    } finally {
      setSubmitting(false);
    }
  }

  const ordenados = periodos ? [...periodos].sort((a, b) => (a.year !== b.year ? b.year - a.year : b.month - a.month)) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Cierre mensual</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Checklist de 15 tareas por período: CFDI, bancos, nómina, declaraciones, contabilidad electrónica y reportes.</p>
        </div>
        {GESTIONAR_ROLES.has(role) && (
          <button onClick={() => setShowForm((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", cursor: "pointer", fontSize: 13 }}>
            {showForm ? "Cancelar" : "+ Abrir período"}
          </button>
        )}
      </header>

      {showForm && (
        <form onSubmit={handleAbrir} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, maxWidth: 320 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Año *
            <input type="number" min="2000" max="2100" value={anio} onChange={(e) => setAnio(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Mes (1-12) *
            <input type="number" min="1" max="12" value={mes} onChange={(e) => setMes(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={submitting} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {submitting ? "Abriendo…" : "Abrir período"}
          </button>
        </form>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !periodos && <EstadoCargando etiqueta="Cargando períodos de cierre…" />}

      {periodos && periodos.length === 0 && !loading && (
        <EstadoVacio mensaje="Todavía no hay ningún período de cierre abierto." />
      )}

      {ordenados.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Período</th>
                <th style={{ padding: "6px 8px" }}>Estatus</th>
                <th style={{ padding: "6px 8px" }}>Abierto</th>
                <th style={{ padding: "6px 8px" }}>Cerrado</th>
              </tr>
            </thead>
            <tbody>
              {ordenados.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px" }}>
                    <Link to={`/despachos/${orgSlug}/cierre-mensual/${p.id}`} style={{ color: "#111827", fontWeight: 600, textDecoration: "none" }}>
                      {formatPeriodo(p.year, p.month)}
                    </Link>
                  </td>
                  <td style={{ padding: "8px" }}>
                    <StatusBadge status={p.status} />
                  </td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatDate(p.openedAt)}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatDate(p.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
