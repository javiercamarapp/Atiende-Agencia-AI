// Rn-26 -- Resumen operativo de rentas (landing del panel). Composición del Resumen de Likida con las piezas UNI-5 de
// @atiende/ui: saludo, KPI de dos capas que enlazan a su pantalla, pildoras de acción y "Orquestación de agentes". TODA cifra
// viene de GET /rentas/:propertyId/resumen (agregados reales, sin PII); un bloque que el servidor marca "no_disponible" (base
// sin migrar) se muestra como tal ("—" con su razón) y el resto carga; uno "sin_permiso" (rol) no se pinta. El rol `limpieza`
// no tiene Resumen: se le lleva a "Mis tareas", su panel real. El selector de propiedad vive en el Shell.
import { useEffect, useState } from "react";
import { RentasFijadosCopiloto } from "./Copiloto.tsx";
import { OnboardingChecklist } from "../components/OnboardingChecklist.tsx";
import { Navigate, Link } from "react-router-dom";
import { AlertTriangle, BedDouble, ClipboardList, Inbox, LogIn, LogOut, RefreshCcw } from "lucide-react";
import { AgentRunCard, EstadoCargando, EstadoError, PageContainer, PillLink, ResumenLayout, ResumenSeccion, StatCard } from "@atiende/ui";
import type { AgentRunEstado } from "@atiende/ui";
import { saludoPorHora, primerNombreOCorreo } from "../../../lib/greeting.ts";
import { fetchResumen } from "../lib/resumen-client.ts";
import type { AgenteResumen, Bloque, ResumenOperativo } from "../lib/resumen-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

/** Roles con acceso a Reportes (mismo techo que el reporte de Rn-03: finanzas). */
const ROLES_REPORTES: ReadonlySet<string> = new Set(["admin_gestora", "contador"]);
const SIN_DATO = "No disponible aún en este ambiente";

const ESTADO_AGENTE: Record<AgenteResumen["estado"], AgentRunEstado> = {
  ok: { tone: "success", etiqueta: "Al día" },
  atencion: { tone: "warning", etiqueta: "Requiere atención" },
  error: { tone: "danger", etiqueta: "Con error" },
};

const PANTALLA_AGENTE: Record<AgenteResumen["clave"], string> = {
  sync_ical: "ical-sync",
  borradores_ia: "aprobaciones",
  liberacion_acceso: "acceso-huesped",
  checkout_sweep: "mis-tareas",
};

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** "2 oct, 14:05" en la zona de la property; si la zona no es válida, cae a la del navegador. */
function cuando(iso: string, zona: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "fecha desconocida";
  const opciones: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("es-MX", { ...opciones, timeZone: zona }).format(d);
  } catch {
    return new Intl.DateTimeFormat("es-MX", opciones).format(d);
  }
}

