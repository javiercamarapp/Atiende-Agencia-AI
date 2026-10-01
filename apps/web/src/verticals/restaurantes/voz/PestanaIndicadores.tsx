// Pestaña "Indicadores" del agente de voz (R-13): KPI de llamadas, resolución vs handoff, pedidos por voz, errores de
// proveedor, p95 de herramientas, costo del día y del mes (centavos MXN) y alertas internas por umbral. Todo es agregado:
// no hay teléfonos ni transcripciones aquí. "Día" = día local de la sucursal. Solo avisos en el panel (y bitácora en el
// servidor): ninguna acción de esta pantalla envía WhatsApp ni correo. Sin dato = "—" (nunca 0 inventado).
import { useCallback, useEffect, useState } from "react";
import { Activity, Clock, DollarSign, Headset, PhoneCall, ShoppingBag, TriangleAlert } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { evaluarVozAlertas, fetchVozAlertas, fetchVozKpi, updateVozUmbrales } from "../lib/voz-kpi-client.ts";
import type { VozAlerta, VozKpi, VozUmbrales } from "../lib/voz-kpi-client.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";
import { etiquetaAlerta, formatoDia, formatoMs, formatoMxn, formatoPct, pesosACentavos } from "./formato-kpi.ts";
import { formatoDuracion } from "./formato-voz.ts";

interface Datos {
  readonly kpi: VozKpi;
  readonly umbrales: VozUmbrales;
  readonly alertas: readonly VozAlerta[];
}

function notaCosto(t: VozKpi["mes"]): string | undefined {
  return t.costoCompleto ? undefined : "Falta tipo de cambio en algún día con gasto: la cifra es un mínimo.";
}

