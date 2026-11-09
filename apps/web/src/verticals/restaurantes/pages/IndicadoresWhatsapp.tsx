// Indicadores del agente de WhatsApp (R-31): conversaciones nuevas, conversión a pedido, tasa de handoff, pedidos y costo LLM
// promedio por pedido, por sucursal y por día local. Solo lectura (owner/admin). Todo es agregado: sin teléfonos ni mensajes.
// Rótulos veraces: el costo LLM es de la ORGANIZACIÓN (la base lo guarda por día y rol, no por conversación ni sucursal), así que
// "Costo LLM promedio por pedido" es un promedio del periodo, no el costo real de cada pedido. Sin dato = "—" con su razón.
import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCheck, DollarSign, Headset, MessageSquare, MessageSquareWarning, Send, ShoppingBag, TrendingUp, Wrench } from "lucide-react";
import { Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, Selector, PageContainer, PageHeader, StatCard, Tabs, TabsContent, TabsList, TabsTrigger, traductorActivo, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesIndicadoresWhatsapp } from "@atiende/ui/i18n/restaurantes/indicadoresWhatsapp";
import { ConocimientoNegocio } from "../components/ConocimientoNegocio.tsx";
import { fetchWhatsappKpi } from "../lib/whatsapp-kpi-client.ts";
import type { WhatsappEntrega, WhatsappEntregaDiaSerie, WhatsappKpi, WhatsappKpiDiaSerie, WhatsappKpiResumen } from "../lib/whatsapp-kpi-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoDia, formatoMxn, formatoPct } from "../voz/formato-kpi.ts";
import { WidgetWhatsApp } from "../preview/WidgetWhatsApp.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_INDICADORES: ReadonlySet<string> = new Set(["owner", "admin"]);
const PERIODOS: readonly { readonly dias: number; readonly clave: Clave }[] = [
  { dias: 7, clave: "restaurantes.indicadoresWhatsapp.periodo.7" },
  { dias: 14, clave: "restaurantes.indicadoresWhatsapp.periodo.14" },
  { dias: 30, clave: "restaurantes.indicadoresWhatsapp.periodo.30" },
  { dias: 60, clave: "restaurantes.indicadoresWhatsapp.periodo.60" },
];

const tr = traductorActivo(restaurantesIndicadoresWhatsapp);

/** Por qué no hay costo por pedido (cada razón es real y distinta; nunca un 0 inventado). */
function razonSinCostoPorPedido(r: WhatsappKpiResumen): string | null {
  if (r.costoLlmPorPedidoCentavosMxn !== null) return null;
  if (r.orgEsDemo) return tr("restaurantes.indicadoresWhatsapp.sinCosto.demo");
  if (r.pedidosOrg === null) return tr("restaurantes.indicadoresWhatsapp.sinCosto.soloOrg");
  if (r.pedidosOrg === 0) return tr("restaurantes.indicadoresWhatsapp.sinCosto.sinPedidos");
  return tr("restaurantes.indicadoresWhatsapp.sinCosto.tipoCambio");
}

function razonSinCostoTotal(r: WhatsappKpiResumen): string | null {
  if (r.costoLlmOrgCentavosMxn !== null) return null;
  if (r.orgEsDemo) return tr("restaurantes.indicadoresWhatsapp.sinCosto.demoTotal");
  if (r.pedidosOrg === null) return tr("restaurantes.indicadoresWhatsapp.sinCosto.soloOrgTotal");
  return tr("restaurantes.indicadoresWhatsapp.sinCosto.tipoCambio");
}

/** Motivos de fallo de entrega (los mismos codigos que guarda la base). Texto de la plataforma, nunca del cliente. */
const MOTIVOS_FALLO: Readonly<Record<string, Clave>> = {
  fuera_de_ventana: "restaurantes.indicadoresWhatsapp.fallo.fuera_de_ventana",
  fuera_de_ventana_plantilla_sin_usar: "restaurantes.indicadoresWhatsapp.fallo.fuera_de_ventana_plantilla_sin_usar",
  numero_no_entregable: "restaurantes.indicadoresWhatsapp.fallo.numero_no_entregable",
  plantilla: "restaurantes.indicadoresWhatsapp.fallo.plantilla",
  limite_marketing: "restaurantes.indicadoresWhatsapp.fallo.limite_marketing",
  otro: "restaurantes.indicadoresWhatsapp.fallo.otro",
};

