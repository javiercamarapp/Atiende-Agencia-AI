// Costos y facturacion (SA-L-21): una sola pagina con cuatro pestanas que MONTAN las paginas existentes (Facturacion, Costos y
// margen, P&L por vertical, Contratos) sin duplicar su logica; cada una va sin h1 propio (`incrustada`). La pestana activa vive en
// la URL (`?tab=`) para poder enlazarla y para que las rutas viejas redirijan a su pestana. Arriba, dos KpiTiles que salen del
// MISMO endpoint del Resumen (GET /superadmin/consola/resumen): gasto historico de IA y costo de IA por operacion atendida
// (gasto / operaciones; `null` con su motivo si falta cualquiera de las dos, nunca un cero).
import { BadgeDollarSign, Workflow } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { KpiTile, PageContainer, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { fetchConsolaResumen } from "../lib/consola-client.ts";
import type { ConsolaResumen } from "../lib/consola-client.ts";
import { useCarga } from "../lib/use-carga.ts";
import { SuperAdminContratosPage } from "./Contratos.tsx";
import { SuperAdminCostosMargenPage } from "./CostosMargen.tsx";
import { SuperAdminFacturacionPage } from "./Facturacion.tsx";
import { SuperAdminPylVerticalPage } from "./PylVertical.tsx";

export const PESTANAS_COSTOS = [
  { valor: "facturacion", etiqueta: "Facturación" },
  { valor: "costos", etiqueta: "Costos y margen" },
  { valor: "pyl", etiqueta: "P&L" },
  { valor: "contratos", etiqueta: "Contratos" },
] as const;
export type PestanaCostos = (typeof PESTANAS_COSTOS)[number]["valor"];
const PESTANA_POR_DEFECTO: PestanaCostos = "facturacion";

export function pestanaValida(valor: string | null): PestanaCostos {
  return PESTANAS_COSTOS.find((p) => p.valor === valor)?.valor ?? PESTANA_POR_DEFECTO;
}

/** Costo de IA por operacion atendida: `null` si falta el gasto, las operaciones, o no hubo ninguna operacion. */
export function costoPorOperacion(r: ConsolaResumen): { readonly valor: number | null; readonly razon?: string; readonly nota?: string } {
  const gasto = r.gastoIa.valor;
  const ops = r.operaciones.valor;
  if (!gasto) return { valor: null, razon: r.gastoIa.razon ?? "Sin dato de gasto de IA." };
  if (!ops) return { valor: null, razon: r.operaciones.razon ?? "Sin dato de operaciones atendidas." };
  if (ops.total <= 0) return { valor: null, razon: "Todavía no hay operaciones atendidas para dividir el gasto." };
  return { valor: gasto.totalUsd / ops.total, nota: ops.verticalesSinFuente.length > 0 ? `Operaciones sin fuente en: ${ops.verticalesSinFuente.join(", ")}.` : undefined };
}

export function SuperAdminCostosFacturacionPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [params, setParams] = useSearchParams();
  const activa = pestanaValida(params.get("tab"));
  const { carga } = useCarga<ConsolaResumen>(() => fetchConsolaResumen(apiBaseUrl, token), [apiBaseUrl, token], "No se pudo cargar el resumen de costos.");

  const cargando = carga.estado === "cargando";
  const error = carga.estado === "error" ? `No se pudo cargar: ${carga.mensaje}` : undefined;
  const resumen = carga.estado === "ok" ? carga.data : null;
  const gasto = resumen?.gastoIa.valor ?? null;
  const porOperacion = resumen ? costoPorOperacion(resumen) : null;
  const serie = gasto?.serie14d.valor?.map((p) => p.usd);

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader titulo="Costos y facturación" descripcion="Lo que Atiende cobra, lo que le cuesta y lo pactado con cada cliente. Lo que no tiene fuente se muestra como «—», nunca como cero." />

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <KpiTile
          icono={<BadgeDollarSign className="size-[15px]" strokeWidth={1.75} />}
          etiqueta="Gasto de IA histórico"
          valor={gasto ? gasto.totalUsd : null}
          formato="usd"
          sparkline={serie}
          vacio={cargando ? "Cargando…" : (error ?? (gasto ? undefined : (resumen?.gastoIa.razon ?? "Sin dato de gasto de IA.")))}
        />
        <KpiTile
          icono={<Workflow className="size-[15px]" strokeWidth={1.75} />}
          etiqueta="Costo de IA por operación atendida"
          valor={porOperacion?.valor ?? null}
          formato="usd4"
          vacio={cargando ? "Cargando…" : (error ?? (porOperacion?.valor === null ? porOperacion.razon : undefined))}
          nota={porOperacion?.nota}
        />
      </div>

      <Tabs value={activa} onValueChange={(v) => setParams({ tab: pestanaValida(v) }, { replace: true })}>
        <TabsList aria-label="Secciones de costos y facturación">
          {PESTANAS_COSTOS.map((p) => (
            <TabsTrigger key={p.valor} value={p.valor}>
              {p.etiqueta}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="facturacion">
          <SuperAdminFacturacionPage apiBaseUrl={apiBaseUrl} token={token} incrustada />
        </TabsContent>
        <TabsContent value="costos">
          <SuperAdminCostosMargenPage apiBaseUrl={apiBaseUrl} token={token} incrustada />
        </TabsContent>
        <TabsContent value="pyl">
          <SuperAdminPylVerticalPage apiBaseUrl={apiBaseUrl} token={token} incrustada />
        </TabsContent>
        <TabsContent value="contratos">
          <SuperAdminContratosPage apiBaseUrl={apiBaseUrl} token={token} incrustada />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
