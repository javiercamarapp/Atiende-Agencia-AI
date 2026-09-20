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
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// las tablas/tarjetas/inputs de estilos inline por Card/Table/Input/Label/Button/
// Tabs reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún
// cambio de lógica: mismos props, mismo estado, mismas llamadas de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
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
import { hoyFechaSolo, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type PeriodDays = 7 | 30 | 90;
const PERIOD_OPTIONS: ReadonlyArray<{ days: PeriodDays; label: string }> = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "90 días" },
];

/** Mismo helper que Dashboard.tsx (ExecutiveSummary) — el servidor exige
 * `desde <= hasta` en YYYY-MM-DD (`DATE_RE`/`parseDateRange` en pl.ts). Redeclarado
 * aquí (no importado de Dashboard.tsx) porque esta página también permite un rango
 * manual, a diferencia del Dashboard que solo ofrece los 3 presets.
 *
 * BUG REAL corregido aquí (revisión de PR #170, mismo bug REQ-r5 ya arreglado en
 * Asistencia.tsx::todayIso): `hasta` se calculaba con `new Date().toISOString().
 * slice(0, 10)` -- día UTC, no el día de calendario del negocio. Entre las 18:00 y
 * las 23:59 hora de CDMX (00:00-05:59 UTC) eso pedía el P&L de MAÑANA (y corría
 * `desde` un día también) y precargaba la fecha del gasto nuevo (`defaultFecha`,
 * más abajo en esta página) con la fecha de MAÑANA -- cae en otro día/periodo
 * contable. `hoyFechaSolo`/`sumarDiasFechaSolo` (apps/web/src/lib/formato-fecha.ts)
 * usan el día de calendario en America/Mexico_City, nunca el día UTC. */
function rangeForDays(days: PeriodDays): { desde: string; hasta: string } {
  const hasta = hoyFechaSolo();
  const desde = sumarDiasFechaSolo(hasta, -(days - 1));
  return { desde, hasta };
}

function formatMoney(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });
}

function formatPct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

const selectClass =
  "mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Ingresos por departamento -> Utilidad departamental (los 3 departamentos operados,
 * los únicos con `revenue` propio — ver `USALI_REVENUE_DEPARTMENTS`). */
