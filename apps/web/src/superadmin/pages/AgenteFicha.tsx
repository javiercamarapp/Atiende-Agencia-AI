// Fichas de agente (SA-L-09): "Agente extractor", "Agente de conciliación" y "Agente de WhatsApp y voz". Backend real:
// GET /superadmin/agentes/:ficha (apps/api/src/routes/superadmin-agentes-fichas.ts, migracion 0049). Solo lectura: ningun control
// escribe; el interruptor de cada agente sigue en el Panel de agentes e Interruptores.
// Cada bloque maneja cargando, error y "no disponible aun" (base sin la 0049); un campo `null` se pinta "—" con su razon, nunca 0.
// Nombres de las fichas pendientes de confirmacion de Javier (ver cuerpo del PR).
import type { ReactNode } from "react";
import { BadgeDollarSign, FileSearch, MessageCircle, Phone, Scale, Workflow } from "lucide-react";
import { BarChartSimple, Callout, ChartCard, DataTable, EstadoCargando, EstadoError, EstadoVacio, PageContainer, PageHeader, StatCard } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { NOMBRE_VERTICAL } from "../lib/consola-client.ts";
import { fetchFicha, fmtDecimal, fmtEntero, fmtPct, fmtUsd } from "../lib/fichas-client.ts";
import type { FichaBase, FichaConciliacion, FichaExtractor, FichaModeloFila, FichaWhatsapp, FichaWhatsappVertical } from "../lib/fichas-client.ts";
import { useCarga } from "../lib/use-carga.ts";
import type { Carga } from "../lib/use-carga.ts";

type Icono = typeof BadgeDollarSign;
type Medida = { readonly value: string; readonly nota?: string } | { readonly sinDato: string };
const nulo = (razon: string | undefined, porDefecto: string): { readonly sinDato: string } => ({ sinDato: razon ?? porDefecto });

/** Una `StatCard` a partir de la ficha: dato real, "Cargando…", error del bloque o "—" + razon del campo. Nunca un cero inventado. */
function tarjeta<F extends FichaBase>(ficha: Carga<F>, clave: string, icon: Icono, label: string, medir: (f: F) => Medida) {
  if (ficha.estado === "cargando") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato="Cargando…" />;
  if (ficha.estado === "error") return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={`No se pudo cargar: ${ficha.mensaje}`} />;
  const m = medir(ficha.data);
  if ("sinDato" in m) return <StatCard key={clave} variante="neutra" icon={icon} label={label} value="—" sinDato={m.sinDato} />;
  return <StatCard key={clave} variante="neutra" icon={icon} label={label} value={m.value} nota={m.nota} />;
}

const COLUMNAS_MODELO: readonly DataTableColumna<FichaModeloFila>[] = [
  { id: "modelo", encabezado: "Modelo", principal: true, valorOrden: (m) => m.modelo, celda: (m) => <span className="font-mono text-xs">{m.modelo}</span> },
  { id: "proveedor", encabezado: "Proveedor", valorOrden: (m) => m.proveedor, celda: (m) => <span className="text-muted-foreground">{m.proveedor}</span> },
  { id: "llamadas", encabezado: "Llamadas", alinear: "right", valorOrden: (m) => m.llamadas, celda: (m) => fmtEntero(m.llamadas) },
  { id: "fallbacks", encabezado: "Fallbacks", alinear: "right", valorOrden: (m) => m.fallbacks, celda: (m) => fmtEntero(m.fallbacks) },
  { id: "tokens", encabezado: "Tokens (ent. / sal.)", alinear: "right", celda: (m) => `${fmtEntero(m.tokensEntrada)} / ${fmtEntero(m.tokensSalida)}` },
  { id: "costo", encabezado: "Costo", alinear: "right", valorOrden: (m) => m.costoUsd, celda: (m) => fmtUsd(m.costoUsd) },
];