/** "jueves 2 de octubre" a partir de la fecha de calendario `YYYY-MM-DD` de la property (sin pasar por la zona del navegador). */
function fechaLarga(hoy: string): string {
  const d = new Date(`${hoy}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return hoy;
  return new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d);
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
  const sinDato = (icon: typeof LogIn) => (etiqueta: string) => <StatCard variante="neutra" icon={icon} label={etiqueta} value="—" sinDato={SIN_DATO} />;

  agrega(r.llegadasSalidas, "llegadas", `${base}/calendario`, (v) => <StatCard variante="neutra" icon={LogIn} label="Llegadas hoy" value={String(v.llegadas)} nota={v.llegadas === 0 ? "Sin llegadas hoy" : "Reservas confirmadas"} />, sinDato(LogIn), "Llegadas hoy");
  agrega(r.llegadasSalidas, "salidas", `${base}/calendario`, (v) => <StatCard variante="neutra" icon={LogOut} label="Salidas hoy" value={String(v.salidas)} nota={v.salidas === 0 ? "Sin salidas hoy" : "Check-outs del día"} />, sinDato(LogOut), "Salidas hoy");
  agrega(
    r.ocupacionMes,
    "ocupacion",
    puedeReportes ? `${base}/reportes` : `${base}/calendario`,
    (v) => (
      <StatCard
        variante="neutra"
        icon={BedDouble}
        label="Ocupación del mes"
        value={v.ocupacionBasisPoints === null ? "—" : `${(v.ocupacionBasisPoints / 100).toFixed(1)}%`}
        nota={v.nochesDisponibles === null ? `${plural(v.nochesOcupadas, "noche ocupada", "noches ocupadas")}` : `${v.nochesOcupadas} de ${v.nochesDisponibles} noches`}
        sinDato={v.ocupacionBasisPoints === null ? "Aún no hay unidades con noches disponibles" : undefined}
      />
    ),
    sinDato(BedDouble),
    "Ocupación del mes",
  );
  agrega(r.conflictos, "conflictos", `${base}/monitor-sync`, (v) => <StatCard variante="neutra" icon={AlertTriangle} label="Conflictos abiertos" value={String(v.abiertos)} nota={v.abiertos === 0 ? "Sin cruces de calendario" : "Requieren decisión"} />, sinDato(AlertTriangle), "Conflictos abiertos");
  agrega(
    r.limpieza,
    "limpieza",
    `${base}/mis-tareas`,
    (v) => <StatCard variante="neutra" icon={ClipboardList} label="Tareas pendientes" value={String(v.pendientes)} nota={v.vencidas > 0 ? `${plural(v.vencidas, "vencida", "vencidas")}` : "Ninguna vencida"} />,
    sinDato(ClipboardList),
    "Tareas pendientes",
  );
  agrega(r.aprobaciones, "aprobaciones", `${base}/aprobaciones`, (v) => <StatCard variante="neutra" icon={Inbox} label="Por aprobar" value={String(v.pendientes)} nota={v.pendientes === 0 ? "Bandeja al día" : "Borradores esperando aprobación"} />, sinDato(Inbox), "Por aprobar");
  agrega(
    r.feeds,
    "feeds",
    `${base}/monitor-sync`,
    (v) => <StatCard variante="neutra" icon={RefreshCcw} label="Feeds iCal con problema" value={String(v.conProblema)} nota={`de ${plural(v.activos, "feed activo", "feeds activos")}`} />,
    sinDato(RefreshCcw),
    "Feeds iCal con problema",
  );
  return out;
}

export function RentasDashboardPage({ apiBaseUrl, token, propertyId, properties, orgSlug, session }: RentasShellContext) {
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
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el resumen.");
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
  const saludo = saludoPorHora();
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
        <EstadoCargando variante="tarjeta" etiqueta="Cargando el resumen…" />
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
            <PillLink to={`${base}/calendario`}>Ver calendario</PillLink>
            {resumen.aprobaciones.estado !== "sin_permiso" && <PillLink to={`${base}/aprobaciones`}>Ver aprobaciones</PillLink>}
            {puedeReportes && <PillLink to={`${base}/reportes`}>Ver reportes</PillLink>}
          </>
        }
      >
        {org?.rol === "admin_gestora" && <OnboardingChecklist apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />}
        <ResumenSeccion titulo="Orquestación de agentes">
          {resumen.agentes.length === 0 ? (
            <p className="col-span-full text-xs text-faint">Todavía no hay corridas registradas de los agentes de esta propiedad.</p>
          ) : (
            resumen.agentes.map((a) => (
              <AgentRunCard key={a.clave} nombre={a.nombre} estado={ESTADO_AGENTE[a.estado]} meta={`${a.detalle} · ${cuando(a.ultimaCorridaEn, resumen.zonaHoraria)}`} href={`${base}/${PANTALLA_AGENTE[a.clave]}`} />
            ))
          )}
        </ResumenSeccion>
        <RentasFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
    </PageContainer>
  );
}
