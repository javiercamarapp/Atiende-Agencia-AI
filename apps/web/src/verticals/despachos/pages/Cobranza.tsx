// Panel de cobranza (Fase 10) -- hallazgo de auditoría (severidad ALTA):
// "Cobranza tiene motor + persistencia completos (aging/score de
// cobrabilidad/proyección/resumen ejecutivo, más el correo real de
// recordatorio construido en la ronda 2) pero cero rutas HTTP y cero UI".
// Antes de esta fase, el ÚNICO camino para disparar un recordatorio de
// cobranza era el barrido interno de worker
// (`POST /internal/despachos/cobranza-reminders`, gateado por secreto
// compartido) -- ningún humano podía ni ver la cartera ni mandar un
// recordatorio fuera de su fecha exacta. Esta página cierra las 2 mitades del
// gap: lectura real de la cartera (resumen ejecutivo + tabla con aging/score
// ya calculados por `@atiende/domain-despachos::resumenCobranza`) y las 3
// acciones reales que el repositorio ya soportaba sin ruta
// (registerReceivable/markReceivablePaid/el envío real de recordatorio, ver
// cobranza-client.ts).
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { fetchInvoices } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import {
  COBRANZA_REMINDER_STAGES,
  enviarRecordatorioCobranza,
  fetchCuentasCobranza,
  fetchResumenCobranza,
  marcarCuentaPagada,
  registrarCuentaCobranza,
} from "../lib/cobranza-client.ts";
import type { CobranzaAgeBucket, CobranzaReminderStage, CuentaCobranza, ResumenCobranza } from "../lib/cobranza-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

const BUCKET_LABELS: Record<CobranzaAgeBucket, string> = { "0-30": "0-30 días", "31-60": "31-60 días", "61-90": "61-90 días", "90+": "90+ días" };
const BUCKET_COLORS: Record<CobranzaAgeBucket, { bg: string; fg: string }> = {
  "0-30": { bg: "#dcfce7", fg: "#166534" },
  "31-60": { bg: "#fef9c3", fg: "#854d0e" },
  "61-90": { bg: "#fed7aa", fg: "#9a3412" },
  "90+": { bg: "#fee2e2", fg: "#991b1b" },
};
const STAGE_LABELS: Record<CobranzaReminderStage, string> = {
  pre_vencimiento: "Recordatorio amigable (7 días antes)",
  vencimiento: "Vence hoy",
  recordatorio_formal: "Primer recordatorio formal (+7 días)",
  segundo_recordatorio: "Segundo recordatorio (+30 días)",
  escalamiento: "Escalamiento a gerencia (+60 días)",
};

function BucketBadge({ bucket }: { bucket: CobranzaAgeBucket }) {
  const colors = BUCKET_COLORS[bucket];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{BUCKET_LABELS[bucket]}</span>;
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "#166534" : score >= 0.4 ? "#854d0e" : "#991b1b";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 48, height: 6, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 12, color }}>{pct}%</span>
    </div>
  );
}

