// Panel de vencimientos fiscales -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI"): vencimientos.ts expone
// GET /vencimientos, POST /vencimientos/calcular, POST /:id/completar y
// POST /:id/escalar (este último ya dispara notificación real por correo,
// ver @atiende/domain-despachos::tryEnqueueEscalationEmail), pero ningún
// cliente web ni página los usaba. Esta página cierra el gap: lectura de las
// obligaciones fiscales del despacho (ISR/IVA/DIOT/Nómina, día 17 del mes
// siguiente -- motor 100% determinista, ver vencimientos/engine.ts), el
// cálculo de un nuevo periodo, y las 2 acciones reales por vencimiento
// (marcar completado con comprobante opcional, escalar). El escalamiento en
// sí SIEMPRE exige revisión humana (CFF art. 89, ver decidirEscalamiento) --
// esta UI nunca decide una fecha límite fiscal, solo dispara el motor
// existente y muestra su resultado.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import {
  calcularVencimientos,
  completarVencimiento,
  escalarVencimiento,
  fetchVencimientos,
} from "../lib/vencimientos-client.ts";
import type { EstadoVencimiento, FiscalDeadline } from "../lib/vencimientos-client.ts";
import { formatDate, formatEstadoVencimiento, formatPrioridadVencimiento } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const PRIORIDAD_COLORS: Record<FiscalDeadline["prioridad"], { bg: string; fg: string }> = {
  critica: { bg: "#fee2e2", fg: "#991b1b" },
  alta: { bg: "#fed7aa", fg: "#9a3412" },
  media: { bg: "#fef9c3", fg: "#854d0e" },
  baja: { bg: "#dcfce7", fg: "#166534" },
};

const ESTADO_COLORS: Record<EstadoVencimiento, { bg: string; fg: string }> = {
  pendiente: { bg: "#e5e7eb", fg: "#374151" },
  en_proceso: { bg: "#dbeafe", fg: "#1e40af" },
  completado: { bg: "#dcfce7", fg: "#166534" },
  vencido: { bg: "#fee2e2", fg: "#991b1b" },
  escalado: { bg: "#fde68a", fg: "#92400e" },
};

const ESTADO_FILTROS: ReadonlyArray<{ value: EstadoVencimiento | ""; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "pendiente", label: "Pendiente" },
  { value: "en_proceso", label: "En proceso" },
  { value: "vencido", label: "Vencido" },
  { value: "escalado", label: "Escalado" },
  { value: "completado", label: "Completado" },
];

function PrioridadBadge({ prioridad }: { prioridad: FiscalDeadline["prioridad"] }) {
  const colors = PRIORIDAD_COLORS[prioridad];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatPrioridadVencimiento(prioridad)}</span>;
}