function DepartmentTable({ pl }: { pl: PlFullResponse["total"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Ingresos por departamento → Utilidad departamental
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Departamento</TableHead>
              <TableHead className="text-right">Ingresos</TableHead>
              <TableHead className="text-right">Costo de ventas</TableHead>
              <TableHead className="text-right">Nómina</TableHead>
              <TableHead className="text-right">Otros gastos</TableHead>
              <TableHead className="text-right">Gastos totales</TableHead>
              <TableHead className="text-right">Utilidad departamental</TableHead>
              <TableHead className="text-right">Margen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {USALI_REVENUE_DEPARTMENTS.map((dept) => {
              const row = pl.departamentos.find((d) => d.department === dept);
              if (!row) return null;
              return (
                <TableRow key={dept}>
                  <TableCell>{USALI_DEPARTMENT_LABELS[dept]}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.revenue)}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.costOfSales)}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.payroll)}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.otherExpenses)}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.totalExpenses)}</TableCell>
                  <TableCell className="text-right">{formatMoney(row.departmentalProfit)}</TableCell>
                  <TableCell className="text-right">{formatPct(row.profitMarginPct)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow className="font-bold bg-muted/50">
              <TableCell>Total</TableCell>
              <TableCell className="text-right">{formatMoney(pl.ingresosTotales)}</TableCell>
              <TableCell colSpan={4} />
              <TableCell className="text-right">{formatMoney(pl.utilidadDepartamentalTotal)}</TableCell>
              <TableCell className="text-right">{pl.ingresosTotales > 0 ? formatPct((pl.utilidadDepartamentalTotal / pl.ingresosTotales) * 100) : "—"}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Gastos no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no
 * operativos -> Utilidad neta (el resto del Summary Operating Statement USALI). */
function SummaryStatement({ pl }: { pl: PlFullResponse["total"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Gastos no distribuidos → GOP → EBITDA → Utilidad neta
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableBody>
            {USALI_UNDISTRIBUTED_DEPARTMENTS.map((dept) => {
              const row = pl.gastosNoDistribuidos.find((d) => d.department === dept);
              return (
                <TableRow key={dept}>
                  <TableCell>{USALI_DEPARTMENT_LABELS[dept]}</TableCell>
                  <TableCell className="text-right">{formatMoney(row?.amount ?? 0)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow className="font-bold bg-muted/50">
              <TableCell>Total gastos no distribuidos</TableCell>
              <TableCell className="text-right">{formatMoney(pl.totalGastosNoDistribuidos)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Utilidad departamental total</TableCell>
              <TableCell className="text-right">{formatMoney(pl.utilidadDepartamentalTotal)}</TableCell>
            </TableRow>
            <TableRow className="font-bold bg-muted/50">
              <TableCell>GOP (Gross Operating Profit)</TableCell>
              <TableCell className="text-right">
                {formatMoney(pl.gop)} <span className="font-normal text-muted-foreground">({formatPct(pl.gopMarginPct)})</span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{USALI_DEPARTMENT_LABELS.cuota_administracion}</TableCell>
              <TableCell className="text-right">{formatMoney(pl.cuotaAdministracion)}</TableCell>
            </TableRow>
            <TableRow className="font-bold bg-muted/50">
              <TableCell>EBITDA</TableCell>
              <TableCell className="text-right">{formatMoney(pl.ebitda)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{USALI_DEPARTMENT_LABELS.no_operativo}</TableCell>
              <TableCell className="text-right">{formatMoney(pl.gastosNoOperativos)}</TableCell>
            </TableRow>
            <TableRow className="font-bold bg-muted/50 text-base">
              <TableCell>Utilidad neta</TableCell>
              <TableCell className="text-right">{formatMoney(pl.utilidadNeta)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BreakevenAndAlerts({ data }: { data: PlFullResponse }) {
  const be = data.puntoEquilibrio;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">Punto de equilibrio dinámico</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <div>
            <p className="text-sm text-muted-foreground">Ocupación real</p>
            <p className="mt-0.5 font-semibold text-foreground">{formatPct(be.actualOccupancyPct)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Ocupación de equilibrio</p>
            <p className="mt-0.5 font-semibold text-foreground">{formatPct(be.breakevenOccupancyPct)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Brecha</p>
            <p className={`mt-0.5 font-semibold ${be.occupancyGapPct != null && be.occupancyGapPct < 0 ? "text-destructive" : "text-green-700 dark:text-green-500"}`}>
              {be.occupancyGapPct == null ? "—" : `${be.occupancyGapPct >= 0 ? "+" : ""}${be.occupancyGapPct.toFixed(1)} pp`}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Margen de contribución/habitación</p>
            <p className="mt-0.5 font-semibold text-foreground">{formatMoney(be.contributionMarginPerRoom)}</p>
          </div>
        </div>
        {data.ownersReport.alertas.length > 0 && (
          <div className="mt-3 flex flex-col gap-1.5">
            {data.ownersReport.alertas.map((alerta, i) => (
              <p key={i} role="alert" className="text-sm text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-2.5 py-2">
                {alerta}
              </p>
            ))}
          </div>
        )}
        {data.alcance.pendiente.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Fuera de alcance de este P&amp;L todavía: {data.alcance.pendiente.map((p) => p.split(":")[0]).join(", ")}.
          </p>
        )}
      </CardContent>
    </Card>
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
    <Card className="max-w-md">
      <CardContent className="p-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-foreground">Registrar gasto</p>
          <div>
            <Label htmlFor="pl-departamento">Departamento</Label>
            <select id="pl-departamento" value={departamento} onChange={(e) => setDepartamento(e.target.value as UsaliDepartment)} className={selectClass}>
              {USALI_ALL_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {USALI_DEPARTMENT_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="pl-categoria">Categoría</Label>
              <select id="pl-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value as UsaliExpenseCategory)} className={selectClass}>
                {USALI_EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {USALI_EXPENSE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <Label htmlFor="pl-fecha">Fecha</Label>
              <Input id="pl-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required className="mt-1" />
            </div>
          </div>
          <div>
            <Label htmlFor="pl-descripcion">Descripción</Label>
            <Input id="pl-descripcion" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} required className="mt-1" />
          </div>
          <div>
            <Label htmlFor="pl-monto">Monto (MXN)</Label>
            <Input id="pl-monto" type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} required className="mt-1" />
          </div>
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <Button type="submit" disabled={creating}>
            {creating ? "Registrando…" : "Registrar gasto"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ExpenseHistory({ expenses, error }: { expenses: readonly PlExpenseEntry[] | null; error: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">Historial de gastos del periodo</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {error && <EstadoError mensaje={error} />}
        {!expenses && !error && <EstadoCargando lineas={2} etiqueta="Cargando historial de gastos…" />}
        {expenses && expenses.length === 0 && <EstadoVacio mensaje="Sin gastos registrados en este periodo." />}
        {expenses && expenses.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Departamento</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.fecha}</TableCell>
                  <TableCell>{USALI_DEPARTMENT_LABELS[e.departamento]}</TableCell>
                  <TableCell>{USALI_EXPENSE_CATEGORY_LABELS[e.categoria]}</TableCell>
                  <TableCell>{e.descripcion}</TableCell>
                  <TableCell className="text-right">{formatMoney(e.monto)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
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
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-display font-semibold text-foreground">P&amp;L — Estado de resultados USALI</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Periodo {desde} — {hasta}. Formato-resumen 12ª edición: Ingresos por departamento → Utilidad departamental → Gastos no distribuidos → GOP → cuota de administración → EBITDA → Utilidad neta.
          </p>
        </div>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v) as PeriodDays)}>
          <TabsList>
            {PERIOD_OPTIONS.map((opt) => (
              <TabsTrigger key={opt.days} value={String(opt.days)}>
                {opt.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {error && <EstadoError mensaje={error} />}
      {!data && !error && <EstadoCargando etiqueta="Cargando P&L…" />}

      {data && (
        <>
          <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
            <DepartmentTable pl={data.total} />
            <SummaryStatement pl={data.total} />
          </div>

          <BreakevenAndAlerts data={data} />

          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">Gastos</p>
            <Button type="button" variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
              {!showForm && <Plus className="w-4 h-4" strokeWidth={1.75} />}
              {showForm ? "Cancelar" : "Registrar gasto"}
            </Button>
          </div>

          {showForm && <ExpenseForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} defaultFecha={hasta} onCreated={handleExpenseCreated} />}

          <ExpenseHistory expenses={expenses} error={expensesError} />
        </>
      )}
    </div>
  );
}
