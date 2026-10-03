// Resumen de licitaciones (UNI-RES-licitaciones): la composicion del Resumen de Likida con las piezas de @atiende/ui. Saludo +
// subtitulo, destacado "Convocatorias abiertas" (odometro), KPI de dos capas que enlazan a su pantalla, pildoras de profundizacion,
// "Orquestacion de agentes" y "Agentes - ultima corrida".
//
// TODA cifra sale de una lectura real de la API que ya existia (tenders, sources/freshness, sources, sources/runs,
// deadline-reminders, tender-change-notifications, renewals/alerts, company/*, company/signers). Si una lectura falla, su tarjeta
// dice "No se pudo leer" en vez de un cero inventado; si TODAS fallan, la pantalla muestra el error con reintento. KPIs que NO se
// pintan por falta de endpoint a nivel organizacion: go/no-go pendientes (las decisiones se leen por convocatoria) y facturas
// de cobranza vencidas (el resumen de cartera se lee por contrato). Solo la ingesta tiene bitacora de corridas
// (licitaciones.source_run); los demas agentes dicen "Sin corridas registradas.".
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  BellRing,
  CalendarClock,
  CheckCheck,
  Database,
  FileEdit,
  FileSearch,
  Gavel,
  MessageCircle,
  PenLine,
  Radar,
  ShieldAlert,
  Sparkles,
  Timer,
  FilePen,
  Siren,
} from "lucide-react";
import {
  AgentRunCard,
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
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import { LicitacionesFijadosCopiloto } from "./Copiloto.tsx";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchSourceConnectors, fetchSourceFreshness, fetchSourceRuns } from "../lib/sources-client.ts";
import type { SourceConnectorInfo, SourceFreshness, SourceRun } from "../lib/sources-client.ts";
import { fetchDeadlineReminders, fetchTenderChangeNotifications } from "../lib/seguimiento-client.ts";
import { fetchRenewalAlerts } from "../lib/renewal-radar-client.ts";
import { fetchApprovedRates, fetchCompanyCapabilities, fetchCompanyDocuments, fetchCompanyExperience, fetchCompanySigners } from "../lib/company-data-client.ts";
import { convocatoriasAbiertas, cierranEnVentana, fechaLargaEnZona, plural, propuestasEnPreparacion, saludoEnZona, ultimaCorridaPorFuente, VENTANA_PLAZO_DIAS } from "../lib/resumen.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

/** Resultado de una lectura: valor, o null cuando fallo (la tarjeta lo muestra como "No se pudo leer"). */
type Medida<T> = T | null;

interface Resumen {
  tenders: Medida<readonly TenderSummary[]>;
  fuentes: Medida<readonly SourceFreshness[]>;
  conectores: Medida<readonly SourceConnectorInfo[]>;
  corridas: Medida<readonly SourceRun[]>;
  recordatoriosPendientes: Medida<number>;
  cambiosPendientes: Medida<number>;
  renovacionesPendientes: Medida<number>;
  aprobacionesPendientes: Medida<number>;
  firmantesAutorizados: Medida<number>;
  /** Cuantas de las lecturas fallaron (de `LECTURAS`): si fallan todas, la pantalla muestra el error en vez de 8 "sin dato". */
  fallidas: number;
}

const LECTURAS = 12;
const SIN_LECTURA = "No se pudo leer";

const ok = <T,>(r: PromiseSettledResult<T>): Medida<T> => (r.status === "fulfilled" ? r.value : null);

