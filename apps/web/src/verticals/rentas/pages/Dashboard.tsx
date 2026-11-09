// Rn-26 -- Resumen operativo de rentas (landing del panel). Composición del Resumen de Likida con las piezas UNI-5 de
// @atiende/ui: saludo, KPI de dos capas que enlazan a su pantalla, pildoras de acción y "Orquestación de agentes". TODA cifra
// viene de GET /rentas/:propertyId/resumen (agregados reales, sin PII); un bloque que el servidor marca "no_disponible" (base
// sin migrar) se muestra como tal ("—" con su razón) y el resto carga; uno "sin_permiso" (rol) no se pinta. El rol `limpieza`
// no tiene Resumen: se le lleva a "Mis tareas", su panel real. El selector de propiedad vive en el Shell.
import { useEffect, useState } from "react";
import { RentasFijadosCopiloto } from "./Copiloto.tsx";
import { Navigate, Link } from "react-router-dom";
import { AlertTriangle, BedDouble, ClipboardList, Inbox, LogIn, LogOut, RefreshCcw } from "lucide-react";
import { AgentRunCard, EstadoCargando, EstadoError, PageContainer, PillLink, ResumenLayout, ResumenSeccion, StatCard, localeActivo, traductorActivo, useT } from "@atiende/ui";
import type { AgentRunEstado } from "@atiende/ui";
import { rentasResumen } from "@atiende/ui/i18n/rentas/resumen";
import { saludoPorHora, primerNombreOCorreo } from "../../../lib/greeting.ts";
import { fetchResumen } from "../lib/resumen-client.ts";
import type { AgenteResumen, Bloque, ResumenOperativo } from "../lib/resumen-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

/** Roles con acceso a Reportes (mismo techo que el reporte de Rn-03: finanzas). */
const ROLES_REPORTES: ReadonlySet<string> = new Set(["admin_gestora", "contador"]);
// Funciones de texto fuera del componente: traducen al idioma activo (la pagina consume el contexto con `useT`, asi que se repinta al cambiarlo).
const tr = traductorActivo(rentasResumen);

const TONO_AGENTE: Record<AgenteResumen["estado"], AgentRunEstado["tone"]> = { ok: "success", atencion: "warning", error: "danger" };

function estadoAgente(estado: AgenteResumen["estado"]): AgentRunEstado {
  return { tone: TONO_AGENTE[estado], etiqueta: tr(`rentas.resumen.agente.${estado}`) };
}

/** Saludo por hora (greeting.ts) en el idioma activo. */
function saludoTraducido(): string {
  const s = saludoPorHora(); // i18n-ignorar (se compara con el literal de greeting.ts, no se pinta)
  return tr(s === "Buenos días" ? "rentas.resumen.saludo.manana" : s === "Buenas tardes" ? "rentas.resumen.saludo.tarde" : "rentas.resumen.saludo.noche");
}

const PANTALLA_AGENTE: Record<AgenteResumen["clave"], string> = {
  sync_ical: "ical-sync",
  borradores_ia: "aprobaciones",
  liberacion_acceso: "acceso-huesped",
  checkout_sweep: "mis-tareas",
};

/** "2 oct, 14:05" en la zona de la property; si la zona no es válida, cae a la del navegador. */
function cuando(iso: string, zona: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return tr("rentas.resumen.fechaDesconocida");
  const opciones: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(localeActivo(), { ...opciones, timeZone: zona }).format(d);
  } catch {
    return new Intl.DateTimeFormat(localeActivo(), opciones).format(d);
  }
}