function ResumenCards({ resumen }: { resumen: ResumenCobranza }) {
  const buckets: readonly CobranzaAgeBucket[] = ["0-30", "31-60", "61-90", "90+"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 160px", border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Cartera pendiente</p>
          <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>{formatMoney(resumen.totalCartera)}</p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{resumen.totalCount} cuenta(s)</p>
        </div>
        <div style={{ flex: "1 1 160px", border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Cobro esperado</p>
          <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>{formatMoney(resumen.totalEsperado)}</p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{resumen.tasaRecuperacionEsperada}% tasa esperada</p>
        </div>
        {buckets.map((b) => (
          <div key={b} style={{ flex: "1 1 120px", border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
            <p style={{ margin: 0, fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>{BUCKET_LABELS[b]}</p>
            <p style={{ margin: "4px 0 0", fontSize: 16, fontWeight: 700 }}>{formatMoney(resumen.porAntiguedad[b].monto)}</p>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
              {resumen.porAntiguedad[b].count} · {resumen.porAntiguedad[b].porcentaje}%
            </p>
          </div>
        ))}
      </div>
      {resumen.alertas.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {resumen.alertas.map((a, i) => (
            <p key={i} role="alert" style={{ margin: 0, fontSize: 13, padding: "8px 12px", borderRadius: 8, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}>
              ⚠ {a}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

interface RowActionState {
  readonly loading: boolean;
  readonly message: string | null;
  readonly isError: boolean;
}

export function CobranzaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const [cuentas, setCuentas] = useState<readonly CuentaCobranza[] | null>(null);
  const [resumen, setResumen] = useState<ResumenCobranza | null>(null);
  const [invoicesElegibles, setInvoicesElegibles] = useState<readonly InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [fechaVencimiento, setFechaVencimiento] = useState("");
  const [clienteNombre, setClienteNombre] = useState("");
  const [clienteEmail, setClienteEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [rowActions, setRowActions] = useState<Record<string, RowActionState>>({});
  const [stageChoice, setStageChoice] = useState<Record<string, CobranzaReminderStage | "">>({});

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cuentasRes, resumenRes, invoicesRes] = await Promise.all([
        fetchCuentasCobranza(fetch, apiBaseUrl, token, propertyId, soloPendientes ? { pendiente: true } : undefined),
        fetchResumenCobranza(fetch, apiBaseUrl, token, propertyId),
        fetchInvoices(fetch, apiBaseUrl, token, propertyId),
      ]);
      setCuentas(cuentasRes);
      setResumen(resumenRes);
      setInvoicesElegibles(invoicesRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la cartera de cobranza.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, soloPendientes]);

  // Invoices tipo 'I' que todavía no tienen una cuenta por cobrar registrada
  // -- las únicas que puede elegir el formulario de "registrar cuenta".
  const invoiceIdsConCuenta = useMemo(() => new Set((cuentas ?? []).map((c) => c.invoiceId)), [cuentas]);
  const invoicesDisponibles = useMemo(() => invoicesElegibles.filter((inv) => inv.tipo === "I" && !invoiceIdsConCuenta.has(inv.id)), [invoicesElegibles, invoiceIdsConCuenta]);

  async function handleRegistrar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!invoiceId) {
      setFormError("Elige un CFDI de tipo Ingreso.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaVencimiento)) {
      setFormError("Fecha de vencimiento inválida.");
      return;
    }
    setSubmitting(true);
    try {
      await registrarCuentaCobranza(fetch, apiBaseUrl, token, propertyId, {
        invoiceId,
        fechaVencimiento,
        clienteNombre: clienteNombre.trim() || null,
        clienteEmail: clienteEmail.trim() || null,
      });
      setShowForm(false);
      setInvoiceId("");
      setFechaVencimiento("");
      setClienteNombre("");
      setClienteEmail("");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar la cuenta por cobrar.");
    } finally {
      setSubmitting(false);
    }
  }

  function setRowState(id: string, state: RowActionState) {
    setRowActions((prev) => ({ ...prev, [id]: state }));
  }

  async function handleMarcarPagada(cuenta: CuentaCobranza) {
    setRowState(cuenta.id, { loading: true, message: null, isError: false });
    try {
      await marcarCuentaPagada(fetch, apiBaseUrl, token, propertyId, cuenta.id, { montoPagado: cuenta.monto });
      setRowState(cuenta.id, { loading: false, message: "Marcada como pagada.", isError: false });
      await load();
    } catch (err) {
      setRowState(cuenta.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo marcar como pagada.", isError: true });
    }
  }

  async function handleEnviarRecordatorio(cuenta: CuentaCobranza) {
    const stage = stageChoice[cuenta.id] || undefined;
    setRowState(cuenta.id, { loading: true, message: null, isError: false });
    try {
      const resultado = await enviarRecordatorioCobranza(fetch, apiBaseUrl, token, propertyId, cuenta.id, stage || undefined);
      const etiqueta = STAGE_LABELS[resultado.etapa] ?? resultado.etapa;
      const mensaje = resultado.enviado ? `Recordatorio enviado (${etiqueta}).` : `Evento registrado (${etiqueta}), pero esta cuenta no tiene correo de contacto capturado.`;
      setRowState(cuenta.id, { loading: false, message: mensaje, isError: !resultado.enviado });
    } catch (err) {
      setRowState(cuenta.id, { loading: false, message: err instanceof Error ? err.message : "No se pudo enviar el recordatorio.", isError: true });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Cobranza</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Cartera por antigüedad, score de cobrabilidad y recordatorios reales por correo.</p>
        </div>
        {puedeGestionar && (
          <button onClick={() => setShowForm((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", cursor: "pointer", fontSize: 13 }}>
            {showForm ? "Cancelar" : "+ Registrar cuenta por cobrar"}
          </button>
        )}
      </header>

      {showForm && (
        <form onSubmit={handleRegistrar} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, maxWidth: 420 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            CFDI (tipo Ingreso) *
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }}>
              <option value="">Selecciona un CFDI…</option>
              {invoicesDisponibles.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.folioFiscal.slice(0, 13)}… · {inv.emisorNombre ?? inv.rfcEmisor} · {formatMoney(inv.total)}
                </option>
              ))}
            </select>
            {invoicesDisponibles.length === 0 && <span style={{ fontSize: 12, color: "#9ca3af" }}>No hay CFDI de ingreso sin cuenta por cobrar todavía.</span>}
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Fecha de vencimiento *
            <input type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Nombre del cliente (opcional)
            <input type="text" value={clienteNombre} onChange={(e) => setClienteNombre(e.target.value)} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Correo de contacto (opcional -- sin esto no se puede enviar recordatorio real)
            <input type="email" value={clienteEmail} onChange={(e) => setClienteEmail(e.target.value)} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={submitting} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {submitting ? "Registrando…" : "Registrar cuenta"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {loading && !resumen && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {resumen && <ResumenCards resumen={resumen} />}

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151" }}>
        <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} />
        Solo cuentas pendientes de cobro
      </label>

      {cuentas && cuentas.length === 0 && !loading && <p style={{ color: "#6b7280" }}>{soloPendientes ? "No hay cuentas por cobrar pendientes." : "Todavía no hay ninguna cuenta por cobrar registrada."}</p>}

      {cuentas && cuentas.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Factura</th>
                <th style={{ padding: "6px 8px" }}>Cliente</th>
                <th style={{ padding: "6px 8px" }}>Monto</th>
                <th style={{ padding: "6px 8px" }}>Vence</th>
                <th style={{ padding: "6px 8px" }}>Antigüedad</th>
                <th style={{ padding: "6px 8px" }}>Score</th>
                <th style={{ padding: "6px 8px" }}>Estatus</th>
                {puedeGestionar && <th style={{ padding: "6px 8px" }}>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {cuentas.map((cuenta) => {
                const rowState = rowActions[cuenta.id];
                return (
                  <tr key={cuenta.id} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
                    <td style={{ padding: "8px", fontFamily: "monospace", fontSize: 12 }}>{cuenta.facturaId ? `${cuenta.facturaId.slice(0, 13)}…` : "—"}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>
                      {cuenta.clienteNombre ?? "Sin nombre"}
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{cuenta.clienteEmail ?? "sin correo capturado"}</div>
                    </td>
                    <td style={{ padding: "8px", color: "#374151" }}>{formatMoney(cuenta.monto)}</td>
                    <td style={{ padding: "8px", color: "#374151" }}>
                      {formatDate(cuenta.fechaVencimiento)}
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{cuenta.diasVencido > 0 ? `${cuenta.diasVencido} días de atraso` : cuenta.diasVencido < 0 ? `vence en ${-cuenta.diasVencido} días` : "vence hoy"}</div>
                    </td>
                    <td style={{ padding: "8px" }}>
                      <BucketBadge bucket={cuenta.bucket} />
                    </td>
                    <td style={{ padding: "8px" }}>
                      <ScoreBar score={cuenta.score} />
                    </td>
                    <td style={{ padding: "8px" }}>
                      {cuenta.pagadoEn ? (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#dcfce7", color: "#166534", fontWeight: 600 }}>Pagada {formatDate(cuenta.pagadoEn)}</span>
                      ) : (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#fef9c3", color: "#854d0e", fontWeight: 600 }}>Pendiente</span>
                      )}
                    </td>
                    {puedeGestionar && (
                      <td style={{ padding: "8px" }}>
                        {!cuenta.pagadoEn && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <select
                                value={stageChoice[cuenta.id] ?? ""}
                                onChange={(e) => setStageChoice((prev) => ({ ...prev, [cuenta.id]: e.target.value as CobranzaReminderStage | "" }))}
                                style={{ flex: 1, padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
                              >
                                <option value="">Etapa sugerida</option>
                                {COBRANZA_REMINDER_STAGES.map((s) => (
                                  <option key={s} value={s}>
                                    {STAGE_LABELS[s]}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => void handleEnviarRecordatorio(cuenta)}
                                disabled={rowState?.loading}
                                style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #111827", background: "#fff", color: "#111827", cursor: "pointer", fontSize: 12 }}
                              >
                                {rowState?.loading ? "…" : "Enviar recordatorio"}
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleMarcarPagada(cuenta)}
                              disabled={rowState?.loading}
                              style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #166534", background: "#fff", color: "#166534", cursor: "pointer", fontSize: 12 }}
                            >
                              Marcar pagada
                            </button>
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
