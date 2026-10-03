// Ejecutivo / Board (SA-L-24): el Dashboard CFO (SA-01/05/36) renombrado como en Likida, con tres piezas nuevas:
//   - arriba, el odometro del MRR contra la meta de $1,000,000 y KpiTiles de Likida (gasto de IA con sparkline de 14 dias,
//     Organizaciones y Operaciones), todos de GET /superadmin/consola/resumen (el mismo endpoint y la misma politica de MRR del Resumen);
//   - en medio, el CfoDashboard intacto (incrustado: sin h1 propio), que conserva su propio step-up y la bitacora CFO del backend;
//   - al final, "Lo que este panel todavia no puede mostrar" con el ticket que cierra cada hueco (nada se maqueta).
// Un campo sin dato se pinta "—" con su motivo, nunca un cero.
import { BadgeDollarSign, Building2, Workflow } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EstadoError, KpiTile, Odometro, PageContainer, PageHeader, formatMoney } from "@atiende/ui";
import { META_MRR_MXN, fetchConsolaResumen } from "../lib/consola-client.ts";
import type { ConsolaResumen } from "../lib/consola-client.ts";
import { useCarga } from "../lib/use-carga.ts";
import { SuperAdminCfoDashboardPage } from "./CfoDashboard.tsx";

/** Lo que el panel no puede mostrar todavia y quien lo cierra. Fuente: tablero de paridad (SA-09, SA-25/SA-08, SA-26). */
export const PENDIENTES_EJECUTIVO: readonly { readonly titulo: string; readonly motivo: string; readonly ticket: string }[] = [
  { titulo: "Caja", motivo: "No hay una fuente de caja: el cobro real por Stripe todavía no está conectado.", ticket: "SA-26 (bloqueado por la credencial de Stripe)" },
  { titulo: "Cobranza con aging", motivo: "Se cuenta cuántos clientes tienen pago pendiente, pero no hay cuentas por cobrar con antigüedad (0-30, 31-60, 61+ días).", ticket: "SA-09" },
  { titulo: "Embudo y cohortes de crecimiento", motivo: "Sin embudo de prospectos a clientes ni retención por cohorte.", ticket: "SA-25 / SA-08" },
];

const mxn0 = (n: number): string => `$${formatMoney(n, 0)}`;

function carga<T>(c: ReturnType<typeof useCarga<T>>["carga"]): { readonly data: T | null; readonly cargando: boolean; readonly error?: string } {
  return c.estado === "ok" ? { data: c.data, cargando: false } : c.estado === "cargando" ? { data: null, cargando: true } : { data: null, cargando: false, error: `No se pudo cargar: ${c.mensaje}` };
}

export function SuperAdminEjecutivoPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const { carga: bruta, recargar } = useCarga<ConsolaResumen>(() => fetchConsolaResumen(apiBaseUrl, token), [apiBaseUrl, token], "No se pudo cargar el resumen de la consola.");
  const { data: r, cargando, error } = carga<ConsolaResumen>(bruta);

  const mrr = r?.mrr ?? null;
  const mrrMxn = mrr?.valor ? Math.round(mrr.valor.totalMxn) : null;
  const sinPrecio = mrr?.valor?.organizacionesSinPrecio ?? 0;
  const sinDatoMrr = error ?? (cargando ? "Cargando…" : (mrr?.razon ?? "Sin dato de MRR."));

  const gasto = r?.gastoIa.valor ?? null;
  const orgs = r?.organizaciones.valor ?? null;
  const ops = r?.operaciones.valor ?? null;
  const motivo = (campo: { razon?: string } | undefined, porDefecto: string): string | undefined => (cargando ? "Cargando…" : (error ?? campo?.razon ?? porDefecto));

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader titulo="Ejecutivo / Board" descripcion="Ingreso recurrente contra la meta, margen, cobranza y riesgos de toda la plataforma. Lo que no tiene fuente se muestra como «—», nunca como cero." />

      <Card className="p-3.5">
        <div className="flex min-w-0 flex-col items-end gap-2.5">
          <Odometro valor={mrrMxn} digitos={7} prefijo="$" etiqueta={`MRR — META ${mxn0(META_MRR_MXN)}`} sinDato={sinDatoMrr} tamano="lg" meta={META_MRR_MXN} />
          {/* El odometro solo se pinta desde `sm`: en movil el mismo dato va en texto. */}
          <p className="text-ui text-muted-foreground sm:hidden">
            MRR <span className="font-medium tabular-nums text-foreground">{mrrMxn === null ? "—" : mxn0(mrrMxn)}</span> · meta {mxn0(META_MRR_MXN)}
          </p>
          {mrrMxn !== null && sinPrecio > 0 && <p className="text-xs text-muted-foreground">{sinPrecio === 1 ? "1 organización sin precio (no suma)" : `${sinPrecio} organizaciones sin precio (no suman)`}</p>}
          {error && <EstadoError compacto mensaje={error} onReintentar={recargar} />}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <KpiTile
          icono={<BadgeDollarSign className="size-[15px]" strokeWidth={1.75} />}
          etiqueta="Gasto de IA histórico"
          valor={gasto ? gasto.totalUsd : null}
          formato="usd"
          sparkline={gasto?.serie14d.valor?.map((p) => p.usd)}
          vacio={gasto ? undefined : motivo(r?.gastoIa, "Sin dato de gasto de IA.")}
          nota={gasto && !gasto.serie14d.valor ? (gasto.serie14d.razon ?? "Sin serie diaria de gasto.") : undefined}
        />
        <KpiTile icono={<Building2 className="size-[15px]" strokeWidth={1.75} />} etiqueta="Organizaciones" valor={orgs ? orgs.total : null} formato="entero" vacio={orgs ? undefined : motivo(r?.organizaciones, "Sin dato de organizaciones.")} />
        <KpiTile
          icono={<Workflow className="size-[15px]" strokeWidth={1.75} />}
          etiqueta="Operaciones atendidas"
          valor={ops ? ops.total : null}
          formato="entero"
          sparkline={ops?.serie14d.map((p) => p.cantidad)}
          vacio={ops ? undefined : motivo(r?.operaciones, "Sin dato de operaciones.")}
          nota={ops && ops.verticalesSinFuente.length > 0 ? `Sin fuente en: ${ops.verticalesSinFuente.join(", ")}.` : undefined}
        />
      </div>

      <SuperAdminCfoDashboardPage apiBaseUrl={apiBaseUrl} token={token} incrustada />

      <Card>
        <CardHeader>
          <CardTitle>Lo que este panel todavía no puede mostrar</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2.5">
            {PENDIENTES_EJECUTIVO.map((p) => (
              <li key={p.titulo} className="text-sm">
                <span className="font-medium text-foreground">{p.titulo}.</span> <span className="text-muted-foreground">{p.motivo}</span>{" "}
                <span className="text-xs text-faint">Lo cierra: {p.ticket}.</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
