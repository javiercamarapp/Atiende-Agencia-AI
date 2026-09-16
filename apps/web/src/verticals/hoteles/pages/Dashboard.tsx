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
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { EstadoCargando, EstadoError } from "@atiende/ui";
import { fetchPlSummary } from "../lib/pl-client.ts";
import type { PlSummaryResponse } from "../lib/pl-client.ts";
import { fetchReservations } from "../lib/reservas-client.ts";
import type { ReservationSummary } from "../lib/reservas-client.ts";
import { fetchTickets } from "../lib/housekeeping-client.ts";
import type { MaintenanceTicketSummary } from "../lib/housekeeping-client.ts";
import { fetchPedidosFnb } from "../lib/pedidos-fnb-client.ts";
import type { FnbPedido } from "../lib/pedidos-fnb-client.ts";
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

function Card({ children }: { children: ReactNode }) {
  return <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>;
}

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
      <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 600, margin: "4px 0 0" }}>{value}</p>
      {note && <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>{note}</p>}
    </div>
  );
}

function linkButtonStyle(): CSSProperties {
  return { alignSelf: "flex-start", fontSize: 13, color: "#111827", fontWeight: 600, textDecoration: "none" };
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
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Resumen ejecutivo</p>
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
      {!data && !error && <EstadoCargando etiqueta="Cargando resumen financiero…" />}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <StatTile label="Ocupación" value={formatPct(data.kpis.occupancyPct)} note={`${data.kpis.occupiedRoomNights}/${data.kpis.availableRoomNights} noches-habitación`} />
            <StatTile label="ADR" value={formatMoney(data.kpis.adr)} note="tarifa promedio diaria" />
            <StatTile label="RevPAR" value={formatMoney(data.kpis.revpar)} note="ingreso por habitación disponible" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <StatTile label="Ingresos totales" value={formatMoney(data.total.ingresosTotales)} />
            <StatTile label="GOP" value={formatMoney(data.total.gop)} note={`${formatPct(data.total.gopMarginPct)} de margen`} />
            <StatTile label="EBITDA" value={formatMoney(data.total.ebitda)} />
            <StatTile label="Utilidad neta" value={formatMoney(data.total.utilidadNeta)} />
          </div>
          <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Periodo {data.periodo.desde} — {data.periodo.hasta}.</p>
          <Link to={`/hoteles/${orgSlug}/pl`} style={linkButtonStyle()}>
            Ver P&amp;L completo (por departamento + gastos) →
          </Link>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <Card>
          <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Reservas de hoy</p>
          {reservationsError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {reservationsError}
            </p>
          )}
          {reservations === null && !reservationsError && <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Cargando…</p>}
          {reservations !== null && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              <StatTile label="Llegadas" value={String(llegadasHoy)} />
              <StatTile label="Salidas" value={String(salidasHoy)} />
              <StatTile label="En estancia" value={String(enEstancia)} />
            </div>
          )}
          <Link to={`/hoteles/${orgSlug}/reservas`} style={linkButtonStyle()}>
            Ir a Reservas →
          </Link>
        </Card>

        {showTickets && (
          <Card>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Mantenimiento</p>
            {ticketsError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {ticketsError}
              </p>
            )}
            {tickets === null && !ticketsError && <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Cargando…</p>}
            {tickets !== null && <StatTile label="Tickets abiertos" value={String(tickets.length)} />}
            <Link to={`/hoteles/${orgSlug}/mantenimiento`} style={linkButtonStyle()}>
              Ir a Mantenimiento →
            </Link>
          </Card>
        )}

        {showPedidos && (
          <Card>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Pedidos F&amp;B</p>
            {pedidosError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {pedidosError}
              </p>
            )}
            {pedidos === null && !pedidosError && <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Cargando…</p>}
            {pedidos !== null && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                <StatTile label="Pedidos activos" value={String(pedidos.length)} />
                <StatTile label="Alergia sin confirmar" value={String(alergiasSinConfirmar)} />
              </div>
            )}
            <Link to={`/hoteles/${orgSlug}/pedidos-fnb`} style={linkButtonStyle()}>
              Ir a Pedidos F&amp;B →
            </Link>
          </Card>
        )}
      </div>
    </div>
  );
}

export function DashboardPage(ctx: HotelesShellContext) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Panel de {ctx.orgSlug}</h1>
      {EXECUTIVE_ROLES.has(ctx.role) ? <ExecutiveSummary {...ctx} /> : <OperationalSummary {...ctx} />}
    </div>
  );
}
