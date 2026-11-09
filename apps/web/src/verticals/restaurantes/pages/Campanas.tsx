// Campanas de reactivacion de clientes inactivos (autopiloto 2, migracion 052). Solo owner/admin con alcance a TODA la organizacion.
// El agente arma un BORRADOR por segmento (clientes CON consentimiento que llevan 30/60/90 dias sin pedir, la promocion vigente y el costo
// estimado de Meta); NADA se envia hasta que la persona aprueba con un clic. Rechazar o ignorar no envia nada. Estado honesto cuando falta un
// requisito (tarifa, plantilla aprobada de Meta, WhatsApp conectado, promocion vigente): se dice "requiere X", jamas se finge que funciona.
// Todo viene del API real; sin datos inventados. Sin telefonos ni nombres de clientes en pantalla.
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, Megaphone } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, PageContainer, PageHeader, StatCard, StatusBadge, etiquetasTraducidas, notify, useConfirm, useT } from "@atiende/ui";
import { restaurantesCampanas } from "@atiende/ui/i18n/restaurantes/campanas";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { decidirCampana, ETIQUETA_SEGMENTO, fetchMarketing, guardarConfigMarketing, recompraIncremental } from "../lib/marketing-client.ts";
import type { CampanaMarketing, ConfigMarketing, EstadoCampana, PanelMarketing } from "../lib/marketing-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoMxn, pesosACentavos } from "../voz/formato-kpi.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_CAMPANAS: ReadonlySet<string> = new Set(["owner", "admin"]);
// Codigos de rol y nombre tecnico de plantilla de Meta: se muestran tal cual en los dos idiomas (no son texto de interfaz).
const ROL_OWNER = "owner";
const ROL_ADMIN = "admin";
const PLANTILLA_EJEMPLO = "reactivacion_promo";

const TONO_ESTADO: Readonly<Record<EstadoCampana, "info" | "success" | "neutral" | "warning">> = { borrador: "info", aprobada: "success", rechazada: "neutral", expirada: "warning" };
const ETIQUETA_ESTADO: Readonly<Record<EstadoCampana, string>> = etiquetasTraducidas<EstadoCampana>(
  ["borrador", "aprobada", "rechazada", "expirada"],
  (e) => `restaurantes.campanas.estado.${e}` as const,
  restaurantesCampanas,
);

function centavosAPesos(c: number | null): string {
  return c === null ? "" : (c / 100).toFixed(2);
}

/** Fecha y hora de creacion en la zona del negocio (formateador canonico de lib/formato-fecha.ts). */
function fecha(iso: string): string {
  return fechaHoraEsMx(iso, "America/Merida");
}

