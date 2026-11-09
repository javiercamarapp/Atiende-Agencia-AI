// Resumen de licitaciones (UNI-RES-licitaciones): la composicion del Resumen de Likida con las piezas de @atiende/ui. Saludo +
// subtitulo, destacado "Convocatorias abiertas" (odometro), KPI de dos capas que enlazan a su pantalla, pildoras de profundizacion,
// "Orquestacion de agentes" y "Agentes - ultima corrida".
//
// TODA cifra sale de una lectura real de la API que ya existia (tenders, sources/freshness, sources, sources/runs,
// deadline-reminders, tender-change-notifications, renewals/alerts, company/*, company/signers). Si una lectura falla, su tarjeta
// dice "No se pudo leer" en vez de un cero inventado; si TODAS fallan, la pantalla muestra el error con reintento. KPIs que NO se
// pintan por falta de endpoint a nivel organizacion: go/no-go pendientes (la decision se registra por convocatoria; el estatus
// de la lista solo es un proxy) y facturas de cobranza vencidas (el resumen de cartera se lee por contrato). La fecha y el
// saludo usan la zona de la organizacion (admin/tenant-config; America/Mexico_City si no esta configurada o no se pudo leer).
// "Ultima corrida" sale de registros reales: la ingesta (sources/runs), el listado 69-B (kyc-69b -> lista.ingestadoEn) y el ultimo
// aviso de seguimiento (createdAt); extractor, junta y WhatsApp no tienen bitacora legible y dicen "Sin corridas registradas.".
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
  useT,
} from "@atiende/ui";
import { licitacionesResumen } from "@atiende/ui/i18n/licitaciones/resumen";
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import { LicitacionesFijadosCopiloto } from "./Copiloto.tsx";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchSourceConnectors, fetchSourceFreshness, fetchSourceRuns } from "../lib/sources-client.ts";
import type { SourceConnectorInfo, SourceFreshness, SourceRun } from "../lib/sources-client.ts";
import { fetchDeadlineReminders, fetchTenderChangeNotifications } from "../lib/seguimiento-client.ts";
import { fetchTenantConfig } from "../lib/admin-client.ts";
import { fetchKycResumen } from "../lib/kyc-69b-client.ts";
import type { KycResumen } from "../lib/kyc-69b-client.ts";
import { fetchRenewalAlerts } from "../lib/renewal-radar-client.ts";
import { fetchApprovedRates, fetchCompanyCapabilities, fetchCompanyDocuments, fetchCompanyExperience, fetchCompanySigners } from "../lib/company-data-client.ts";
import type { CorridaSimple } from "../lib/resumen.ts";
import { convocatoriasAbiertas, cierranEnVentana, corridaKyc, corridaSeguimiento, fechaLargaEnZona, propuestasEnPreparacion, saludoEnZona, ultimaCorridaPorFuente, VENTANA_PLAZO_DIAS, zonaEfectiva } from "../lib/resumen.ts";
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
  /** Zona de la organizacion (tenant-config) ya resuelta: cae a Mexico si no esta configurada o la lectura fallo. */
  zona: string;
  kyc: Medida<KycResumen>;
  /** `createdAt` de los recordatorios y cambios leidos (null si alguna de las dos lecturas fallo). */
  avisosCreados: Medida<readonly string[]>;
  /** Cuantas de las lecturas fallaron (de `LECTURAS`): si fallan todas, la pantalla muestra el error en vez de 8 "sin dato". */
  fallidas: number;
}

const LECTURAS = 12;

const ok = <T,>(r: PromiseSettledResult<T>): Medida<T> => (r.status === "fulfilled" ? r.value : null);

