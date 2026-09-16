// Dashboard — landing real del panel de hoteles (Fase 16). Hallazgo de auditoría
// (severidad ALTA, "No hay dashboard por tipo de usuario: todos aterrizan en
// Reservas"): antes de esta fase, `HotelesRootRedirect` (App.tsx) mandaba a CUALQUIER
// rol directo a `/hoteles/:orgSlug/reservas` — owner/gm/accountant no tenían ninguna
// vista financiera (aunque el backend ya expone `GET .../pl` desde Fase 10 y
// `GET/POST .../night-audit` desde Fase 6) y housekeeping/maintenance/fnb no tenían
// NINGUNA vista propia (solo Reservas, que ni siquiera pueden usar para nada útil
// desde su rol). Mismo patrón exacto que `RestaurantesDashboardPage`
// (verticals/restaurantes/pages/Dashboard.tsx): montado DIRECTO en la raíz del
// orgSlug (ver App.tsx — `HotelesRootRedirect` se elimina, esta página reemplaza esa
// ruta), no una redirección aparte.
//
// Dos variantes según rol (mismo criterio "cosmético, nunca la única barrera" que el
// resto de este panel — ver comentario de cabecera de HotelesShell.tsx: el gate REAL
// vive siempre en el servidor, `PL_ROLES`/`MAINTENANCE_TICKET_CREATE_ROLES` de
// domain-hoteles/src/roles.ts):
//
//   1. owner/gm/accountant (mismo conjunto exacto que `PL_ROLES`): resumen ejecutivo
//      con los KPIs reales de ocupación/ADR/RevPAR y el TOTAL del P&L USALI del
//      periodo, ambos de `GET .../pl` (pl-client.ts), con un link a `pages/Pl.tsx`
//      (back-office de P&L completo: desglose por departamento, gastos no
//      distribuidos, punto de equilibrio dinámico, owner's report y registro/
//      historial de gastos — hallazgo de auditoría severidad ALTA, "P&L USALI (P0)...
//      sin UI", porción restante). Este resumen ejecutivo SIGUE siendo solo el TOTAL
//      del periodo (esta pantalla es un RESUMEN, no una reconstrucción a nivel
//      Cfdi.tsx/Folio.tsx del P&L completo) — el desglose vive en `pages/Pl.tsx`.
//      Night audit (`GET .../night-audit`) tampoco se agrega aquí: sus
//      KPIs de ocupación reales ya llegan por el mismo `GET .../pl` (`kpis.
//      occupancyPct`), y el resto de night-audit (conciliación A/B, cargos posteados)
//      es una acción operativa de cierre de día, no un KPI de resumen — corresponde a
//      su propia pantalla dedicada (gap independiente, no de este hallazgo).
//   2. resto (frontdesk/reservations/housekeeping/maintenance/fnb): sin acceso a
//      `PL_ROLES` (el servidor respondería 403 en `/pl`), así que un resumen
//      operativo simple — reservas de hoy (llegadas/salidas/en estancia, mismo dato
//      para los 5 roles, ninguno gateado del lado del servidor en `GET .../reservas`)
//      más un acceso directo a SU área: Mantenimiento (housekeeping/maintenance,
//      mismo subconjunto de `MAINTENANCE_TICKET_CREATE_ROLES` que puede consultar el
//      conteo de tickets sin 403 entre estos 5 roles — fnb/reservations NO están en
//      esa lista, ver housekeeping.ts) o Pedidos F&B (fnb, único rol de este grupo
//      cuya área es la cocina).
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza los
// KPI-tiles/tarjetas de estilos inline por StatCard/Card reales — mismo criterio ya
// aplicado en HotelesShell.tsx/Login.tsx. Ningún cambio de lógica: mismos props,
// mismo estado, mismas llamadas de red, misma condición de cada rama.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BedDouble, CalendarCheck, CalendarClock, CircleDollarSign, PiggyBank, ShieldAlert, TrendingUp, UtensilsCrossed, Wallet, Wrench } from "lucide-react";
import { Button, Card, CardContent, EstadoCargando, EstadoError, StatCard, Tabs, TabsList, TabsTrigger } from "@atiende/ui";
import { fetchPlSummary } from "../lib/pl-client.ts";
import type { PlSummaryResponse } from "../lib/pl-client.ts";
import { fetchReservations } from "../lib/reservas-client.ts";
import type { ReservationSummary } from "../lib/reservas-client.ts";
import { fetchTickets } from "../lib/housekeeping-client.ts";
import type { MaintenanceTicketSummary } from "../lib/housekeeping-client.ts";
import { fetchPedidosFnb } from "../lib/pedidos-fnb-client.ts";
import type { FnbPedido } from "../lib/pedidos-fnb-client.ts";
import { saludoConNombre } from "../../../lib/greeting.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

