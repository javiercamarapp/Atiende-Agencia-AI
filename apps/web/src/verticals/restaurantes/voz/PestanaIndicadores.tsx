// Pestaña "Indicadores" del agente de voz (R-13): KPI de llamadas, resolución vs handoff, pedidos por voz, errores de
// proveedor, p95 de herramientas, costo del día y del mes (centavos MXN) y alertas internas por umbral. Todo es agregado:
// no hay teléfonos ni transcripciones aquí. "Día" = día local de la sucursal. Solo avisos en el panel (y bitácora en el
// servidor): ninguna acción de esta pantalla envía WhatsApp ni correo. Sin dato = "—" (nunca 0 inventado).
import { useCallback, useEffect, useState } from "react";
import { Activity, Clock, DollarSign, Headset, PhoneCall, ShoppingBag, TriangleAlert } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, StatCard, DataTable, traductorActivo, useT } from "@atiende/ui";
import { restaurantesIndicadoresVoz } from "@atiende/ui/i18n/restaurantes/indicadoresVoz";
import { evaluarVozAlertas, fetchVozAlertas, fetchVozKpi, fetchVozKpiDesborde, updateVozUmbrales } from "../lib/voz-kpi-client.ts";
import type { VozAlerta, VozKpi, VozKpiDesborde, VozKpiDiaSerie, VozUmbrales } from "../lib/voz-kpi-client.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";
import { etiquetaAlerta, formatoDia, formatoMs, formatoMxn, formatoPct, pesosACentavos } from "./formato-kpi.ts";
import { formatoDuracion } from "./formato-voz.ts";

interface Datos {
  readonly kpi: VozKpi;
  readonly umbrales: VozUmbrales;
  readonly alertas: readonly VozAlerta[];
}

const tr = traductorActivo(restaurantesIndicadoresVoz);

function notaCosto(m: VozKpi["mes"]): string | undefined {
  return m.costoCompleto ? undefined : tr("restaurantes.indicadoresVoz.costoMinimo");
}

