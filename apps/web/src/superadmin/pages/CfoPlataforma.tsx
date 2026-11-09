// CFO de la plataforma (cockpit del superadmin): economia por cliente, metricas SaaS, comparativos y
// supuestos/capturas del dueño. Backend real: GET /superadmin/cfo/cockpit (zona CFO, bitacora),
// GET /superadmin/cfo/cockpit/export.csv y PUT /superadmin/cfo/{supuestos,capturas} (step-up).
// Ninguna cifra se calcula aqui: la pagina pinta lo que arma la API; un campo sin dato es «—» con su
// motivo, nunca un cero.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BadgeDollarSign, Banknote, Clock, Download, Gauge, Landmark, Lightbulb, Percent, PiggyBank, Repeat, TrendingUp, Users } from "lucide-react";
import {
  BarrasAgrupadas,
  Button,
  Callout,
  ChartCard,
  DataTable,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  KpiTile,
  NativeSelect,
  PageContainer,
  PageHeader,
  RankingBarras,
  StatusBadge,
  TablaDatosGrafica,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatMoney,
  notify,
  resolverFormato,
} from "@atiende/ui";
import type { DataTableColumna, StatusTone } from "@atiende/ui";
import {
  ETIQUETA_BANDERA,
  ETIQUETA_CAPTURA,
  ETIQUETA_FUENTE,
  descargar,
  fetchCapturas,
  fetchCockpit,
  guardarCaptura,
  guardarSupuesto,
  pedirRecomendaciones,
} from "../lib/cfo-cockpit-client.ts";
import type { Agregado, AlertaCockpit, BanderaCliente, Captura, FilaEconomia, RespuestaCockpit, RespuestaRecomendaciones, TipoCaptura, ValorSupuesto } from "../lib/cfo-cockpit-client.ts";
import { useCarga } from "../lib/use-carga.ts";

type Cockpit = Extract<RespuestaCockpit, { disponible: true }>;

const SIN = "—";
// Formato unico (PL-19): solo los formateadores canonicos de @atiende/ui (formatMoney / resolverFormato).
const numero = resolverFormato("numero");
const usd4 = resolverFormato("usd4");
const fijo = (v: number, dec: number): string => (dec === 0 ? formatMoney(v, 0) : dec === 2 ? formatMoney(v, 2) : dec === 1 ? numero(Math.round(v * 10) / 10) : String(Math.round(v * 10 ** dec) / 10 ** dec));
const mxn = (v: number | null | undefined, dec: 0 | 2 = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? SIN : `$${formatMoney(v, dec)}`);
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? SIN : `${numero(Math.round(v * 10) / 10)} %`);
const num = (v: number | null | undefined, dec = 0): string => (v === null || v === undefined ? SIN : fijo(v, dec));
const usd = (v: number | null | undefined): string => (v === null || v === undefined ? SIN : usd4(v));

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

const TONO_BANDERA: Readonly<Record<BanderaCliente, StatusTone>> = {
  no_rentable: "danger",
  margen_bajo: "warning",
  sobre_el_tope: "danger",
  cerca_del_tope: "warning",
  anomalia_uso: "info",
  pico_costo: "warning",
  pago_fallido: "danger",
};

const TONO_ALERTA: Readonly<Record<AlertaCockpit["severidad"], "danger" | "warning" | "info">> = { critica: "danger", alta: "warning", media: "info" };

function Banderas({ banderas }: { readonly banderas: readonly BanderaCliente[] }) {
  if (banderas.length === 0) return <span className="text-xs text-muted-foreground">{SIN}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {banderas.map((b) => (
        <StatusBadge key={b} tone={TONO_BANDERA[b]} className="px-1.5 py-0 text-2xs">
          {ETIQUETA_BANDERA[b]}
        </StatusBadge>
      ))}
    </span>
  );
}

function poolTexto(f: FilaEconomia): string {
  const partes: string[] = [];
  if (f.poolVoz) partes.push(`voz ${pct(f.poolVoz.pct)}`);
  if (f.poolWa) partes.push(`WA ${pct(f.poolWa.pct)}`);
  return partes.length === 0 ? SIN : partes.join(" · ");
}