// Mismo conjunto exacto que `PL_ROLES` (domain-hoteles/src/roles.ts) — redeclarado a
// propósito, mismo criterio que el resto de este vertical (apps/web no depende de
// paquetes domain-*, ver comentario de cabecera de pl-client.ts).
const EXECUTIVE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);
// Mismo conjunto exacto que `MAINTENANCE_TICKET_CREATE_ROLES` — de los 5 roles que
// llegan a `OperationalSummary`, solo estos pueden consultar `GET .../mantenimiento/
// tickets` sin que el servidor responda 403 (ver housekeeping.ts).
const TICKETS_VISIBLE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "housekeeping", "maintenance"]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type PeriodDays = 7 | 30 | 90;
const PERIOD_OPTIONS: ReadonlyArray<{ days: PeriodDays; label: string }> = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "90 días" },
];

/** El servidor exige `desde <= hasta` en formato YYYY-MM-DD (ver `DATE_RE`/
 * `parseDateRange` en pl.ts) — este helper solo arma ese rango en UTC, nunca decide
 * qué periodo mostrar por default (eso es estado de React, ver `ExecutiveSummary`). */
function rangeForDays(days: PeriodDays): { desde: string; hasta: string } {
  const hasta = new Date();
  const desde = new Date(hasta);
  desde.setUTCDate(desde.getUTCDate() - (days - 1));
  return { desde: isoDate(desde), hasta: isoDate(hasta) };
}