function enlazada(to: string, tarjeta: React.ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

export function PanelPage({ apiBaseUrl, token, propertyId, orgSlug, staffFullName, staffEmail }: LicitacionesShellContext) {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setResumen(null);
    (async () => {
      const lecturas = await Promise.allSettled([
        fetchTenders(fetch, apiBaseUrl, token, propertyId),
        fetchSourceFreshness(fetch, apiBaseUrl, token, propertyId),
        fetchDeadlineReminders(fetch, apiBaseUrl, token, propertyId),
        fetchTenderChangeNotifications(fetch, apiBaseUrl, token, propertyId),
        fetchRenewalAlerts(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
        fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
        fetchCompanySigners(fetch, apiBaseUrl, token, propertyId),
        fetchSourceConnectors(fetch, apiBaseUrl, token, propertyId),
        fetchSourceRuns(fetch, apiBaseUrl, token, propertyId, { limit: 50 }),
      ]);
      if (cancelado) return;
      const [tenders, fuentes, recs, cambios, renov, docs, rates, caps, exps, firmantes, conectores, corridas] = lecturas;
      const datosEmpresa = [docs, rates, caps, exps];
      // Las aprobaciones solo se cuentan si las 4 lecturas respondieron: una suma parcial parecería "todo al día".
      const aprobaciones = datosEmpresa.every((r) => r.status === "fulfilled")
        ? datosEmpresa.reduce((acc, r) => acc + (r as PromiseFulfilledResult<readonly { approvalStatus: string }[]>).value.filter((x) => x.approvalStatus === "pendiente_aprobacion").length, 0)
        : null;
      const r = ok(recs);
      const c = ok(cambios);
      const rn = ok(renov);
      const fi = ok(firmantes);
      setResumen({
        tenders: ok(tenders),
        fuentes: ok(fuentes),
        conectores: ok(conectores),
        corridas: ok(corridas),
        recordatoriosPendientes: r ? r.filter((x) => x.acknowledgedAt === null).length : null,
        cambiosPendientes: c ? c.filter((x) => x.acknowledgedAt === null).length : null,
        renovacionesPendientes: rn ? rn.filter((x) => x.status === "pendiente").length : null,
        aprobacionesPendientes: aprobaciones,
        firmantesAutorizados: fi ? fi.filter((x) => x.authorized).length : null,
        fallidas: lecturas.filter((x) => x.status === "rejected").length,
      });
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const base = `/licitaciones/${orgSlug}`;

  if (!resumen) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoCargando variante="tarjeta" etiqueta="Cargando resumen…" />
      </PageContainer>
    );
  }
  if (resumen.fallidas >= LECTURAS) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoError mensaje="No se pudo cargar el resumen de licitaciones." onReintentar={() => setRecarga((n) => n + 1)} />
      </PageContainer>
    );
  }

  const ahora = new Date();
  const abiertas = resumen.tenders ? convocatoriasAbiertas(resumen.tenders) : null;
  const proximas = abiertas ? cierranEnVentana(abiertas, ahora.getTime()) : null;
  const enPreparacion = resumen.tenders ? propuestasEnPreparacion(resumen.tenders) : null;
  const obsoletas = resumen.fuentes ? resumen.fuentes.filter((f) => f.stale).length : null;

  /** KPI de dos capas: con dato = cifra; sin dato = "—" y "No se pudo leer" (nunca un cero). */
  const kpi = (clave: string, to: string, icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>, label: string, valor: number | string | null, nota: string) => (
    <div key={clave} className="min-w-0">
      {enlazada(to, valor === null ? <StatCard icon={icon} label={label} value="" sinDato={SIN_LECTURA} /> : <StatCard icon={icon} label={label} value={String(valor)} nota={nota} />)}
    </div>
  );

  const kpis = [
    kpi("cierran", `${base}/convocatorias`, CalendarClock, `Cierran en ${VENTANA_PLAZO_DIAS} días`, proximas?.length ?? null, "plazo de presentación de propuestas"),
    kpi("preparacion", `${base}/convocatorias`, FilePen, "Propuestas en preparación", enPreparacion, "convocatorias en preparación"),
    kpi("recordatorios", `${base}/seguimiento`, BellRing, "Recordatorios de plazo", resumen.recordatoriosPendientes, "pendientes de reconocer"),
    kpi("cambios", `${base}/seguimiento`, FileEdit, "Cambios de convocatoria", resumen.cambiosPendientes, "bases o anexos por revisar"),
    kpi("renovaciones", `${base}/radar-renovaciones`, Radar, "Renovaciones por vencer", resumen.renovacionesPendientes, "alertas del radar sin reconocer"),
    kpi("aprobar", `${base}/aprobaciones`, CheckCheck, "Datos por aprobar", resumen.aprobacionesPendientes, "documentos, tarifas, capacidades y experiencia"),
    kpi(
      "firmantes",
      `${base}/firmantes`,
      PenLine,
      "Firmantes autorizados",
      resumen.firmantesAutorizados,
      resumen.firmantesAutorizados === 0 ? "sin firmante no se puede firmar una propuesta" : "pueden firmar propuestas",
    ),
    kpi("fuentes", `${base}/fuentes`, Database, "Fuentes obsoletas", obsoletas === null || !resumen.fuentes ? null : `${obsoletas} de ${resumen.fuentes.length}`, "sin corrida exitosa dentro de su umbral"),
  ];

  const abiertasN = abiertas?.length ?? null;
  const subtitulo =
    abiertasN === null
      ? `${fechaLargaEnZona(ahora)} · convocatorias no disponibles`
      : `${fechaLargaEnZona(ahora)} · ${plural(abiertasN, "convocatoria abierta", "convocatorias abiertas")}`;

  const corridasPorFuente = resumen.conectores && resumen.corridas ? ultimaCorridaPorFuente(resumen.conectores, resumen.corridas) : null;
  const sinBitacora = [
    { nombre: "Extractor de requisitos", href: `${base}/convocatorias` },
    { nombre: "Borrador de junta de aclaraciones", href: `${base}/convocatorias` },
    { nombre: "Alertas y recordatorios", href: `${base}/seguimiento` },
    { nombre: "WhatsApp", href: `${base}/whatsapp` },
    { nombre: "KYC proveedores (69-B)", href: `${base}/kyc-69b` },
  ];

  const descripcionIngesta =
    resumen.fuentes === null ? "No se pudo leer la frescura de las fuentes." : obsoletas === 0 ? `${plural(resumen.fuentes.length, "fuente al día", "fuentes al día")}.` : `${plural(obsoletas ?? 0, "fuente obsoleta", "fuentes obsoletas")} de ${resumen.fuentes.length}.`;
  const badgeIngesta =
    resumen.fuentes === null || resumen.fuentes.length === 0 ? undefined : obsoletas === 0 ? <StatusBadge tone="success">Al día</StatusBadge> : <StatusBadge tone="warning">Obsoleta</StatusBadge>;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoEnZona(ahora)}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        subtitulo={subtitulo}
        // El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra viaja en el subtítulo.
        destacado={<Odometro valor={abiertasN} digitos={Math.max(3, String(abiertasN ?? 0).length)} etiqueta="Convocatorias abiertas" tamano="md" sinDato={SIN_LECTURA} />}
        kpis={kpis}
        acciones={
          <>
            <PillLink to={`${base}/convocatorias`}>Ver convocatorias</PillLink>
            <PillLink to={`${base}/seguimiento`}>Ver seguimiento</PillLink>
          </>
        }
      >
        <ResumenSeccion titulo="Orquestación de agentes">
          <TileLink to={`${base}/fuentes`} icon={Database} titulo="Descubrimiento e ingesta" badge={badgeIngesta} descripcion={descripcionIngesta} />
          <TileLink to={`${base}/convocatorias`} icon={FileSearch} titulo="Extractor de requisitos" descripcion="Se ejecuta desde cada convocatoria." />
          <TileLink to={`${base}/convocatorias`} icon={Gavel} titulo="Borrador de junta de aclaraciones" descripcion="Se prepara desde cada convocatoria." />
          <TileLink
            to={`${base}/seguimiento`}
            icon={Timer}
            titulo="Alertas y recordatorios"
            descripcion={
              resumen.recordatoriosPendientes === null || resumen.cambiosPendientes === null
                ? "No se pudo leer el seguimiento."
                : `${plural(resumen.recordatoriosPendientes, "recordatorio pendiente", "recordatorios pendientes")} · ${plural(resumen.cambiosPendientes, "cambio por revisar", "cambios por revisar")}`
            }
          />
          <TileLink to={`${base}/whatsapp`} icon={MessageCircle} titulo="WhatsApp" descripcion="Avisos de plazos, fallos y decisiones." />
          <TileLink to={`${base}/kyc-69b`} icon={ShieldAlert} titulo="KYC proveedores (69-B)" descripcion="Consulta del listado del SAT." />
          <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo="Copiloto" descripcion="Pregunta a tus datos de licitaciones." />
        </ResumenSeccion>
        <ResumenSeccion titulo="Agentes — última corrida">
          {corridasPorFuente === null ? (
            <p data-testid="corridas-sin-lectura" className="col-span-full flex items-center gap-1.5 text-xs text-muted-foreground">
              <Siren aria-hidden="true" className="size-3" strokeWidth={1.75} />
              No se pudo leer el registro de corridas de la ingesta.
            </p>
          ) : (
            corridasPorFuente.map((c) => <AgentRunCard key={c.source} nombre={`Ingesta · ${c.nombre}`} estado={c.estado} meta={c.meta} href={`${base}/fuentes`} />)
          )}
          {sinBitacora.map((a) => (
            <Link key={a.nombre} to={a.href} className="block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <AgentRunCard nombre={a.nombre} />
            </Link>
          ))}
        </ResumenSeccion>
        <LicitacionesFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
    </PageContainer>
  );
}