const COLUMNAS_CLIENTES: DataTableColumna<FilaEconomia>[] = [
  { id: "cliente", encabezado: "Cliente", principal: true, celda: (f) => <span className="font-medium">{f.nombre}</span>, valorOrden: (f) => f.nombre },
  { id: "plan", encabezado: "Plan", celda: (f) => `${f.planNombre ?? "sin plan"} · ${num(f.sucursales)} suc.`, valorOrden: (f) => f.planNombre ?? "" },
  { id: "mrr", encabezado: "MRR", alinear: "right", celda: (f) => mxn(f.mrrMxn), valorOrden: (f) => f.mrrMxn },
  { id: "llamadas", encabezado: "Llamadas", alinear: "right", celda: (f) => num(f.uso.llamadas), valorOrden: (f) => f.uso.llamadas },
  { id: "min", encabezado: "Min (prom.)", alinear: "right", celda: (f) => (f.uso.minutosVoz === null ? SIN : `${num(f.uso.minutosVoz)} (${num(f.uso.duracionPromedioMin, 1)})`), valorOrden: (f) => f.uso.minutosVoz },
  { id: "wa", encabezado: "Conv. WA", alinear: "right", celda: (f) => num(f.uso.conversacionesWa), valorOrden: (f) => f.uso.conversacionesWa },
  { id: "pedidos", encabezado: "Pedidos", alinear: "right", celda: (f) => num(f.uso.pedidos), valorOrden: (f) => f.uso.pedidos },
  {
    id: "costo",
    encabezado: "Costo real",
    alinear: "right",
    celda: (f) => (
      <span title={Object.entries(f.costo).map(([k, v]) => `${k}: ${usd(v.usd)} (${ETIQUETA_FUENTE[v.fuente]})`).join("\n")}>
        {mxn(f.costoDirectoMxn)}
        {f.infraMxn !== null && <span className="text-muted-foreground"> + {mxn(f.infraMxn)} infra</span>}
      </span>
    ),
    valorOrden: (f) => f.costoDirectoMxn,
  },
  { id: "margen", encabezado: "Margen", alinear: "right", celda: (f) => (f.margenBrutoMxn !== null ? `${mxn(f.margenBrutoMxn)} (${pct(f.margenBrutoPct)})` : f.contribucionMxn !== null ? `${mxn(f.contribucionMxn)} (${pct(f.contribucionPct)}) contrib.` : SIN), valorOrden: (f) => f.margenBrutoPct ?? f.contribucionPct },
  { id: "proy", encabezado: "Cierre proyectado", alinear: "right", celda: (f) => (f.proyeccion.margenMxn === null ? SIN : `${mxn(f.proyeccion.margenMxn)} (${pct(f.proyeccion.margenPct)})`), valorOrden: (f) => f.proyeccion.margenPct },
  { id: "pool", encabezado: "Pool", alinear: "right", celda: poolTexto, valorOrden: (f) => Math.max(f.poolVoz?.pct ?? -1, f.poolWa?.pct ?? -1) },
  { id: "banderas", encabezado: "Estado", celda: (f) => <Banderas banderas={f.banderas} /> },
];

const COLUMNAS_AGREGADO: DataTableColumna<Agregado>[] = [
  { id: "clave", encabezado: "Grupo", principal: true, celda: (a) => <span className="font-medium">{a.clave}</span>, valorOrden: (a) => a.clave },
  { id: "clientes", encabezado: "Clientes", alinear: "right", celda: (a) => `${num(a.clientes)} (${num(a.clientesConMargen)} con margen)`, valorOrden: (a) => a.clientes },
  { id: "ingreso", encabezado: "Ingreso", alinear: "right", celda: (a) => mxn(a.ingresoMxn), valorOrden: (a) => a.ingresoMxn },
  { id: "costo", encabezado: "Costo directo", alinear: "right", celda: (a) => mxn(a.costoDirectoMxn), valorOrden: (a) => a.costoDirectoMxn },
  { id: "contrib", encabezado: "Contribución", alinear: "right", celda: (a) => pct(a.contribucionPct), valorOrden: (a) => a.contribucionPct },
  { id: "bruto", encabezado: "Margen bruto", alinear: "right", celda: (a) => pct(a.margenBrutoPct), valorOrden: (a) => a.margenBrutoPct },
  { id: "dur", encabezado: "Min por llamada", alinear: "right", celda: (a) => num(a.duracionPromedioMin, 1), valorOrden: (a) => a.duracionPromedioMin },
  { id: "wa", encabezado: "Conv. WA", alinear: "right", celda: (a) => num(a.conversacionesWa), valorOrden: (a) => a.conversacionesWa },
  { id: "pedidos", encabezado: "Pedidos", alinear: "right", celda: (a) => num(a.pedidos), valorOrden: (a) => a.pedidos },
];

