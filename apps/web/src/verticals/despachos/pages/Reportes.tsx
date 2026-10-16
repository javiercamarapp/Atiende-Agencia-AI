// Reportes de cliente (D-01): balanza, DIOT, nómina e impuestos de un contribuyente y período,
// con vista en pantalla y exportación a PDF y Excel. Todo sale de datos reales (CFDI 4.0
// ingeridos, vencimientos del SAT); lo que el modelo no guarda se muestra «Sin datos» con su
// motivo (ver `@atiende/domain-despachos::reportes/builders.ts`). Solo lectura.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  cn,
  EstadoCargando,
  EstadoError,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import { ETIQUETAS_TIPO_REPORTE, TIPOS_REPORTE, descargarReporte, fetchReporte, formatearCeldaReporte } from "../lib/reportes-client.ts";
import type { FormatoReporte, ReporteCliente, SeccionReporte, TipoReporte } from "../lib/reportes-client.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Mes calendario anterior al día de negocio (CDMX) — el período que normalmente se reporta al cliente. */
export function periodoPorDefecto(): string {
  const hoy = hoyFechaSolo();
  const year = Number(hoy.slice(0, 4));
  const month = Number(hoy.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function guardarArchivo(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function SeccionTabla({ seccion }: { seccion: SeccionReporte }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-sm font-semibold text-foreground">{seccion.titulo}</h3>
      {seccion.sinDatosMotivo !== null ? (
        <div role="status" className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-3 text-sm">
          <p className="font-medium text-foreground">Sin datos</p>
          <p className="mt-0.5 text-muted-foreground">{seccion.sinDatosMotivo}</p>
        </div>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableCaption className="sr-only">{seccion.titulo}</TableCaption>
              <TableHeader>
                <TableRow>
                  {seccion.columnas.map((c, ci) => (
                    <TableHead key={c.clave} className={cn(ci === 0 && "sticky left-0 z-10 bg-canvas", c.tipo !== "texto" && "text-right")}>
                      {c.titulo}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {seccion.filas.map((f, i) => (
                  <TableRow key={i}>
                    {seccion.columnas.map((c, ci) => (
                      <TableCell key={c.clave} className={cn(ci === 0 && "sticky left-0 z-10 bg-card", c.tipo === "texto" ? "text-muted-foreground" : "text-right tabular-nums text-muted-foreground")}>
                        {formatearCeldaReporte(f[c.clave] ?? null, c)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {seccion.totales && (
                  <TableRow className="font-semibold">
                    {seccion.columnas.map((c, ci) => (
                      <TableCell key={c.clave} className={cn(ci === 0 && "sticky left-0 z-10 bg-card", c.tipo !== "texto" && "text-right tabular-nums")}>
                        {formatearCeldaReporte(seccion.totales![c.clave] ?? null, c)}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export function ReportesPage({ apiBaseUrl, token, propertyId }: DespachosShellContext) {
  const [tipo, setTipo] = useState<TipoReporte>("diot");
  const [periodo, setPeriodo] = useState(periodoPorDefecto);
  const [reporte, setReporte] = useState<ReporteCliente | null>(null);
  const [loading, setLoading] = useState(false);
  const [descargando, setDescargando] = useState<FormatoReporte | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generar() {
    if (!PERIODO_RE.test(periodo)) {
      setError("Período inválido: usa el formato AAAA-MM.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReporte(await fetchReporte(fetch, apiBaseUrl, token, propertyId, tipo, periodo));
    } catch (err) {
      setReporte(null);
      setError(err instanceof Error ? err.message : "No se pudo generar el reporte.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void generar();
    // Solo al montar y al cambiar de contribuyente (el Shell remonta por propertyId); el resto lo dispara el botón.
  }, [apiBaseUrl, token, propertyId]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void generar();
  }

  async function descargar(formato: FormatoReporte) {
    setDescargando(formato);
    setError(null);
    try {
      const { blob, nombre } = await descargarReporte(fetch, apiBaseUrl, token, propertyId, tipo, periodo, formato);
      guardarArchivo(blob, nombre);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo descargar el archivo.");
    } finally {
      setDescargando(null);
    }
  }

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Reportes de cliente</h1>
        <p className="mt-1 text-sm text-muted-foreground">Balanza, DIOT, nómina e impuestos del contribuyente activo, listos para revisar, descargar en PDF o en Excel. Solo con datos reales: lo que aún no existe en el sistema se marca «Sin datos».</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reporte-tipo">Reporte</Label>
          <NativeSelect
            id="reporte-tipo"
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TipoReporte)}
            wrapperClassName="w-auto min-w-44"
          >
            {TIPOS_REPORTE.map((t) => (
              <option key={t} value={t}>
                {ETIQUETAS_TIPO_REPORTE[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reporte-periodo">Período (AAAA-MM)</Label>
          <Input
            id="reporte-periodo"
            type="text"
            inputMode="numeric"
            placeholder="2026-08"
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value)}
            className="w-32"
          />
        </div>
        <Button type="submit" disabled={loading}>
          {loading ? "Generando…" : "Generar reporte"}
        </Button>
      </form>

      {error && <EstadoError mensaje={error} onReintentar={() => void generar()} />}
      {loading && !reporte && <EstadoCargando etiqueta="Generando reporte…" />}

      {reporte && (
        <article className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-foreground">{reporte.titulo}</h2>
              <p className="text-sm text-muted-foreground">
                {reporte.contribuyente.nombre} · RFC {reporte.contribuyente.rfc ?? "sin datos"} · Período {reporte.periodo} · Generado el {reporte.generadoEn}
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void descargar("pdf")} disabled={descargando !== null}>
                {descargando === "pdf" ? <Download /> : <FileText />}
                Descargar PDF
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void descargar("xlsx")} disabled={descargando !== null}>
                {descargando === "xlsx" ? <Download /> : <FileSpreadsheet />}
                Descargar Excel
              </Button>
            </div>
          </div>

          {reporte.sinDatos && (
            <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              No hay datos para este reporte en el período indicado.
            </p>
          )}

          {reporte.secciones.map((s) => (
            <SeccionTabla key={s.titulo} seccion={s} />
          ))}

          {reporte.notas.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              {reporte.notas.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </article>
      )}
    </PageContainer>
  );
}