function enlazada(to: string, tarjeta: React.ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

export function PanelPage({ apiBaseUrl, token, propertyId, orgSlug, staffFullName, staffEmail }: LicitacionesShellContext) {
  const t = useT(licitacionesResumen);
  const sinLectura = t("licitaciones.resumen.sinLectura");
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setResumen(null);
    (async () => {
      // Lecturas auxiliares (no cuentan para el error total): si fallan, zona = Mexico y la tarjeta de KYC queda sin corrida.
      const auxiliares = Promise.allSettled([fetchTenantConfig(fetch, apiBaseUrl, token, orgSlug), fetchKycResumen(fetch, apiBaseUrl, token, propertyId)]);
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
      const [tz, kycLectura] = await auxiliares;
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
        zona: zonaEfectiva(tz.status === "fulfilled" ? tz.value.timezone : null),
        kyc: ok(kycLectura),
        avisosCreados: r && c ? [...r.map((x) => x.createdAt), ...c.map((x) => x.createdAt)] : null,
        fallidas: lecturas.filter((x) => x.status === "rejected").length,
      });
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, orgSlug, recarga]);

  const base = `/licitaciones/${orgSlug}`;

  if (!resumen) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoCargando variante="tarjeta" etiqueta={t("licitaciones.resumen.cargando")} />
      </PageContainer>
    );
  }
  if (resumen.fallidas >= LECTURAS) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        <EstadoError mensaje={t("licitaciones.resumen.error")} onReintentar={() => setRecarga((n) => n + 1)} />
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
      {enlazada(to, valor === null ? <StatCard icon={icon} label={label} value="" sinDato={sinLectura} /> : <StatCard icon={icon} label={label} value={String(valor)} nota={nota} />)}
    </div>
  );

  const kpis = [
    kpi("cierran", `${base}/convocatorias`, CalendarClock, t("licitaciones.resumen.kpi.cierran", { dias: VENTANA_PLAZO_DIAS }), proximas?.length ?? null, t("licitaciones.resumen.kpi.cierranNota")),
    kpi("preparacion", `${base}/convocatorias`, FilePen, t("licitaciones.resumen.kpi.preparacion"), enPreparacion, t("licitaciones.resumen.kpi.preparacionNota")),
    kpi("recordatorios", `${base}/seguimiento`, BellRing, t("licitaciones.resumen.kpi.recordatorios"), resumen.recordatoriosPendientes, t("licitaciones.resumen.kpi.recordatoriosNota")),
    kpi("cambios", `${base}/seguimiento`, FileEdit, t("licitaciones.resumen.kpi.cambios"), resumen.cambiosPendientes, t("licitaciones.resumen.kpi.cambiosNota")),
    kpi("renovaciones", `${base}/radar-renovaciones`, Radar, t("licitaciones.resumen.kpi.renovaciones"), resumen.renovacionesPendientes, t("licitaciones.resumen.kpi.renovacionesNota")),
    kpi("aprobar", `${base}/aprobaciones`, CheckCheck, t("licitaciones.resumen.kpi.aprobar"), resumen.aprobacionesPendientes, t("licitaciones.resumen.kpi.aprobarNota")),
    kpi(
      "firmantes",
      `${base}/firmantes`,
      PenLine,
      t("licitaciones.resumen.kpi.firmantes"),
      resumen.firmantesAutorizados,
      resumen.firmantesAutorizados === 0 ? t("licitaciones.resumen.kpi.firmantesNinguno") : t("licitaciones.resumen.kpi.firmantesNota"),
    ),
    kpi(
      "fuentes",
      `${base}/fuentes`,
      Database,
      t("licitaciones.resumen.kpi.fuentes"),
      obsoletas === null || !resumen.fuentes ? null : t("licitaciones.resumen.kpi.fuentesValor", { n: obsoletas, total: resumen.fuentes.length }),
      t("licitaciones.resumen.kpi.fuentesNota"),
    ),
  ];

  const abiertasN = abiertas?.length ?? null;
  const fechaHoy = fechaLargaEnZona(ahora, resumen.zona);
  const abiertasTexto = abiertasN === null ? null : t("licitaciones.resumen.abiertas", { count: abiertasN });
  const subtitulo = abiertasTexto === null ? t("licitaciones.resumen.subtituloSinDato", { fecha: fechaHoy }) : `${fechaHoy} · ${abiertasTexto}`;

  const corridasPorFuente = resumen.conectores && resumen.corridas ? ultimaCorridaPorFuente(resumen.conectores, resumen.corridas, resumen.zona) : null;
  const corridaDeKyc = resumen.kyc?.available ? corridaKyc(resumen.kyc.lista, resumen.zona) : null;
  const corridaDeSeguimiento = resumen.avisosCreados ? corridaSeguimiento(resumen.avisosCreados, resumen.zona) : null;
  /** Con corrida real: la ficha lleva su propio "ver ficha"; sin ella, la tarjeta entera enlaza a la pantalla del agente. */
  const tarjetaCorrida = (nombre: string, href: string, c: CorridaSimple | null) =>
    c ? (
      <AgentRunCard key={nombre} nombre={nombre} estado={c.estado} meta={c.meta} href={href} />
    ) : (
      <Link key={nombre} to={href} className="block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <AgentRunCard nombre={nombre} />
      </Link>
    );
  const sinBitacora = [
    { nombre: t("licitaciones.resumen.extractor"), href: `${base}/convocatorias` },
    { nombre: t("licitaciones.resumen.junta"), href: `${base}/convocatorias` },
    { nombre: t("licitaciones.resumen.whatsapp"), href: `${base}/whatsapp` },
  ];

  const descripcionIngesta =
    resumen.fuentes === null
      ? t("licitaciones.resumen.ingestaError")
      : obsoletas === 0
        ? t("licitaciones.resumen.fuentesAlDia", { count: resumen.fuentes.length })
        : t("licitaciones.resumen.fuentesObsoletas", { count: obsoletas ?? 0, total: resumen.fuentes.length });
  const badgeIngesta =
    resumen.fuentes === null || resumen.fuentes.length === 0 ? undefined : obsoletas === 0 ? <StatusBadge tone="success">{t("licitaciones.resumen.alDia")}</StatusBadge> : <StatusBadge tone="warning">{t("licitaciones.resumen.obsoleta")}</StatusBadge>;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoEnZona(ahora, resumen.zona)}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        subtitulo={subtitulo}
        frase={
          abiertasTexto === null ? undefined : (
            <>
              {fechaHoy}: <strong>{abiertasTexto}</strong>.
            </>
          )
        }
        // El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra viaja en el subtítulo.
        destacado={<Odometro valor={abiertasN} digitos={Math.max(3, String(abiertasN ?? 0).length)} etiqueta={t("licitaciones.resumen.odometro")} tamano="md" sinDato={sinLectura} />}
        kpis={kpis}
        acciones={
          <>
            <PillLink to={`${base}/convocatorias`}>{t("licitaciones.resumen.verConvocatorias")}</PillLink>
            <PillLink to={`${base}/seguimiento`}>{t("licitaciones.resumen.verSeguimiento")}</PillLink>
          </>
        }
      >
        <ResumenSeccion titulo={t("licitaciones.resumen.orquestacion")}>
          <TileLink to={`${base}/fuentes`} icon={Database} titulo={t("licitaciones.resumen.ingesta")} badge={badgeIngesta} descripcion={descripcionIngesta} />
          <TileLink to={`${base}/convocatorias`} icon={FileSearch} titulo={t("licitaciones.resumen.extractor")} descripcion={t("licitaciones.resumen.extractorNota")} />
          <TileLink to={`${base}/convocatorias`} icon={Gavel} titulo={t("licitaciones.resumen.junta")} descripcion={t("licitaciones.resumen.juntaNota")} />
          <TileLink
            to={`${base}/seguimiento`}
            icon={Timer}
            titulo={t("licitaciones.resumen.alertas")}
            descripcion={
              resumen.recordatoriosPendientes === null || resumen.cambiosPendientes === null
                ? t("licitaciones.resumen.alertasError")
                : `${t("licitaciones.resumen.recordatoriosPendientes", { count: resumen.recordatoriosPendientes })} · ${t("licitaciones.resumen.cambiosPorRevisar", { count: resumen.cambiosPendientes })}`
            }
          />
          <TileLink to={`${base}/whatsapp`} icon={MessageCircle} titulo={t("licitaciones.resumen.whatsapp")} descripcion={t("licitaciones.resumen.whatsappNota")} />
          <TileLink to={`${base}/kyc-69b`} icon={ShieldAlert} titulo={t("licitaciones.resumen.kyc")} descripcion={t("licitaciones.resumen.kycNota")} />
          <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo={t("licitaciones.resumen.copiloto")} descripcion={t("licitaciones.resumen.copilotoNota")} />
        </ResumenSeccion>
        <ResumenSeccion titulo={t("licitaciones.resumen.ultimaCorrida")}>
          {corridasPorFuente === null ? (
            <p data-testid="corridas-sin-lectura" className="col-span-full flex items-center gap-1.5 text-xs text-muted-foreground">
              <Siren aria-hidden="true" className="size-3" strokeWidth={1.75} />
              {t("licitaciones.resumen.corridasError")}
            </p>
          ) : (
            corridasPorFuente.map((c) => <AgentRunCard key={c.source} nombre={t("licitaciones.resumen.ingestaDe", { nombre: c.nombre })} estado={c.estado} meta={c.meta} href={`${base}/fuentes`} />)
          )}
          {tarjetaCorrida(t("licitaciones.resumen.alertas"), `${base}/seguimiento`, corridaDeSeguimiento)}
          {tarjetaCorrida(t("licitaciones.resumen.kyc"), `${base}/kyc-69b`, corridaDeKyc)}
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