const COLUMNAS_VERTICAL: readonly DataTableColumna<FichaWhatsappVertical>[] = [
  { id: "vertical", encabezado: "Vertical", principal: true, valorOrden: (v) => v.vertical, celda: (v) => <span className="font-medium text-foreground">{NOMBRE_VERTICAL[v.vertical] ?? v.vertical}</span> },
  { id: "llamadas", encabezado: "Llamadas", alinear: "right", valorOrden: (v) => v.llamadas, celda: (v) => fmtEntero(v.llamadas) },
  { id: "escaladas", encabezado: "Escaladas", alinear: "right", valorOrden: (v) => v.escaladas, celda: (v) => fmtEntero(v.escaladas) },
  { id: "costoLlm", encabezado: "Costo LLM", alinear: "right", valorOrden: (v) => v.costoLlmUsd, celda: (v) => fmtUsd(v.costoLlmUsd) },
  {
    id: "conversaciones",
    encabezado: "Conversaciones",
    alinear: "right",
    valorOrden: (v) => v.conversaciones.valor,
    celda: (v) => (v.conversaciones.valor === null ? <span title={v.conversaciones.razon} className="text-muted-foreground">—</span> : fmtEntero(v.conversaciones.valor)),
  },
  {
    id: "minutos",
    encabezado: "Minutos de voz",
    alinear: "right",
    valorOrden: (v) => v.minutosVoz.valor,
    celda: (v) => (v.minutosVoz.valor === null ? <span title={v.minutosVoz.razon} className="text-muted-foreground">—</span> : fmtDecimal(v.minutosVoz.valor)),
  },
  {
    id: "costoVoz",
    encabezado: "Costo de voz",
    alinear: "right",
    valorOrden: (v) => v.costoVozUsd.valor,
    celda: (v) => (v.costoVozUsd.valor === null ? <span title={v.costoVozUsd.razon} className="text-muted-foreground">—</span> : fmtUsd(v.costoVozUsd.valor)),
  },
];

function Bloque({ ficha, onReintentar, children }: { readonly ficha: Carga<FichaBase>; readonly onReintentar: () => void; readonly children: (f: FichaBase) => ReactNode }) {
  if (ficha.estado === "cargando") return <EstadoCargando etiqueta="Cargando…" lineas={2} />;
  if (ficha.estado === "error") return <EstadoError compacto mensaje={`No se pudo cargar: ${ficha.mensaje}`} onReintentar={onReintentar} />;
  return <>{children(ficha.data)}</>;
}

function Comunes({ ficha, onReintentar }: { readonly ficha: Carga<FichaBase>; readonly onReintentar: () => void }) {
  return (
    <>
      <ChartCard titulo="Llamadas al modelo por día" subtitulo="últimos 7 días" tamano="S">
        <Bloque ficha={ficha} onReintentar={onReintentar}>
          {(f) =>
            f.serie7d.valor ? (
              <BarChartSimple datos={f.serie7d.valor.map((p) => ({ dia: p.dia, valor: p.llamadas }))} etiquetaValor={(v) => `${fmtEntero(v)} llamadas`} />
            ) : (
              <p className="text-xs text-muted-foreground">{f.serie7d.razon ?? "Sin dato de actividad."}</p>
            )
          }
        </Bloque>
      </ChartCard>
      <ChartCard titulo="Costo por modelo" subtitulo="últimos 30 días, US$" tamano="S">
        <Bloque ficha={ficha} onReintentar={onReintentar}>
          {(f) =>
            f.costoPorModelo.valor ? (
              <DataTable
                etiqueta="Costo por modelo"
                columnas={COLUMNAS_MODELO}
                filas={f.costoPorModelo.valor}
                obtenerId={(m) => `${m.proveedor}|${m.modelo}`}
                paginacion={false}
                vacio={{ titulo: "Sin consumo", mensaje: "Este agente no registra llamadas al modelo en los últimos 30 días." }}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{f.costoPorModelo.razon ?? "Sin dato de costo por modelo."}</p>
            )
          }
        </Bloque>
      </ChartCard>
    </>
  );
}

