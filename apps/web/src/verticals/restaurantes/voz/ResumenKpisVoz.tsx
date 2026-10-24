// KPI del Resumen del agente de voz (como el original: pedidos completados, participacion, cancelacion, llamadas, escalacion y concurrencia),
// con datos reales: pedidos por canal (kpis/channels, ultimos 30 dias) y telemetria de llamadas (voz/kpi, mes en curso). Lo que no existe
// se dice como «no disponible aun: requiere X»; nunca una cifra inventada. Las metas son referencias fijas de producto, no datos.
import { useCallback, useEffect, useState } from "react";
import { Ban, Headset, PhoneCall, Radio, ShoppingBag, Share2 } from "lucide-react";
import { Button, EstadoCargando, EstadoError, StatCard } from "@atiende/ui";
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

/** Un decimal en todas las tarjetas (es-MX), para que 90.0 % y 8.0 % se lean igual. */
function formatoPct1(pct: number | null): string {
  return pct === null || !Number.isFinite(pct) ? "—" : `${pct.toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

function pct(parte: number, total: number): number | null {
  return total <= 0 ? null : Math.round((parte / total) * 1000) / 10;
}

export function ResumenKpisVoz({ apiBaseUrl, token, propertyId, role, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly role: string; readonly fetchImpl?: typeof fetch }) {
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
            voz = e instanceof VozNoDisponibleError ? { tipo: "no_disponible" } : { tipo: "error", mensaje: e instanceof Error ? e.message : "No se pudieron cargar las llamadas del mes." };
          }
        }
        if (!cancelado) setDatos({ estado: "listo", datos: { canales, voz } });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar los indicadores del canal de voz."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, role, version, fetchImpl]);

  if (datos.estado === "cargando") return <EstadoCargando etiqueta="Cargando indicadores del canal…" />;
  if (datos.estado !== "listo") return <EstadoError mensaje={datos.estado === "error" ? datos.mensaje : "Los indicadores del canal aún no están disponibles."} onReintentar={reintentar} />;

  const { canales, voz } = datos.datos;
  const v = canales.voice;
  const completados = pct(v.completed, v.orders);
  const participacion = pct(v.orders, canales.totalOrders);
  const cancelacion = pct(v.cancelled, v.orders);
  const mes = voz.tipo === "datos" ? voz.kpi.mes : null;
  const sinLlamadas =
    voz.tipo === "sin_permiso"
      ? "Solo el dueño o un administrador ve las llamadas del mes."
      : voz.tipo === "error"
        ? "No se pudieron cargar las llamadas del mes."
        : "No disponible aún: requiere la telemetría de llamadas de voz en esta base.";

  return (
    <section aria-label="Indicadores del canal de voz" className="space-y-2" data-testid="resumen-kpis-voz">
      <p className="text-xs text-muted-foreground">{canales.periodo.etiqueta}. Pedidos por voz de esta organización y llamadas del mes en curso de esta sucursal.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={ShoppingBag} label="Pedidos completados por voz" value={formatoPct1(completados)} nota={completados === null ? "Aún no hay pedidos por voz" : `${v.completed} de ${v.orders} · meta de referencia: 90%`} variante="neutra" />
        <StatCard icon={Share2} label="Participación del canal de voz" value={formatoPct1(participacion)} nota={participacion === null ? "Aún no hay pedidos" : `${v.orders} de ${canales.totalOrders} pedidos · meta de referencia: 25%`} variante="neutra" />
        <StatCard icon={Ban} label="Tasa de cancelación (voz)" value={formatoPct1(cancelacion)} nota={cancelacion === null ? "Aún no hay pedidos por voz" : `${plural(v.cancelled, "cancelado", "cancelados")} · meta de referencia: menos de 5%`} variante="neutra" />
        {mes ? (
          <StatCard icon={PhoneCall} label="Llamadas del mes" value={String(mes.llamadas)} nota={plural(mes.llamadasCerradas, "cerrada", "cerradas")} variante="neutra" />
        ) : (
          <StatCard icon={PhoneCall} label="Llamadas del mes" value="—" sinDato={sinLlamadas} variante="neutra" />
        )}
        {mes ? (
          <StatCard icon={Headset} label="Escalación a una persona" value={formatoPct1(mes.tasaHandoffPct)} nota={mes.tasaHandoffPct === null ? "Sin llamadas cerradas" : plural(mes.escaladas, "llamada", "llamadas")} variante="neutra" />
        ) : (
          <StatCard icon={Headset} label="Escalación a una persona" value="—" sinDato={sinLlamadas} variante="neutra" />
        )}
        <StatCard icon={Radio} label="Uso de concurrencia" value="—" sinDato="No disponible aún: requiere leer la concurrencia del proveedor de voz, que no la reporta por webhook." variante="neutra" />
      </div>
      {voz.tipo === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{voz.mensaje}</span>
          <Button type="button" size="sm" variant="outline" onClick={reintentar}>
            Reintentar
          </Button>
        </div>
      )}
    </section>
  );
}
