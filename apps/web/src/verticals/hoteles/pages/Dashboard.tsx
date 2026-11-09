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
  traductorActivo,
  useT,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { hotelesResumen } from "@atiende/ui/i18n/hoteles/resumen";
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
import { capacidadesResumen, cuandoNegocio } from "../lib/resumen.ts";
import { fetchTickets as fetchTicketsHuesped } from "../lib/tickets-client.ts";
import type { TicketListado } from "../lib/tickets-client.ts";
import { dineroMxConSigno } from "../lib/dinero.ts";
import { formatFechaSolo, hoyFechaSolo, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import { primerNombreOCorreo, saludoPorHora } from "../../../lib/greeting.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";
import { COPILOTO_HOTELES_ROLES, HotelesFijadosCopiloto } from "./Copiloto.tsx";

type PeriodDays = "7" | "30" | "90";
const PERIOD_IDS: readonly PeriodDays[] = ["7", "30", "90"];

// Funciones de texto fuera del componente: traducen al idioma activo (la pagina consume el contexto con `useT`, asi que se repinta al cambiarlo).
const tr = traductorActivo(hotelesResumen);

/** "Buenos días" / "Buenas tardes" / "Buenas noches" (misma regla de hora que `saludoPorHora`) en el idioma activo. */
function saludoTraducido(): string {
  const s = saludoPorHora(); // i18n-ignorar (se compara con el literal de greeting.ts, no se pinta)
  return tr(s === "Buenos días" ? "hoteles.resumen.saludo.manana" : s === "Buenas tardes" ? "hoteles.resumen.saludo.tarde" : "hoteles.resumen.saludo.noche"); // i18n-ignorar
}

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
  }, [activo, ...dependencias]);
  return carga;
}

interface Medida {
  readonly value: string;
  readonly nota?: string;
}

/** Una `StatCard` a partir de una carga: dato real, "Cargando…" o su propio error ("—" + motivo). Nunca un cero inventado. */
function tarjeta<T>(carga: Carga<T>, clave: string, icon: typeof BedDouble, label: string, medir: (data: T) => Medida | { readonly sinDato: string }) {
  if (carga.estado === "cargando") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={tr("hoteles.resumen.cargando")} />;
  if (carga.estado === "error") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={tr("hoteles.resumen.noSeCargo", { mensaje: carga.mensaje })} />;
  const m = medir(carga.data);
  if ("sinDato" in m) return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={m.sinDato} />;
  return <StatCard key={clave} variante="neutra" icon={icon} label={label} value={m.value} nota={m.nota} />;
}

const AGENTE_ESTADO_TONES: Readonly<Record<AgenteEstado, StatusTone>> = { activo: "success", pausado: "warning", presupuesto_agotado: "danger" };
const AGENTE_ESTADO_CLAVES = { activo: "hoteles.resumen.agente.activo", pausado: "hoteles.resumen.agente.pausado", presupuesto_agotado: "hoteles.resumen.agente.presupuesto_agotado" } as const satisfies Readonly<Record<AgenteEstado, string>>;