export function CampanasPage({ apiBaseUrl, token, propertyId, role, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const t = useT(restaurantesCampanas);
  const puedeVer = ROLES_CAMPANAS.has(role);
  const f = fetchImpl ?? fetch;
  const [datos, setDatos] = useState<Carga<PanelMarketing>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const [decidiendo, setDecidiendo] = useState<string | null>(null);
  const { confirmar, dialogo } = useConfirm();
  const recargar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setDatos({ estado: "cargando" });
    (async () => {
      try {
        const panel = await fetchMarketing(f, apiBaseUrl, token, propertyId);
        if (!cancelado) setDatos({ estado: "listo", datos: panel });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, t("restaurantes.campanas.error.cargar")));
      }
    })();
    return () => {
      cancelado = true;
    };
    // `f` cambia de identidad solo si cambia fetchImpl (prop de prueba).
  }, [apiBaseUrl, token, propertyId, version, puedeVer, f]);

  async function decidir(c: CampanaMarketing, accion: "aprobar" | "rechazar") {
    if (accion === "aprobar") {
      const ok = await confirmar({
        titulo: t("restaurantes.campanas.aprobarTitulo"),
        descripcion: t("restaurantes.campanas.aprobarDesc", { codigo: c.promoCodigo, conteo: c.conteo, costo: formatoMxn(c.costoEstimadoCentavos) }),
        confirmar: t("restaurantes.campanas.aprobarEnviar"),
        cancelar: t("restaurantes.campanas.volver"),
      });
      if (!ok) return;
    }
    setDecidiendo(c.id);
    try {
      const r = await decidirCampana(f, apiBaseUrl, token, propertyId, c.id, accion);
      notify.success(r.estado === "aprobada" ? t("restaurantes.campanas.aprobada", { n: r.encolados }) : t("restaurantes.campanas.rechazada"));
      recargar();
    } catch (err) {
      // El servidor responde "requiere X" (tarifa, plantilla aprobada, WhatsApp conectado, tope mensual): se muestra tal cual.
      notify.error(err instanceof Error ? err.message : t("restaurantes.campanas.error.decision"));
    } finally {
      setDecidiendo(null);
    }
  }

  return (
    <PageContainer padding="none">
      <PageHeader titulo={t("restaurantes.campanas.titulo")} descripcion={t("restaurantes.campanas.subtitulo")} />

      {!puedeVer ? (
        <Callout tone="info">
          {t("restaurantes.campanas.soloRoles.antes")}<strong className="text-foreground">{ROL_OWNER}</strong>/<strong className="text-foreground">{ROL_ADMIN}</strong>{t("restaurantes.campanas.soloRoles.despues")}<strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : datos.estado === "cargando" ? (
        <EstadoCargando etiqueta={t("restaurantes.campanas.cargando")} />
      ) : datos.estado === "no_disponible" ? (
        <EstadoVacio
          icon={Megaphone}
          titulo={t("restaurantes.campanas.noDisponibleTitulo")}
          mensaje={t("restaurantes.campanas.noDisponible")}
        />
      ) : datos.estado === "error" ? (
        <EstadoError mensaje={datos.mensaje} onReintentar={recargar} />
      ) : (
        <Contenido panel={datos.datos} decidiendo={decidiendo} onDecidir={decidir} onGuardado={recargar} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={f} />
      )}
      {dialogo}
    </PageContainer>
  );
}

