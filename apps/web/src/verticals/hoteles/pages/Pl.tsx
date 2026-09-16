// P&L (back-office financiero) — hallazgo de auditoría (severidad ALTA, "P&L USALI
// (P0) y checador de asistencia LFT sin UI", porción restante): el checador de
// asistencia LFT ya se construyó en una ronda anterior (Asistencia.tsx) y
// Dashboard.tsx ya muestra un resumen ejecutivo del P&L TOTAL (ingresos/GOP/EBITDA/
// utilidad neta) — pero hasta esta fase no existía ninguna pantalla con el desglose
// COMPLETO por departamento (Rooms/F&B/Otros Departamentos -> utilidad departamental,
// gastos no distribuidos por rubro, punto de equilibrio dinámico, owner's report) ni
// forma de registrar o consultar el historial de `hoteles.expense_entry` — el
// back-office real de `GET .../pl` + `POST/GET .../pl/gastos` (ambos ya construidos
// en Fase 10, REQ-BO-010) seguía sin ninguna UI propia. `lib/pl-client.ts` YA existía
// (creado para el resumen ejecutivo del Dashboard) — se EXTENDIÓ ahí
// (`fetchPlFull`/`fetchPlExpenses`/`createPlExpense`), esta página es la UI nueva.
//
// Gate: PL_ROLES (owner/gm/accountant, domain-hoteles/src/roles.ts) — mismo criterio
// "cosmético, nunca la única barrera" que el resto de este panel (HotelesShell.tsx
// solo oculta el link "P&L" del nav para estos 3 roles; un rol sin acceso que navegue
// directo a esta URL ve el 403 real del servidor como mensaje de error, igual que
// Mantenimiento.tsx/Fraude.tsx con sus propios roles).
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import {
  createPlExpense,
  fetchPlExpenses,
  fetchPlFull,
  USALI_ALL_DEPARTMENTS,
  USALI_DEPARTMENT_LABELS,
  USALI_EXPENSE_CATEGORIES,
  USALI_EXPENSE_CATEGORY_LABELS,
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
} from "../lib/pl-client.ts";
import type { PlExpenseEntry, PlFullResponse, UsaliDepartment, UsaliExpenseCategory } from "../lib/pl-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type PeriodDays = 7 | 30 | 90;
const PERIOD_OPTIONS: ReadonlyArray<{ days: PeriodDays; label: string }> = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "90 días" },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Mismo helper que Dashboard.tsx (ExecutiveSummary) — el servidor exige
 * `desde <= hasta` en YYYY-MM-DD (`DATE_RE`/`parseDateRange` en pl.ts). Redeclarado
 * aquí (no importado de Dashboard.tsx) porque esta página también permite un rango
 * manual, a diferencia del Dashboard que solo ofrece los 3 presets. */
function rangeForDays(days: PeriodDays): { desde: string; hasta: string } {
  const hasta = new Date();
  const desde = new Date(hasta);
  desde.setUTCDate(desde.getUTCDate() - (days - 1));
  return { desde: isoDate(desde), hasta: isoDate(hasta) };
}

function formatMoney(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });
}

function formatPct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

const th: CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6b7280", borderBottom: "1px solid #e5e7eb" };
const thLeft: CSSProperties = { ...th, textAlign: "left" };
const td: CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6" };
const tdLeft: CSSProperties = { ...td, textAlign: "left" };
const sectionLabelStyle: CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" };
const cardStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" };
const totalRowStyle: CSSProperties = { fontWeight: 700, background: "#f9fafb" };

/** Ingresos por departamento -> Utilidad departamental (los 3 departamentos operados,
 * los únicos con `revenue` propio — ver `USALI_REVENUE_DEPARTMENTS`). */