/** "jueves 2 de octubre" a partir de la fecha de calendario `YYYY-MM-DD` de la property (sin pasar por la zona del navegador). */
function fechaLarga(hoy: string): string {
  const d = new Date(`${hoy}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return hoy;
  return new Intl.DateTimeFormat(localeActivo(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d);
}

function ligado(to: string, tarjeta: React.ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

function kpis(r: ResumenOperativo, base: string, puedeReportes: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const agrega = <T,>(b: Bloque<T>, clave: string, to: string, render: (v: Extract<Bloque<T>, { estado: "ok" }>) => React.ReactNode, vacio: (etiqueta: string) => React.ReactNode, etiqueta: string) => {
    if (b.estado === "sin_permiso") return;
    out.push(<div key={clave} className="min-w-0">{ligado(to, b.estado === "ok" ? render(b as Extract<Bloque<T>, { estado: "ok" }>) : vacio(etiqueta))}</div>);
  };
  const sinDato = (icon: typeof LogIn) => (etiqueta: string) => <StatCard variante="neutra" icon={icon} label={etiqueta} value="—" sinDato={tr("rentas.resumen.sinDato")} />;

  agrega(r.llegadasSalidas, "llegadas", `${base}/calendario`, (v) => <StatCard variante="neutra" icon={LogIn} label={tr("rentas.resumen.kpi.llegadas")} value={String(v.llegadas)} nota={tr(v.llegadas === 0 ? "rentas.resumen.kpi.llegadasCero" : "rentas.resumen.kpi.llegadasNota")} />, sinDato(LogIn), tr("rentas.resumen.kpi.llegadas"));
  agrega(r.llegadasSalidas, "salidas", `${base}/calendario`, (v) => <StatCard variante="neutra" icon={LogOut} label={tr("rentas.resumen.kpi.salidas")} value={String(v.salidas)} nota={tr(v.salidas === 0 ? "rentas.resumen.kpi.salidasCero" : "rentas.resumen.kpi.salidasNota")} />, sinDato(LogOut), tr("rentas.resumen.kpi.salidas"));
  agrega(
    r.ocupacionMes,
    "ocupacion",
    puedeReportes ? `${base}/reportes` : `${base}/calendario`,
    (v) => (
      <StatCard
        variante="neutra"
        icon={BedDouble}
        label={tr("rentas.resumen.kpi.ocupacion")}
        value={v.ocupacionBasisPoints === null ? "—" : `${(v.ocupacionBasisPoints / 100).toFixed(1)}%`}
        nota={v.nochesDisponibles === null ? tr("rentas.resumen.kpi.nochesOcupadas", { count: v.nochesOcupadas }) : tr("rentas.resumen.kpi.nochesDe", { ocupadas: v.nochesOcupadas, disponibles: v.nochesDisponibles })}
        sinDato={v.ocupacionBasisPoints === null ? tr("rentas.resumen.kpi.sinUnidades") : undefined}
      />
    ),
    sinDato(BedDouble),
    tr("rentas.resumen.kpi.ocupacion"),
  );
  agrega(r.conflictos, "conflictos", `${base}/monitor-sync`, (v) => <StatCard variante="neutra" icon={AlertTriangle} label={tr("rentas.resumen.kpi.conflictos")} value={String(v.abiertos)} nota={tr(v.abiertos === 0 ? "rentas.resumen.kpi.conflictosCero" : "rentas.resumen.kpi.conflictosNota")} />, sinDato(AlertTriangle), tr("rentas.resumen.kpi.conflictos"));
  agrega(
    r.limpieza,
    "limpieza",
    `${base}/mis-tareas`,
    (v) => <StatCard variante="neutra" icon={ClipboardList} label={tr("rentas.resumen.kpi.tareas")} value={String(v.pendientes)} nota={v.vencidas > 0 ? tr("rentas.resumen.kpi.vencidas", { count: v.vencidas }) : tr("rentas.resumen.kpi.ningunaVencida")} />,
    sinDato(ClipboardList),
    tr("rentas.resumen.kpi.tareas"),
  );
  agrega(r.aprobaciones, "aprobaciones", `${base}/aprobaciones`, (v) => <StatCard variante="neutra" icon={Inbox} label={tr("rentas.resumen.kpi.porAprobar")} value={String(v.pendientes)} nota={tr(v.pendientes === 0 ? "rentas.resumen.kpi.bandejaAlDia" : "rentas.resumen.kpi.borradores")} />, sinDato(Inbox), tr("rentas.resumen.kpi.porAprobar"));
  agrega(
    r.feeds,
    "feeds",
    `${base}/monitor-sync`,
    (v) => <StatCard variante="neutra" icon={RefreshCcw} label={tr("rentas.resumen.kpi.feeds")} value={String(v.conProblema)} nota={tr("rentas.resumen.kpi.feedsActivos", { count: v.activos })} />,
    sinDato(RefreshCcw),
    tr("rentas.resumen.kpi.feeds"),
  );
  return out;
}

export function RentasDashboardPage({ apiBaseUrl, token, propertyId, properties, orgSlug, session }: RentasShellContext) {
  const t = useT(rentasResumen);
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const esLimpieza = org?.rol === "limpieza";
  const [resumen, setResumen] = useState<ResumenOperativo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (esLimpieza) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const r = await fetchResumen(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setResumen(r);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : t("rentas.resumen.errorResumen"));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, esLimpieza, recarga]);

  const base = `/rentas/${orgSlug}`;
  // El panel del rol `limpieza` es "Mis tareas": el Resumen operativo no es para él (el servidor además responde 403).
  if (esLimpieza) return <Navigate to={`${base}/mis-tareas`} replace />;

  const propiedad = properties.find((p) => p.propertyId === propertyId);
  const saludo = saludoTraducido();
  const nombre = primerNombreOCorreo(session.fullName, session.email);

  if (error !== null) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />
      </PageContainer>
    );
  }
  if (resumen === null) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoCargando variante="tarjeta" etiqueta={t("rentas.resumen.cargando")} />
      </PageContainer>
    );
  }

  const puedeReportes = org !== undefined && ROLES_REPORTES.has(org.rol);
  const subtitulo = `${org?.nombre ?? orgSlug}${propiedad ? ` · ${propiedad.nombre}` : ""} · ${fechaLarga(resumen.hoy)}`;
  const tarjetas = kpis(resumen, base, puedeReportes);

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludo}
        nombre={nombre}
        subtitulo={subtitulo}
        kpis={tarjetas}
        acciones={
          <>
            <PillLink to={`${base}/calendario`}>{t("rentas.resumen.verCalendario")}</PillLink>
            {resumen.aprobaciones.estado !== "sin_permiso" && <PillLink to={`${base}/aprobaciones`}>{t("rentas.resumen.verAprobaciones")}</PillLink>}
            {puedeReportes && <PillLink to={`${base}/reportes`}>{t("rentas.resumen.verReportes")}</PillLink>}
          </>
        }
      >
        <ResumenSeccion titulo={t("rentas.resumen.orquestacion")}>
          {resumen.agentes.length === 0 ? (
            <p className="col-span-full text-xs text-faint">{t("rentas.resumen.sinCorridas")}</p>
          ) : (
            resumen.agentes.map((a) => (
              <AgentRunCard key={a.clave} nombre={a.nombre} estado={estadoAgente(a.estado)} meta={`${a.detalle} · ${cuando(a.ultimaCorridaEn, resumen.zonaHoraria)}`} href={`${base}/${PANTALLA_AGENTE[a.clave]}`} />
            ))
          )}
        </ResumenSeccion>
        <RentasFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
    </PageContainer>
  );
}
