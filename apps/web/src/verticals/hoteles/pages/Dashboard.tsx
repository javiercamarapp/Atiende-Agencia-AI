// Resumen de hoteles (landing del panel, ruta /hoteles/:orgSlug): la composicion del Resumen de Likida con las piezas de
// @atiende/ui (ResumenLayout, StatCard de dos capas, Odometro, PillLink, ResumenSeccion/TileLink, AgentRunCard), igual que
// el Resumen de restaurantes. Vive DENTRO de HotelesShell: sesion y propiedad las resuelve el Shell.
//
// TODA cifra sale de un endpoint que ya existe, y cada uno se pide POR SEPARADO: el que falla pinta su propio error en su
// tarjeta ("—" + motivo) sin tumbar el resto de la pagina. Fuentes:
//   - ocupacion, ADR y RevPAR (destacado) ............ GET .../pl                       (owner/gm/accountant)
//   - llegadas / salidas / en casa ................... GET .../recepcion                (owner/gm/frontdesk/reservations)
//       (los demas roles no la ven: no se sustituye por GET .../reservas, que solo devuelve una pagina de 50 y daria cifras parciales)
//   - tickets con SLA vencido ........................ GET .../tickets?activos=1        (los 8 roles)
//   - aprobaciones pendientes ........................ GET .../aprobaciones?abiertas=1  (AGENT_VIEW_ROLES)
//   - holds del agente de reservas ................... GET .../reservas-agente/holds?abiertas=1 (HOLD_VIEW_ROLES)
//   - tarjetas de agentes ............................ GET .../agentes                  (AGENT_VIEW_ROLES)
//   - ultima corrida ................................. GET .../night-audit              (owner/gm/accountant)
//   - fijados del Copiloto ........................... GET .../chat-datos/pins            (owner/gm; los re-ejecuta el servidor)
//   - atajos de piso ................................. GET .../mantenimiento/tickets y .../pedidos-fnb (solo su rol)
// Cada rol solo pide lo que el servidor le deja leer (ver `capacidadesResumen`): ninguna llamada de este Resumen da 403 por
// rol. No existe una bitacora de corridas de agentes: "Ultima corrida" muestra el ultimo night audit si lo hay y, si no, un
// vacio honesto (nada inventado). Un solo `h1` (el saludo, dentro de `ResumenLayout`).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AgentRunCard,
  Card,
  EstadoVacio,
  Odometro,
  PageContainer,
  PillLink,
  RadioSegmentado,
  ResumenLayout,
  ResumenSeccion,
  SectionLabel,
  StatCard,
  StatusBadge,
  TileLink,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { BedDouble, Bot, CalendarCheck, CalendarClock, CircleDollarSign, ClipboardList, Gauge, LifeBuoy, ShieldAlert, Star, UtensilsCrossed, Wrench } from "lucide-react";
