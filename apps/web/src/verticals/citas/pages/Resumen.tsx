// Resumen de citas (UNI-RES-citas): composición del Resumen de Likida con las piezas UNI-5 de @atiende/ui. Saludo, destacado
// "Citas hoy", KPI de dos capas que enlazan a su pantalla, píldora "Ver agenda" y "Orquestación de agentes".
//
// TODA cifra sale del servidor: GET .../resumen (conteos, incluido lo creado por canal), y para owner/admin además
// GET .../admin/avisos (recordatorios de 24 h) y GET .../admin/whatsapp-agente (conexión del número). Si el resumen falla se
// muestra el error, nunca un 0 inventado; si una lectura secundaria falla o la base aún no tiene la migración, ese tile dice
// "no disponible" en vez de una cifra. "Agentes — última corrida" no se pinta con fechas: ningún endpoint del tenant expone el
// latido del cron de recordatorios (solo la consola de plataforma), así que declara honestamente "sin datos de corrida".
// El rol staff ve únicamente los conteos de citas; los tiles de agentes (configuración y entrega) son de owner/admin.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, Bot, CalendarDays, CalendarX, Clock, Mic, Sparkles, UserPlus } from "lucide-react";
import {
  EstadoCargando,
  EstadoError,
  Odometro,
  PageContainer,
  PillLink,
  ResumenLayout,
  ResumenSeccion,
  StatCard,
  StatusBadge,
  TileLink,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { saludoPorHora, primerNombreOCorreo } from "../../../lib/greeting.ts";
import { fetchCitasResumen, formatDiaCorto, formatDiaNegocio } from "../lib/resumen-client.ts";
import type { CitasResumen } from "../lib/resumen-client.ts";
import { fetchAvisosCitas } from "../lib/avisos-client.ts";
import type { AvisosCitas } from "../lib/avisos-client.ts";
import { fetchPanelAgente } from "../lib/whatsapp-agente-client.ts";
import type { EstadoConexion, PanelAgenteWire } from "../lib/whatsapp-agente-client.ts";
import { COPILOTO_CITAS_ROLES, CitasFijadosCopiloto } from "./Copiloto.tsx";
import type { CitasShellContext } from "../CitasShell.tsx";

const SIN_MIGRAR = "No disponible aún en este ambiente";

const CONEXION_BADGE: Readonly<Record<EstadoConexion, { tone: StatusTone; etiqueta: string }>> = {
  registrado: { tone: "success", etiqueta: "Conectado" },
  pausado: { tone: "warning", etiqueta: "Pausado" },
  sin_credenciales_de_envio: { tone: "warning", etiqueta: "Sin credenciales" },
  sin_numero: { tone: "neutral", etiqueta: "Sin número" },
};

/** Lectura secundaria: `null` = todavía no llega; `"error"` = falló (el tile lo dice, no inventa). */
type Lectura<T> = T | null | "error";

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

function ligado(to: string, tarjeta: React.ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

function descripcionRecordatorios(avisos: Lectura<AvisosCitas>): string {
  if (avisos === null) return "Cargando…";
  if (avisos === "error") return "No se pudo cargar el estado de entrega.";
  const r = avisos.recordatorios;
  if (!r.visible) return "Solo owner o admin ven el estado de entrega.";
  if (!r.disponible) return SIN_MIGRAR;
  const total = (estados: readonly string[]) => r.filas.filter((f) => estados.includes(f.estado)).reduce((n, f) => n + f.total, 0);
  const enviados = total(["sent"]);
  const fallidos = total(["failed", "dead"]);
  return `${plural(enviados, "enviado", "enviados")} · ${plural(fallidos, "fallido", "fallidos")} (${r.ventanaDias} días)`;
}

function descripcionPorCanal(resumen: CitasResumen, canal: "whatsapp" | "voice", singular: string, varias: string, sufijo: string): string {
  const por = resumen.createdBySourceLast30Days;
  if (por === null) return SIN_MIGRAR;
  return `${plural(por[canal], singular, varias)} ${sufijo} (30 días)`;
}

export function ResumenPage({ apiBaseUrl, token, propertyId, orgSlug, role, staffFullName, staffEmail }: CitasShellContext) {
  const [resumen, setResumen] = useState<CitasResumen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [avisos, setAvisos] = useState<Lectura<AvisosCitas>>(null);
  const [panelAgente, setPanelAgente] = useState<Lectura<PanelAgenteWire>>(null);
  const verAgentes = COPILOTO_CITAS_ROLES.has(role);

  useEffect(() => {
    let cancelado = false;
    setResumen(null);
    setError(null);
    fetchCitasResumen(fetch, apiBaseUrl, token, propertyId)
      .then((r) => !cancelado && setResumen(r))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  // Lecturas de los tiles de agentes: independientes del resumen, solo para owner/admin (el servidor las niega a otros roles).
  useEffect(() => {
    setAvisos(null);
    setPanelAgente(null);
    if (!verAgentes) return;
    let cancelado = false;
    fetchAvisosCitas(fetch, apiBaseUrl, token, propertyId)
      .then((r) => !cancelado && setAvisos(r))
      .catch(() => !cancelado && setAvisos("error"));
    fetchPanelAgente(fetch, apiBaseUrl, token, propertyId)
      .then((r) => !cancelado && setPanelAgente(r))
      .catch(() => !cancelado && setPanelAgente("error"));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, verAgentes]);

  const base = `/citas/${orgSlug}`;

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
        <EstadoCargando variante="tarjeta" etiqueta="Cargando resumen…" />
      </PageContainer>
    );
  }

  const kpis = [
    <div key="semana" className="min-w-0">
      {ligado(`${base}/agenda`, <StatCard variante="neutra" icon={CalendarDays} label="Citas esta semana" value={String(resumen.week.total)} nota={`${formatDiaCorto(resumen.week.fromDate)} – ${formatDiaCorto(resumen.week.toDate)}`} />)}
    </div>,
    <div key="por-confirmar" className="min-w-0">
      {ligado(`${base}/avisos`, <StatCard variante="neutra" icon={Clock} label="Por confirmar" value={String(resumen.pendingToConfirm)} nota="próximos 30 días" />)}
    </div>,
    <div key="no-show" className="min-w-0">
      {ligado(`${base}/agenda`, <StatCard variante="neutra" icon={CalendarX} label="No asistieron" value={String(resumen.noShowsLast30Days)} nota="últimos 30 días" />)}
    </div>,
    <div key="nuevos" className="min-w-0">
      {ligado(`${base}/clientes`, <StatCard variante="neutra" icon={UserPlus} label="Clientes nuevos" value={String(resumen.newCustomersLast30Days)} nota="últimos 30 días" />)}
    </div>,
  ];

  const conexion = panelAgente !== null && panelAgente !== "error" ? CONEXION_BADGE[panelAgente.conexion.estado] : undefined;
  const descripcionWhatsapp =
    panelAgente === "error" ? `${descripcionPorCanal(resumen, "whatsapp", "cita creada", "citas creadas", "por WhatsApp")} · conexión no disponible` : descripcionPorCanal(resumen, "whatsapp", "cita creada", "citas creadas", "por WhatsApp");

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoPorHora()}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        // El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra de hoy viaja en el subtítulo.
        subtitulo={`${formatDiaNegocio(resumen.today.date)} · ${plural(resumen.today.total, "cita hoy", "citas hoy")}`}
        destacado={<Odometro valor={resumen.today.total} digitos={Math.max(3, String(resumen.today.total).length)} etiqueta="Citas hoy" tamano="md" />}
        kpis={kpis}
        acciones={<PillLink to={`${base}/agenda`}>Ver agenda</PillLink>}
      >
        {verAgentes && (
          <>
            <ResumenSeccion titulo="Orquestación de agentes">
              <TileLink
                to={`${base}/agente-whatsapp`}
                icon={Bot}
                titulo="Agente de WhatsApp"
                badge={conexion ? <StatusBadge tone={conexion.tone}>{conexion.etiqueta}</StatusBadge> : undefined}
                descripcion={descripcionWhatsapp}
              />
              <TileLink to={`${base}/avisos`} icon={Bell} titulo="Recordatorios 24 h" descripcion={descripcionRecordatorios(avisos)} />
              <TileLink to={`${base}/agenda`} icon={Mic} titulo="Voz" descripcion={descripcionPorCanal(resumen, "voice", "cita creada", "citas creadas", "por voz")} />
              <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo="Copiloto" descripcion="Pregunta a tus datos de citas." />
            </ResumenSeccion>
            <ResumenSeccion titulo="Agentes — última corrida">
              <p data-testid="sin-datos-corrida" className="col-span-full text-xs text-faint">
                Sin datos de corrida: el latido del recordatorio de 24 h solo lo expone la consola de plataforma y no hay bitácora de corridas por negocio.
              </p>
            </ResumenSeccion>
          </>
        )}
        <CitasFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} role={role} />
      </ResumenLayout>
    </PageContainer>
  );
}