function EstadoBadge({ estado }: { estado: EstadoVencimiento }) {
  const colors = ESTADO_COLORS[estado];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatEstadoVencimiento(estado)}</span>;
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function VencimientosPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const [vencimientos, setVencimientos] = useState<readonly FiscalDeadline[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoVencimiento | "">("");

  const now = useMemo(() => new Date(), []);
  const [showCalcularForm, setShowCalcularForm] = useState(false);
  const [calcAnio, setCalcAnio] = useState(now.getUTCFullYear());
  const [calcMes, setCalcMes] = useState(now.getUTCMonth() + 1);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  const [comprobanteDrafts, setComprobanteDrafts] = useState<Record<string, string>>({});
  const [rowActions, setRowActions] = useState<Record<string, RowActionState>>({});

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchVencimientos(fetch, apiBaseUrl, token, propertyId, filtroEstado ? { estado: filtroEstado } : undefined);
      setVencimientos(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los vencimientos fiscales.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, filtroEstado]);

  async function handleCalcular(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCalcError(null);
    if (!Number.isInteger(calcMes) || calcMes < 1 || calcMes > 12) {
      setCalcError("Mes inválido.");
      return;
    }
    setCalculando(true);
    try {
      await calcularVencimientos(fetch, apiBaseUrl, token, propertyId, { year: calcAnio, month: calcMes });
      setShowCalcularForm(false);
      await load();
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : "No se pudieron calcular los vencimientos del periodo.");
    } finally {
      setCalculando(false);
    }
  }

  function setRowState(id: string, state: RowActionState) {
    setRowActions((prev) => ({ ...prev, [id]: state }));
  }

  async function handleCompletar(deadline: FiscalDeadline) {
    const comprobanteUrl = comprobanteDrafts[deadline.id]?.trim() || null;
    setRowState(deadline.id, { loading: true, message: null, isError: false });
    try {
      await completarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id, comprobanteUrl);
      setRowState(deadline.id, { loading: false, message: "Marcado como completado.", isError: false });
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo marcar como completado.", isError: true });
    }
  }

  async function handleEscalar(deadline: FiscalDeadline) {
    setRowState(deadline.id, { loading: true, message: null, isError: false });
    try {
      const resultado = await escalarVencimiento(fetch, apiBaseUrl, token, propertyId, deadline.id);
      const correos = resultado.notificacion.correosEncolados;
      const mensaje = correos > 0 ? `Escalado (${resultado.escalamiento.nivel}). ${correos} correo(s) encolado(s) al staff.` : `Escalado (${resultado.escalamiento.nivel}). Sin correo enviado (sin destinatarios elegibles).`;
      setRowState(deadline.id, { loading: false, message: mensaje, isError: false });
      await load();
    } catch (err) {
      setRowState(deadline.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo escalar el vencimiento.", isError: true });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Vencimientos fiscales</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>ISR, IVA, DIOT y Nómina -- fecha límite día 17 del mes siguiente, prioridad y escalamiento automáticos.</p>
        </div>
        {puedeGestionar && (
          <button
            onClick={() => setShowCalcularForm((v) => !v)}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showCalcularForm ? "#fff" : "#111827", color: showCalcularForm ? "#111827" : "#fff", cursor: "pointer", fontSize: 13 }}
          >
            {showCalcularForm ? "Cancelar" : "+ Calcular vencimientos del periodo"}
          </button>
        )}
      </header>

      {showCalcularForm && (
        <form onSubmit={handleCalcular} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, maxWidth: 340 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Año *
            <input type="number" value={calcAnio} onChange={(e) => setCalcAnio(Number(e.target.value))} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Mes *
            <select value={calcMes} onChange={(e) => setCalcMes(Number(e.target.value))} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }}>
              {MESES.slice(1).map((nombre, i) => (
                <option key={i + 1} value={i + 1}>
                  {nombre}
                </option>
              ))}
            </select>
          </label>
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Genera las 4 obligaciones estándar (ISR/IVA/DIOT/Nómina) con fecha límite el día 17 del mes siguiente.</p>
          {calcError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {calcError}
            </p>
          )}
          <button type="submit" disabled={calculando} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {calculando ? "Calculando…" : "Calcular"}
          </button>
        </form>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
        Filtrar por estado
        <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as EstadoVencimiento | "")} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}>
          {ESTADO_FILTROS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      {loading && !vencimientos && <EstadoCargando etiqueta="Cargando vencimientos…" />}

      {vencimientos && vencimientos.length === 0 && !loading && (
        <EstadoVacio mensaje={`No hay vencimientos fiscales registrados${filtroEstado ? " con ese estado" : ""} todavía.`} />
      )}

      {vencimientos && vencimientos.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Tipo</th>
                <th style={{ padding: "6px 8px" }}>Periodo</th>
                <th style={{ padding: "6px 8px" }}>Fecha límite</th>
                <th style={{ padding: "6px 8px" }}>Prioridad</th>
                <th style={{ padding: "6px 8px" }}>Estado</th>
                {puedeGestionar && <th style={{ padding: "6px 8px" }}>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {vencimientos.map((d) => {
                const rowState = rowActions[d.id];
                const finalizado = d.estado === "completado";
                return (
                  <tr key={d.id} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
                    <td style={{ padding: "8px", fontWeight: 600, color: "#111827" }}>{d.tipo}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>{d.periodo}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>
                      {formatDate(d.fechaLimite)}
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{d.diasRestantes < 0 ? `${-d.diasRestantes} día(s) de atraso` : d.diasRestantes === 0 ? "vence hoy" : `vence en ${d.diasRestantes} día(s)`}</div>
                    </td>
                    <td style={{ padding: "8px" }}>
                      <PrioridadBadge prioridad={d.prioridad} />
                    </td>
                    <td style={{ padding: "8px" }}>
                      <EstadoBadge estado={d.estado} />
                      {finalizado && d.fechaPresentacion && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>Presentado {formatDate(d.fechaPresentacion)}</div>}
                      {finalizado && d.comprobanteUrl && (
                        <div style={{ fontSize: 11, marginTop: 2 }}>
                          <a href={d.comprobanteUrl} target="_blank" rel="noreferrer">
                            Ver comprobante
                          </a>
                        </div>
                      )}
                    </td>
                    {puedeGestionar && (
                      <td style={{ padding: "8px" }}>
                        {!finalizado && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
                            <input
                              type="text"
                              placeholder="URL de comprobante (opcional)"
                              value={comprobanteDrafts[d.id] ?? ""}
                              onChange={(e) => setComprobanteDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                              style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                            />
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => void handleCompletar(d)}
                                disabled={rowState?.loading}
                                style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #166534", background: "#fff", color: "#166534", cursor: "pointer", fontSize: 12 }}
                              >
                                {rowState?.loading ? "…" : "Marcar completado"}
                              </button>
                              {d.estado !== "escalado" && (
                                <button
                                  type="button"
                                  onClick={() => void handleEscalar(d)}
                                  disabled={rowState?.loading}
                                  style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #b45309", background: "#fff", color: "#b45309", cursor: "pointer", fontSize: 12 }}
                                >
                                  Escalar
                                </button>
                              )}
                            </div>
                            {rowState?.message && (
                              <span style={{ fontSize: 11, color: rowState.isError ? "#b91c1c" : "#166534" }} role={rowState.isError ? "alert" : undefined}>
                                {rowState.message}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
