// Resumen de citas (UNI-RES-citas): composición del Resumen de Likida con las piezas UNI-5 de @atiende/ui. Saludo, destacado
// "Citas hoy", KPI de dos capas que enlazan a su pantalla, píldora "Ver agenda" y "Orquestación de agentes".
//
// TODA cifra sale del servidor: GET .../resumen (conteos, incluido lo creado por canal), y para owner/admin además
// GET .../admin/avisos (recordatorios de 24 h) y GET .../admin/whatsapp-agente (conexión del número). Si el resumen falla se
// muestra el error, nunca un 0 inventado; si una lectura secundaria falla o la base aún no tiene la migración, ese tile dice
// "no disponible" en vez de una cifra. "Agentes — última corrida" no se pinta con fechas: ningún endpoint del tenant expone el
// registro de corridas (core.agent_run solo lo lee la consola de plataforma; falta un endpoint de tenant), así que declara honestamente que aún no hay registro.
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
  traductorActivo,
  useT,
} from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { citasResumen } from "@atiende/ui/i18n/citas/resumen";
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import { saludoTraducido } from "../lib/format.ts";
import { fetchCitasResumen, formatDiaCorto, formatDiaNegocio } from "../lib/resumen-client.ts";
import type { CitasResumen } from "../lib/resumen-client.ts";
import { fetchAvisosCitas } from "../lib/avisos-client.ts";
import type { AvisosCitas } from "../lib/avisos-client.ts";
import { fetchPanelAgente } from "../lib/whatsapp-agente-client.ts";
import type { EstadoConexion, PanelAgenteWire } from "../lib/whatsapp-agente-client.ts";
import { COPILOTO_CITAS_ROLES, CitasFijadosCopiloto } from "./Copiloto.tsx";
import type { CitasShellContext } from "../CitasShell.tsx";

// Funciones de texto fuera del componente: traducen al idioma activo (la pagina consume el contexto con `useT`, asi que se repinta al cambiarlo).
const tr = traductorActivo(citasResumen);

const CONEXION_TONO: Readonly<Record<EstadoConexion, StatusTone>> = {
  registrado: "success",
  pausado: "warning",
  sin_credenciales_de_envio: "warning",
  sin_numero: "neutral",
};

/** Lectura secundaria: `null` = todavía no llega; `"error"` = falló (el tile lo dice, no inventa). */
type Lectura<T> = T | null | "error";