function Alerta({ ficha }: { readonly ficha: Carga<FichaBase> }) {
  if (ficha.estado !== "ok" || ficha.data.disponible) return null;
  return (
    <Callout tone="warning" titulo="Todavía no disponible en esta base">
      {ficha.data.mensaje ?? "Falta aplicar la migración 0049_superadmin_fichas_agente."} Mientras tanto los agentes siguen funcionando como antes.
    </Callout>
  );
}

const llamadasMedida = (f: FichaBase): Medida => {
  if (f.llamadas.valor === null) return nulo(f.llamadas.razon, "Sin dato de llamadas.");
  const fb = f.fallbacks.valor;
  return { value: fmtEntero(f.llamadas.valor), nota: fb ? `${fmtEntero(fb.total)} con fallback${fb.tasaPct === null ? "" : ` · ${fmtPct(fb.tasaPct)}`} — histórico` : "histórico" };
};
const gastadoMedida = (f: FichaBase): Medida => {
  const g = f.gastado.valor;
  if (g === null) return nulo(f.gastado.razon, "Sin dato de gasto.");
  return { value: fmtUsd(g.totalUsd), nota: g.vozUsd === null ? "LLM — histórico" : `LLM ${fmtUsd(g.llmUsd)} · voz ${fmtUsd(g.vozUsd)} — histórico` };
};

export interface AgenteFichaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
}

function Cabecera({ nombre, descripcion }: { readonly nombre: string; readonly descripcion: string }) {
  return <PageHeader titulo={nombre} descripcion={descripcion} />;
}

export function SuperAdminAgenteExtractorPage({ apiBaseUrl, token }: AgenteFichaProps) {
  const { carga, recargar } = useCarga<FichaExtractor>(() => fetchFicha(apiBaseUrl, token, "extractor"), [apiBaseUrl, token], "No se pudo cargar la ficha del agente.");
  return (
    <PageContainer>
      <Cabecera nombre="Agente extractor" descripcion="Lee los documentos de las bases de licitación y extrae sus requisitos. Cifras reales del gateway de modelos y de licitaciones." />
      <Alerta ficha={carga} />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {tarjeta(carga, "gastado", BadgeDollarSign, "Gastado", gastadoMedida)}
        {tarjeta(carga, "llamadas", Workflow, "Llamadas", llamadasMedida)}
        {tarjeta(carga, "documentos", FileSearch, "Documentos extraídos", (f) => {
          const d = f.documentosExtraidos.valor;
          if (!d) return nulo(f.documentosExtraidos.razon, "Sin dato de documentos extraídos.");
          return { value: fmtEntero(d.documentos), nota: `${fmtEntero(d.requisitos)} requisitos · ${fmtEntero(d.licitaciones)} licitaciones` };
        })}
      </div>
      <ChartCard titulo="Precisión del extractor" subtitulo="contra verdad de terreno" tamano="S">
        <Bloque ficha={carga} onReintentar={recargar}>
          {(f) => <EstadoVacio compacto titulo="Sin verdad de terreno todavía" mensaje={(f as FichaExtractor).precision.razon ?? "La precisión no está medida."} />}
        </Bloque>
      </ChartCard>
      <Comunes ficha={carga} onReintentar={recargar} />
    </PageContainer>
  );
}

export function SuperAdminAgenteConciliacionPage({ apiBaseUrl, token }: AgenteFichaProps) {
  const { carga, recargar } = useCarga<FichaConciliacion>(() => fetchFicha(apiBaseUrl, token, "conciliacion"), [apiBaseUrl, token], "No se pudo cargar la ficha del agente.");
  return (
    <PageContainer>
      <Cabecera nombre="Agente de conciliación" descripcion="Sugiere la conciliación de movimientos bancarios con facturas cuando el motor determinista no alcanza. Cifras reales del gateway y de despachos." />
      <Alerta ficha={carga} />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {tarjeta(carga, "gastado", BadgeDollarSign, "Gastado", gastadoMedida)}
        {tarjeta(carga, "llamadas", Workflow, "Llamadas", llamadasMedida)}
        {tarjeta(carga, "movimientos", Scale, "Movimientos conciliados", (f) => {
          const m = f.movimientosConciliados.valor;
          if (!m) return nulo(f.movimientosConciliados.razon, "Sin dato de movimientos conciliados.");
          return { value: fmtEntero(m.total), nota: `${fmtEntero(m.porMotor)} motor · ${fmtEntero(m.porLlmAprobado)} IA aprobada · ${fmtEntero(m.porManual)} manual · ${fmtEntero(m.sugerenciasPendientes)} sugerencias pendientes` };
        })}
      </div>
      <Comunes ficha={carga} onReintentar={recargar} />
    </PageContainer>
  );
}