function EntregaAvisos({ entrega }: { readonly entrega: WhatsappEntrega | undefined }) {
  const t = useT(restaurantesIndicadoresWhatsapp);
  if (!entrega || !entrega.disponible) {
    return (
      <Callout tone="info" data-testid="entrega-no-disponible">
        {t("restaurantes.indicadoresWhatsapp.entrega.noDisponible")}
      </Callout>
    );
  }
  const r = entrega.resumen;
  const motivos = Object.entries(r.fallosPorMotivo).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2.5" data-testid="entrega-avisos">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard icon={Send} label={t("restaurantes.indicadoresWhatsapp.entrega.enviados")} value={String(r.enviados)} nota={t("restaurantes.indicadoresWhatsapp.entrega.enviadosNota")} />
        <StatCard
          icon={CheckCheck}
          label={t("restaurantes.indicadoresWhatsapp.entrega.tasa")}
          value={formatoPct(r.entregaPct)}
          {...(r.entregaPct === null
            ? { sinDato: t("restaurantes.indicadoresWhatsapp.entrega.sinEnviados") }
            : { nota: `${t("restaurantes.indicadoresWhatsapp.entrega.tasaNota", { entregados: r.entregados, enviados: r.enviados })}${r.sinEstado > 0 ? t("restaurantes.indicadoresWhatsapp.entrega.sinConfirmacion", { n: r.sinEstado }) : ""}` })}
        />
        <StatCard
          icon={MessageSquare}
          label={t("restaurantes.indicadoresWhatsapp.entrega.lectura")}
          value={formatoPct(r.lecturaPct)}
          {...(r.lecturaPct === null ? { sinDato: t("restaurantes.indicadoresWhatsapp.entrega.sinEntregados") } : { nota: t("restaurantes.indicadoresWhatsapp.entrega.lecturaNota", { leidos: r.leidos, entregados: r.entregados }) })}
        />
        <StatCard icon={MessageSquareWarning} label={t("restaurantes.indicadoresWhatsapp.entrega.fallidos")} value={String(r.fallidos)} nota={t("restaurantes.indicadoresWhatsapp.entrega.fallidosNota")} />
      </div>
      {motivos.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="entrega-motivos">
          {t("restaurantes.indicadoresWhatsapp.entrega.motivos", { lista: motivos.map(([motivo, n]) => `${t(MOTIVOS_FALLO[motivo] ?? "restaurantes.indicadoresWhatsapp.fallo.otro")} (${n})`).join(" · ") })}
        </p>
      ) : null}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{t("restaurantes.indicadoresWhatsapp.entrega.porDia")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WhatsappEntregaDiaSerie>
            etiqueta={t("restaurantes.indicadoresWhatsapp.entrega.tablaEtiqueta")}
            filas={[...entrega.serie].reverse()}
            obtenerId={(d) => d.fecha}
            atributosFila={(d) => ({ "data-dia-entrega": d.fecha })}
            vacio={{ titulo: t("restaurantes.indicadoresWhatsapp.sinDias"), mensaje: t("restaurantes.indicadoresWhatsapp.entrega.sinDiasTexto") }}
            paginacion={false}
            columnas={[
              { id: "dia", encabezado: t("restaurantes.indicadoresWhatsapp.col.dia"), principal: true, celda: (d) => formatoDia(d.fecha) },
              { id: "enviados", encabezado: t("restaurantes.indicadoresWhatsapp.col.enviados"), alinear: "right", className: "tabular-nums", celda: (d) => d.enviados },
              { id: "entregados", encabezado: t("restaurantes.indicadoresWhatsapp.col.entregados"), alinear: "right", className: "tabular-nums", celda: (d) => d.entregados },
              { id: "leidos", encabezado: t("restaurantes.indicadoresWhatsapp.col.leidos"), alinear: "right", className: "tabular-nums", celda: (d) => d.leidos },
              { id: "fallidos", encabezado: t("restaurantes.indicadoresWhatsapp.col.noEntregados"), alinear: "right", className: "tabular-nums", celda: (d) => d.fallidos },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function IndicadoresWhatsappPage({ apiBaseUrl, token, propertyId, role, nombreSucursal, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const t = useT(restaurantesIndicadoresWhatsapp);
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
        if (!cancelado) setDatos(desdeError(err, t("restaurantes.indicadoresWhatsapp.errorCarga")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, dias, version, fetchImpl, puedeVer]);

  return (
    <>
    {/* pb-24: el globo flotante «Probar conversación» (fixed, 56 px + 24 px de margen) no debe tapar el ultimo texto de la pagina. */}
    <PageContainer padding="none" className={puedeVer ? "pb-24" : undefined}>
      <PageHeader
        titulo={t("restaurantes.indicadoresWhatsapp.titulo")}
        descripcion={t("restaurantes.indicadoresWhatsapp.subtitulo")}
        acciones={
          puedeVer ? (
            <>
              <label htmlFor="periodo-whatsapp" className="sr-only">
                {t("restaurantes.indicadoresWhatsapp.periodo")}
              </label>
              <Selector id="periodo-whatsapp" value={String(dias)} onChange={(e) => setDias(Number(e.target.value))} wrapperClassName="w-auto" className="rounded-full">
                {PERIODOS.map((p) => (
                  <option key={p.dias} value={p.dias}>
                    {t(p.clave)}
                  </option>
                ))}
              </Selector>
            </>
          ) : undefined
        }
      />

      {!puedeVer ? (
        <Callout tone="info">
          {t("restaurantes.indicadoresWhatsapp.soloRoles")}
          {/* // i18n-ignorar: «owner» y «admin» son los nombres tecnicos del rol, iguales en los dos idiomas */}
          <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong>
          {t("restaurantes.indicadoresWhatsapp.soloRolesFin")}{" "}
          <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : (
        <Tabs defaultValue="general" className="flex flex-col gap-3">
          <TabsList className="self-start">
            <TabsTrigger value="general">{t("restaurantes.indicadoresWhatsapp.tab.general")}</TabsTrigger>
            <TabsTrigger value="herramientas">{t("restaurantes.indicadoresWhatsapp.tab.herramientas")}</TabsTrigger>
            <TabsTrigger value="conocimiento">{t("restaurantes.indicadoresWhatsapp.tab.conocimiento")}</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-0">
            {datos.estado === "cargando" ? (
              <EstadoCargando etiqueta={t("restaurantes.indicadoresWhatsapp.cargando")} />
            ) : datos.estado === "no_disponible" ? (
              <EstadoVacio
                icon={Activity}
                titulo={t("restaurantes.indicadoresWhatsapp.noDisponibleTitulo")}
                mensaje={t("restaurantes.indicadoresWhatsapp.noDisponibleTexto")}
              />
            ) : datos.estado === "error" ? (
              <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />
            ) : (
              <Contenido kpi={datos.datos} />
            )}
          </TabsContent>
          <TabsContent value="herramientas" className="mt-0">
            <EstadoVacio
              icon={Wrench}
              titulo={t("restaurantes.indicadoresWhatsapp.herramientasTitulo")}
              mensaje={t("restaurantes.indicadoresWhatsapp.herramientasTexto")}
            />
          </TabsContent>
          <TabsContent value="conocimiento" className="mt-0">
            <ConocimientoNegocio apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} canal="whatsapp" />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
    {/* Chat de WhatsApp de demostración (globo flotante «Probar conversación»), como el probador de voz: prueba el agente real sin efectos. */}
    {puedeVer ? <WidgetWhatsApp apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} {...(nombreSucursal ? { nombreNegocio: nombreSucursal } : {})} /> : null}
    </>
  );
}

function Contenido({ kpi }: { readonly kpi: WhatsappKpi }) {
  const t = useT(restaurantesIndicadoresWhatsapp);
  const r = kpi.resumen;
  const sinCostoPorPedido = razonSinCostoPorPedido(r);
  const sinCostoTotal = razonSinCostoTotal(r);
  return (
    <div className="space-y-2.5" data-testid="indicadores-whatsapp">
      <p className="text-xs text-muted-foreground">
        {t("restaurantes.indicadoresWhatsapp.rango", { desde: formatoDia(kpi.desde), hasta: formatoDia(kpi.hasta), zona: kpi.zonaHoraria })}
      </p>

      {r.orgEsDemo ? (
        <Callout tone="info" data-testid="aviso-demo">
          {t("restaurantes.indicadoresWhatsapp.avisoDemo")}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <StatCard icon={MessageSquare} label={t("restaurantes.indicadoresWhatsapp.kpi.conversaciones")} value={String(r.conversaciones)} nota={t("restaurantes.indicadoresWhatsapp.kpi.conversacionesNota")} />
        <StatCard
          icon={ShoppingBag}
          label={t("restaurantes.indicadoresWhatsapp.kpi.conversion")}
          value={formatoPct(r.conversionPct)}
          {...(r.conversionPct === null
            ? { sinDato: t("restaurantes.indicadoresWhatsapp.kpi.sinConversaciones") }
            : { nota: t("restaurantes.indicadoresWhatsapp.kpi.conversionNota", { con: r.conversacionesConPedido, total: r.conversaciones }) })}
        />
        <StatCard
          icon={Headset}
          label={t("restaurantes.indicadoresWhatsapp.kpi.handoff")}
          value={formatoPct(r.handoffPct)}
          {...(r.handoffPct === null
            ? { sinDato: t("restaurantes.indicadoresWhatsapp.kpi.sinConversaciones") }
            : { nota: t("restaurantes.indicadoresWhatsapp.kpi.handoffNota", { con: r.conversacionesConHandoff, total: r.conversaciones }) })}
        />
        <StatCard icon={TrendingUp} label={t("restaurantes.indicadoresWhatsapp.kpi.pedidos")} value={String(r.pedidos)} nota={t("restaurantes.indicadoresWhatsapp.kpi.pedidosNota", { n: r.handoffs })} />
        <StatCard
          icon={DollarSign}
          label={t("restaurantes.indicadoresWhatsapp.kpi.costoPedido")}
          value={formatoMxn(r.costoLlmPorPedidoCentavosMxn)}
          {...(sinCostoPorPedido ? { sinDato: sinCostoPorPedido } : { nota: t("restaurantes.indicadoresWhatsapp.kpi.costoPedidoNota") })}
        />
        <StatCard
          icon={DollarSign}
          label={t("restaurantes.indicadoresWhatsapp.kpi.costoOrg")}
          value={formatoMxn(r.costoLlmOrgCentavosMxn)}
          {...(sinCostoTotal ? { sinDato: sinCostoTotal } : { nota: t("restaurantes.indicadoresWhatsapp.kpi.costoOrgNota", { n: r.pedidosOrg ?? 0 }) })}
        />
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>{t("restaurantes.indicadoresWhatsapp.porDia")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WhatsappKpiDiaSerie>
            etiqueta={t("restaurantes.indicadoresWhatsapp.tablaEtiqueta")}
            filas={[...kpi.serie].reverse()}
            obtenerId={(d) => d.fecha}
            atributosFila={(d) => ({ "data-dia": d.fecha })}
            vacio={{ titulo: t("restaurantes.indicadoresWhatsapp.sinDias"), mensaje: t("restaurantes.indicadoresWhatsapp.sinDiasTexto") }}
            paginacion={false}
            columnas={[
              { id: "dia", encabezado: t("restaurantes.indicadoresWhatsapp.col.dia"), principal: true, celda: (d) => formatoDia(d.fecha) },
              { id: "conversaciones", encabezado: t("restaurantes.indicadoresWhatsapp.col.conversaciones"), alinear: "right", className: "tabular-nums", celda: (d) => d.conversaciones },
              { id: "conversion", encabezado: t("restaurantes.indicadoresWhatsapp.col.conversion"), alinear: "right", className: "tabular-nums", celda: (d) => formatoPct(d.conversionPct) },
              { id: "handoff", encabezado: t("restaurantes.indicadoresWhatsapp.col.handoff"), alinear: "right", className: "tabular-nums", celda: (d) => formatoPct(d.handoffPct) },
              { id: "pedidos", encabezado: t("restaurantes.indicadoresWhatsapp.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (d) => d.pedidos },
              { id: "costo", encabezado: t("restaurantes.indicadoresWhatsapp.col.costo"), alinear: "right", className: "tabular-nums", celda: (d) => formatoMxn(d.costoLlmPorPedidoCentavosMxn) },
            ]}
          />
        </CardContent>
      </Card>

      <h2 className="font-display pt-1 text-base font-semibold">{t("restaurantes.indicadoresWhatsapp.entregaTitulo")}</h2>
      <EntregaAvisos entrega={kpi.entrega} />

      <p className="text-xs text-muted-foreground" data-testid="notas-definiciones">
        {t("restaurantes.indicadoresWhatsapp.definiciones")}
      </p>
    </div>
  );
}
