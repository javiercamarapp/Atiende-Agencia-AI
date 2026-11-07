// KPI del Resumen del agente de voz (como el original: pedidos completados, participacion, cancelacion, llamadas, escalacion y concurrencia),
// con datos reales: pedidos por canal (kpis/channels, ultimos 30 dias) y telemetria de llamadas (voz/kpi, mes en curso). Lo que no existe
// se dice como «no disponible aun: requiere X»; nunca una cifra inventada. Las metas son referencias fijas de producto, no datos.
import { useCallback, useEffect, useState } from "react";
import { Ban, Headset, PhoneCall, Radio, ShoppingBag, Share2 } from "lucide-react";
import { Button, EstadoCargando, EstadoError, StatCard, localeActivo, useT } from "@atiende/ui";
import { restaurantesIndicadoresVoz } from "@atiende/ui/i18n/restaurantes/indicadoresVoz";
import { fetchChannelKpis } from "../dashboard-client.ts";
import type { ChannelKpis } from "../dashboard-client.ts";
import { fetchVozKpi } from "../lib/voz-kpi-client.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import type { VozKpi } from "../lib/voz-kpi-client.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";

/** Telemetria de llamadas: datos, aun no activa en la base, sin permiso (solo owner/admin) o error real (con Reintentar). */
type EstadoVoz =
  | { readonly tipo: "datos"; readonly kpi: VozKpi }
  | { readonly tipo: "no_disponible" }
  | { readonly tipo: "sin_permiso" }
  | { readonly tipo: "error"; readonly mensaje: string };

interface Datos {
  readonly canales: ChannelKpis;
  readonly voz: EstadoVoz;
}

const ROLES_TELEMETRIA: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Un decimal en todas las tarjetas (locale de la consola), para que 90.0 % y 8.0 % se lean igual. */
function formatoPct1(pct: number | null): string {
  return pct === null || !Number.isFinite(pct) ? "—" : `${new Intl.NumberFormat(localeActivo(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(pct)}%`;
}

function pct(parte: number, total: number): number | null {
  return total <= 0 ? null : Math.round((parte / total) * 1000) / 10;
}