function Alertas({ c }: { readonly c: Cockpit }) {
  const todas = [...c.alertas.cfo, ...c.alertas.cockpit];
  if (todas.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="cfo-plataforma-alertas">
      {todas.map((a) => (
        <Callout key={a.codigo} tone={TONO_ALERTA[a.severidad]} titulo={a.titulo}>
          {a.organizaciones.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4">
              {a.organizaciones.slice(0, 8).map((o) => (
                <li key={o.organizationId}>
                  {o.nombre}: {o.dato}
                </li>
              ))}
            </ul>
          )}
        </Callout>
      ))}
    </div>
  );
}

function Resumen({ c }: { readonly c: Cockpit }) {
  const s = c.saas;
  const ultimo = s.serie.at(-1);
  const sparkMrr = s.serie.map((p) => p.mrrMxn);
  const ltv = s.ltv.disponible ? s.ltv : null;
  const cac = s.cac.disponible ? s.cac : null;
  const burn = s.burn.disponible ? s.burn : null;
  const fx = s.fx.disponible ? s.fx : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile icono={<BadgeDollarSign className="size-[15px]" strokeWidth={1.75} />} etiqueta="MRR" valor={s.mrrMxn} formato="mxn" sparkline={sparkMrr} nota={`ARR ${mxn(s.arrMxn)} · ${num(s.clientes)} clientes`} />
        <KpiTile icono={<Repeat className="size-[15px]" strokeWidth={1.75} />} etiqueta="NRR del mes" valor={ultimo?.nrrPct ?? null} formato="porcentaje" vacio="Sin foto del mes anterior" nota={`GRR ${pct(ultimo?.grrPct)} · churn de logos ${pct(ultimo?.churnLogosPct)}`} />
        <KpiTile icono={<Percent className="size-[15px]" strokeWidth={1.75} />} etiqueta="Margen bruto" valor={s.margen.margenBrutoPct} formato="porcentaje" vacio="Sin infraestructura capturada" nota={`Contribución ${pct(s.margen.contribucionPct)}`} />
        <KpiTile icono={<Users className="size-[15px]" strokeWidth={1.75} />} etiqueta="ARPA" valor={s.arpaMxn} formato="mxn" nota={`Top 1: ${pct(s.concentracion.top1Pct)} · top 5: ${pct(s.concentracion.top5Pct)}`} />
        <KpiTile icono={<TrendingUp className="size-[15px]" strokeWidth={1.75} />} etiqueta="LTV" valor={ltv?.ltvMxn ?? null} formato="mxn" vacio={s.ltv.disponible ? undefined : s.ltv.razon} nota={ltv ? `${num(ltv.vidaMeses, 1)} meses de vida${ltv.vidaTopada ? " (tope: sin churn medido)" : ""}` : undefined} />
        <KpiTile icono={<Gauge className="size-[15px]" strokeWidth={1.75} />} etiqueta="CAC" valor={cac?.cacMxn ?? null} formato="mxn" vacio={s.cac.disponible ? "Sin clientes nuevos en 3 meses" : s.cac.razon} nota={cac ? `Payback ${num(cac.paybackMeses, 1)} meses · LTV/CAC ${num(cac.ltvCac, 1)}` : undefined} />
        <KpiTile icono={<PiggyBank className="size-[15px]" strokeWidth={1.75} />} etiqueta={burn?.proyectado ? "Resultado del mes (proyectado)" : "Resultado del mes"} valor={burn?.resultadoMxn ?? null} formato="mxn" vacio={s.burn.disponible ? undefined : s.burn.razon} nota={burn ? (burn.burnNetoMxn > 0 ? `Burn ${mxn(burn.burnNetoMxn)} · runway ${burn.runwayMeses === null ? "sin saldo capturado" : `${num(burn.runwayMeses, 1)} meses`}` : "No quema caja") : undefined} />
        <KpiTile icono={<Landmark className="size-[15px]" strokeWidth={1.75} />} etiqueta="Exposición al dólar" valor={fx?.exposicionPct ?? null} formato="porcentaje" vacio={s.fx.disponible ? "Sin ingreso" : s.fx.razon} nota={fx ? `${num(fx.mxnPorUsd, 4)} MXN/USD (${fx.fuente ?? "sin fuente"}) · ${pct(fx.movimiento30dPct)} vs cierre previo · +10 % = −${mxn(fx.sensibilidad10PctMxn)}` : undefined} />
      </div>
      <Alertas c={c} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard titulo="MRR por mes" subtitulo="Foto mensual de ingreso; el mes en curso, en vivo" tamano="M">
          <BarrasAgrupadas series={[{ id: "mrr", etiqueta: "MRR" }]} grupos={s.serie.map((p) => ({ etiqueta: p.mes, valores: { mrr: p.mrrMxn } }))} formato={(v) => mxn(v)} sinDatos="Aún no hay fotos mensuales de MRR" />
          <TablaDatosGrafica titulo="MRR por mes" encabezados={["Mes", "MRR", "Clientes", "ARPA"]} filas={s.serie.map((p) => [p.mes, mxn(p.mrrMxn), num(p.clientes), mxn(p.arpaMxn)])} />
        </ChartCard>
        <ChartCard titulo="Puente de MRR" subtitulo="Nuevo, expansión, contracción y churn contra el mes anterior" tamano="M">
          <BarrasAgrupadas
            series={[
              { id: "nuevo", etiqueta: "Nuevo" },
              { id: "expansion", etiqueta: "Expansión" },
              { id: "contraccion", etiqueta: "Contracción" },
              { id: "churn", etiqueta: "Churn" },
            ]}
            grupos={s.serie.filter((p) => p.nuevoMxn !== null).map((p) => ({ etiqueta: p.mes, valores: { nuevo: p.nuevoMxn, expansion: p.expansionMxn, contraccion: p.contraccionMxn, churn: p.churnMxn } }))}
            formato={(v) => mxn(v)}
            sinDatos="Hace falta la foto de dos meses seguidos"
          />
          <TablaDatosGrafica
            titulo="Puente de MRR"
            encabezados={["Mes", "Nuevo", "Expansión", "Contracción", "Churn", "NRR", "GRR"]}
            filas={s.serie.map((p) => [p.mes, mxn(p.nuevoMxn), mxn(p.expansionMxn), mxn(p.contraccionMxn), mxn(p.churnMxn), pct(p.nrrPct), pct(p.grrPct)])}
          />
        </ChartCard>
      </div>
      <ChartCard titulo="Cohortes" subtitulo="% de clientes y de MRR inicial que siguen aportando, por mes de alta" tamano="M">
        {s.cohortes.length === 0 ? (
          <EstadoVacio icon={Clock} titulo="Sin cohortes todavía" mensaje="Aparecen cuando hay fotos mensuales de MRR." />
        ) : (
          <TablaDatosGrafica
            titulo="Cohortes"
            etiqueta="Ver cohortes"
            encabezados={["Cohorte", "Clientes", ...s.cohortes[0]!.meses.map((_, i) => `M${i}`)]}
            filas={s.cohortes.map((co) => [co.cohorte, num(co.clientesIniciales), ...co.meses.map((m) => `${pct(m.logosPct)} / ${pct(m.mrrPct)}`)])}
          />
        )}
      </ChartCard>
    </div>
  );
}

