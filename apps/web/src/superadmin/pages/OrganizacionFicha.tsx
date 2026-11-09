// Ficha 360 de una organizacion (SA-07), /superadmin/organizaciones/:id. Backend real: GET /superadmin/organizaciones/:id/ficha (uso, costo,
// membresias, ultimos errores, facturacion y contrato, checklist de onboarding; funciones core.get_org_ficha_for_superadmin y
// core.get_org_onboarding_for_superadmin) y GET /superadmin/organizaciones/margen (zona CFO: step-up y bitacora; se pide aparte).
// Honesto: un dato que no se pudo medir es "—" con su razon; un paso de onboarding "No se pudo medir" NO es "Pendiente". Una organizacion
// inexistente da un 404 honesto (estado vacio con enlace de regreso), no una pantalla en blanco. Un solo <h1> (PageHeader).
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Activity, Boxes, CircleDollarSign, DoorOpen, Gauge, KeyRound, MessageSquare, Mic, ShieldAlert, TrendingUp, Users } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, PageHeader, StatCard, StatusBadge, etiquetasTraducidas, statusTone, traductorActivo, useT } from "@atiende/ui";
import { waMeta } from "@atiende/ui/i18n/waMeta";
import type { StatusTone } from "@atiende/ui";
import { comun } from "@atiende/ui/i18n/comun";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminFicha } from "@atiende/ui/i18n/superadmin/ficha";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchJson } from "../lib/fetch-json.ts";
import { fetchConStepUp } from "../lib/stepup.ts";
import { BILLING_ESTADO_TONES, ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { NOMBRE_ESTADO_ORG, NOMBRE_ESTADO_PASO, NOMBRE_VERTICAL, entero, mxn, usd } from "../lib/organizaciones.ts";
import type { CampoOrg, EstadoPasoOnboarding, FichaNoDisponible, FichaOrganizacion, MargenOrg, RespuestaMargen } from "../lib/organizaciones.ts";
import { useEntrarOrganizacion } from "../components/EntrarOrganizacion.tsx";
import { EquipoOrganizacion } from "../components/EquipoOrganizacion.tsx";

type Carga = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "no_encontrada" } | { readonly estado: "ok"; readonly ficha: FichaOrganizacion | FichaNoDisponible };

const TONO_PASO: Readonly<Record<EstadoPasoOnboarding, StatusTone>> = { hecho: "success", pendiente: "warning", no_se_pudo_medir: "neutral" };

// Textos fuera de React (etiquetas de cobro, tarjetas, error de carga): siguen al idioma activo; la pagina usa `useT` y se repinta al cambiarlo.
const tr = traductorActivo(comun, superadminComun, superadminFicha);
const NOMBRE_COBRO: Readonly<Record<string, string>> = etiquetasTraducidas(["activa", "pago_pendiente", "sin_suscripcion", "cancelada"] as const, (k) => `superadmin.ficha.cobro.${k}` as const, superadminFicha);

/** Props de una StatCard a partir de un dato medible: la cifra, o "—" con su razon (`sinDato`). */
function datoCard<T>(campo: CampoOrg<T> | undefined, formato: (v: T) => string, cargando = false): { value: string; sinDato?: string } {
  if (!campo) return { value: "—", sinDato: cargando ? tr("comun.cargando") : tr("superadmin.comun.sinDatoPunto") };
  if (campo.valor === null) return { value: "—", sinDato: campo.razon ?? tr("superadmin.comun.sinDatoPunto") };
  return { value: formato(campo.valor) };
}

export function SuperAdminOrganizacionFichaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const t = useT(comun, superadminComun, superadminFicha, waMeta);
  const { id = "" } = useParams<{ id: string }>();
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [margen, setMargen] = useState<{ readonly estado: "cargando" } | { readonly estado: "listo"; readonly campo: CampoOrg<MargenOrg> }>({ estado: "cargando" });
  const { entrar, dialogo } = useEntrarOrganizacion(apiBaseUrl, token);
  const navigate = useNavigate();

  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    setMargen({ estado: "cargando" });
    const pedirFicha = (async () => {
      const res = await fetchFichaCrudo(apiBaseUrl, token, id);
      setCarga(res);
    })();
    // El margen es de la zona CFO (step-up): su rechazo solo deja esa tarjeta en "—".
    const pedirMargen = fetchJson<RespuestaMargen>(apiBaseUrl, token, "/superadmin/organizaciones/margen")
      .then((r) => setMargen({ estado: "listo", campo: r.margenes[id] ?? { valor: null, razon: r.mensaje ?? tr("superadmin.comun.sinMargen") } }))
      .catch((err: unknown) => setMargen({ estado: "listo", campo: { valor: null, razon: err instanceof Error ? err.message : tr("superadmin.comun.error.margen") } }));
    await Promise.all([pedirFicha, pedirMargen]);
  }, [apiBaseUrl, token, id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (carga.estado === "cargando") return <EstadoCargando etiqueta={t("superadmin.ficha.cargando")} />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  if (carga.estado === "no_encontrada") {
    return (
      <PageContainer padding="none">
        <PageHeader titulo={t("superadmin.ficha.noEncontrada")} atras={{ to: "/superadmin/organizaciones", etiqueta: t("superadmin.comun.organizaciones") }} />
        <EstadoVacio titulo={t("superadmin.ficha.noEncontradaTitulo")} mensaje={t("superadmin.ficha.noEncontradaMensaje")} />
      </PageContainer>
    );
  }

  const f = carga.ficha;
  const org = f.organizacion;
  const cabecera = (
    <PageHeader
      titulo={org.nombre}
      descripcion={`${NOMBRE_VERTICAL[org.vertical] ?? org.vertical} · ${org.slug}`}
      atras={{ to: "/superadmin/organizaciones", etiqueta: t("superadmin.comun.organizaciones") }}
      meta={<StatusBadge tone={statusTone(ORG_STATUS_TONES, org.estado)}>{NOMBRE_ESTADO_ORG[org.estado] ?? org.estado}</StatusBadge>}
      acciones={
        <>
          {/* Credenciales de Meta por organizacion (migracion 0090). */}
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/superadmin/organizaciones/${encodeURIComponent(org.id)}/whatsapp`)}>
            <KeyRound className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            {t("waMeta.boton.ficha")}
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => entrar({ id: org.id, nombre: org.nombre })}>
            <DoorOpen className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            {t("superadmin.comun.entrar")}
            <span className="sr-only"> {t("superadmin.comun.srA", { nombre: org.nombre })}</span>
          </Button>
        </>
      }
    />
  );

  if (!f.disponible) {
    return (
      <PageContainer padding="none" className="[&>*]:min-w-0">
        {cabecera}
        <Callout tone="warning" role="status">
          {f.mensaje}
        </Callout>
        {/* El equipo tiene su propia fuente: se puede dar de alta aunque las metricas de la ficha no esten disponibles. */}
        <EquipoOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />
        {dialogo}
      </PageContainer>
    );
  }

  const margenCampo = margen.estado === "listo" ? margen.campo : undefined;
  const hechos = f.onboarding.filter((p) => p.estado === "hecho").length;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      {cabecera}

      <section aria-labelledby="ficha-uso" className="grid gap-2.5">
        <h2 id="ficha-uso" className="text-ui font-semibold uppercase tracking-wide text-muted-foreground">
          {t("superadmin.ficha.uso")}
        </h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <StatCard variante="neutra" icon={Activity} label={t("superadmin.ficha.operaciones")} {...datoCard(f.uso.operaciones30d, entero)} />
          <StatCard variante="neutra" icon={MessageSquare} label={t("superadmin.ficha.conversaciones")} {...datoCard(f.uso.conversaciones30d, entero)} />
          <StatCard variante="neutra" icon={Mic} label={t("superadmin.ficha.minutosVoz")} {...datoCard(f.uso.minutosVoz30d, (v) => entero(Math.round(v)))} />
        </div>
      </section>

      <section aria-labelledby="ficha-costo" className="grid gap-2.5">
        <h2 id="ficha-costo" className="text-ui font-semibold uppercase tracking-wide text-muted-foreground">
          {t("superadmin.ficha.costo")}
        </h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <StatCard variante="neutra" icon={CircleDollarSign} label={t("superadmin.ficha.costoIa")} {...datoCard(f.costo.llm30dUsd, usd)} />
          <StatCard variante="neutra" icon={Gauge} label={t("superadmin.ficha.costoEvento")} nota={t("superadmin.ficha.costoEventoNota")} {...datoCard(f.costo.costoPorEventoUsd, usd)} />
          <StatCard
            variante="neutra"
            icon={TrendingUp}
            label={t("superadmin.ficha.margen", { mes: f.mes })}
            {...datoCard(margenCampo, (m) => `${mxn(m.mxn)} (${Math.round(m.pct)}%)`, true)}
            nota={margenCampo?.valor ? t("superadmin.ficha.ingresoEsperado", { monto: mxn(margenCampo.valor.ingresoMxn) }) : undefined}
          />
        </div>
      </section>

      <EquipoOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />

      <div className="grid gap-2.5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {t("superadmin.ficha.membresias")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {f.membresias.porRol.length === 0 ? (
              <p className="text-ui text-muted-foreground">{t("superadmin.ficha.sinPersonasOrg")}</p>
            ) : (
              <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.ficha.staffPorRol")}>
                {f.membresias.porRol.map((r) => (
                  <li key={r.rol} className="flex items-center justify-between py-1.5 text-ui">
                    <span className="text-foreground">{r.rol}</span>
                    <span className="tabular-nums text-muted-foreground">{r.cantidad}</span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("superadmin.ficha.ultimosAccesos")}</p>
              {f.membresias.ultimosAccesos.valor === null ? (
                <p className="text-ui text-muted-foreground">— {f.membresias.ultimosAccesos.razon}</p>
              ) : f.membresias.ultimosAccesos.valor.length === 0 ? (
                <p className="text-ui text-muted-foreground">{t("superadmin.ficha.sinPersonas")}</p>
              ) : (
                <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.ficha.ultimosAccesos")}>
                  {f.membresias.ultimosAccesos.valor.map((a, i) => (
                    <li key={`${a.rol}-${i}`} className="flex items-center justify-between py-1.5 text-ui">
                      <span className="text-foreground">{a.rol}</span>
                      <span className="text-muted-foreground">{a.ultimoAcceso ? fechaHoraEsMx(a.ultimoAcceso) : t("superadmin.ficha.sinSesion")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {t("superadmin.ficha.ultimosErrores")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <StatCard variante="neutra" icon={Boxes} label={t("superadmin.ficha.outbox")} {...datoCard(f.errores.outboxMuerto, entero)} />
              <StatCard variante="neutra" icon={ShieldAlert} label={t("superadmin.ficha.denegados")} {...datoCard(f.errores.denegaciones30d, entero)} />
            </div>
            {f.errores.denegaciones30d.ultimas.length > 0 && (
              <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.ficha.ultimasDenegaciones")}>
                {f.errores.denegaciones30d.ultimas.map((d, i) => (
                  <li key={`${d.ruta}-${d.cuando}-${i}`} className="flex items-center justify-between gap-3 py-1.5 text-ui">
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">{d.ruta}</span>
                    <span className="shrink-0 text-muted-foreground">{fechaHoraEsMx(d.cuando)}</span>
                  </li>
                ))}
              </ul>
            )}
            {/* // i18n-ignorar: «Crons» se dice igual en ingles; la razon es del servidor */}
            <p className="text-xs text-faint">Crons: — {f.errores.crons.razon}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("superadmin.ficha.facturacion")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-ui">
              <dt className="text-muted-foreground">{t("superadmin.comun.col.plan")}</dt>
              <dd className="text-foreground">{f.facturacion.plan ? f.facturacion.plan.nombre : t("superadmin.ficha.sinPlan")}</dd>
              <dt className="text-muted-foreground">{t("superadmin.ficha.cobro")}</dt>
              <dd>
                {f.facturacion.cobro ? (
                  <StatusBadge tone={statusTone(BILLING_ESTADO_TONES, f.facturacion.cobro.estado)}>{NOMBRE_COBRO[f.facturacion.cobro.estado] ?? f.facturacion.cobro.estado}</StatusBadge>
                ) : (
                  <span className="text-muted-foreground">{t("superadmin.ficha.sinCobro")}</span>
                )}
              </dd>
              {f.facturacion.cobro?.periodoHasta && (
                <>
                  <dt className="text-muted-foreground">{t("superadmin.ficha.periodoHasta")}</dt>
                  <dd className="text-foreground">{fechaHoraEsMx(f.facturacion.cobro.periodoHasta)}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t("superadmin.ficha.contratoVigente")}</dt>
              <dd className="text-foreground">{f.facturacion.contrato ? t("superadmin.ficha.version", { v: String(f.facturacion.contrato.version ?? "—") }) : t("superadmin.ficha.sinContrato")}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              {/* // i18n-ignorar: «Onboarding» se dice igual en ingles */}
              Onboarding · {hechos}/{f.onboarding.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-dashed divide-line2" aria-label={t("superadmin.ficha.checklist")}>
              {f.onboarding.map((p) => (
                <li key={p.paso} className="flex items-start justify-between gap-3 py-1.5 text-ui" data-paso={p.paso} data-estado={p.estado}>
                  <span className="min-w-0">
                    <span className="block text-foreground">{p.titulo}</span>
                    {p.estado === "no_se_pudo_medir" && p.razonTexto && <span className="block text-xs text-muted-foreground">{p.razonTexto}</span>}
                  </span>
                  <StatusBadge tone={TONO_PASO[p.estado]}>{NOMBRE_ESTADO_PASO[p.estado]}</StatusBadge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {dialogo}
    </PageContainer>
  );
}

/** GET de la ficha distinguiendo el 404 honesto (organizacion inexistente) del resto de fallos. */
async function fetchFichaCrudo(apiBaseUrl: string, token: string, id: string): Promise<Carga> {
  try {
    const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}/superadmin/organizaciones/${encodeURIComponent(id)}/ficha`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404) return { estado: "no_encontrada" };
    if (!res.ok) return { estado: "error", mensaje: tr("superadmin.ficha.error") };
    return { estado: "ok", ficha: (await res.json()) as FichaOrganizacion | FichaNoDisponible };
  } catch {
    return { estado: "error", mensaje: tr("superadmin.ficha.error") };
  }
}