export function ResumenKpisVoz({ apiBaseUrl, token, propertyId, role, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly role: string; readonly fetchImpl?: typeof fetch }) {
  const t = useT(restaurantesIndicadoresVoz);
  const [datos, setDatos] = useState<Carga<Datos>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelado = false;
    const f = fetchImpl ?? fetch;
    setDatos({ estado: "cargando" });
    (async () => {
      try {
        const canales = await fetchChannelKpis(f, apiBaseUrl, token, propertyId);
        // voz/kpi exige owner|admin: a otros roles ni se les pide (un 403 no debe leerse como «telemetria no activa»).
        let voz: EstadoVoz;
        if (!ROLES_TELEMETRIA.has(role)) voz = { tipo: "sin_permiso" };
        else {
          try {
            voz = { tipo: "datos", kpi: await fetchVozKpi(f, apiBaseUrl, token, propertyId) };
          } catch (e) {
            voz = e instanceof VozNoDisponibleError ? { tipo: "no_disponible" } : { tipo: "error", mensaje: e instanceof Error ? e.message : t("restaurantes.indicadoresVoz.kpis.errorLlamadas") };
          }
        }
        if (!cancelado) setDatos({ estado: "listo", datos: { canales, voz } });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, t("restaurantes.indicadoresVoz.kpis.error")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, role, version, fetchImpl]);

  if (datos.estado === "cargando") return <EstadoCargando etiqueta={t("restaurantes.indicadoresVoz.kpis.cargando")} />;
  if (datos.estado !== "listo") return <EstadoError mensaje={datos.estado === "error" ? datos.mensaje : t("restaurantes.indicadoresVoz.kpis.noDisponible")} onReintentar={reintentar} />;

  const { canales, voz } = datos.datos;
  const v = canales.voice;
  const completados = pct(v.completed, v.orders);
  const participacion = pct(v.orders, canales.totalOrders);
  const cancelacion = pct(v.cancelled, v.orders);
  const mes = voz.tipo === "datos" ? voz.kpi.mes : null;
  const sinLlamadas =
    voz.tipo === "sin_permiso"
      ? t("restaurantes.indicadoresVoz.kpis.sinPermiso")
      : voz.tipo === "error"
        ? t("restaurantes.indicadoresVoz.kpis.errorLlamadas")
        : t("restaurantes.indicadoresVoz.kpis.sinTelemetria");

  return (
    <section aria-label={t("restaurantes.indicadoresVoz.kpis.seccion")} className="space-y-2" data-testid="resumen-kpis-voz">
      {/* El periodo lo redacta el servidor y llega tal cual. */}
      <p className="text-xs text-muted-foreground">{t("restaurantes.indicadoresVoz.kpis.intro", { periodo: canales.periodo.etiqueta })}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={ShoppingBag} label={t("restaurantes.indicadoresVoz.kpis.completados")} value={formatoPct1(completados)} nota={completados === null ? t("restaurantes.indicadoresVoz.kpis.sinPedidosVoz") : t("restaurantes.indicadoresVoz.kpis.completadosNota", { completados: v.completed, pedidos: v.orders })} variante="neutra" />
        <StatCard icon={Share2} label={t("restaurantes.indicadoresVoz.kpis.participacion")} value={formatoPct1(participacion)} nota={participacion === null ? t("restaurantes.indicadoresVoz.kpis.sinPedidos") : t("restaurantes.indicadoresVoz.kpis.participacionNota", { pedidos: v.orders, total: canales.totalOrders })} variante="neutra" />
        <StatCard icon={Ban} label={t("restaurantes.indicadoresVoz.kpis.cancelacion")} value={formatoPct1(cancelacion)} nota={cancelacion === null ? t("restaurantes.indicadoresVoz.kpis.sinPedidosVoz") : t("restaurantes.indicadoresVoz.kpis.cancelacionNota", { cancelados: t("restaurantes.indicadoresVoz.kpis.cancelados", { count: v.cancelled }) })} variante="neutra" />
        {mes ? (
          <StatCard icon={PhoneCall} label={t("restaurantes.indicadoresVoz.kpis.llamadasMes")} value={String(mes.llamadas)} nota={t("restaurantes.indicadoresVoz.kpis.cerradas", { count: mes.llamadasCerradas })} variante="neutra" />
        ) : (
          <StatCard icon={PhoneCall} label={t("restaurantes.indicadoresVoz.kpis.llamadasMes")} value="—" sinDato={sinLlamadas} variante="neutra" />
        )}
        {mes ? (
          <StatCard icon={Headset} label={t("restaurantes.indicadoresVoz.kpis.escalacion")} value={formatoPct1(mes.tasaHandoffPct)} nota={mes.tasaHandoffPct === null ? t("restaurantes.indicadoresVoz.kpis.sinCerradas") : t("restaurantes.indicadoresVoz.kpis.llamadas", { count: mes.escaladas })} variante="neutra" />
        ) : (
          <StatCard icon={Headset} label={t("restaurantes.indicadoresVoz.kpis.escalacion")} value="—" sinDato={sinLlamadas} variante="neutra" />
        )}
        <StatCard icon={Radio} label={t("restaurantes.indicadoresVoz.kpis.concurrencia")} value="—" sinDato={t("restaurantes.indicadoresVoz.kpis.concurrenciaNoDisponible")} variante="neutra" />
      </div>
      {voz.tipo === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{voz.mensaje}</span>
          <Button type="button" size="sm" variant="outline" onClick={reintentar}>
            {t("restaurantes.indicadoresVoz.kpis.reintentar")}
          </Button>
        </div>
      )}
    </section>
  );
}