export function PestanaIndicadores({ apiBaseUrl, token, propertyId, fetchImpl }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl?: typeof fetch }) {
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
        if (!cancelado) setDatos(desdeError(err, "No se pudieron cargar los indicadores de voz."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version, fetchImpl]);

  if (datos.estado === "cargando") return <EstadoCargando etiqueta="Cargando indicadores…" />;
  if (datos.estado === "no_disponible") {
    return <EstadoVacio icon={Activity} titulo="Indicadores no disponibles todavía" mensaje="Los indicadores de voz aún no están activos en este negocio. Cuando lo estén, aquí verás llamadas, resolución, errores, latencia y costo por día." />;
  }
  if (datos.estado === "error") return <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />;

  const { kpi, umbrales, alertas } = datos.datos;
  const hoy = kpi.diaDeHoy;
  const mes = kpi.mes;
  const alertasHoy = alertas.filter((a) => a.fecha === kpi.hoy);

  return (
    <div className="space-y-4" data-testid="indicadores-voz">
      <p className="text-xs text-muted-foreground">
        Hoy es {formatoDia(kpi.hoy)} (zona {kpi.zonaHoraria}). Una llamada cuenta en el día en que empezó. Son cifras agregadas: no incluyen teléfonos ni transcripciones.
      </p>

      {alertasHoy.length > 0 ? (
        <div className="space-y-2" role="alert" data-testid="alertas-hoy">
          {alertasHoy.map((a) => (
            <Callout key={a.tipo} tone="warning" titulo={a.tipo === "costo_dia" ? "Costo del día alto" : "Errores de proveedor altos"} icon={<TriangleAlert className="h-4 w-4" aria-hidden />}>
              {etiquetaAlerta(a.tipo, a.valor, a.umbral)}
            </Callout>
          ))}
        </div>
      ) : null}

      <section aria-label="Hoy" className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Hoy</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard icon={PhoneCall} label="Llamadas" value={String(hoy.llamadas)} nota={`${hoy.llamadasCerradas} cerradas`} />
          <StatCard icon={Clock} label="Duración promedio" value={formatoDuracion(hoy.duracionPromedioS)} {...(hoy.duracionPromedioS === null ? { sinDato: "Sin llamadas cerradas hoy." } : {})} />
          <StatCard icon={ShoppingBag} label="Pedidos por voz" value={String(hoy.pedidosVoz)} nota={`Resolución ${formatoPct(hoy.tasaResolucionPct)}`} />
          <StatCard icon={Headset} label="Pasadas a una persona" value={String(hoy.escaladas)} nota={`Handoff ${formatoPct(hoy.tasaHandoffPct)}`} />
          <StatCard icon={TriangleAlert} label="Errores de proveedor" value={String(hoy.erroresProveedor)} nota={`Twilio ${hoy.erroresTwilio} · Gemini y otros ${hoy.erroresOtros}`} />
          <StatCard icon={Activity} label="p95 de herramientas" value={formatoMs(hoy.toolP95PeorDiaMs)} {...(hoy.toolP95PeorDiaMs === null ? { sinDato: "Sin llamadas a herramientas hoy." } : {})} />
          <StatCard icon={DollarSign} label="Costo estimado del día" value={formatoMxn(hoy.costoCentavosMxn)} {...(hoy.costoCentavosMxn === null ? { sinDato: "Falta el tipo de cambio para convertir a pesos." } : { nota: `Por llamada ${formatoMxn(hoy.costoPorLlamadaCentavosMxn)}` })} />
          <StatCard icon={DollarSign} label="Costo estimado del mes" value={formatoMxn(mes.costoCentavosMxn)} {...(mes.costoCentavosMxn === null ? { sinDato: "Falta el tipo de cambio para convertir a pesos." } : { nota: notaCosto(mes) ?? `Voz y telefonía, ${mes.llamadas} llamadas` })} />
        </div>
        {mes.costoLlmOrgCentavosMxn !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="costo-llm-org">
            Aparte: LLM de texto de toda la organización este mes (todas las sucursales y canales, no solo voz): {formatoMxn(mes.costoLlmOrgCentavosMxn)}.
          </p>
        ) : null}
      </section>

      <section aria-label="Del mes" className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Mes en curso</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard icon={PhoneCall} label="Llamadas" value={String(mes.llamadas)} />
          <StatCard icon={ShoppingBag} label="Resolución (pedido)" value={formatoPct(mes.tasaResolucionPct)} {...(mes.tasaResolucionPct === null ? { sinDato: "Sin llamadas cerradas." } : { nota: `${mes.pedidosVoz} pedidos` })} />
          <StatCard icon={Headset} label="Handoff a una persona" value={formatoPct(mes.tasaHandoffPct)} {...(mes.tasaHandoffPct === null ? { sinDato: "Sin llamadas cerradas." } : { nota: `${mes.escaladas} llamadas` })} />
          <StatCard icon={TriangleAlert} label="Tasa de error" value={formatoPct(mes.tasaErrorPct)} {...(mes.tasaErrorPct === null ? { sinDato: "Sin llamadas." } : { nota: `${mes.erroresProveedor} errores` })} />
        </div>
      </section>

      <section aria-label="Últimos 14 días" className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Últimos 14 días</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Día</TableHead>
                <TableHead className="text-right">Llamadas</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">A persona</TableHead>
                <TableHead className="text-right">Errores</TableHead>
                <TableHead className="text-right">p95 herr.</TableHead>
                <TableHead className="text-right">Costo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...kpi.serie].reverse().map((d) => (
                <TableRow key={d.fecha} data-dia={d.fecha}>
                  <TableCell>{formatoDia(d.fecha)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.llamadas}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.pedidosVoz}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.escaladas}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.erroresProveedor}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatoMs(d.toolP95Ms)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatoMxn(d.costoCentavosMxn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <FormularioUmbrales umbrales={umbrales} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} onGuardado={reintentar} />

      {alertas.length > 0 ? (
        <section aria-label="Alertas recientes" className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Alertas recientes</h3>
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

function FormularioUmbrales({ umbrales, apiBaseUrl, token, propertyId, fetchImpl, onGuardado }: { readonly umbrales: VozUmbrales; readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined; readonly onGuardado: () => void }) {
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
    const t = tasa.trim() === "" ? null : Number(tasa);
    const m = Number(minimo);
    if (centavos === undefined) return setError("El umbral de costo debe ser un monto en pesos (hasta 2 decimales) o quedar vacío para apagarlo.");
    if (t !== null && (!Number.isInteger(t) || t < 1 || t > 100)) return setError("El umbral de error debe ser un entero de 1 a 100, o quedar vacío para apagarlo.");
    if (!Number.isInteger(m) || m < 1 || m > 1000) return setError("El mínimo de llamadas debe ser un entero de 1 a 1000.");
    setGuardando(true);
    try {
      await updateVozUmbrales(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, { umbralCostoDiaCentavosMxn: centavos, umbralTasaErrorPct: t, minLlamadasTasaError: m });
      setAviso(true);
      onGuardado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los umbrales.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Alertas por umbral</CardTitle>
        <CardDescription>Avisos internos en este panel y en la bitácora. No se envía WhatsApp ni correo. Deja un campo vacío para apagar esa alerta.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="umbral-costo" className="block text-sm font-medium text-foreground mb-1.5">
              Costo del día (MXN)
            </label>
            <Input id="umbral-costo" inputMode="decimal" value={costo} onChange={(e) => setCosto(e.target.value)} placeholder="Ej. 500.00" />
          </div>
          <div>
            <label htmlFor="umbral-tasa" className="block text-sm font-medium text-foreground mb-1.5">
              Errores de proveedor (%)
            </label>
            <Input id="umbral-tasa" inputMode="numeric" value={tasa} onChange={(e) => setTasa(e.target.value)} placeholder="Ej. 20" />
          </div>
          <div>
            <label htmlFor="umbral-minimo" className="block text-sm font-medium text-foreground mb-1.5">
              Mínimo de llamadas para evaluar errores
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
          <Button type="button" onClick={() => void guardar()} disabled={guardando}>
            {guardando ? "Guardando…" : "Guardar umbrales"}
          </Button>
          {aviso ? (
            <span role="status" className="text-xs text-primary">
              Umbrales guardados.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