export function PestanaIndicadores({ apiBaseUrl, token, propertyId, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl?: typeof fetch }) {
  const t = useT(restaurantesIndicadoresVoz);
  const [datos, setDatos] = useState<Carga<Datos>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelado = false;
    const f = fetchImpl ?? fetch;
    // Al recargar tras guardar umbrales se conserva lo ya pintado (el formulario no pierde su aviso de guardado).
    setDatos((previo) => (previo.estado === "listo" ? previo : { estado: "cargando" }));
    (async () => {
      try {
        const kpi = await fetchVozKpi(f, apiBaseUrl, token, propertyId);
        // Evaluar registra (panel + bitácora) las alertas de hoy si los umbrales se cruzaron; luego se lee el estado final.
        await evaluarVozAlertas(f, apiBaseUrl, token, propertyId);
        const { umbrales, alertas } = await fetchVozAlertas(f, apiBaseUrl, token, propertyId);
        if (!cancelado) setDatos({ estado: "listo", datos: { kpi, umbrales, alertas } });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, tr("restaurantes.indicadoresVoz.error.cargar")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version, fetchImpl]);

  if (datos.estado === "cargando") return <EstadoCargando etiqueta={t("restaurantes.indicadoresVoz.cargando")} />;
  if (datos.estado === "no_disponible") {
    return <EstadoVacio icon={Activity} titulo={t("restaurantes.indicadoresVoz.noDisponible")} mensaje={t("restaurantes.indicadoresVoz.noDisponible.mensaje")} />;
  }
  if (datos.estado === "error") return <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />;

  const { kpi, umbrales, alertas } = datos.datos;
  const hoy = kpi.diaDeHoy;
  const mes = kpi.mes;
  const alertasHoy = alertas.filter((a) => a.fecha === kpi.hoy);

  return (
    <div className="space-y-4" data-testid="indicadores-voz">
      <p className="text-xs text-muted-foreground">{t("restaurantes.indicadoresVoz.hoyEs", { dia: formatoDia(kpi.hoy), zona: kpi.zonaHoraria })}</p>

      {alertasHoy.length > 0 ? (
        <div className="space-y-2" role="alert" data-testid="alertas-hoy">
          {alertasHoy.map((a) => (
            <Callout key={a.tipo} tone="warning" titulo={t(a.tipo === "costo_dia" ? "restaurantes.indicadoresVoz.alerta.costo" : "restaurantes.indicadoresVoz.alerta.errores")} icon={<TriangleAlert className="h-4 w-4" aria-hidden />}>
              {etiquetaAlerta(a.tipo, a.valor, a.umbral)}
            </Callout>
          ))}
        </div>
      ) : null}

      <section aria-label={t("restaurantes.indicadoresVoz.hoy")} className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t("restaurantes.indicadoresVoz.hoy")}</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard icon={PhoneCall} label={t("restaurantes.indicadoresVoz.llamadas")} value={String(hoy.llamadas)} nota={t("restaurantes.indicadoresVoz.cerradas", { n: String(hoy.llamadasCerradas) })} />
          <StatCard icon={Clock} label={t("restaurantes.indicadoresVoz.duracionPromedio")} value={formatoDuracion(hoy.duracionPromedioS)} {...(hoy.duracionPromedioS === null ? { sinDato: t("restaurantes.indicadoresVoz.sinCerradasHoy") } : {})} />
          <StatCard icon={ShoppingBag} label={t("restaurantes.indicadoresVoz.pedidosVoz")} value={String(hoy.pedidosVoz)} nota={t("restaurantes.indicadoresVoz.resolucionNota", { pct: formatoPct(hoy.tasaResolucionPct) })} />
          <StatCard icon={Headset} label={t("restaurantes.indicadoresVoz.aPersona")} value={String(hoy.escaladas)} nota={t("restaurantes.indicadoresVoz.handoffNota", { pct: formatoPct(hoy.tasaHandoffPct) })} />
          <StatCard icon={TriangleAlert} label={t("restaurantes.indicadoresVoz.erroresProveedor")} value={String(hoy.erroresProveedor)} nota={t("restaurantes.indicadoresVoz.erroresNota", { twilio: String(hoy.erroresTwilio), otros: String(hoy.erroresOtros) })} />
          <StatCard icon={Activity} label={t("restaurantes.indicadoresVoz.p95")} value={formatoMs(hoy.toolP95PeorDiaMs)} {...(hoy.toolP95PeorDiaMs === null ? { sinDato: t("restaurantes.indicadoresVoz.sinHerramientasHoy") } : {})} />
          <StatCard icon={DollarSign} label={t("restaurantes.indicadoresVoz.costoDia")} value={formatoMxn(hoy.costoCentavosMxn)} {...(hoy.costoCentavosMxn === null ? { sinDato: t("restaurantes.indicadoresVoz.sinTipoCambio") } : { nota: t("restaurantes.indicadoresVoz.porLlamada", { costo: formatoMxn(hoy.costoPorLlamadaCentavosMxn) }) })} />
          <StatCard icon={DollarSign} label={t("restaurantes.indicadoresVoz.costoMes")} value={formatoMxn(mes.costoCentavosMxn)} {...(mes.costoCentavosMxn === null ? { sinDato: t("restaurantes.indicadoresVoz.sinTipoCambio") } : { nota: notaCosto(mes) ?? t("restaurantes.indicadoresVoz.costoMesNota", { n: mes.llamadas }) })} />
        </div>
        {mes.costoLlmOrgCentavosMxn !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="costo-llm-org">
            {t("restaurantes.indicadoresVoz.costoLlmOrg", { costo: formatoMxn(mes.costoLlmOrgCentavosMxn) })}
          </p>
        ) : null}
      </section>

      <section aria-label={t("restaurantes.indicadoresVoz.delMes")} className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t("restaurantes.indicadoresVoz.mesEnCurso")}</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard icon={PhoneCall} label={t("restaurantes.indicadoresVoz.llamadas")} value={String(mes.llamadas)} />
          <StatCard icon={ShoppingBag} label={t("restaurantes.indicadoresVoz.resolucionPedido")} value={formatoPct(mes.tasaResolucionPct)} {...(mes.tasaResolucionPct === null ? { sinDato: t("restaurantes.indicadoresVoz.sinCerradas") } : { nota: t("restaurantes.indicadoresVoz.pedidosN", { n: mes.pedidosVoz }) })} />
          <StatCard icon={Headset} label={t("restaurantes.indicadoresVoz.handoffPersona")} value={formatoPct(mes.tasaHandoffPct)} {...(mes.tasaHandoffPct === null ? { sinDato: t("restaurantes.indicadoresVoz.sinCerradas") } : { nota: t("restaurantes.indicadoresVoz.llamadasN", { n: mes.escaladas }) })} />
          <StatCard icon={TriangleAlert} label={t("restaurantes.indicadoresVoz.tasaError")} value={formatoPct(mes.tasaErrorPct)} {...(mes.tasaErrorPct === null ? { sinDato: t("restaurantes.indicadoresVoz.sinLlamadas") } : { nota: t("restaurantes.indicadoresVoz.erroresN", { n: mes.erroresProveedor }) })} />
        </div>
      </section>

      <SeccionDesborde apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} />

      <section aria-label={t("restaurantes.indicadoresVoz.ultimos14")} className="space-y-2">
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>{t("restaurantes.indicadoresVoz.ultimos14")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<VozKpiDiaSerie>
              etiqueta={t("restaurantes.indicadoresVoz.tabla")}
              filas={[...kpi.serie].reverse()}
              obtenerId={(d) => d.fecha}
              atributosFila={(d) => ({ "data-dia": d.fecha })}
              vacio={{ titulo: t("restaurantes.indicadoresVoz.sinDias"), mensaje: t("restaurantes.indicadoresVoz.sinDias.mensaje") }}
              paginacion={false}
              columnas={[
                { id: "dia", encabezado: t("restaurantes.indicadoresVoz.col.dia"), principal: true, celda: (d) => formatoDia(d.fecha) },
                { id: "llamadas", encabezado: t("restaurantes.indicadoresVoz.llamadas"), alinear: "right", className: "tabular-nums", celda: (d) => d.llamadas },
                { id: "pedidos", encabezado: t("restaurantes.indicadoresVoz.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (d) => d.pedidosVoz },
                { id: "persona", encabezado: t("restaurantes.indicadoresVoz.col.aPersona"), alinear: "right", className: "tabular-nums", celda: (d) => d.escaladas },
                { id: "errores", encabezado: t("restaurantes.indicadoresVoz.col.errores"), alinear: "right", className: "tabular-nums", celda: (d) => d.erroresProveedor },
                { id: "p95", encabezado: t("restaurantes.indicadoresVoz.col.p95"), alinear: "right", className: "tabular-nums", celda: (d) => formatoMs(d.toolP95Ms) },
                { id: "costo", encabezado: t("restaurantes.indicadoresVoz.col.costo"), alinear: "right", className: "tabular-nums", celda: (d) => formatoMxn(d.costoCentavosMxn) },
              ]}
            />
          </CardContent>
        </Card>
      </section>

      <FormularioUmbrales umbrales={umbrales} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} onGuardado={reintentar} />

      {alertas.length > 0 ? (
        <section aria-label={t("restaurantes.indicadoresVoz.alertasRecientes")} className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t("restaurantes.indicadoresVoz.alertasRecientes")}</h3>
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="alertas-recientes">
            {alertas.map((a) => (
              <li key={`${a.fecha}-${a.tipo}`}>
                {formatoDia(a.fecha)}: {etiquetaAlerta(a.tipo, a.valor, a.umbral)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Llamadas que el personal no contestó (modo desborde) -> pedidos -> ventas recuperadas, y latencia de voz a voz contra el objetivo. Carga APARTE de los demás
 * indicadores: si la API o la base aún no tienen la migración 067, solo esta sección dice "no disponible aún" y el resto sigue funcionando. */
function SeccionDesborde({ apiBaseUrl, token, propertyId, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined }) {
  const [datos, setDatos] = useState<Carga<VozKpiDesborde>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelado = false;
    setDatos({ estado: "cargando" });
    fetchVozKpiDesborde(fetchImpl ?? fetch, apiBaseUrl, token, propertyId).then(
      (kpi) => {
        if (!cancelado) setDatos({ estado: "listo", datos: kpi });
      },
      (err: unknown) => {
        if (!cancelado) setDatos(desdeError(err, tr("restaurantes.indicadoresVoz.desborde.error")));
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version, fetchImpl]);

  const t = useT(restaurantesIndicadoresVoz);
  return (
    <section aria-label={t("restaurantes.indicadoresVoz.desborde.titulo")} className="space-y-2" data-testid="kpi-desborde">
      <h3 className="text-sm font-medium text-foreground">{t("restaurantes.indicadoresVoz.desborde.titulo")}</h3>
      {datos.estado === "cargando" ? <EstadoCargando etiqueta={t("restaurantes.indicadoresVoz.desborde.cargando")} /> : null}
      {datos.estado === "error" ? <EstadoError mensaje={datos.mensaje} onReintentar={() => setVersion((v) => v + 1)} /> : null}
      {datos.estado === "no_disponible" ? (
        <p className="text-xs text-muted-foreground" data-testid="kpi-desborde-no-disponible">
          {t("restaurantes.indicadoresVoz.desborde.noDisponible")}
        </p>
      ) : null}
      {datos.estado === "listo" ? <ContenidoDesborde kpi={datos.datos} /> : null}
    </section>
  );
}

function ContenidoDesborde({ kpi }: { readonly kpi: VozKpiDesborde }) {
  const t = useT(restaurantesIndicadoresVoz);
  const tot = kpi.totales;
  const lat = kpi.ultimaLatencia;
  const cumple = lat !== null && lat.p95Ms !== null ? lat.p95Ms < kpi.objetivoLatenciaP95Ms : null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatCard icon={PhoneCall} label={t("restaurantes.indicadoresVoz.desborde.noContestadas")} value={String(tot.llamadasDesborde)} nota={t("restaurantes.indicadoresVoz.desborde.rango", { desde: formatoDia(kpi.desde), hasta: formatoDia(kpi.hasta) })} />
        <StatCard icon={ShoppingBag} label={t("restaurantes.indicadoresVoz.desborde.pedido")} value={String(tot.pedidosDesborde)} nota={tot.llamadasDesborde > 0 ? t("restaurantes.indicadoresVoz.desborde.pctLlamadas", { pct: String(Math.round((tot.pedidosDesborde / tot.llamadasDesborde) * 100)) }) : undefined} {...(tot.llamadasDesborde === 0 ? { sinDato: t("restaurantes.indicadoresVoz.desborde.sinLlamadas") } : {})} />
        <StatCard icon={DollarSign} label={t("restaurantes.indicadoresVoz.desborde.ventas")} value={formatoMxn(Math.round(tot.ventasRecuperadas * 100))} nota={t("restaurantes.indicadoresVoz.desborde.ventasNota")} />
        <StatCard
          icon={Activity}
          label={t("restaurantes.indicadoresVoz.desborde.latencia")}
          value={formatoMs(lat?.p95Ms ?? null)}
          {...(lat === null || lat.p95Ms === null ? { sinDato: t("restaurantes.indicadoresVoz.desborde.sinLatencia") } : { nota: t(cumple ? "restaurantes.indicadoresVoz.desborde.cumple" : "restaurantes.indicadoresVoz.desborde.noCumple", { objetivo: formatoMs(kpi.objetivoLatenciaP95Ms), p50: formatoMs(lat.p50Ms), dia: formatoDia(lat.fecha) }) })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("restaurantes.indicadoresVoz.desborde.nota")}</p>
    </div>
  );
}

function FormularioUmbrales({ umbrales, apiBaseUrl, token, propertyId, fetchImpl, onGuardado }: { readonly umbrales: VozUmbrales; readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined; readonly onGuardado: () => void }) {
  const t = useT(restaurantesIndicadoresVoz);
  const [costo, setCosto] = useState(umbrales.umbralCostoDiaCentavosMxn === null ? "" : (umbrales.umbralCostoDiaCentavosMxn / 100).toFixed(2));
  const [tasa, setTasa] = useState(umbrales.umbralTasaErrorPct === null ? "" : String(umbrales.umbralTasaErrorPct));
  const [minimo, setMinimo] = useState(String(umbrales.minLlamadasTasaError));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState(false);

  async function guardar() {
    setError(null);
    setAviso(false);
    const centavos = pesosACentavos(costo);
    const pct = tasa.trim() === "" ? null : Number(tasa);
    const m = Number(minimo);
    if (centavos === undefined) return setError(t("restaurantes.indicadoresVoz.umbral.errorCosto"));
    if (pct !== null && (!Number.isInteger(pct) || pct < 1 || pct > 100)) return setError(t("restaurantes.indicadoresVoz.umbral.errorTasa"));
    if (!Number.isInteger(m) || m < 1 || m > 1000) return setError(t("restaurantes.indicadoresVoz.umbral.errorMinimo"));
    setGuardando(true);
    try {
      await updateVozUmbrales(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, { umbralCostoDiaCentavosMxn: centavos, umbralTasaErrorPct: pct, minLlamadasTasaError: m });
      setAviso(true);
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.indicadoresVoz.umbral.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("restaurantes.indicadoresVoz.umbral.titulo")}</CardTitle>
        <CardDescription>{t("restaurantes.indicadoresVoz.umbral.descripcion")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="umbral-costo" className="block text-sm font-medium text-foreground mb-1.5">
              {t("restaurantes.indicadoresVoz.umbral.costo")}
            </label>
            <Input id="umbral-costo" inputMode="decimal" value={costo} onChange={(e) => setCosto(e.target.value)} placeholder={t("restaurantes.indicadoresVoz.umbral.costoEjemplo")} />
          </div>
          <div>
            <label htmlFor="umbral-tasa" className="block text-sm font-medium text-foreground mb-1.5">
              {t("restaurantes.indicadoresVoz.umbral.tasa")}
            </label>
            <Input id="umbral-tasa" inputMode="numeric" value={tasa} onChange={(e) => setTasa(e.target.value)} placeholder={t("restaurantes.indicadoresVoz.umbral.tasaEjemplo")} />
          </div>
          <div>
            <label htmlFor="umbral-minimo" className="block text-sm font-medium text-foreground mb-1.5">
              {t("restaurantes.indicadoresVoz.umbral.minimo")}
            </label>
            <Input id="umbral-minimo" inputMode="numeric" value={minimo} onChange={(e) => setMinimo(e.target.value)} />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void guardar()} loading={guardando}>
            {t("restaurantes.indicadoresVoz.umbral.guardar")}
          </Button>
          {aviso ? (
            <span role="status" className="text-xs text-primary">
              {t("restaurantes.indicadoresVoz.umbral.guardados")}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
