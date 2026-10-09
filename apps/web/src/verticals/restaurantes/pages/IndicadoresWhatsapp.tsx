// Indicadores del agente de WhatsApp (R-31): conversaciones nuevas, conversión a pedido, tasa de handoff, pedidos y costo LLM
// promedio por pedido, por sucursal y por día local. Solo lectura (owner/admin). Todo es agregado: sin teléfonos ni mensajes.
// Rótulos veraces: el costo LLM es de la ORGANIZACIÓN (la base lo guarda por día y rol, no por conversación ni sucursal), así que
// "Costo LLM promedio por pedido" es un promedio del periodo, no el costo real de cada pedido. Sin dato = "—" con su razón.
import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCheck, DollarSign, Headset, MessageSquare, MessageSquareWarning, Send, ShoppingBag, TrendingUp } from "lucide-react";
import { Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, NativeSelect, PageContainer, StatCard } from "@atiende/ui";
import { fetchWhatsappKpi } from "../lib/whatsapp-kpi-client.ts";
import type { WhatsappEntrega, WhatsappEntregaDiaSerie, WhatsappKpi, WhatsappKpiDiaSerie, WhatsappKpiResumen } from "../lib/whatsapp-kpi-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoDia, formatoMxn, formatoPct } from "../voz/formato-kpi.ts";
import { WidgetWhatsApp } from "../preview/WidgetWhatsApp.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_INDICADORES: ReadonlySet<string> = new Set(["owner", "admin"]);
const PERIODOS: readonly { readonly dias: number; readonly etiqueta: string }[] = [
  { dias: 7, etiqueta: "Últimos 7 días" },
  { dias: 14, etiqueta: "Últimos 14 días" },
  { dias: 30, etiqueta: "Últimos 30 días" },
  { dias: 60, etiqueta: "Últimos 60 días" },
];

/** Por qué no hay costo por pedido (cada razón es real y distinta; nunca un 0 inventado). */
function razonSinCostoPorPedido(r: WhatsappKpiResumen): string | null {
  if (r.costoLlmPorPedidoCentavosMxn !== null) return null;
  if (r.orgEsDemo) return "Organización de demostración: su costo LLM mezcla el widget público con uso real y no se muestra.";
  if (r.pedidosOrg === null) return "Solo se muestra con acceso a toda la organización: el costo LLM no se separa por sucursal.";
  if (r.pedidosOrg === 0) return "Sin pedidos de WhatsApp en el periodo.";
  return "Falta el tipo de cambio de algún día para convertir a pesos.";
}

function razonSinCostoTotal(r: WhatsappKpiResumen): string | null {
  if (r.costoLlmOrgCentavosMxn !== null) return null;
  if (r.orgEsDemo) return "Organización de demostración: no se muestra el costo.";
  if (r.pedidosOrg === null) return "Solo se muestra con acceso a toda la organización.";
  return "Falta el tipo de cambio de algún día para convertir a pesos.";
}

/** Motivos de fallo de entrega (los mismos codigos que guarda la base). Texto de la plataforma, nunca del cliente. */
const MOTIVOS_FALLO: Readonly<Record<string, string>> = {
  fuera_de_ventana: "Fuera de la ventana de 24 h",
  fuera_de_ventana_plantilla_sin_usar: "Fuera de la ventana de 24 h, con plantilla disponible sin usar",
  numero_no_entregable: "Número no entregable",
  plantilla: "Plantilla pausada o con parámetros incorrectos",
  limite_marketing: "Límite de mensajes de marketing",
  otro: "Otro motivo",
};