import { fetchAgentes, fetchAprobaciones } from "../lib/agentes-client.ts";
import type { AgenteCatalogo, AgenteClave, AgenteEstado, CatalogoAgentes, AprobacionesResultado } from "../lib/agentes-client.ts";
import { fetchTickets as fetchTicketsMantenimiento } from "../lib/housekeeping-client.ts";
import { fetchNightAuditRuns, ultimaCorrida } from "../lib/night-audit-client.ts";
import type { NightAuditCorrida } from "../lib/night-audit-client.ts";
import { fetchPedidosFnb } from "../lib/pedidos-fnb-client.ts";
import { fetchPlSummary } from "../lib/pl-client.ts";
import type { PlSummaryResponse } from "../lib/pl-client.ts";
import { fetchRecepcion } from "../lib/recepcion-client.ts";
import type { Recepcion } from "../lib/recepcion-client.ts";
import { fetchHoldsAbiertos } from "../lib/reservas-agente-client.ts";
import type { HoldsResultado } from "../lib/reservas-agente-client.ts";
import { capacidadesResumen, cuandoNegocio, plural } from "../lib/resumen.ts";
import { fetchTickets as fetchTicketsHuesped } from "../lib/tickets-client.ts";
import type { TicketListado } from "../lib/tickets-client.ts";
import { dineroMxConSigno } from "../lib/dinero.ts";
import { formatFechaSolo, hoyFechaSolo, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import { primerNombreOCorreo, saludoPorHora } from "../../../lib/greeting.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";
import { COPILOTO_HOTELES_ROLES, HotelesFijadosCopiloto } from "./Copiloto.tsx";

type PeriodDays = "7" | "30" | "90";
const PERIOD_OPTIONS: ReadonlyArray<{ id: PeriodDays; rotulo: string }> = [
  { id: "7", rotulo: "7 días" },
  { id: "30", rotulo: "30 días" },
  { id: "90", rotulo: "90 días" },
];

/** El servidor exige `desde <= hasta` (YYYY-MM-DD) pero no calcula ningun "hoy": el dia de calendario del negocio sale de
 * `hoyFechaSolo` (America/Mexico_City), nunca del dia UTC (hallazgo de auditoria a4: entre las 18:00 y las 23:59 de CDMX el
 * dia UTC ya es manana y la ocupacion/RevPAR salian deflactados). Mismo helper que `Pl.tsx::rangeForDays`. */
function rangeForDays(days: PeriodDays): { desde: string; hasta: string } {
  const hasta = hoyFechaSolo();
  const desde = sumarDiasFechaSolo(hasta, -(Number(days) - 1));
  return { desde, hasta };
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ---- carga independiente por bloque ---------------------------------------------------------------------------------

type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "ok"; readonly data: T } | { readonly estado: "error"; readonly mensaje: string };

const CARGANDO: Carga<never> = { estado: "cargando" };

/** Carga un bloque del Resumen. `activo=false` = el rol no puede leerlo: no se llama (cero 403) y queda en "cargando", que
 * el que arma la pagina nunca pinta porque tampoco pinta ese bloque. */
function useCarga<T>(activo: boolean, cargar: () => Promise<T>, dependencias: readonly unknown[], mensajeVacio: string): Carga<T> {
  const [carga, setCarga] = useState<Carga<T>>(CARGANDO);
  useEffect(() => {
    if (!activo) return;
    let cancelado = false;
    setCarga(CARGANDO);
    cargar()
      .then((data) => {
        if (!cancelado) setCarga({ estado: "ok", data });
      })
      .catch((err) => {
        if (!cancelado) setCarga({ estado: "error", mensaje: err instanceof Error && err.message ? err.message : mensajeVacio });
      });
    return () => {
      cancelado = true;
    };
    // `cargar` se recrea en cada render: la identidad de la carga la fijan `dependencias`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, ...dependencias]);
  return carga;
}

interface Medida {
  readonly value: string;
  readonly nota?: string;
}

/** Una `StatCard` a partir de una carga: dato real, "Cargando…" o su propio error ("—" + motivo). Nunca un cero inventado. */
function tarjeta<T>(carga: Carga<T>, clave: string, icon: typeof BedDouble, label: string, medir: (data: T) => Medida | { readonly sinDato: string }) {
  if (carga.estado === "cargando") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato="Cargando…" />;
  if (carga.estado === "error") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={`No se pudo cargar: ${carga.mensaje}`} />;
  const m = medir(carga.data);
  if ("sinDato" in m) return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={m.sinDato} />;
  return <StatCard key={clave} variante="neutra" icon={icon} label={label} value={m.value} nota={m.nota} />;
}

const AGENTE_ESTADO_TONES: Readonly<Record<AgenteEstado, StatusTone>> = { activo: "success", pausado: "warning", presupuesto_agotado: "danger" };
const AGENTE_ESTADO_ETIQUETAS: Readonly<Record<AgenteEstado, string>> = { activo: "Activo", pausado: "Pausado", presupuesto_agotado: "Sin presupuesto" };

export function DashboardPage(ctx: HotelesShellContext) {
  const { apiBaseUrl, token, propertyId, orgSlug, role } = ctx;
  const cap = capacidadesResumen(role);
  const base = `/hoteles/${orgSlug}`;
  const [periodo, setPeriodo] = useState<PeriodDays>("30");

  // Mismo cuerpo de dependencias para todos: cambia la propiedad, la sesion o el rol -> se vuelve a pedir.
  const dep = [apiBaseUrl, token, propertyId] as const;
  const pl = useCarga<PlSummaryResponse>(
    cap.pl,
    () => {
      const { desde, hasta } = rangeForDays(periodo);
      return fetchPlSummary(fetch, apiBaseUrl, token, propertyId, desde, hasta);
    },
    [...dep, periodo],
    "No se pudo cargar el resumen financiero.",
  );
  const recepcion = useCarga<Recepcion>(cap.recepcion, () => fetchRecepcion(fetch, apiBaseUrl, token, propertyId), dep, "No se pudo cargar la recepción.");
  const ticketsSla = useCarga<TicketListado>(true, () => fetchTicketsHuesped(fetch, apiBaseUrl, token, propertyId, { activos: true }), dep, "No se pudieron cargar los tickets.");
  const aprobaciones = useCarga<AprobacionesResultado>(cap.agentes, () => fetchAprobaciones(fetch, apiBaseUrl, token, propertyId, { abiertas: true }), dep, "No se pudieron cargar las aprobaciones.");
  const holds = useCarga<HoldsResultado>(cap.agentes, () => fetchHoldsAbiertos(fetch, apiBaseUrl, token, propertyId), dep, "No se pudieron cargar los holds del agente.");
  const agentes = useCarga<CatalogoAgentes>(cap.agentes, () => fetchAgentes(fetch, apiBaseUrl, token, propertyId), dep, "No se pudo cargar el catálogo de agentes.");
  const corridas = useCarga<readonly NightAuditCorrida[]>(cap.nightAudit, () => fetchNightAuditRuns(fetch, apiBaseUrl, token, propertyId), dep, "No se pudo cargar el night audit.");
  const mantenimiento = useCarga(cap.mantenimiento, () => fetchTicketsMantenimiento(fetch, apiBaseUrl, token, propertyId, "abierto"), dep, "No se pudieron cargar los tickets de mantenimiento.");
  const pedidos = useCarga(cap.pedidosFnb, () => fetchPedidosFnb(fetch, apiBaseUrl, token, propertyId), dep, "No se pudieron cargar los pedidos de F&B.");

  const kpis: ReactNode[] = [];

  if (cap.pl) {
    kpis.push(
      tarjeta(pl, "ocupacion", BedDouble, "Ocupación", (d) => ({ value: formatPct(d.kpis.occupancyPct), nota: `${d.kpis.occupiedRoomNights}/${d.kpis.availableRoomNights} noches-habitación` })),
      tarjeta(pl, "adr", CircleDollarSign, "ADR", (d) => ({ value: dineroMxConSigno(d.kpis.adr, 0), nota: "tarifa promedio diaria" })),
    );
  }
  if (cap.recepcion) {
    kpis.push(
      tarjeta(recepcion, "llegadas", CalendarCheck, "Llegadas", (d) => ({ value: String(d.resumen.llegadas), nota: `${d.resumen.llegadasPendientes} por llegar` })),
      tarjeta(recepcion, "salidas", CalendarClock, "Salidas", (d) => ({ value: String(d.resumen.salidas), nota: `${d.resumen.salidasPendientes} por salir` })),
      tarjeta(recepcion, "en-casa", BedDouble, "En casa", (d) => ({ value: String(d.resumen.enCasa), nota: "huéspedes en estancia" })),
    );
  }
  kpis.push(
    tarjeta(ticketsSla, "tickets-sla", LifeBuoy, "Tickets con SLA vencido", (d) => {
      if (!d.disponible) return { sinDato: "Aún no disponible: esta base todavía no tiene los tickets de huésped." };
      const vencidos = d.tickets.filter((t) => t.estadoSla === "vencido").length;
      return { value: String(vencidos), nota: plural(d.tickets.length, "ticket activo", "tickets activos") };
    }),
  );
  if (cap.agentes) {
    kpis.push(
      tarjeta(aprobaciones, "aprobaciones", ClipboardList, "Aprobaciones pendientes", (d) => {
        if (!d.disponible) return { sinDato: "Aún no disponible: esta base todavía no tiene la cola de aprobaciones." };
        return { value: String(d.aprobaciones.filter((a) => a.estado === "pendiente").length), nota: "esperan a una persona" };
      }),
      tarjeta(holds, "holds", Bot, "Holds del agente", (d) => {
        if (!d.disponible) return { sinDato: "Aún no disponible: esta base todavía no tiene los holds del agente de reservas." };
        return { value: String(d.holds.length), nota: "reservas en curso por WhatsApp o voz" };
      }),
    );
  }
  if (cap.mantenimiento) {
    kpis.push(tarjeta(mantenimiento, "mantenimiento", Wrench, "Tickets de mantenimiento abiertos", (ts) => ({ value: String(ts.length), nota: "pendientes de cerrar" })));
  }
  if (cap.pedidosFnb) {
    kpis.push(
      tarjeta(pedidos, "pedidos", UtensilsCrossed, "Pedidos activos", (ps) => ({ value: String(ps.length), nota: "cocina y servicio a cuarto" })),
      tarjeta(pedidos, "alergias", ShieldAlert, "Alergia sin confirmar", (ps) => ({ value: String(ps.filter((p) => p.alergiaDeclarada && !p.cocineroConfirmoEn).length), nota: "esperan confirmación de cocina" })),
    );
  }

  const etiquetaPeriodo = PERIOD_OPTIONS.find((o) => o.id === periodo)?.rotulo ?? periodo;
  const revpar = pl.estado === "ok" ? Math.round(pl.data.kpis.revpar) : null;
  const destacado = cap.pl ? (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro
        valor={revpar}
        digitos={4}
        prefijo="$"
        etiqueta={`RevPAR · ${etiquetaPeriodo}`}
        sinDato={pl.estado === "error" ? `No se pudo cargar: ${pl.mensaje}` : pl.estado === "cargando" ? "Cargando…" : undefined}
        tamano="md"
      />
      {/* El odometro solo se pinta desde `sm`: en movil el mismo dato va en texto. */}
      <p className="text-ui text-muted-foreground sm:hidden">
        RevPAR{" "}
        <span className="font-medium tabular-nums text-foreground">{pl.estado === "ok" ? dineroMxConSigno(pl.data.kpis.revpar, 0) : "—"}</span>
      </p>
      <RadioSegmentado
        name="resumen-periodo"
        label="Periodo"
        opciones={PERIOD_OPTIONS.map((o) => ({ id: o.id, rotulo: o.rotulo }))}
        value={periodo}
        onChange={setPeriodo}
        className="justify-end gap-1.5"
      />
    </div>
  ) : undefined;

  const nombreProperty = ctx.propertyName ?? orgSlug;
  const acciones = (
    <>
      {cap.recepcion && <PillLink to={`${base}/recepcion`}>Ver recepción</PillLink>}
      {cap.revenue && <PillLink to={`${base}/revenue`}>Ver revenue</PillLink>}
      {!cap.recepcion && <PillLink to={`${base}/reservas`}>Ver reservas</PillLink>}
      {cap.mantenimiento && <PillLink to={`${base}/mantenimiento`}>Ver mantenimiento</PillLink>}
      {cap.pedidosFnb && <PillLink to={`${base}/pedidos-fnb`}>Ver pedidos F&amp;B</PillLink>}
      {COPILOTO_HOTELES_ROLES.has(role) && <PillLink to={`${base}/copiloto`}>Pregunta a tus datos</PillLink>}
    </>
  );

  const ultima = corridas.estado === "ok" ? ultimaCorrida(corridas.data) : null;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoPorHora()}
        nombre={primerNombreOCorreo(ctx.staffFullName, ctx.staffEmail)}
        subtitulo={cap.pl ? `${nombreProperty} · ${etiquetaPeriodo}` : nombreProperty}
        destacado={destacado}
        kpis={kpis}
        acciones={acciones}
      >
        {cap.agentes && (
          <ResumenSeccion titulo="Orquestación de agentes">
            {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">Cargando agentes…</p>}
            {agentes.estado === "error" && (
              <p role="alert" className="text-xs text-destructive sm:col-span-2 lg:col-span-3">
                No se pudo cargar: {agentes.mensaje}
              </p>
            )}
            {agentes.estado === "ok" && !agentes.data.disponible && (
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">Aún no disponible: esta base todavía no tiene el catálogo de agentes.</p>
            )}
            {agentes.estado === "ok" &&
              agentes.data.disponible &&
              agentes.data.agentes.map((a) => (
                <TileLink
                  key={a.clave}
                  to={destinoAgente(base, a.clave, cap)}
                  icon={iconoAgente(a.clave)}
                  titulo={a.nombre}
                  badge={<StatusBadge tone={AGENTE_ESTADO_TONES[a.estado] ?? "neutral"}>{AGENTE_ESTADO_ETIQUETAS[a.estado] ?? a.estado}</StatusBadge>}
                  descripcion={descripcionAgente(a, agentes.data.mes)}
                />
              ))}
          </ResumenSeccion>
        )}

        {cap.nightAudit && (
          <Card className="p-3" role="region" aria-labelledby="resumen-ultima-corrida">
            <SectionLabel id="resumen-ultima-corrida">Última corrida</SectionLabel>
            <div className="mt-2">
              {corridas.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando la última corrida…</p>}
              {corridas.estado === "error" && (
                <p role="alert" className="text-xs text-destructive">
                  No se pudo cargar: {corridas.mensaje}
                </p>
              )}
              {corridas.estado === "ok" && ultima === null && (
                <EstadoVacio
                  compacto
                  titulo="Sin bitácora de corridas"
                  mensaje="El night audit aún no ha corrido en esta propiedad. Aún no existe una bitácora de corridas de los agentes; aparecerá aquí en cuanto haya una."
                />
              )}
              {ultima !== null && (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  <AgentRunCard
                    nombre="Night audit"
                    estado={ultima.estado === "completado" ? { tone: "success", etiqueta: "OK" } : { tone: "warning", etiqueta: "En curso" }}
                    meta={metaCorrida(ultima)}
                  />
                </div>
              )}
            </div>
          </Card>
        )}

        {/* CHAT-15: tablero de fijados del Copiloto (owner/gm; para los demas roles no se pinta ni se pide). */}
        <HotelesFijadosCopiloto {...ctx} />
      </ResumenLayout>
    </PageContainer>
  );
}

function metaCorrida(c: NightAuditCorrida): string {
  const cierre = cuandoNegocio(c.completadoEn);
  return `Fecha de negocio ${formatFechaSolo(c.fecha)}${cierre ? ` · completado ${cierre}` : " · sin cerrar todavía"}`;
}

function iconoAgente(clave: AgenteClave) {
  switch (clave) {
    case "revenue":
      return Gauge;
    case "reputacion":
      return Star;
    case "mantenimiento":
      return Wrench;
    default:
      return Bot;
  }
}

/** Cada tarjeta lleva a la pantalla donde se atiende ese agente, solo si el rol la ve en el menu; si no, al catalogo de agentes. */
function destinoAgente(base: string, clave: AgenteClave, cap: ReturnType<typeof capacidadesResumen>): string {
  if (clave === "revenue" && cap.revenue) return `${base}/revenue`;
  if (clave === "reputacion" && cap.reputacion) return `${base}/reputacion`;
  return `${base}/agentes`;
}

function descripcionAgente(a: AgenteCatalogo, mes: string): string {
  const uso = `${plural(a.llamadas, "llamada", "llamadas")} en ${mes}`;
  if (a.presupuestoUsd !== null && a.porcentajeUso !== null) return `${uso} · ${Math.round(a.porcentajeUso)}% del presupuesto`;
  return uso;
}
