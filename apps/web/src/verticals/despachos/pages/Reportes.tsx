// Reportes de cliente (D-01): balanza, DIOT, nómina e impuestos de un contribuyente y período,
// con vista en pantalla y exportación a PDF y Excel. Todo sale de datos reales (CFDI 4.0
// ingeridos, vencimientos del SAT); lo que el modelo no guarda se muestra «Sin datos» con su
// motivo (ver `@atiende/domain-despachos::reportes/builders.ts`). Solo lectura.
import { useEffect, useState } from "react";
import { FileSpreadsheet, FileText } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  NativeSelect,
  notify,
  PageContainer,
  PageHeader,
  Table,
  TableBody,
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
      <h2 className="text-sm font-medium text-foreground">{seccion.titulo}</h2>
      {seccion.sinDatosMotivo !== null ? (
        <EstadoVacio titulo="Sin datos" mensaje={seccion.sinDatosMotivo} />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {seccion.columnas.map((c) => (
                    <TableHead key={c.clave} className={c.tipo === "texto" ? undefined : "text-right"}>
                      {c.titulo}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {seccion.filas.map((f, i) => (
                  <TableRow key={i}>
                    {seccion.columnas.map((c) => (
                      <TableCell key={c.clave} className={c.tipo === "texto" ? "text-muted-foreground" : "text-right tabular-nums text-muted-foreground"}>
                        {formatearCeldaReporte(f[c.clave] ?? null, c)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {seccion.totales && (
                  <TableRow className="font-semibold">
                    {seccion.columnas.map((c) => (
                      <TableCell key={c.clave} className={c.tipo === "texto" ? undefined : "text-right tabular-nums"}>
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

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void generar();
  }

  async function descargar(formato: FormatoReporte) {
    setDescargando(formato);
    try {
      const { blob, nombre } = await descargarReporte(fetch, apiBaseUrl, token, propertyId, tipo, periodo, formato);
      guardarArchivo(blob, nombre);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo descargar el archivo.");
    } finally {
      setDescargando(null);
    }
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader titulo="Reportes de cliente" descripcion="Balanza, DIOT, nómina e impuestos del contribuyente activo, en PDF o Excel. Lo que aún no existe se marca «Sin datos»." />

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <FormField label="Reporte">
          <NativeSelect id="reporte-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as TipoReporte)} wrapperClassName="w-auto min-w-44">
            {TIPOS_REPORTE.map((t) => (
              <option key={t} value={t}>
                {ETIQUETAS_TIPO_REPORTE[t]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Período (AAAA-MM)">
          <Input id="reporte-periodo" type="text" inputMode="numeric" placeholder="2026-08" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-32" />
        </FormField>
        <Button type="submit" loading={loading}>
          Generar reporte
        </Button>
      </form>

      {error && <EstadoError mensaje={error} onReintentar={() => void generar()} />}
      {loading && !reporte && <EstadoCargando etiqueta="Generando reporte…" />}

      {reporte && (
        <article className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-foreground">{reporte.titulo}</h2>
              <p className="text-ui text-muted-foreground">
                {reporte.contribuyente.nombre} · RFC {reporte.contribuyente.rfc ?? "sin datos"} · Período {reporte.periodo} · Generado el {reporte.generadoEn}
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void descargar("pdf")} loading={descargando === "pdf"} disabled={descargando !== null}>
                <FileText />
                Descargar PDF
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void descargar("xlsx")} loading={descargando === "xlsx"} disabled={descargando !== null}>
                <FileSpreadsheet />
                Descargar Excel
              </Button>
            </div>
          </div>

          {reporte.sinDatos && (
            <Callout tone="neutral">No hay datos para este reporte en el período indicado.</Callout>
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