function Comparativos({ c }: { readonly c: Cockpit }) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const opciones = c.economia.map((f) => ({ id: f.organizationId, nombre: f.nombre }));
  const seleccion = [a, b].map((id) => c.economia.find((f) => f.organizationId === id)).filter((f): f is FilaEconomia => f !== undefined);
  const metricas: ReadonlyArray<readonly [string, (f: FilaEconomia) => string]> = [
    ["MRR", (f) => mxn(f.mrrMxn)],
    ["Llamadas", (f) => num(f.uso.llamadas)],
    ["Minutos por llamada", (f) => num(f.uso.duracionPromedioMin, 1)],
    ["Conversaciones WA", (f) => num(f.uso.conversacionesWa)],
    ["Pedidos", (f) => num(f.uso.pedidos)],
    ["Costo directo", (f) => mxn(f.costoDirectoMxn)],
    ["Margen", (f) => pct(f.margenBrutoPct ?? f.contribucionPct)],
    ["Margen proyectado", (f) => pct(f.proyeccion.margenPct)],
    ["Pool", poolTexto],
  ];
  const presupuesto = c.saas.presupuesto;
  return (
    <div className="space-y-3">
      <ChartCard titulo="Margen por vertical" subtitulo="Solo clientes con ingreso y costo conocidos" tamano="M">
        <RankingBarras filas={c.agregados.porVertical.map((v) => ({ id: v.clave, etiqueta: v.clave, valor: v.margenBrutoPct ?? v.contribucionPct }))} formato={(v) => pct(v)} sinDatos="Sin margen calculable" />
      </ChartCard>
      <DataTable etiqueta="Comparativo por vertical" columnas={COLUMNAS_AGREGADO} filas={c.agregados.porVertical} obtenerId={(x) => x.clave} paginacion={false} />
      <DataTable etiqueta="Comparativo por plan" columnas={COLUMNAS_AGREGADO} filas={c.agregados.porPlan} obtenerId={(x) => x.clave} paginacion={false} />
      <ChartCard titulo="Cliente contra cliente" tamano="M">
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            [a, setA, "Cliente A"],
            [b, setB, "Cliente B"],
          ].map(([valor, set, etiqueta]) => (
            <FormField key={etiqueta as string} label={etiqueta as string}>
              {(p) => (
                <NativeSelect {...p} value={valor as string} onChange={(e) => (set as (v: string) => void)(e.target.value)}>
                  <option value="">Elige un cliente</option>
                  {opciones.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nombre}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          ))}
        </div>
        {seleccion.length === 0 ? (
          <p className="text-xs text-muted-foreground">Elige uno o dos clientes para compararlos.</p>
        ) : (
          <TablaDatosGrafica titulo="Cliente contra cliente" etiqueta="Ver comparación" encabezados={["Métrica", ...seleccion.map((f) => f.nombre)]} filas={metricas.map(([m, fn]) => [m, ...seleccion.map(fn)])} />
        )}
      </ChartCard>
      <ChartCard titulo="Presupuesto contra real" subtitulo="Ingreso y costo por mes; captura el presupuesto en Supuestos y capturas" tamano="M">
        <BarrasAgrupadas
          series={[
            { id: "pi", etiqueta: "Ingreso presupuestado" },
            { id: "ri", etiqueta: "Ingreso real" },
            { id: "pc", etiqueta: "Costo presupuestado" },
            { id: "rc", etiqueta: "Costo real" },
          ]}
          grupos={presupuesto.map((p) => ({ etiqueta: p.mes, valores: { pi: p.ingresoPresupuestoMxn, ri: p.ingresoRealMxn, pc: p.costoPresupuestoMxn, rc: p.costoRealMxn } }))}
          formato={(v) => mxn(v)}
          sinDatos="Sin presupuesto capturado"
        />
      </ChartCard>
    </div>
  );
}

