// KPI del Resumen del agente de voz (como el original: pedidos completados, participacion, cancelacion, llamadas, escalacion y concurrencia),
// con datos reales: pedidos por canal (kpis/channels, ultimos 30 dias) y telemetria de llamadas (voz/kpi, mes en curso). Lo que no existe
// se dice como «no disponible aun: requiere X»; nunca una cifra inventada. Las metas son referencias fijas de producto, no datos.
import { useCallback, useEffect, useState } from "react";
import { Ban, Headset, PhoneCall, Radio, ShoppingBag, Share2 } from "lucide-react";
import { EstadoCargando, EstadoError, StatCard } from "@atiende/ui";
import { fetchChannelKpis } from "../dashboard-client.ts";
import type { ChannelKpis } from "../dashboard-client.ts";
import { fetchVozKpi } from "../lib/voz-kpi-client.ts";
import type { VozKpi } from "../lib/voz-kpi-client.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";
import { formatoPct } from "./formato-kpi.ts";

interface Datos {
  readonly canales: ChannelKpis;
  /** `null` = la telemetria de llamadas aun no esta activa en esta base. */
  readonly voz: VozKpi | null;
}

function pct(parte: number, total: number): number | null {
  return total <= 0 ? null : Math.round((parte / total) * 1000) / 10;
}

export function ResumenKpisVoz({ apiBaseUrl, token, propertyId, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl?: typeof fetch }) {
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
        const voz = await fetchVozKpi(f, apiBaseUrl, token, propertyId).catch(() => null);
        if (!cancelado) setDatos({ estado: "listo", datos: { canales, voz } });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar los indicadores del canal de voz."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version, fetchImpl]);

  if (datos.estado === "cargando") return <EstadoCargando etiqueta="Cargando indicadores del canal…" />;
  if (datos.estado !== "listo") return <EstadoError mensaje={datos.estado === "error" ? datos.mensaje : "Los indicadores del canal aún no están disponibles."} onReintentar={reintentar} />;

  const { canales, voz } = datos.datos;
  const v = canales.voice;
  const completados = pct(v.completed, v.orders);
  const participacion = pct(v.orders, canales.totalOrders);
  const cancelacion = pct(v.cancelled, v.orders);
  const mes = voz?.mes ?? null;
  const sinTelemetria = "No disponible aún: requiere la telemetría de llamadas de voz en esta base.";

  return (
    <section aria-label="Indicadores del canal de voz" className="space-y-2" data-testid="resumen-kpis-voz">
      <p className="text-xs text-muted-foreground">{canales.periodo.etiqueta}. Pedidos por voz de esta organización y llamadas del mes en curso de esta sucursal.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={ShoppingBag} label="Pedidos completados por voz" value={formatoPct(completados)} nota={completados === null ? "Aún no hay pedidos por voz" : `${v.completed} de ${v.orders} · meta de referencia: 90%`} variante="neutra" />
        <StatCard icon={Share2} label="Participación del canal de voz" value={formatoPct(participacion)} nota={participacion === null ? "Aún no hay pedidos" : `${v.orders} de ${canales.totalOrders} pedidos · meta de referencia: 25%`} variante="neutra" />
        <StatCard icon={Ban} label="Tasa de cancelación (voz)" value={formatoPct(cancelacion)} nota={cancelacion === null ? "Aún no hay pedidos por voz" : `${v.cancelled} cancelados · meta de referencia: menos de 5%`} variante="neutra" />
        {mes ? (
          <StatCard icon={PhoneCall} label="Llamadas del mes" value={String(mes.llamadas)} nota={`${mes.llamadasCerradas} cerradas`} variante="neutra" />
        ) : (
          <StatCard icon={PhoneCall} label="Llamadas del mes" value="—" sinDato={sinTelemetria} variante="neutra" />
        )}
        {mes ? (
          <StatCard icon={Headset} label="Escalación a una persona" value={formatoPct(mes.tasaHandoffPct)} nota={mes.tasaHandoffPct === null ? "Sin llamadas cerradas" : `${mes.escaladas} llamadas`} variante="neutra" />
        ) : (
          <StatCard icon={Headset} label="Escalación a una persona" value="—" sinDato={sinTelemetria} variante="neutra" />
        )}
        <StatCard icon={Radio} label="Uso de concurrencia" value="—" sinDato="No disponible aún: requiere leer la concurrencia del proveedor de voz, que no la reporta por webhook." variante="neutra" />
      </div>
    </section>
  );
}