function DepartmentTable({ pl }: { pl: PlFullResponse["total"] }) {
  return (
    <div style={cardStyle}>
      <p style={sectionLabelStyle}>Ingresos por departamento → Utilidad departamental</p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={thLeft}>Departamento</th>
              <th style={th}>Ingresos</th>
              <th style={th}>Costo de ventas</th>
              <th style={th}>Nómina</th>
              <th style={th}>Otros gastos</th>
              <th style={th}>Gastos totales</th>
              <th style={th}>Utilidad departamental</th>
              <th style={th}>Margen</th>
            </tr>
          </thead>
          <tbody>
            {USALI_REVENUE_DEPARTMENTS.map((dept) => {
              const row = pl.departamentos.find((d) => d.department === dept);
              if (!row) return null;
              return (
                <tr key={dept}>
                  <td style={tdLeft}>{USALI_DEPARTMENT_LABELS[dept]}</td>
                  <td style={td}>{formatMoney(row.revenue)}</td>
                  <td style={td}>{formatMoney(row.costOfSales)}</td>
                  <td style={td}>{formatMoney(row.payroll)}</td>
                  <td style={td}>{formatMoney(row.otherExpenses)}</td>
                  <td style={td}>{formatMoney(row.totalExpenses)}</td>
                  <td style={td}>{formatMoney(row.departmentalProfit)}</td>
                  <td style={td}>{formatPct(row.profitMarginPct)}</td>
                </tr>
              );
            })}
            <tr style={totalRowStyle}>
              <td style={tdLeft}>Total</td>
              <td style={td}>{formatMoney(pl.ingresosTotales)}</td>
              <td style={td} colSpan={4} />
              <td style={td}>{formatMoney(pl.utilidadDepartamentalTotal)}</td>
              <td style={td}>{pl.ingresosTotales > 0 ? formatPct((pl.utilidadDepartamentalTotal / pl.ingresosTotales) * 100) : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Gastos no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no
 * operativos -> Utilidad neta (el resto del Summary Operating Statement USALI). */
function SummaryStatement({ pl }: { pl: PlFullResponse["total"] }) {
  return (
    <div style={cardStyle}>
      <p style={sectionLabelStyle}>Gastos no distribuidos → GOP → EBITDA → Utilidad neta</p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}>
          <tbody>
            {USALI_UNDISTRIBUTED_DEPARTMENTS.map((dept) => {
              const row = pl.gastosNoDistribuidos.find((d) => d.department === dept);
              return (
                <tr key={dept}>
                  <td style={tdLeft}>{USALI_DEPARTMENT_LABELS[dept]}</td>
                  <td style={td}>{formatMoney(row?.amount ?? 0)}</td>
                </tr>
              );
            })}
            <tr style={totalRowStyle}>
              <td style={tdLeft}>Total gastos no distribuidos</td>
              <td style={td}>{formatMoney(pl.totalGastosNoDistribuidos)}</td>
            </tr>
            <tr>
              <td style={tdLeft}>Utilidad departamental total</td>
              <td style={td}>{formatMoney(pl.utilidadDepartamentalTotal)}</td>
            </tr>
            <tr style={totalRowStyle}>
              <td style={tdLeft}>GOP (Gross Operating Profit)</td>
              <td style={td}>
                {formatMoney(pl.gop)} <span style={{ fontWeight: 400, color: "#6b7280" }}>({formatPct(pl.gopMarginPct)})</span>
              </td>
            </tr>
            <tr>
              <td style={tdLeft}>{USALI_DEPARTMENT_LABELS.cuota_administracion}</td>
              <td style={td}>{formatMoney(pl.cuotaAdministracion)}</td>
            </tr>
            <tr style={totalRowStyle}>
              <td style={tdLeft}>EBITDA</td>
              <td style={td}>{formatMoney(pl.ebitda)}</td>
            </tr>
            <tr>
              <td style={tdLeft}>{USALI_DEPARTMENT_LABELS.no_operativo}</td>
              <td style={td}>{formatMoney(pl.gastosNoOperativos)}</td>
            </tr>
            <tr style={{ ...totalRowStyle, fontSize: 15 }}>
              <td style={tdLeft}>Utilidad neta</td>
              <td style={td}>{formatMoney(pl.utilidadNeta)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakevenAndAlerts({ data }: { data: PlFullResponse }) {
  const be = data.puntoEquilibrio;
  return (
    <div style={cardStyle}>
      <p style={sectionLabelStyle}>Punto de equilibrio dinámico</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, fontSize: 13 }}>
        <div>
          <p style={{ margin: 0, color: "#6b7280" }}>Ocupación real</p>
          <p style={{ margin: "2px 0 0", fontWeight: 600 }}>{formatPct(be.actualOccupancyPct)}</p>
        </div>
        <div>
          <p style={{ margin: 0, color: "#6b7280" }}>Ocupación de equilibrio</p>
          <p style={{ margin: "2px 0 0", fontWeight: 600 }}>{formatPct(be.breakevenOccupancyPct)}</p>
        </div>
        <div>
          <p style={{ margin: 0, color: "#6b7280" }}>Brecha</p>
          <p style={{ margin: "2px 0 0", fontWeight: 600, color: be.occupancyGapPct != null && be.occupancyGapPct < 0 ? "#b91c1c" : "#166534" }}>
            {be.occupancyGapPct == null ? "—" : `${be.occupancyGapPct >= 0 ? "+" : ""}${be.occupancyGapPct.toFixed(1)} pp`}
          </p>
        </div>
        <div>
          <p style={{ margin: 0, color: "#6b7280" }}>Margen de contribución/habitación</p>
          <p style={{ margin: "2px 0 0", fontWeight: 600 }}>{formatMoney(be.contributionMarginPerRoom)}</p>
        </div>
      </div>
      {data.ownersReport.alertas.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {data.ownersReport.alertas.map((alerta, i) => (
            <p key={i} role="alert" style={{ margin: 0, fontSize: 13, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px" }}>
              {alerta}
            </p>
          ))}
        </div>
      )}
      {data.alcance.pendiente.length > 0 && (
        <p style={{ marginTop: 12, fontSize: 11, color: "#9ca3af" }}>
          Fuera de alcance de este P&amp;L todavía: {data.alcance.pendiente.map((p) => p.split(":")[0]).join(", ")}.
        </p>
      )}
    </div>
  );
}

function ExpenseForm({ apiBaseUrl, token, propertyId, defaultFecha, onCreated }: { apiBaseUrl: string; token: string; propertyId: string; defaultFecha: string; onCreated: () => void }) {
  const [departamento, setDepartamento] = useState<UsaliDepartment>(USALI_ALL_DEPARTMENTS[0]);
  const [categoria, setCategoria] = useState<UsaliExpenseCategory>(USALI_EXPENSE_CATEGORIES[0]);
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(defaultFecha);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const montoNum = Number(monto);
    if (!descripcion.trim()) return setFormError("Descripción requerida.");
    if (!Number.isFinite(montoNum) || montoNum < 0) return setFormError("Monto debe ser un número >= 0.");
    if (!fecha) return setFormError("Fecha requerida.");
    setCreating(true);
    try {
      await createPlExpense(fetch, apiBaseUrl, token, propertyId, { departamento, categoria, descripcion: descripcion.trim(), monto: montoNum, fecha });
      setDescripcion("");
      setMonto("");
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar el gasto.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 460 }}>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Registrar gasto</p>
      <label style={{ fontSize: 13 }}>
        Departamento
        <select value={departamento} onChange={(e) => setDepartamento(e.target.value as UsaliDepartment)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}>
          {USALI_ALL_DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {USALI_DEPARTMENT_LABELS[d]}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: 10 }}>
        <label style={{ fontSize: 13, flex: 1 }}>
          Categoría
          <select value={categoria} onChange={(e) => setCategoria(e.target.value as UsaliExpenseCategory)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}>
            {USALI_EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {USALI_EXPENSE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, flex: 1 }}>
          Fecha
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
        </label>
      </div>
      <label style={{ fontSize: 13 }}>
        Descripción
        <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
      </label>
      <label style={{ fontSize: 13 }}>
        Monto (MXN)
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} required style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
      </label>
      {formError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
          {formError}
        </p>
      )}
      <button type="submit" disabled={creating} style={{ padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" }}>
        {creating ? "Registrando…" : "Registrar gasto"}
      </button>
    </form>
  );
}

function ExpenseHistory({ expenses, error }: { expenses: readonly PlExpenseEntry[] | null; error: string | null }) {
  return (
    <div style={cardStyle}>
      <p style={sectionLabelStyle}>Historial de gastos del periodo</p>
      {error && <EstadoError mensaje={error} />}
      {!expenses && !error && <EstadoCargando lineas={2} etiqueta="Cargando historial de gastos…" />}
      {expenses && expenses.length === 0 && <EstadoVacio mensaje="Sin gastos registrados en este periodo." />}
      {expenses && expenses.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>
                <th style={thLeft}>Fecha</th>
                <th style={thLeft}>Departamento</th>
                <th style={thLeft}>Categoría</th>
                <th style={thLeft}>Descripción</th>
                <th style={th}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td style={tdLeft}>{e.fecha}</td>
                  <td style={tdLeft}>{USALI_DEPARTMENT_LABELS[e.departamento]}</td>
                  <td style={tdLeft}>{USALI_EXPENSE_CATEGORY_LABELS[e.categoria]}</td>
                  <td style={tdLeft}>{e.descripcion}</td>
                  <td style={td}>{formatMoney(e.monto)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PlPage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [days, setDays] = useState<PeriodDays>(30);
  const [data, setData] = useState<PlFullResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<readonly PlExpenseEntry[] | null>(null);
  const [expensesError, setExpensesError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const { desde, hasta } = rangeForDays(days);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    fetchPlFull(fetch, apiBaseUrl, token, propertyId, desde, hasta)
      .then((result) => {
        if (!cancelado) setData(result);
      })
      .catch((err) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el P&L.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, days, reloadToken]);

  useEffect(() => {
    let cancelado = false;
    setExpensesError(null);
    fetchPlExpenses(fetch, apiBaseUrl, token, propertyId, desde, hasta)
      .then((result) => {
        if (!cancelado) setExpenses(result);
      })
      .catch((err) => {
        if (!cancelado) setExpensesError(err instanceof Error ? err.message : "No se pudieron cargar los gastos.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, days, reloadToken]);

  function handleExpenseCreated() {
    setShowForm(false);
    setReloadToken((t) => t + 1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>P&amp;L — Estado de resultados USALI</h1>
          <p style={{ fontSize: 12, color: "#9ca3af", margin: "4px 0 0" }}>
            Periodo {desde} — {hasta}. Formato-resumen 12ª edición: Ingresos por departamento → Utilidad departamental → Gastos no distribuidos → GOP → cuota de administración → EBITDA → Utilidad neta.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                background: days === opt.days ? "#111827" : "#fff",
                color: days === opt.days ? "#fff" : "#111827",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>

      {error && <EstadoError mensaje={error} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando P&L…" />}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
            <DepartmentTable pl={data.total} />
            <SummaryStatement pl={data.total} />
          </div>

          <BreakevenAndAlerts data={data} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={sectionLabelStyle}>Gastos</p>
            <button
              onClick={() => setShowForm((v) => !v)}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", fontSize: 13, cursor: "pointer" }}
            >
              {showForm ? "Cancelar" : "+ Registrar gasto"}
            </button>
          </div>

          {showForm && <ExpenseForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} defaultFecha={hasta} onCreated={handleExpenseCreated} />}

          <ExpenseHistory expenses={expenses} error={expensesError} />
        </>
      )}
    </div>
  );
}