function ligado(to: string, tarjeta: React.ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

function descripcionRecordatorios(avisos: Lectura<AvisosCitas>): string {
  if (avisos === null) return tr("citas.resumen.cargandoCorto");
  if (avisos === "error") return tr("citas.resumen.errorEntrega");
  const r = avisos.recordatorios;
  if (!r.visible) return tr("citas.resumen.soloOwner");
  if (!r.disponible) return tr("citas.resumen.sinMigrar");
  const total = (estados: readonly string[]) => r.filas.filter((f) => estados.includes(f.estado)).reduce((n, f) => n + f.total, 0);
  const enviados = total(["sent"]);
  const fallidos = total(["failed", "dead"]);
  return tr("citas.resumen.entrega", {
    enviados: tr("citas.resumen.enviados", { count: enviados }),
    fallidos: tr("citas.resumen.fallidos", { count: fallidos }),
    dias: r.ventanaDias,
  });
}

function descripcionPorCanal(resumen: CitasResumen, canal: "whatsapp" | "voice"): string {
  const por = resumen.createdBySourceLast30Days;
  if (por === null) return tr("citas.resumen.sinMigrar");
  return tr(canal === "whatsapp" ? "citas.resumen.porWhatsapp" : "citas.resumen.porVoz", { count: por[canal] });
}

export function ResumenPage({ apiBaseUrl, token, propertyId, orgSlug, role, staffFullName, staffEmail }: CitasShellContext) {
  const t = useT(citasResumen);
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
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("citas.resumen.errorResumen")));
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
        <EstadoCargando variante="tarjeta" etiqueta={t("citas.resumen.cargando")} />
      </PageContainer>
    );
  }

  const kpis = [
    <div key="semana" className="min-w-0">
      {ligado(`${base}/agenda`, <StatCard icon={CalendarDays} label={t("citas.resumen.kpi.semana")} value={String(resumen.week.total)} nota={`${formatDiaCorto(resumen.week.fromDate)} – ${formatDiaCorto(resumen.week.toDate)}`} />)}
    </div>,
    <div key="por-confirmar" className="min-w-0">
      {ligado(`${base}/avisos`, <StatCard icon={Clock} label={t("citas.resumen.kpi.porConfirmar")} value={String(resumen.pendingToConfirm)} nota={t("citas.resumen.kpi.proximos30")} />)}
    </div>,
    <div key="no-show" className="min-w-0">
      {ligado(`${base}/agenda`, <StatCard icon={CalendarX} label={t("citas.resumen.kpi.noAsistieron")} value={String(resumen.noShowsLast30Days)} nota={t("citas.resumen.kpi.ultimos30")} />)}
    </div>,
    <div key="nuevos" className="min-w-0">
      {ligado(`${base}/clientes`, <StatCard icon={UserPlus} label={t("citas.resumen.kpi.nuevos")} value={String(resumen.newCustomersLast30Days)} nota={t("citas.resumen.kpi.ultimos30")} />)}
    </div>,
  ];

  const estadoConexion = panelAgente !== null && panelAgente !== "error" ? panelAgente.conexion.estado : undefined;
  const conexion = estadoConexion ? { tone: CONEXION_TONO[estadoConexion], etiqueta: t(`citas.resumen.conexion.${estadoConexion}`) } : undefined;
  const descripcionWhatsapp =
    panelAgente === "error" ? t("citas.resumen.conexionNoDisponible", { descripcion: descripcionPorCanal(resumen, "whatsapp") }) : descripcionPorCanal(resumen, "whatsapp");
  const citasHoy = t("citas.resumen.citasHoy", { count: resumen.today.total });

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoTraducido()}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        // El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra de hoy viaja en el subtítulo.
        subtitulo={`${formatDiaNegocio(resumen.today.date)} · ${citasHoy}`}
        // ds3: la cifra clave en negritas sustituye al odometro (Rovaq «Hoy»).
        frase={
          <>
            {formatDiaNegocio(resumen.today.date)}: <strong>{citasHoy}</strong>.
          </>
        }
        destacado={<Odometro valor={resumen.today.total} digitos={Math.max(3, String(resumen.today.total).length)} etiqueta={t("citas.resumen.citasHoyEtiqueta")} tamano="md" />}
        kpis={kpis}
        acciones={<PillLink to={`${base}/agenda`}>{t("citas.resumen.verAgenda")}</PillLink>}
      >
        {verAgentes && (
          <>
            <ResumenSeccion titulo={t("citas.resumen.orquestacion")}>
              <TileLink
                to={`${base}/agente-whatsapp`}
                icon={Bot}
                titulo={t("citas.resumen.agenteWhatsapp")}
                badge={conexion ? <StatusBadge tone={conexion.tone}>{conexion.etiqueta}</StatusBadge> : undefined}
                descripcion={descripcionWhatsapp}
              />
              <TileLink to={`${base}/avisos`} icon={Bell} titulo={t("citas.resumen.recordatorios")} descripcion={descripcionRecordatorios(avisos)} />
              <TileLink to={`${base}/agenda`} icon={Mic} titulo={t("citas.resumen.voz")} descripcion={descripcionPorCanal(resumen, "voice")} />
              <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo={t("citas.resumen.copiloto")} descripcion={t("citas.resumen.copilotoDesc")} />
            </ResumenSeccion>
            <ResumenSeccion titulo={t("citas.resumen.ultimaCorrida")}>
              <p data-testid="sin-datos-corrida" className="col-span-full text-xs text-faint">
                {t("citas.resumen.sinCorridas")}
              </p>
            </ResumenSeccion>
          </>
        )}
        <CitasFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} role={role} />
      </ResumenLayout>
    </PageContainer>
  );
}