export function DashboardPage(ctx: HotelesShellContext) {
  const { apiBaseUrl, token, propertyId, orgSlug, role } = ctx;
  const t = useT(hotelesResumen);
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
    t("hoteles.resumen.error.pl"),
  );
  const recepcion = useCarga<Recepcion>(cap.recepcion, () => fetchRecepcion(fetch, apiBaseUrl, token, propertyId), dep, t("hoteles.resumen.error.recepcion"));
  const ticketsSla = useCarga<TicketListado>(true, () => fetchTicketsHuesped(fetch, apiBaseUrl, token, propertyId, { activos: true }), dep, t("hoteles.resumen.error.tickets"));
  const aprobaciones = useCarga<AprobacionesResultado>(cap.agentes, () => fetchAprobaciones(fetch, apiBaseUrl, token, propertyId, { abiertas: true }), dep, t("hoteles.resumen.error.aprobaciones"));
  const holds = useCarga<HoldsResultado>(cap.agentes, () => fetchHoldsAbiertos(fetch, apiBaseUrl, token, propertyId), dep, t("hoteles.resumen.error.holds"));
  const agentes = useCarga<CatalogoAgentes>(cap.agentes, () => fetchAgentes(fetch, apiBaseUrl, token, propertyId), dep, t("hoteles.resumen.error.agentes"));
  const corridas = useCarga<readonly NightAuditCorrida[]>(cap.nightAudit, () => fetchNightAuditRuns(fetch, apiBaseUrl, token, propertyId), dep, t("hoteles.resumen.error.nightAudit"));
  const mantenimiento = useCarga(cap.mantenimiento, () => fetchTicketsMantenimiento(fetch, apiBaseUrl, token, propertyId, "abierto"), dep, t("hoteles.resumen.error.mantenimiento"));
  const pedidos = useCarga(cap.pedidosFnb, () => fetchPedidosFnb(fetch, apiBaseUrl, token, propertyId), dep, t("hoteles.resumen.error.pedidos"));

  const kpis: ReactNode[] = [];

  if (cap.pl) {
    kpis.push(
      tarjeta(pl, "ocupacion", BedDouble, t("hoteles.resumen.kpi.ocupacion"), (d) => ({ value: formatPct(d.kpis.occupancyPct), nota: t("hoteles.resumen.kpi.ocupacionNota", { ocupadas: d.kpis.occupiedRoomNights, disponibles: d.kpis.availableRoomNights }) })),
      tarjeta(pl, "adr", CircleDollarSign, t("hoteles.resumen.kpi.adr"), (d) => ({ value: dineroMxConSigno(d.kpis.adr, 0), nota: t("hoteles.resumen.kpi.adrNota") })),
    );
  }
  if (cap.recepcion) {
    kpis.push(
      tarjeta(recepcion, "llegadas", CalendarCheck, t("hoteles.resumen.kpi.llegadas"), (d) => ({ value: String(d.resumen.llegadas), nota: t("hoteles.resumen.kpi.llegadasNota", { n: d.resumen.llegadasPendientes }) })),
      tarjeta(recepcion, "salidas", CalendarClock, t("hoteles.resumen.kpi.salidas"), (d) => ({ value: String(d.resumen.salidas), nota: t("hoteles.resumen.kpi.salidasNota", { n: d.resumen.salidasPendientes }) })),
      tarjeta(recepcion, "en-casa", BedDouble, t("hoteles.resumen.kpi.enCasa"), (d) => ({ value: String(d.resumen.enCasa), nota: t("hoteles.resumen.kpi.enCasaNota") })),
    );
  }
  kpis.push(
    tarjeta(ticketsSla, "tickets-sla", LifeBuoy, t("hoteles.resumen.kpi.ticketsSla"), (d) => {
      if (!d.disponible) return { sinDato: t("hoteles.resumen.kpi.ticketsSlaSinTabla") };
      const vencidos = d.tickets.filter((t) => t.estadoSla === "vencido").length;
      return { value: String(vencidos), nota: t("hoteles.resumen.kpi.ticketsActivos", { count: d.tickets.length }) };
    }),
  );
  if (cap.agentes) {
    kpis.push(
      tarjeta(aprobaciones, "aprobaciones", ClipboardList, t("hoteles.resumen.kpi.aprobaciones"), (d) => {
        if (!d.disponible) return { sinDato: t("hoteles.resumen.kpi.aprobacionesSinTabla") };
        return { value: String(d.aprobaciones.filter((a) => a.estado === "pendiente").length), nota: t("hoteles.resumen.kpi.aprobacionesNota") };
      }),
      tarjeta(holds, "holds", Bot, t("hoteles.resumen.kpi.holds"), (d) => {
        if (!d.disponible) return { sinDato: t("hoteles.resumen.kpi.holdsSinTabla") };
        return { value: String(d.holds.length), nota: t("hoteles.resumen.kpi.holdsNota") };
      }),
    );
  }
  if (cap.mantenimiento) {
    kpis.push(tarjeta(mantenimiento, "mantenimiento", Wrench, t("hoteles.resumen.kpi.mantenimiento"), (ts) => ({ value: String(ts.length), nota: t("hoteles.resumen.kpi.mantenimientoNota") })));
  }
  if (cap.pedidosFnb) {
    kpis.push(
      tarjeta(pedidos, "pedidos", UtensilsCrossed, t("hoteles.resumen.kpi.pedidos"), (ps) => ({ value: String(ps.length), nota: t("hoteles.resumen.kpi.pedidosNota") })),
      tarjeta(pedidos, "alergias", ShieldAlert, t("hoteles.resumen.kpi.alergias"), (ps) => ({ value: String(ps.filter((p) => p.alergiaDeclarada && !p.cocineroConfirmoEn).length), nota: t("hoteles.resumen.kpi.alergiasNota") })),
    );
  }

  const rotuloPeriodo = (id: PeriodDays) => t(`hoteles.resumen.periodo.${id}`);
  const etiquetaPeriodo = rotuloPeriodo(periodo);
  const revpar = pl.estado === "ok" ? Math.round(pl.data.kpis.revpar) : null;
  const destacado = cap.pl ? (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro
        valor={revpar}
        digitos={4}
        prefijo="$"
        etiqueta={t("hoteles.resumen.revparEtiqueta", { periodo: etiquetaPeriodo })}
        sinDato={pl.estado === "error" ? t("hoteles.resumen.noSeCargo", { mensaje: pl.mensaje }) : pl.estado === "cargando" ? t("hoteles.resumen.cargando") : undefined}
        tamano="md"
      />
      {/* El odometro solo se pinta desde `sm`: en movil el mismo dato va en texto. */}
      <p className="ds3-resumen-movil text-ui text-muted-foreground sm:hidden">
        {t("hoteles.resumen.revpar")}{" "}
        <span className="font-medium tabular-nums text-foreground">{pl.estado === "ok" ? dineroMxConSigno(pl.data.kpis.revpar, 0) : "—"}</span>
      </p>
      <RadioSegmentado
        name="resumen-periodo"
        label={t("hoteles.resumen.periodo")}
        opciones={PERIOD_IDS.map((id) => ({ id, rotulo: rotuloPeriodo(id) }))}
        value={periodo}
        onChange={setPeriodo}
        className="justify-end gap-1.5"
      />
    </div>
  ) : undefined;

  const nombreProperty = ctx.propertyName ?? orgSlug;
  const acciones = (
    <>
      {cap.recepcion && <PillLink to={`${base}/recepcion`}>{t("hoteles.resumen.verRecepcion")}</PillLink>}
      {cap.revenue && <PillLink to={`${base}/revenue`}>{t("hoteles.resumen.verRevenue")}</PillLink>}
      {!cap.recepcion && <PillLink to={`${base}/reservas`}>{t("hoteles.resumen.verReservas")}</PillLink>}
      {cap.mantenimiento && <PillLink to={`${base}/mantenimiento`}>{t("hoteles.resumen.verMantenimiento")}</PillLink>}
      {cap.pedidosFnb && <PillLink to={`${base}/pedidos-fnb`}>{t("hoteles.resumen.verPedidos")}</PillLink>}
      {COPILOTO_HOTELES_ROLES.has(role) && <PillLink to={`${base}/copiloto`}>{t("hoteles.resumen.preguntale")}</PillLink>}
    </>
  );

  const ultima = corridas.estado === "ok" ? ultimaCorrida(corridas.data) : null;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoTraducido()}
        nombre={primerNombreOCorreo(ctx.staffFullName, ctx.staffEmail)}
        subtitulo={cap.pl ? `${nombreProperty} · ${etiquetaPeriodo}` : nombreProperty}
        frase={
          cap.pl && pl.estado === "ok" ? (
            <>
              {t("hoteles.resumen.frase", { propiedad: nombreProperty, periodo: etiquetaPeriodo })}<strong>{dineroMxConSigno(pl.data.kpis.revpar, 0)}</strong>.
            </>
          ) : undefined
        }
        destacado={destacado}
        kpis={kpis}
        acciones={acciones}
      >
        {cap.agentes && (
          <ResumenSeccion titulo={t("hoteles.resumen.orquestacion")}>
            {agentes.estado === "cargando" && <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{t("hoteles.resumen.cargandoAgentes")}</p>}
            {agentes.estado === "error" && (
              <p role="alert" className="text-xs text-destructive sm:col-span-2 lg:col-span-3">
                {t("hoteles.resumen.noSeCargo", { mensaje: agentes.mensaje })}
              </p>
            )}
            {agentes.estado === "ok" && !agentes.data.disponible && (
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{t("hoteles.resumen.agentesSinTabla")}</p>
            )}
            {agentes.estado === "ok" &&
              agentes.data.disponible &&
              agentes.data.agentes.map((a) => (
                <TileLink
                  key={a.clave}
                  to={destinoAgente(base, a.clave, cap)}
                  icon={iconoAgente(a.clave)}
                  titulo={a.nombre}
                  badge={<StatusBadge tone={AGENTE_ESTADO_TONES[a.estado] ?? "neutral"}>{AGENTE_ESTADO_CLAVES[a.estado] ? t(AGENTE_ESTADO_CLAVES[a.estado]) : a.estado}</StatusBadge>}
                  descripcion={descripcionAgente(a, agentes.data.mes)}
                />
              ))}
          </ResumenSeccion>
        )}

        {cap.nightAudit && (
          <Card className="p-3" role="region" aria-labelledby="resumen-ultima-corrida">
            <SectionLabel id="resumen-ultima-corrida">{t("hoteles.resumen.ultimaCorrida")}</SectionLabel>
            <div className="mt-2">
              {corridas.estado === "cargando" && <p className="text-xs text-muted-foreground">{t("hoteles.resumen.cargandoCorrida")}</p>}
              {corridas.estado === "error" && (
                <p role="alert" className="text-xs text-destructive">
                  {t("hoteles.resumen.noSeCargo", { mensaje: corridas.mensaje })}
                </p>
              )}
              {corridas.estado === "ok" && ultima === null && (
                <EstadoVacio
                  compacto
                  titulo={t("hoteles.resumen.sinBitacora")}
                  mensaje={t("hoteles.resumen.sinBitacoraMensaje")}
                />
              )}
              {ultima !== null && (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  <AgentRunCard
                    nombre={t("hoteles.resumen.nightAudit")}
                    estado={ultima.estado === "completado" ? { tone: "success", etiqueta: t("hoteles.resumen.corrida.ok") } : { tone: "warning", etiqueta: t("hoteles.resumen.corrida.enCurso") }}
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
  return tr("hoteles.resumen.corrida.meta", { fecha: formatFechaSolo(c.fecha) }) + (cierre ? tr("hoteles.resumen.corrida.completado", { cuando: cierre }) : tr("hoteles.resumen.corrida.sinCerrar"));
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
  const uso = tr("hoteles.resumen.agente.llamadas", { count: a.llamadas, mes });
  if (a.presupuestoUsd !== null && a.porcentajeUso !== null) return tr("hoteles.resumen.agente.presupuesto", { uso, pct: Math.round(a.porcentajeUso) });
  return uso;
}
