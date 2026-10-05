// Ficha 360 de una organizacion (SA-07), /superadmin/organizaciones/:id. Backend real: GET /superadmin/organizaciones/:id/ficha (uso, costo,
// membresias, ultimos errores, facturacion y contrato, checklist de onboarding; funciones core.get_org_ficha_for_superadmin y
// core.get_org_onboarding_for_superadmin) y GET /superadmin/organizaciones/margen (zona CFO: step-up y bitacora; se pide aparte).
// Honesto: un dato que no se pudo medir es "—" con su razon; un paso de onboarding "No se pudo medir" NO es "Pendiente". Una organizacion
// inexistente da un 404 honesto (estado vacio con enlace de regreso), no una pantalla en blanco. Un solo <h1> (PageHeader).
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Activity, Boxes, CircleDollarSign, DoorOpen, Gauge, MessageSquare, Mic, ShieldAlert, TrendingUp, Users } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, PageContainer, PageHeader, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, statusTone } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { fetchJson } from "../lib/fetch-json.ts";
import { fetchConStepUp } from "../lib/stepup.ts";
import { BILLING_ESTADO_TONES, ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { NOMBRE_ESTADO_ORG, NOMBRE_ESTADO_PASO, NOMBRE_VERTICAL, entero, mxn, usd } from "../lib/organizaciones.ts";
import type { CampoOrg, EstadoPasoOnboarding, FichaNoDisponible, FichaOrganizacion, MargenOrg, RespuestaMargen } from "../lib/organizaciones.ts";
import { useEntrarOrganizacion } from "../components/EntrarOrganizacion.tsx";
import { EquipoOrganizacion } from "../components/EquipoOrganizacion.tsx";
import { PreflightOrganizacion } from "../components/PreflightOrganizacion.tsx";

type Carga = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "no_encontrada" } | { readonly estado: "ok"; readonly ficha: FichaOrganizacion | FichaNoDisponible };

const TONO_PASO: Readonly<Record<EstadoPasoOnboarding, StatusTone>> = { hecho: "success", pendiente: "warning", no_se_pudo_medir: "neutral" };

const NOMBRE_COBRO: Readonly<Record<string, string>> = { activa: "Activa", pago_pendiente: "Pago pendiente", sin_suscripcion: "Sin suscripción", cancelada: "Cancelada" };

/** Props de una StatCard a partir de un dato medible: la cifra, o "—" con su razon (`sinDato`). */
function datoCard<T>(campo: CampoOrg<T> | undefined, formato: (v: T) => string, cargando = false): { value: string; sinDato?: string } {
  if (!campo) return { value: "—", sinDato: cargando ? "Cargando…" : "Sin dato." };
  if (campo.valor === null) return { value: "—", sinDato: campo.razon ?? "Sin dato." };
  return { value: formato(campo.valor) };
}

export function SuperAdminOrganizacionFichaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const { id = "" } = useParams<{ id: string }>();
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [margen, setMargen] = useState<{ readonly estado: "cargando" } | { readonly estado: "listo"; readonly campo: CampoOrg<MargenOrg> }>({ estado: "cargando" });
  const { entrar, dialogo } = useEntrarOrganizacion(apiBaseUrl, token);

  const cargar = useCallback(async () => {
    setCarga({ estado: "cargando" });
    setMargen({ estado: "cargando" });
    const pedirFicha = (async () => {
      const res = await fetchFichaCrudo(apiBaseUrl, token, id);
      setCarga(res);
    })();
    // El margen es de la zona CFO (step-up): su rechazo solo deja esa tarjeta en "—".
    const pedirMargen = fetchJson<RespuestaMargen>(apiBaseUrl, token, "/superadmin/organizaciones/margen")
      .then((r) => setMargen({ estado: "listo", campo: r.margenes[id] ?? { valor: null, razon: r.mensaje ?? "Sin margen para esta organización." } }))
      .catch((err: unknown) => setMargen({ estado: "listo", campo: { valor: null, razon: err instanceof Error ? err.message : "No se pudo leer el margen." } }));
    await Promise.all([pedirFicha, pedirMargen]);
  }, [apiBaseUrl, token, id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (carga.estado === "cargando") return <EstadoCargando etiqueta="Cargando la ficha…" />;
  if (carga.estado === "error") return <EstadoError mensaje={carga.mensaje} onReintentar={() => void cargar()} />;
  if (carga.estado === "no_encontrada") {
    return (
      <PageContainer padding="none">
        <PageHeader titulo="Organización no encontrada" atras={{ to: "/superadmin/organizaciones", etiqueta: "Organizaciones" }} />
        <EstadoVacio titulo="No encontramos esta organización" mensaje="Puede que se haya eliminado o que el enlace sea incorrecto." />
      </PageContainer>
    );
  }

  const f = carga.ficha;
  const org = f.organizacion;
  const cabecera = (
    <PageHeader
      titulo={org.nombre}
      descripcion={`${NOMBRE_VERTICAL[org.vertical] ?? org.vertical} · ${org.slug}`}
      atras={{ to: "/superadmin/organizaciones", etiqueta: "Organizaciones" }}
      meta={<StatusBadge tone={statusTone(ORG_STATUS_TONES, org.estado)}>{NOMBRE_ESTADO_ORG[org.estado] ?? org.estado}</StatusBadge>}
      acciones={
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => entrar({ id: org.id, nombre: org.nombre })}>
          <DoorOpen className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          Entrar
          <span className="sr-only"> a {org.nombre}</span>
        </Button>
      }
    />
  );

  if (!f.disponible) {
    return (
      <PageContainer padding="none" className="[&>*]:min-w-0">
        {cabecera}
        <Tabs defaultValue="resumen">
          <TabsList>
            <TabsTrigger value="resumen">Resumen</TabsTrigger>
            <TabsTrigger value="listo">Listo para producción</TabsTrigger>
          </TabsList>
          <TabsContent value="resumen" className="grid gap-2.5">
            <Callout tone="warning" role="status">
              {f.mensaje}
            </Callout>
            {/* El equipo tiene su propia fuente: se puede dar de alta aunque las metricas de la ficha no esten disponibles. */}
            <EquipoOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />
          </TabsContent>
          {/* El preflight tiene sus propias fuentes: tambien se puede verificar con la ficha sin migrar. */}
          <TabsContent value="listo">
            <PreflightOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />
          </TabsContent>
        </Tabs>
        {dialogo}
      </PageContainer>
    );
  }

  const margenCampo = margen.estado === "listo" ? margen.campo : undefined;
  const hechos = f.onboarding.filter((p) => p.estado === "hecho").length;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      {cabecera}

      <Tabs defaultValue="resumen">
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="listo">Listo para producción</TabsTrigger>
        </TabsList>
        <TabsContent value="resumen" className="grid gap-2.5 [&>*]:min-w-0">
          <section aria-labelledby="ficha-uso" className="grid gap-2.5">
            <h2 id="ficha-uso" className="text-ui font-semibold uppercase tracking-wide text-muted-foreground">
              Uso · últimos 30 días
            </h2>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <StatCard variante="neutra" icon={Activity} label="Operaciones" {...datoCard(f.uso.operaciones30d, entero)} />
              <StatCard variante="neutra" icon={MessageSquare} label="Conversaciones" {...datoCard(f.uso.conversaciones30d, entero)} />
              <StatCard variante="neutra" icon={Mic} label="Minutos de voz" {...datoCard(f.uso.minutosVoz30d, (v) => entero(Math.round(v)))} />
            </div>
          </section>

          <section aria-labelledby="ficha-costo" className="grid gap-2.5">
            <h2 id="ficha-costo" className="text-ui font-semibold uppercase tracking-wide text-muted-foreground">
              Costo
            </h2>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <StatCard variante="neutra" icon={CircleDollarSign} label="Costo de IA · 30 d" {...datoCard(f.costo.llm30dUsd, usd)} />
              <StatCard variante="neutra" icon={Gauge} label="Costo por evento" nota="Voz, WhatsApp y otros · 30 d" {...datoCard(f.costo.costoPorEventoUsd, usd)} />
              <StatCard
                variante="neutra"
                icon={TrendingUp}
                label={`Margen · ${f.mes}`}
                {...datoCard(margenCampo, (m) => `${mxn(m.mxn)} (${Math.round(m.pct)}%)`, true)}
                nota={margenCampo?.valor ? `Ingreso esperado ${mxn(margenCampo.valor.ingresoMxn)}` : undefined}
              />
            </div>
          </section>

          <EquipoOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />

          <div className="grid gap-2.5 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  Membresías
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {f.membresias.porRol.length === 0 ? (
                  <p className="text-ui text-muted-foreground">Esta organización no tiene personas con acceso.</p>
                ) : (
                  <ul className="divide-y divide-dashed divide-line2" aria-label="Staff por rol">
                    {f.membresias.porRol.map((r) => (
                      <li key={r.rol} className="flex items-center justify-between py-1.5 text-ui">
                        <span className="text-foreground">{r.rol}</span>
                        <span className="tabular-nums text-muted-foreground">{r.cantidad}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Últimos accesos</p>
                  {f.membresias.ultimosAccesos.valor === null ? (
                    <p className="text-ui text-muted-foreground">— {f.membresias.ultimosAccesos.razon}</p>
                  ) : f.membresias.ultimosAccesos.valor.length === 0 ? (
                    <p className="text-ui text-muted-foreground">Sin personas con acceso.</p>
                  ) : (
                    <ul className="divide-y divide-dashed divide-line2" aria-label="Últimos accesos">
                      {f.membresias.ultimosAccesos.valor.map((a, i) => (
                        <li key={`${a.rol}-${i}`} className="flex items-center justify-between py-1.5 text-ui">
                          <span className="text-foreground">{a.rol}</span>
                          <span className="text-muted-foreground">{a.ultimoAcceso ? fechaHoraEsMx(a.ultimoAcceso) : "Sin sesión registrada"}</span>
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
                  Últimos errores
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <StatCard variante="neutra" icon={Boxes} label="Outbox muerto" {...datoCard(f.errores.outboxMuerto, entero)} />
                  <StatCard variante="neutra" icon={ShieldAlert} label="Accesos denegados · 30 d" {...datoCard(f.errores.denegaciones30d, entero)} />
                </div>
                {f.errores.denegaciones30d.ultimas.length > 0 && (
                  <ul className="divide-y divide-dashed divide-line2" aria-label="Últimas denegaciones">
                    {f.errores.denegaciones30d.ultimas.map((d, i) => (
                      <li key={`${d.ruta}-${d.cuando}-${i}`} className="flex items-center justify-between gap-3 py-1.5 text-ui">
                        <span className="min-w-0 truncate font-mono text-xs text-foreground">{d.ruta}</span>
                        <span className="shrink-0 text-muted-foreground">{fechaHoraEsMx(d.cuando)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-faint">Crons: — {f.errores.crons.razon}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-2.5 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Facturación y contrato</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-ui">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd className="text-foreground">{f.facturacion.plan ? f.facturacion.plan.nombre : "Sin plan asignado"}</dd>
                  <dt className="text-muted-foreground">Cobro</dt>
                  <dd>
                    {f.facturacion.cobro ? (
                      <StatusBadge tone={statusTone(BILLING_ESTADO_TONES, f.facturacion.cobro.estado)}>{NOMBRE_COBRO[f.facturacion.cobro.estado] ?? f.facturacion.cobro.estado}</StatusBadge>
                    ) : (
                      <span className="text-muted-foreground">Sin registro de cobro</span>
                    )}
                  </dd>
                  {f.facturacion.cobro?.periodoHasta && (
                    <>
                      <dt className="text-muted-foreground">Periodo hasta</dt>
                      <dd className="text-foreground">{fechaHoraEsMx(f.facturacion.cobro.periodoHasta)}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Contrato vigente</dt>
                  <dd className="text-foreground">{f.facturacion.contrato ? `Versión ${f.facturacion.contrato.version ?? "—"}` : "Sin contrato vigente"}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>
                  Onboarding · {hechos}/{f.onboarding.length}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-dashed divide-line2" aria-label="Checklist de onboarding">
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
        </TabsContent>
        <TabsContent value="listo">
          <PreflightOrganizacion apiBaseUrl={apiBaseUrl} token={token} organizacionId={org.id} />
        </TabsContent>
      </Tabs>
      {dialogo}
    </PageContainer>
  );
}

/** GET de la ficha distinguiendo el 404 honesto (organizacion inexistente) del resto de fallos. */
async function fetchFichaCrudo(apiBaseUrl: string, token: string, id: string): Promise<Carga> {
  try {
    const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}/superadmin/organizaciones/${encodeURIComponent(id)}/ficha`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404) return { estado: "no_encontrada" };
    if (!res.ok) return { estado: "error", mensaje: "No se pudo cargar la ficha de la organización." };
    return { estado: "ok", ficha: (await res.json()) as FichaOrganizacion | FichaNoDisponible };
  } catch {
    return { estado: "error", mensaje: "No se pudo cargar la ficha de la organización." };
  }
}