export function SuperAdminAgenteWhatsappPage({ apiBaseUrl, token }: AgenteFichaProps) {
  const { carga, recargar } = useCarga<FichaWhatsapp>(() => fetchFicha(apiBaseUrl, token, "whatsapp"), [apiBaseUrl, token], "No se pudo cargar la ficha del agente.");
  return (
    <PageContainer>
      <Cabecera nombre="Agente de WhatsApp y voz" descripcion="Atiende las conversaciones de WhatsApp y las llamadas de voz de todas las verticales. Cifras reales del gateway y del consumo de voz." />
      <Alerta ficha={carga} />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {tarjeta(carga, "gastado", BadgeDollarSign, "Gastado", gastadoMedida)}
        {tarjeta(carga, "llamadas", Workflow, "Llamadas al modelo", llamadasMedida)}
        {tarjeta(carga, "conversaciones", MessageCircle, "Conversaciones", (f) => {
          if (f.conversaciones.valor === null) return nulo(f.conversaciones.razon, "Sin dato de conversaciones.");
          return { value: fmtEntero(f.conversaciones.valor), nota: "histórico, solo conteo" };
        })}
        {tarjeta(carga, "voz", Phone, "Minutos de voz", (f) => {
          if (f.minutosVoz.valor === null) return nulo(f.minutosVoz.razon, "Sin dato de voz.");
          return { value: fmtDecimal(f.minutosVoz.valor), nota: "histórico, de usage_cost_event" };
        })}
      </div>
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-3">
        <ChartCard titulo="Tasa de escalamiento" subtitulo="llamadas escaladas / llamadas totales" tamano="S">
          <Bloque ficha={carga} onReintentar={recargar}>
            {(base) => {
              const e = (base as FichaWhatsapp).escalamiento;
              if (e.valor === null) return <p className="text-xs text-muted-foreground">{e.razon ?? "Sin dato de escalamiento."}</p>;
              if (e.valor.tasaPct === null) return <EstadoVacio compacto titulo="Sin llamadas" mensaje="Aún no hay llamadas al modelo para calcular la tasa." />;
              return (
                <div className="space-y-1">
                  <p className="text-2xl font-semibold tabular-nums text-foreground">{fmtPct(e.valor.tasaPct)}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtEntero(e.valor.escaladas)} de {fmtEntero(e.valor.total)} llamadas pasaron al modelo de escalamiento
                  </p>
                </div>
              );
            }}
          </Bloque>
        </ChartCard>
        <div className="lg:col-span-2">
          <ChartCard titulo="Desglose por vertical" subtitulo="histórico" tamano="S">
            <Bloque ficha={carga} onReintentar={recargar}>
              {(base) => {
                const p = (base as FichaWhatsapp).porVertical;
                if (p.valor === null) return <p className="text-xs text-muted-foreground">{p.razon ?? "Sin dato por vertical."}</p>;
                return (
                  <DataTable
                    etiqueta="Desglose por vertical"
                    columnas={COLUMNAS_VERTICAL}
                    filas={p.valor}
                    obtenerId={(v) => v.vertical}
                    paginacion={false}
                    vacio={{ titulo: "Sin actividad", mensaje: "Ninguna vertical registra actividad del agente todavía." }}
                  />
                );
              }}
            </Bloque>
          </ChartCard>
        </div>
      </div>
      <Comunes ficha={carga} onReintentar={recargar} />
    </PageContainer>
  );
}