function formatMoney(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** owner/gm/accountant — ver comentario de cabecera del archivo, punto 1. */
function ExecutiveSummary({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const [days, setDays] = useState<PeriodDays>(30);
  const [data, setData] = useState<PlSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    const { desde, hasta } = rangeForDays(days);
    fetchPlSummary(fetch, apiBaseUrl, token, propertyId, desde, hasta)
      .then((result) => {
        if (!cancelado) setData(result);
      })
      .catch((err) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el resumen financiero.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, days]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs font-mono uppercase tracking-[0.08em] text-muted-foreground">Resumen ejecutivo</p>
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
      {!data && !error && <EstadoCargando etiqueta="Cargando resumen financiero…" />}

      {data && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <StatCard icon={BedDouble} label="Ocupación" value={formatPct(data.kpis.occupancyPct)} nota={`${data.kpis.occupiedRoomNights}/${data.kpis.availableRoomNights} noches-habitación`} />
            <StatCard icon={CircleDollarSign} label="ADR" value={formatMoney(data.kpis.adr)} nota="tarifa promedio diaria" />
            <StatCard icon={TrendingUp} label="RevPAR" value={formatMoney(data.kpis.revpar)} nota="ingreso por habitación disponible" />
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <StatCard icon={Wallet} label="Ingresos totales" value={formatMoney(data.total.ingresosTotales)} />
            <StatCard icon={PiggyBank} label="GOP" value={formatMoney(data.total.gop)} nota={`${formatPct(data.total.gopMarginPct)} de margen`} />
            <StatCard icon={TrendingUp} label="EBITDA" value={formatMoney(data.total.ebitda)} />
            <StatCard icon={CircleDollarSign} label="Utilidad neta" value={formatMoney(data.total.utilidadNeta)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Periodo {data.periodo.desde} — {data.periodo.hasta}.
          </p>
          <Button asChild variant="link" className="self-start px-0">
            <Link to={`/hoteles/${orgSlug}/pl`}>
              Ver P&amp;L completo (por departamento + gastos)
              <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}

/** frontdesk/reservations/housekeeping/maintenance/fnb — ver comentario de cabecera
 * del archivo, punto 2. */
function OperationalSummary({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const [reservations, setReservations] = useState<readonly ReservationSummary[] | null>(null);
  const [reservationsError, setReservationsError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<readonly MaintenanceTicketSummary[] | null>(null);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [pedidos, setPedidos] = useState<readonly FnbPedido[] | null>(null);
  const [pedidosError, setPedidosError] = useState<string | null>(null);

  const showTickets = TICKETS_VISIBLE_ROLES.has(role);
  const showPedidos = role === "fnb";

  useEffect(() => {
    let cancelado = false;
    fetchReservations(fetch, apiBaseUrl, token, propertyId)
      .then((result) => {
        if (!cancelado) setReservations(result);
      })
      .catch((err) => {
        if (!cancelado) setReservationsError(err instanceof Error ? err.message : "No se pudieron cargar las reservas.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!showTickets) return;
    let cancelado = false;
    fetchTickets(fetch, apiBaseUrl, token, propertyId, "abierto")
      .then((result) => {
        if (!cancelado) setTickets(result);
      })
      .catch((err) => {
        if (!cancelado) setTicketsError(err instanceof Error ? err.message : "No se pudieron cargar los tickets de mantenimiento.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, showTickets]);

  useEffect(() => {
    if (!showPedidos) return;
    let cancelado = false;
    fetchPedidosFnb(fetch, apiBaseUrl, token, propertyId)
      .then((result) => {
        if (!cancelado) setPedidos(result);
      })
      .catch((err) => {
        if (!cancelado) setPedidosError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos de F&B.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, showPedidos]);

  const today = isoDate(new Date());
  const llegadasHoy = reservations?.filter((r) => r.checkInDate === today && (r.estado === "confirmada" || r.estado === "check_in")).length ?? null;
  const salidasHoy = reservations?.filter((r) => r.checkOutDate === today && (r.estado === "en_estancia" || r.estado === "check_out")).length ?? null;
  const enEstancia = reservations?.filter((r) => r.estado === "en_estancia").length ?? null;
  const alergiasSinConfirmar = pedidos?.filter((p) => p.alergiaDeclarada && !p.cocineroConfirmoEn).length ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <Card>
          <CardContent className="p-4 flex flex-col gap-2.5">
            <p className="text-xs font-mono uppercase tracking-[0.08em] text-muted-foreground">Reservas de hoy</p>
            {reservationsError && <p role="alert" className="text-sm text-destructive">{reservationsError}</p>}
            {reservations === null && !reservationsError && <p className="text-sm text-muted-foreground">Cargando…</p>}
            {reservations !== null && (
              <div className="grid grid-cols-3 gap-2">
                <StatCard icon={CalendarCheck} label="Llegadas" value={String(llegadasHoy)} />
                <StatCard icon={CalendarClock} label="Salidas" value={String(salidasHoy)} />
                <StatCard icon={BedDouble} label="En estancia" value={String(enEstancia)} />
              </div>
            )}
            <Button asChild variant="link" className="self-start px-0">
              <Link to={`/hoteles/${orgSlug}/reservas`}>
                Ir a Reservas
                <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {showTickets && (
          <Card>
            <CardContent className="p-4 flex flex-col gap-2.5">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-muted-foreground">Mantenimiento</p>
              {ticketsError && <p role="alert" className="text-sm text-destructive">{ticketsError}</p>}
              {tickets === null && !ticketsError && <p className="text-sm text-muted-foreground">Cargando…</p>}
              {tickets !== null && <StatCard icon={Wrench} label="Tickets abiertos" value={String(tickets.length)} />}
              <Button asChild variant="link" className="self-start px-0">
                <Link to={`/hoteles/${orgSlug}/mantenimiento`}>
                  Ir a Mantenimiento
                  <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {showPedidos && (
          <Card>
            <CardContent className="p-4 flex flex-col gap-2.5">
              <p className="text-xs font-mono uppercase tracking-[0.08em] text-muted-foreground">Pedidos F&amp;B</p>
              {pedidosError && <p role="alert" className="text-sm text-destructive">{pedidosError}</p>}
              {pedidos === null && !pedidosError && <p className="text-sm text-muted-foreground">Cargando…</p>}
              {pedidos !== null && (
                <div className="grid grid-cols-2 gap-2">
                  <StatCard icon={UtensilsCrossed} label="Pedidos activos" value={String(pedidos.length)} />
                  <StatCard icon={ShieldAlert} label="Alergia sin confirmar" value={String(alergiasSinConfirmar)} />
                </div>
              )}
              <Button asChild variant="link" className="self-start px-0">
                <Link to={`/hoteles/${orgSlug}/pedidos-fnb`}>
                  Ir a Pedidos F&amp;B
                  <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export function DashboardPage(ctx: HotelesShellContext) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-muted-foreground">{saludoConNombre(ctx.staffFullName, ctx.staffEmail)}</p>
        <h1 className="text-xl font-display font-semibold text-foreground">Panel de {ctx.orgSlug}</h1>
      </div>
      {EXECUTIVE_ROLES.has(ctx.role) ? <ExecutiveSummary {...ctx} /> : <OperationalSummary {...ctx} />}
    </div>
  );
}