export function Recomendaciones({ mes, apiBaseUrl, token }: { readonly mes: string; readonly apiBaseUrl: string; readonly token: string }) {
  const [estado, setEstado] = useState<{ readonly cargando: boolean; readonly datos: RespuestaRecomendaciones | null; readonly error: string | null }>({ cargando: false, datos: null, error: null });
  async function generar() {
    setEstado({ cargando: true, datos: null, error: null });
    try {
      setEstado({ cargando: false, datos: await pedirRecomendaciones(apiBaseUrl, token, mes), error: null });
    } catch (err) {
      setEstado({ cargando: false, datos: null, error: err instanceof Error ? err.message : "No se pudieron generar." });
    }
  }
  const d = estado.datos;
  const hechos = new Map((d?.hechos ?? []).map((h) => [h.id, h.texto]));
  return (
    <div className="space-y-3">
      <ChartCard
        titulo="Recomendaciones"
        subtitulo="Las cifras se calculan en el servidor; el modelo solo las explica y prioriza. Una recomendación con una cifra que no está en sus hechos se descarta."
        tamano="M"
        accion={
          <Button size="sm" onClick={() => void generar()} disabled={estado.cargando}>
            <Lightbulb className="size-4" /> {d ? "Volver a generar" : "Generar"}
          </Button>
        }
      >
        {estado.cargando ? (
          <EstadoCargando />
        ) : estado.error ? (
          <EstadoError compacto mensaje={estado.error} onReintentar={() => void generar()} />
        ) : !d ? (
          <p className="text-xs text-muted-foreground">Genera las recomendaciones del mes. Sin modelo disponible salen de reglas deterministas.</p>
        ) : !d.disponible ? (
          <Callout tone="warning" titulo="No disponible aún">{d.mensaje}</Callout>
        ) : (d.recomendaciones ?? []).length === 0 ? (
          <EstadoVacio icon={Lightbulb} titulo="Sin recomendaciones" mensaje="No hay nada que destacar este mes con los datos que existen." />
        ) : (
          <div className="space-y-2" data-testid="cfo-recomendaciones">
            <p className="text-xs text-muted-foreground">
              {d.fuente === "modelo" ? `Redactadas por ${d.modelo ?? "el modelo"}` : "Reglas deterministas (sin modelo)"}
              {d.descartadas ? ` · ${d.descartadas} descartadas por citar cifras que no están en los hechos` : ""}
            </p>
            {(d.recomendaciones ?? []).map((r, i) => (
              <Callout key={`${i}-${r.titulo}`} tone={r.prioridad <= 2 ? "warning" : "info"} titulo={`${r.prioridad}. ${r.titulo}`}>
                <p>{r.explicacion}</p>
                <p className="font-medium">{r.accion}</p>
                <p className="text-xs text-muted-foreground">De dónde sale: {r.hechos.map((h) => hechos.get(h) ?? h).join(" · ")}</p>
              </Callout>
            ))}
          </div>
        )}
      </ChartCard>
      <Callout tone="info" titulo="Pregúntale a tus datos">
        El Copiloto de superadmin ya responde con las mismas cifras de esta pantalla (herramientas «Economía por cliente» y «Métricas SaaS»); cada consulta financiera pide MFA y queda en la bitácora de la zona CFO.{" "}
        <Link to="/superadmin/copiloto" className="font-medium text-primary underline-offset-2 hover:underline">
          Abrir el Copiloto
        </Link>
      </Callout>
    </div>
  );
}

