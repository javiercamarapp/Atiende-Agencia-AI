// Rn-03 -- Reportes de ocupación e ingresos por unidad, propietario, canal y mes. Pantalla
// de solo lectura para admin_gestora y contador (gate de cliente calcado de
// FINANZAS_LECTURA_ROLES; el servidor y la RLS lo vuelven a exigir). Sin periodo muestra el
// mes en curso de la property. Exporta a CSV (abre en Excel) y a PDF. Las reservas que
// cruzan meses se prorratean por noche: ningún peso ni noche se cuenta dos veces.
import { useEffect, useState } from "react";
import { Download, RefreshCcw } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { descargarReporte, ETIQUETA_AGRUPACION, fetchReporte, formatearMoneda, formatearOcupacion } from "../lib/reportes-client.ts";
import type { AgrupacionReporte, ReporteOcupacionIngresos } from "../lib/reportes-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de FINANZAS_LECTURA_ROLES (packages/domain-rentas/src/roles.ts).
const REPORTES_LECTURA_ROLES = new Set(["admin_gestora", "contador"]);
const AGRUPACIONES: readonly AgrupacionReporte[] = ["unidad", "propietario", "canal", "mes"];

function guardarArchivo(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ReportesPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? REPORTES_LECTURA_ROLES.has(org.rol) : false;

  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [agrupar, setAgrupar] = useState<AgrupacionReporte>("unidad");
  const [reporte, setReporte] = useState<ReporteOcupacionIngresos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDescarga, setErrorDescarga] = useState<string | null>(null);
  const [descargando, setDescargando] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  const periodoCompleto = desde !== "" && hasta !== "";
  const periodoIncompleto = (desde !== "") !== (hasta !== "");
  const params = { desde: periodoCompleto ? desde : undefined, hasta: periodoCompleto ? hasta : undefined, agrupar };

  useEffect(() => {
    if (!puedeLeer || periodoIncompleto) return;
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const r = await fetchReporte(fetch, apiBaseUrl, token, propertyId, { desde: periodoCompleto ? desde : undefined, hasta: periodoCompleto ? hasta : undefined });
        if (!cancelado) setReporte(r);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el reporte.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeLeer, desde, hasta, periodoCompleto, periodoIncompleto, recarga]);

  async function descargar(formato: "csv" | "pdf") {
    setDescargando(formato);
    setErrorDescarga(null);
    try {
      const blob = await descargarReporte(fetch, apiBaseUrl, token, propertyId, params, formato);
      const rango = reporte ? `${reporte.desde}_${reporte.hasta}` : "periodo";
      guardarArchivo(blob, `reporte-ocupacion-ingresos_${rango}.${formato}`);
    } catch (err) {
      setErrorDescarga(err instanceof Error ? err.message : "No se pudo descargar el reporte.");
    } finally {
      setDescargando(null);
    }
  }

  const encabezado = (
    <header>
      <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Reportes de ocupación e ingresos</h1>
      <p className="m-0 text-[13px] text-muted-foreground">
        Por unidad, propietario, canal y mes. Una reserva que cruza meses se prorratea por noche, así que ninguna noche ni ningún peso se cuenta dos veces. Montos en la moneda de la propiedad,
        sin conversión.
      </p>
    </header>
  );

  if (!puedeLeer) {
    return (
      <div className="flex flex-col gap-4 max-w-[640px]">
        {encabezado}
        <p className="m-0 text-[13px] text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a los reportes financieros. Roles con acceso: <strong className="text-foreground">admin_gestora</strong>{" "}
          y <strong className="text-foreground">contador</strong>.
        </p>
      </div>
    );
  }

  const grupos = reporte ? reporte.grupos[agrupar] : [];
  const mostrarDisponibles = agrupar !== "canal";

  return (
    <div className="flex flex-col gap-5 max-w-[1040px]">
      {encabezado}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Desde
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Hasta (exclusivo)
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Agrupar por
            <select value={agrupar} onChange={(e) => setAgrupar(e.target.value as AgrupacionReporte)} className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground">
              {AGRUPACIONES.map((a) => (
                <option key={a} value={a}>
                  {ETIQUETA_AGRUPACION[a]}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={() => setRecarga((n) => n + 1)}>
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Actualizar
          </Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={descargando !== null || periodoIncompleto} onClick={() => descargar("csv")}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {descargando === "csv" ? "Generando…" : "CSV (Excel)"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={descargando !== null || periodoIncompleto} onClick={() => descargar("pdf")}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {descargando === "pdf" ? "Generando…" : "PDF"}
            </Button>
          </div>
          {periodoIncompleto && <p className="m-0 w-full text-xs text-destructive">Indica «desde» y «hasta» juntos, o deja ambos vacíos para ver el mes en curso.</p>}
        </CardContent>
      </Card>

      {errorDescarga && <EstadoError mensaje={errorDescarga} />}
      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!error && reporte === null && !periodoIncompleto && <EstadoCargando lineas={4} />}

      {!error && reporte !== null && (
        <>
          {!reporte.financieroDisponible && (
            <p className="m-0 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
              Los movimientos financieros todavía no están disponibles en esta base de datos: ves noches y ocupación, pero los montos aparecen en cero.
            </p>
          )}
          {(reporte.advertencias.reservasSinMovimientoFinanciero > 0 || reporte.advertencias.reservasMonedaDistinta > 0 || reporte.advertencias.nochesSolapadasOmitidas > 0) && (
            <p className="m-0 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
              {reporte.advertencias.reservasSinMovimientoFinanciero > 0 && <span>{reporte.advertencias.reservasSinMovimientoFinanciero} reserva(s) sin movimiento financiero registrado (suman noches, no dinero). </span>}
              {reporte.advertencias.reservasMonedaDistinta > 0 && <span>{reporte.advertencias.reservasMonedaDistinta} reserva(s) en otra moneda no se suman (no se convierte tipo de cambio). </span>}
              {reporte.advertencias.nochesSolapadasOmitidas > 0 && <span>{reporte.advertencias.nochesSolapadasOmitidas} noche(s) reclamadas por dos reservas se contaron una sola vez.</span>}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Noches ocupadas", String(reporte.totales.nochesOcupadas)],
              ["Ocupación", formatearOcupacion(reporte.totales.ocupacionBasisPoints)],
              ["Ingreso bruto", formatearMoneda(reporte.totales.ingresoBrutoCentavos, reporte.moneda)],
              ["Neto", formatearMoneda(reporte.totales.netoCentavos, reporte.moneda)],
            ].map(([titulo, valor]) => (
              <Card key={titulo}>
                <CardContent className="pt-4">
                  <div className="text-[11px] text-muted-foreground">{titulo}</div>
                  <div className="text-base font-semibold text-foreground">{valor}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                Por {ETIQUETA_AGRUPACION[agrupar].toLowerCase()}
                <Badge variant="outline" className="text-[10px]">
                  {reporte.desde} → {reporte.hasta}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className={grupos.length > 0 ? "p-0" : undefined}>
              {grupos.length === 0 ? (
                <EstadoVacio titulo="Sin datos en el periodo" mensaje="No hay reservas confirmadas ni unidades para este periodo." />
              ) : (
                <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{ETIQUETA_AGRUPACION[agrupar]}</TableHead>
                      <TableHead className="text-right">Llegadas</TableHead>
                      <TableHead className="text-right">Noches</TableHead>
                      {mostrarDisponibles && <TableHead className="text-right">Ocupación</TableHead>}
                      <TableHead className="text-right">Ingreso bruto</TableHead>
                      <TableHead className="text-right">Comisión canal</TableHead>
                      <TableHead className="text-right">Neto</TableHead>
                      <TableHead className="text-right">ADR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grupos.map((g) => (
                      <TableRow key={g.clave}>
                        <TableCell className="text-xs">{g.etiqueta}</TableCell>
                        <TableCell className="text-right text-xs">{g.llegadas}</TableCell>
                        <TableCell className="text-right text-xs">{g.nochesOcupadas}</TableCell>
                        {mostrarDisponibles && <TableCell className="text-right text-xs">{formatearOcupacion(g.ocupacionBasisPoints)}</TableCell>}
                        <TableCell className="text-right text-xs">{formatearMoneda(g.ingresoBrutoCentavos, reporte.moneda)}</TableCell>
                        <TableCell className="text-right text-xs">{formatearMoneda(g.comisionCanalCentavos, reporte.moneda)}</TableCell>
                        <TableCell className="text-right text-xs">{formatearMoneda(g.netoCentavos, reporte.moneda)}</TableCell>
                        <TableCell className="text-right text-xs">{formatearMoneda(g.adrCentavos, reporte.moneda)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Llegadas cuenta cada reserva solo en el periodo de su check-in; noches e ingresos suman únicamente las noches que caen dentro del periodo.
                </p>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