function Requisito({ cumplido, texto, falta }: { readonly cumplido: boolean; readonly texto: string; readonly falta: string }) {
  const Icono = cumplido ? CircleCheck : CircleX;
  return (
    <li className="flex items-start gap-1.5 text-sm" data-requisito={cumplido ? "ok" : "falta"}>
      <Icono className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cumplido ? "text-success" : "text-warning"}`} strokeWidth={1.75} aria-hidden />
      <span>{cumplido ? texto : falta}</span>
    </li>
  );
}

function Contenido({
  panel,
  decidiendo,
  onDecidir,
  onGuardado,
  apiBaseUrl,
  token,
  propertyId,
  fetchImpl,
}: {
  readonly panel: PanelMarketing;
  readonly decidiendo: string | null;
  readonly onDecidir: (c: CampanaMarketing, accion: "aprobar" | "rechazar") => void;
  readonly onGuardado: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl: typeof fetch;
}) {
  const { config, campanas } = panel;
  const t = useT(restaurantesCampanas);
  const requisitosOk = config.tarifaCentavos !== null && config.plantillaAprobada && config.whatsappConectado;
  return (
    <div className="space-y-2.5" data-testid="campanas">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={Megaphone} label={t("restaurantes.campanas.kpi.consentimiento")} value={String(config.consentimientosVigentes)} nota={t("restaurantes.campanas.kpi.consentimientoNota")} />
        <StatCard icon={Megaphone} label={t("restaurantes.campanas.kpi.gastado")} value={formatoMxn(config.gastadoMesCentavos)} nota={config.topeMensualCentavos === null ? t("restaurantes.campanas.kpi.sinTope") : t("restaurantes.campanas.kpi.tope", { monto: formatoMxn(config.topeMensualCentavos) })} />
        <StatCard icon={Megaphone} label={t("restaurantes.campanas.kpi.porAprobar")} value={String(campanas.filter((c) => c.estado === "borrador").length)} nota={t("restaurantes.campanas.kpi.porAprobarNota")} />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{t("restaurantes.campanas.requisitos")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 p-3 pt-0">
          <ul className="m-0 list-none space-y-1 p-0">
            <Requisito cumplido={config.activo} texto={t("restaurantes.campanas.req.activas")} falta={t("restaurantes.campanas.req.activasFalta")} />
            <Requisito cumplido={config.hayPromocionVigente} texto={t("restaurantes.campanas.req.promo")} falta={t("restaurantes.campanas.req.promoFalta")} />
            <Requisito cumplido={config.tarifaCentavos !== null} texto={t("restaurantes.campanas.req.tarifa", { monto: formatoMxn(config.tarifaCentavos) })} falta={t("restaurantes.campanas.req.tarifaFalta")} />
            <Requisito cumplido={config.plantillaAprobada} texto={t("restaurantes.campanas.req.plantilla", { nombre: config.plantillaNombre ?? "" })} falta={t("restaurantes.campanas.req.plantillaFalta")} />
            <Requisito cumplido={config.whatsappConectado} texto={t("restaurantes.campanas.req.whatsapp")} falta={t("restaurantes.campanas.req.whatsappFalta")} />
          </ul>
          {!requisitosOk ? (
            <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.campanas.req.mientras")}</p>
          ) : null}
        </CardContent>
      </Card>

      <ConfigForm config={config} onGuardado={onGuardado} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} />

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{t("restaurantes.campanas.titulo")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CampanaMarketing>
            etiqueta={t("restaurantes.campanas.tabla")}
            filas={[...campanas]}
            obtenerId={(c) => c.id}
            atributosFila={(c) => ({ "data-campana": c.id, "data-estado": c.estado })}
            vacio={{ titulo: t("restaurantes.campanas.sinCampanas"), mensaje: t("restaurantes.campanas.sinCampanasMensaje") }}
            paginacion={false}
            columnas={[
              { id: "segmento", encabezado: t("restaurantes.campanas.col.segmento"), principal: true, celda: (c) => ETIQUETA_SEGMENTO[c.segmento] },
              { id: "estado", encabezado: t("restaurantes.campanas.col.estado"), celda: (c) => <StatusBadge tone={TONO_ESTADO[c.estado]}>{ETIQUETA_ESTADO[c.estado]}</StatusBadge> },
              { id: "promo", encabezado: t("restaurantes.campanas.col.promo"), celda: (c) => `${c.promoNombre} (${c.promoCodigo})` },
              { id: "clientes", encabezado: t("restaurantes.campanas.col.clientes"), alinear: "right", className: "tabular-nums", celda: (c) => (c.estado === "aprobada" ? (c.encolados ?? 0) : c.conteo) },
              { id: "costo", encabezado: t("restaurantes.campanas.col.costo"), alinear: "right", className: "tabular-nums", celda: (c) => formatoMxn(c.costoEstimadoCentavos) },
              { id: "creada", encabezado: t("restaurantes.campanas.col.creada"), alinear: "right", celda: (c) => fecha(c.creadaAt) },
              {
                id: "resultado",
                encabezado: t("restaurantes.campanas.col.recompra"),
                celda: (c) => <Resultado c={c} />,
              },
              {
                id: "acciones",
                encabezado: "",
                alinear: "right",
                celda: (c) =>
                  c.estado === "borrador" ? (
                    <div className="flex justify-end gap-1.5">
                      <Button type="button" size="sm" variant="outline" disabled={decidiendo !== null} onClick={() => onDecidir(c, "rechazar")} aria-label={t("restaurantes.campanas.rechazarAria", { segmento: ETIQUETA_SEGMENTO[c.segmento] })}>
                        {t("restaurantes.campanas.rechazar")}
                      </Button>
                      <Button type="button" size="sm" loading={decidiendo === c.id} disabled={decidiendo !== null} onClick={() => onDecidir(c, "aprobar")} aria-label={t("restaurantes.campanas.aprobarAria", { segmento: ETIQUETA_SEGMENTO[c.segmento] })}>
                        {t("restaurantes.campanas.aprobar")}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Resultado({ c }: { readonly c: CampanaMarketing }) {
  const t = useT(restaurantesCampanas);
  if (c.estado !== "aprobada") return <span className="text-muted-foreground">—</span>;
  const inc = recompraIncremental(c);
  const tratados = t("restaurantes.campanas.res.tratados", { recompra: c.recompraTratados, total: c.encolados ?? 0 });
  const control = t("restaurantes.campanas.res.control", { recompra: c.recompraControl, total: c.conteoControl });
  return (
    <div className="text-xs" data-testid={`resultado-${c.id}`}>
      <div>{tratados}</div>
      <div className="text-muted-foreground">{control}</div>
      <div className="font-medium">{inc === null ? t(c.ventanaCerrada ? "restaurantes.campanas.res.sinControl" : "restaurantes.campanas.res.enCurso") : t("restaurantes.campanas.res.incremental", { signo: inc > 0 ? "+" : "", puntos: inc })}</div>
    </div>
  );
}

function ConfigForm({
  config,
  onGuardado,
  apiBaseUrl,
  token,
  propertyId,
  fetchImpl,
}: {
  readonly config: ConfigMarketing;
  readonly onGuardado: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly fetchImpl: typeof fetch;
}) {
  const t = useT(restaurantesCampanas);
  const [activo, setActivo] = useState(config.activo);
  const [tarifa, setTarifa] = useState(centavosAPesos(config.tarifaCentavos));
  const [tope, setTope] = useState(centavosAPesos(config.topeMensualCentavos));
  const [minimo, setMinimo] = useState(String(config.minimoSegmento));
  const [plantilla, setPlantilla] = useState(config.plantillaNombre ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const tarifaCentavos = pesosACentavos(tarifa);
    const topeCentavos = pesosACentavos(tope);
    const minimoN = Number(minimo);
    if (tarifaCentavos === undefined || (tarifaCentavos !== null && tarifaCentavos > 10000)) return setError(t("restaurantes.campanas.cfg.errorTarifa"));
    if (topeCentavos === undefined) return setError(t("restaurantes.campanas.cfg.errorTope"));
    if (!Number.isInteger(minimoN) || minimoN < 1 || minimoN > 10000) return setError(t("restaurantes.campanas.cfg.errorMinimo"));
    if (plantilla.trim() !== "" && !/^[a-z0-9_]{1,255}$/.test(plantilla.trim())) return setError(t("restaurantes.campanas.cfg.errorPlantilla"));
    setError(null);
    setGuardando(true);
    try {
      await guardarConfigMarketing(fetchImpl, apiBaseUrl, token, propertyId, { activo, tarifaCentavos, topeMensualCentavos: topeCentavos, minimoSegmento: minimoN, plantillaNombre: plantilla.trim() === "" ? null : plantilla.trim(), plantillaIdioma: config.plantillaIdioma });
      notify.success(t("restaurantes.campanas.cfg.guardada"));
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.campanas.cfg.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle>{t("restaurantes.campanas.cfg.titulo")}</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <form onSubmit={guardar} className="space-y-2.5" data-testid="campanas-config">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={activo} onChange={(e) => setActivo(e.target.checked)} aria-label={t("restaurantes.campanas.cfg.activarAria")} />
            <span>{t("restaurantes.campanas.cfg.activar")}</span>
          </label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <FormField label={t("restaurantes.campanas.cfg.tarifa")}>{(p) => <Input {...p} inputMode="decimal" value={tarifa} onChange={(e) => setTarifa(e.target.value)} placeholder="0.80" />}</FormField>
            <FormField label={t("restaurantes.campanas.cfg.tope")}>{(p) => <Input {...p} inputMode="decimal" value={tope} onChange={(e) => setTope(e.target.value)} placeholder={t("restaurantes.campanas.cfg.sinTope")} />}</FormField>
            <FormField label={t("restaurantes.campanas.cfg.minimo")}>{(p) => <Input {...p} inputMode="numeric" value={minimo} onChange={(e) => setMinimo(e.target.value)} />}</FormField>
            <FormField label={t("restaurantes.campanas.cfg.plantilla")}>{(p) => <Input {...p} value={plantilla} onChange={(e) => setPlantilla(e.target.value)} placeholder={PLANTILLA_EJEMPLO}
 />}</FormField>
          </div>
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <Button type="submit" size="sm" loading={guardando}>
            {t("restaurantes.campanas.cfg.guardar")}

          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