function filaSupuesto(etiqueta: string, v: ValorSupuesto | null, unidad: string): readonly (string | number | null)[] {
  return [etiqueta, v === null ? "sin dato" : `${num(v.valor, 4)} ${unidad}`, v === null ? "Captúralo con su fuente" : `${v.origen} · ${v.fuente}`];
}

function SupuestosYCapturas({ c, apiBaseUrl, token, onCambio }: { readonly c: Cockpit; readonly apiBaseUrl: string; readonly token: string; readonly onCambio: () => void }) {
  const caps = useCarga(() => fetchCapturas(apiBaseUrl, token), [apiBaseUrl, token], "No se pudieron cargar las capturas.");
  const [abierto, setAbierto] = useState<"supuesto" | "captura" | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const s = c.supuestos;
  const filas = [
    ...Object.entries(s.vozUsdMinuto).map(([prov, v]) => filaSupuesto(`Voz (${prov === "*" ? "cualquier proveedor" : prov})`, v, "USD/min")),
    ...Object.entries(s.telefoniaUsdMinuto).map(([prov, v]) => filaSupuesto(`Telefonía (${prov})`, v, "USD/min")),
    filaSupuesto("LLM por conversación de WhatsApp", s.llmUsdConversacionWa, "USD"),
    filaSupuesto("Meta por conversación de WhatsApp", s.whatsappUsdConversacion, "USD"),
    filaSupuesto("Umbral de margen", s.umbralMargenPct, "%"),
    filaSupuesto("Aviso de pool", s.umbralPoolPct, "%"),
    filaSupuesto("Pico de costo", s.umbralPicoCostoPct, "%"),
    filaSupuesto("Movimiento del dólar", s.umbralFxPct, "%"),
    filaSupuesto("Tope de vida del LTV", s.ltvMesesTope, "meses"),
  ];

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      if (abierto === "supuesto") {
        const valor = form.valor?.trim() === "" || form.valor === undefined ? null : Number(form.valor);
        if (valor !== null && !Number.isFinite(valor)) throw new Error("El valor debe ser un número.");
        await guardarSupuesto(apiBaseUrl, token, { clave: form.clave ?? "voz_usd_minuto", proveedor: form.proveedor ?? "*", valor, ...(valor === null ? {} : { fuente: form.fuente ?? "" }) });
      } else {
        const monto = form.monto?.trim() === "" || form.monto === undefined ? null : Number(form.monto);
        if (monto !== null && !Number.isFinite(monto)) throw new Error("El monto debe ser un número.");
        await guardarCaptura(apiBaseUrl, token, { mes: form.mes ?? c.mes, tipo: (form.tipo as TipoCaptura) ?? "gasto_fijo", concepto: form.concepto ?? "", montoMxn: monto });
      }
      notify.success("Guardado.");
      setAbierto(null);
      setForm({});
      caps.recargar();
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-3">
      <ChartCard titulo="Supuestos de costo unitario y umbrales" subtitulo="Lo capturado sobrescribe el valor medido; borrar el valor vuelve al medido" tamano="M" accion={<Button size="sm" variant="outline" onClick={() => setAbierto("supuesto")}>Cambiar un supuesto</Button>}>
        <TablaDatosGrafica titulo="Supuestos" etiqueta="Ver supuestos" encabezados={["Supuesto", "Valor", "Origen y fuente"]} filas={filas} />
      </ChartCard>
      <ChartCard titulo="Capturas del dueño" subtitulo="Gasto fijo, marketing, saldo de caja y presupuesto, en pesos sin IVA" tamano="M" accion={<Button size="sm" variant="outline" onClick={() => setAbierto("captura")}>Capturar</Button>}>
        {caps.carga.estado === "cargando" ? (
          <EstadoCargando />
        ) : caps.carga.estado === "error" ? (
          <EstadoError compacto mensaje={caps.carga.mensaje} onReintentar={caps.recargar} />
        ) : !caps.carga.data.disponible ? (
          <Callout tone="warning" titulo="No disponible aún">{caps.carga.data.mensaje}</Callout>
        ) : (
          <DataTable<Captura>
            etiqueta="Capturas del dueño"
            columnas={[
              { id: "mes", encabezado: "Mes", celda: (x) => x.mes.slice(0, 7), valorOrden: (x) => x.mes },
              { id: "tipo", encabezado: "Tipo", celda: (x) => ETIQUETA_CAPTURA[x.tipo], valorOrden: (x) => x.tipo },
              { id: "concepto", encabezado: "Concepto", principal: true, celda: (x) => x.concepto },
              { id: "monto", encabezado: "Monto", alinear: "right", celda: (x) => mxn(x.montoMxnCentavos / 100, 2), valorOrden: (x) => x.montoMxnCentavos },
            ]}
            filas={caps.carga.data.capturas}
            obtenerId={(x) => `${x.mes}|${x.tipo}|${x.concepto}`}
            vacio={{ mensaje: "Todavía no hay capturas. Empieza por los gastos fijos y el saldo de caja." }}
          />
        )}
      </ChartCard>
      <FormDialog
        open={abierto !== null}
        onOpenChange={(o) => {
          if (!o) {
            setAbierto(null);
            setError(null);
          }
        }}
        titulo={abierto === "supuesto" ? "Cambiar un supuesto" : "Capturar un dato del mes"}
        subtitulo="Exige verificar tu código MFA. Queda en la bitácora."
        onGuardar={() => void guardar()}
        guardando={guardando}
        anchoClase="max-w-2xl"
      >
        <div className="space-y-3">
          {abierto === "supuesto" ? (
            <>
              <FormField label="Supuesto">
                {(p) => (
                  <NativeSelect {...p} value={form.clave ?? "voz_usd_minuto"} onChange={set("clave")}>
                    <option value="voz_usd_minuto">Voz, USD por minuto</option>
                    <option value="telefonia_usd_minuto">Telefonía, USD por minuto</option>
                    <option value="llm_usd_conversacion_wa">LLM, USD por conversación de WhatsApp</option>
                    <option value="whatsapp_usd_conversacion">Meta, USD por conversación de WhatsApp</option>
                    <option value="umbral_margen_pct">Umbral de margen (%)</option>
                    <option value="umbral_pool_pct">Aviso de pool (%)</option>
                    <option value="umbral_pico_costo_pct">Pico de costo (%)</option>
                    <option value="umbral_fx_pct">Movimiento del dólar (%)</option>
                    <option value="ltv_meses_tope">Tope de vida del LTV (meses)</option>
                  </NativeSelect>
                )}
              </FormField>
              <FormField label="Proveedor" hint="Solo voz y telefonía: elevenlabs-agents, gemini-3.8-live, gpt-live-1 o * para todos.">
                {(p) => <Input {...p} value={form.proveedor ?? "*"} onChange={set("proveedor")} />}
              </FormField>
              <FormField label="Valor" hint="Déjalo vacío para volver al valor medido.">
                {(p) => <Input {...p} inputMode="decimal" value={form.valor ?? ""} onChange={set("valor")} />}
              </FormField>
              <FormField label="Fuente" hint="De dónde sale: factura, medición, decisión.">
                {(p) => <Input {...p} value={form.fuente ?? ""} onChange={set("fuente")} />}
              </FormField>
            </>
          ) : (
            <>
              <FormField label="Tipo">
                {(p) => (
                  <NativeSelect {...p} value={form.tipo ?? "gasto_fijo"} onChange={set("tipo")}>
                    {(Object.keys(ETIQUETA_CAPTURA) as TipoCaptura[]).map((t) => (
                      <option key={t} value={t}>
                        {ETIQUETA_CAPTURA[t]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
              <FormField label="Mes (AAAA-MM)" hint="Solo el presupuesto admite meses futuros.">
                {(p) => <Input {...p} value={form.mes ?? c.mes} onChange={set("mes")} />}
              </FormField>
              <FormField label="Concepto" hint="Por ejemplo: Nómina, Renta, Meta Ads, Banco.">
                {(p) => <Input {...p} value={form.concepto ?? ""} onChange={set("concepto")} />}
              </FormField>
              <FormField label="Monto en pesos" hint="Déjalo vacío para borrar el concepto.">
                {(p) => <Input {...p} inputMode="decimal" value={form.monto ?? ""} onChange={set("monto")} />}
              </FormField>
            </>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </FormDialog>
    </div>
  );
}

export function SuperAdminCfoPlataformaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [mes, setMes] = useState(mesActual());
  const { carga, recargar } = useCarga(() => fetchCockpit(apiBaseUrl, token, mes), [apiBaseUrl, token, mes], "No se pudo cargar el CFO de la plataforma.");
  const [exportando, setExportando] = useState(false);
  const meses = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i += 1) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    return out;
  }, []);

  async function exportar(tipo: "csv" | "xlsx" | "pdf") {
    setExportando(true);
    const ruta = tipo === "pdf" ? "informe.pdf" : `export.${tipo}`;
    const nombre = tipo === "csv" ? `cfo-economia-clientes-${mes}.csv` : tipo === "xlsx" ? `cfo-plataforma-${mes}.xlsx` : `resumen-inversionistas-${mes}.pdf`;
    try {
      await descargar(apiBaseUrl, token, `/superadmin/cfo/cockpit/${ruta}?mes=${encodeURIComponent(mes)}`, nombre);
    } catch {
      notify.error("No se pudo descargar el archivo.");
    } finally {
      setExportando(false);
    }
  }

  const acciones = (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect aria-label="Mes" value={mes} onChange={(e) => setMes(e.target.value)} className="w-32">
        {meses.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </NativeSelect>
      <Button size="sm" variant="outline" onClick={() => void exportar("csv")} disabled={exportando}>
        <Download className="size-4" /> CSV
      </Button>
      <Button size="sm" variant="outline" onClick={() => void exportar("xlsx")} disabled={exportando}>
        <Download className="size-4" /> Excel
      </Button>
      <Button size="sm" variant="outline" onClick={() => void exportar("pdf")} disabled={exportando}>
        <Download className="size-4" /> Resumen para inversionistas (PDF)
      </Button>
    </div>
  );

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader titulo="CFO de la plataforma" descripcion="Economía por cliente, métricas SaaS, comparativos y supuestos. Las cifras se calculan en el servidor; lo que no tiene fuente se muestra como «—»." acciones={acciones} />
      {carga.estado === "cargando" ? (
        <EstadoCargando />
      ) : carga.estado === "error" ? (
        <EstadoError mensaje={carga.mensaje} onReintentar={recargar} />
      ) : !carga.data.disponible ? (
        <EstadoVacio icon={Banknote} titulo="El CFO de la plataforma aún no está disponible" mensaje={carga.data.mensaje} />
      ) : (
        <Contenido c={carga.data} apiBaseUrl={apiBaseUrl} token={token} onCambio={recargar} />
      )}
    </PageContainer>
  );
}

function Contenido({ c, apiBaseUrl, token, onCambio }: { readonly c: Cockpit; readonly apiBaseUrl: string; readonly token: string; readonly onCambio: () => void }) {
  return (
    <div className="space-y-3">
      {c.faltantes.length > 0 && (
        <Callout tone="warning" titulo="Para que el CFO esté completo" data-testid="cfo-plataforma-faltantes">
          <ul className="list-disc space-y-0.5 pl-4">
            {c.faltantes.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Callout>
      )}
      {c.enCurso && (
        <p className="text-xs text-muted-foreground">
          <AlertTriangle className="mr-1 inline size-3.5" />
          Mes en curso: {c.diasTranscurridos} de {c.diasDelMes} días. La proyección al cierre extrapola el uso; la cuota recurrente no.
        </p>
      )}
      <Tabs defaultValue="resumen">
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="comparativos">Comparativos</TabsTrigger>
          <TabsTrigger value="recomendaciones">Recomendaciones</TabsTrigger>
          <TabsTrigger value="supuestos">Supuestos y capturas</TabsTrigger>
        </TabsList>
        <TabsContent value="resumen">
          <Resumen c={c} />
        </TabsContent>
        <TabsContent value="clientes">
          <DataTable etiqueta="Economía por cliente" columnas={COLUMNAS_CLIENTES} filas={c.economia} obtenerId={(f) => f.organizationId} paginacion={{ tamano: 25 }} vacio={{ mensaje: "No hay organizaciones (las demo no cuentan)." }} />
        </TabsContent>
        <TabsContent value="comparativos">
          <Comparativos c={c} />
        </TabsContent>
        <TabsContent value="recomendaciones">
          <Recomendaciones mes={c.mes} apiBaseUrl={apiBaseUrl} token={token} />
        </TabsContent>
        <TabsContent value="supuestos">
          <SupuestosYCapturas c={c} apiBaseUrl={apiBaseUrl} token={token} onCambio={onCambio} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