function EntregaAvisos({ entrega }: { readonly entrega: WhatsappEntrega | undefined }) {
  if (!entrega || !entrega.disponible) {
    return (
      <Callout tone="info" data-testid="entrega-no-disponible">
        Entrega de avisos de pedido: no disponible aún. Requiere la actualización de base de datos pendiente (migración 066); mientras tanto no se muestran cifras.
      </Callout>
    );
  }
  const r = entrega.resumen;
  const motivos = Object.entries(r.fallosPorMotivo).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2.5" data-testid="entrega-avisos">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard icon={Send} label="Avisos de pedido enviados" value={String(r.enviados)} nota="Estados del pedido por WhatsApp que Meta aceptó" />
        <StatCard
          icon={CheckCheck}
          label="Tasa de entrega"
          value={formatoPct(r.entregaPct)}
          {...(r.entregaPct === null ? { sinDato: "Sin avisos enviados en el periodo." } : { nota: `${r.entregados} de ${r.enviados} llegaron al teléfono del cliente${r.sinEstado > 0 ? ` · ${r.sinEstado} sin confirmación todavía` : ""}` })}
        />
        <StatCard
          icon={MessageSquare}
          label="Tasa de lectura"
          value={formatoPct(r.lecturaPct)}
          {...(r.lecturaPct === null ? { sinDato: "Todavía no hay avisos entregados." } : { nota: `${r.leidos} de ${r.entregados} entregados fueron leídos; quien desactivó la confirmación de lectura no cuenta` })}
        />
        <StatCard icon={MessageSquareWarning} label="Avisos no entregados" value={String(r.fallidos)} nota="Meta reportó fallo; el cliente no los recibió" />
      </div>
      {motivos.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="entrega-motivos">
          Motivos de fallo: {motivos.map(([motivo, n]) => `${MOTIVOS_FALLO[motivo] ?? MOTIVOS_FALLO.otro} (${n})`).join(" · ")}.
        </p>
      ) : null}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Entrega de avisos por día</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WhatsappEntregaDiaSerie>
            etiqueta="Entrega de avisos de pedido por día"
            filas={[...entrega.serie].reverse()}
            obtenerId={(d) => d.fecha}
            atributosFila={(d) => ({ "data-dia-entrega": d.fecha })}
            vacio={{ titulo: "Sin días con datos", mensaje: "Todavía no hay avisos de pedido enviados en este periodo." }}
            paginacion={false}
            columnas={[
              { id: "dia", encabezado: "Día", principal: true, celda: (d) => formatoDia(d.fecha) },
              { id: "enviados", encabezado: "Enviados", alinear: "right", className: "tabular-nums", celda: (d) => d.enviados },
              { id: "entregados", encabezado: "Entregados", alinear: "right", className: "tabular-nums", celda: (d) => d.entregados },
              { id: "leidos", encabezado: "Leídos", alinear: "right", className: "tabular-nums", celda: (d) => d.leidos },
              { id: "fallidos", encabezado: "No entregados", alinear: "right", className: "tabular-nums", celda: (d) => d.fallidos },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function IndicadoresWhatsappPage({ apiBaseUrl, token, propertyId, role, nombreSucursal, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const puedeVer = ROLES_INDICADORES.has(role);
  const [dias, setDias] = useState(14);
  const [datos, setDatos] = useState<Carga<WhatsappKpi>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setDatos({ estado: "cargando" });
    (async () => {
      try {
        const kpi = await fetchWhatsappKpi(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, dias);
        if (!cancelado) setDatos({ estado: "listo", datos: kpi });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar los indicadores del agente de WhatsApp."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, dias, version, fetchImpl, puedeVer]);

  return (
    <>
    <PageContainer padding="none">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl font-semibold">Indicadores del agente de WhatsApp</h1>
          <p className="mt-1 truncate text-ui text-muted-foreground">Conversaciones, pedidos, handoff y costo del agente, por día local de la sucursal.</p>
        </div>
        {puedeVer ? (
          <div className="shrink-0">
            <label htmlFor="periodo-whatsapp" className="sr-only">
              Periodo
            </label>
            <NativeSelect id="periodo-whatsapp" value={String(dias)} onChange={(e) => setDias(Number(e.target.value))}>
              {PERIODOS.map((p) => (
                <option key={p.dias} value={p.dias}>
                  {p.etiqueta}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </header>

      {!puedeVer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> ven los indicadores del agente — tu rol actual es{" "}
          <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : datos.estado === "cargando" ? (
        <EstadoCargando etiqueta="Cargando indicadores…" />
      ) : datos.estado === "no_disponible" ? (
        <EstadoVacio
          icon={Activity}
          titulo="Indicadores no disponibles todavía"
          mensaje="Los indicadores del agente de WhatsApp aún no están activos en este negocio (requieren la actualización de base de datos pendiente). Cuando lo estén, aquí verás conversaciones, conversión a pedido, handoff y costo por día."
        />
      ) : datos.estado === "error" ? (
        <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />
      ) : (
        <Contenido kpi={datos.datos} />
      )}
    </PageContainer>
    {/* Chat de WhatsApp de demostración (botón flotante «Iniciar chat»), como en el panel original: prueba el agente real sin efectos. */}
    {puedeVer ? <WidgetWhatsApp apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} {...(nombreSucursal ? { nombreNegocio: nombreSucursal } : {})} /> : null}
    </>
  );
}

function Contenido({ kpi }: { readonly kpi: WhatsappKpi }) {
  const r = kpi.resumen;
  const sinCostoPorPedido = razonSinCostoPorPedido(r);
  const sinCostoTotal = razonSinCostoTotal(r);
  return (
    <div className="space-y-2.5" data-testid="indicadores-whatsapp">
      <p className="text-xs text-muted-foreground">
        Del {formatoDia(kpi.desde)} al {formatoDia(kpi.hasta)} (zona {kpi.zonaHoraria}). Cifras agregadas de esta sucursal: no incluyen teléfonos ni mensajes ni el tráfico del widget de demostración.
      </p>

      {r.orgEsDemo ? (
        <Callout tone="info" data-testid="aviso-demo">
          Esta organización es de demostración: su costo LLM mezcla el widget público con uso real, por eso no se muestra.
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={MessageSquare} label="Conversaciones nuevas" value={String(r.conversaciones)} nota="Clientes que escribieron por primera vez a esta sucursal" />
        <StatCard
          icon={ShoppingBag}
          label="Conversión a pedido"
          value={formatoPct(r.conversionPct)}
          {...(r.conversionPct === null ? { sinDato: "Sin conversaciones nuevas en el periodo." } : { nota: `${r.conversacionesConPedido} de ${r.conversaciones} conversaciones nuevas terminaron en pedido` })}
        />
        <StatCard
          icon={Headset}
          label="Tasa de handoff a una persona"
          value={formatoPct(r.handoffPct)}
          {...(r.handoffPct === null ? { sinDato: "Sin conversaciones nuevas en el periodo." } : { nota: `${r.conversacionesConHandoff} de ${r.conversaciones} conversaciones nuevas pidieron a una persona` })}
        />
        <StatCard icon={TrendingUp} label="Pedidos de WhatsApp" value={String(r.pedidos)} nota={`Sin cancelados · ${r.handoffs} solicitudes de una persona`} />
        <StatCard
          icon={DollarSign}
          label="Costo LLM promedio por pedido"
          value={formatoMxn(r.costoLlmPorPedidoCentavosMxn)}
          {...(sinCostoPorPedido ? { sinDato: sinCostoPorPedido } : { nota: "Promedio del periodo de toda la organización; no es el costo real de cada pedido" })}
        />
        <StatCard
          icon={DollarSign}
          label="Costo LLM del agente (organización)"
          value={formatoMxn(r.costoLlmOrgCentavosMxn)}
          {...(sinCostoTotal ? { sinDato: sinCostoTotal } : { nota: `Todas las sucursales, ${r.pedidosOrg ?? 0} pedidos de WhatsApp` })}
        />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Por día</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WhatsappKpiDiaSerie>
            etiqueta="Indicadores del agente de WhatsApp por día"
            filas={[...kpi.serie].reverse()}
            obtenerId={(d) => d.fecha}
            atributosFila={(d) => ({ "data-dia": d.fecha })}
            vacio={{ titulo: "Sin días con datos", mensaje: "Todavía no hay actividad del agente de WhatsApp en este periodo." }}
            paginacion={false}
            columnas={[
              { id: "dia", encabezado: "Día", principal: true, celda: (d) => formatoDia(d.fecha) },
              { id: "conversaciones", encabezado: "Conversaciones", alinear: "right", className: "tabular-nums", celda: (d) => d.conversaciones },
              { id: "conversion", encabezado: "Conversión", alinear: "right", className: "tabular-nums", celda: (d) => formatoPct(d.conversionPct) },
              { id: "handoff", encabezado: "Handoff", alinear: "right", className: "tabular-nums", celda: (d) => formatoPct(d.handoffPct) },
              { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (d) => d.pedidos },
              { id: "costo", encabezado: "Costo LLM / pedido", alinear: "right", className: "tabular-nums", celda: (d) => formatoMxn(d.costoLlmPorPedidoCentavosMxn) },
            ]}
          />
        </CardContent>
      </Card>

      <h2 className="font-display pt-1 text-base font-semibold">Entrega de avisos de pedido</h2>
      <EntregaAvisos entrega={kpi.entrega} />

      <p className="text-xs text-muted-foreground" data-testid="notas-definiciones">
        Definiciones: una conversación nueva cuenta en el día local del primer mensaje del cliente a esta sucursal (un cliente que ya existía y vuelve a escribir no suma). La conversión y el handoff se miden sobre esas mismas conversaciones nuevas. Los pedidos son los de
        canal WhatsApp no cancelados creados ese día. El costo LLM viene de un registro diario de toda la organización (no por conversación ni por sucursal) y no incluye los modelos de apoyo de la plataforma. La entrega y la lectura cuentan los avisos de estado de pedido por WhatsApp según los estados que reporta Meta (un aviso en el día local de su envío); un aviso sin estado todavía no cuenta como entregado.
      </p>
    </div>
  );
}
