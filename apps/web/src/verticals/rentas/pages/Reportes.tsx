// Rn-03 -- Reportes de ocupación e ingresos por unidad, propietario, canal y mes. Pantalla
// de solo lectura para admin_gestora y contador (gate de cliente calcado de
// FINANZAS_LECTURA_ROLES; el servidor y la RLS lo vuelven a exigir). Sin periodo muestra el
// mes en curso de la property. Exporta a CSV (abre en Excel) y a PDF. Las reservas que
// cruzan meses se prorratean por noche: ningún peso ni noche se cuenta dos veces.
// UNI-C-rentas: PageHeader (único h1) + PageContainer a ancho completo, filtros con FormField, KPIs con StatCard,
// DataTable, Callout y notify; montos con el formateador único (sin sufijo MXN) y fechas con formatFechaSolo.
import { useEffect, useState } from "react";
import { BedDouble, Download, Percent, RefreshCcw, Wallet } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, FormField, Input, NativeSelect, notify, PageContainer, PageHeader, StatCard, StatusBadge } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { descargarReporte, ETIQUETA_AGRUPACION, fetchReporte, formatearMoneda, formatearOcupacion } from "../lib/reportes-client.ts";
import type { AgrupacionReporte, GrupoReporte, ReporteOcupacionIngresos } from "../lib/reportes-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
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
      notify.success(`Reporte ${formato.toUpperCase()} descargado.`);
    } catch (err) {
      setErrorDescarga(err instanceof Error ? err.message : "No se pudo descargar el reporte.");
    } finally {
      setDescargando(null);
    }
  }

  const encabezado = (
    <PageHeader
      titulo="Reportes de ocupación e ingresos"
      descripcion="Por unidad, propietario, canal y mes. Una reserva que cruza meses se prorratea por noche, así que ninguna noche ni ningún peso se cuenta dos veces. Montos en la moneda de la propiedad, sin conversión."
    />
  );

  if (!puedeLeer) {
    return (
      <PageContainer>
        {encabezado}
        <Callout tone="info" titulo="Sin acceso a los reportes">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a los reportes financieros. Roles con acceso: <strong className="text-foreground">admin_gestora</strong> y{" "}
          <strong className="text-foreground">contador</strong>.
        </Callout>
      </PageContainer>
    );
  }

  const grupos = reporte ? reporte.grupos[agrupar] : [];
  const mostrarDisponibles = agrupar !== "canal";
  const moneda = reporte?.moneda ?? "MXN";

  const columnas: readonly DataTableColumna<GrupoReporte>[] = [
    { id: "grupo", encabezado: ETIQUETA_AGRUPACION[agrupar], principal: true, valorOrden: (g) => g.etiqueta, celda: (g) => <span className="font-medium text-foreground">{g.etiqueta}</span> },
    { id: "llegadas", encabezado: "Llegadas", alinear: "right", valorOrden: (g) => g.llegadas, celda: (g) => <span className="tabular-nums">{g.llegadas}</span> },
    { id: "noches", encabezado: "Noches", alinear: "right", valorOrden: (g) => g.nochesOcupadas, celda: (g) => <span className="tabular-nums">{g.nochesOcupadas}</span> },
    ...(mostrarDisponibles ? [{ id: "ocupacion", encabezado: "Ocupación", alinear: "right" as const, celda: (g: GrupoReporte) => <span className="tabular-nums">{formatearOcupacion(g.ocupacionBasisPoints)}</span> }] : []),
    { id: "bruto", encabezado: "Ingreso bruto", alinear: "right", valorOrden: (g) => g.ingresoBrutoCentavos, celda: (g) => <span className="tabular-nums">{formatearMoneda(g.ingresoBrutoCentavos, moneda)}</span> },
    { id: "comision", encabezado: "Comisión canal", alinear: "right", celda: (g) => <span className="tabular-nums">{formatearMoneda(g.comisionCanalCentavos, moneda)}</span> },
    { id: "neto", encabezado: "Neto", alinear: "right", valorOrden: (g) => g.netoCentavos, celda: (g) => <span className="tabular-nums">{formatearMoneda(g.netoCentavos, moneda)}</span> },
    { id: "adr", encabezado: "ADR", alinear: "right", celda: (g) => <span className="tabular-nums">{formatearMoneda(g.adrCentavos, moneda)}</span> },
  ];

  return (
    <PageContainer>
      {encabezado}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <FormField label="Desde">
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-auto" />
          </FormField>
          <FormField label="Hasta (exclusivo)">
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-auto" />
          </FormField>
          <FormField label="Agrupar por">
            <NativeSelect size="sm" value={agrupar} onChange={(e) => setAgrupar(e.target.value as AgrupacionReporte)}>
              {AGRUPACIONES.map((a) => (
                <option key={a} value={a}>
                  {ETIQUETA_AGRUPACION[a]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="button" variant="outline" size="sm" onClick={() => setRecarga((n) => n + 1)}>
            <RefreshCcw /> Actualizar
          </Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={descargando !== null || periodoIncompleto} loading={descargando === "csv"} loadingText="Generando…" onClick={() => void descargar("csv")}>
              <Download /> CSV (Excel)
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={descargando !== null || periodoIncompleto} loading={descargando === "pdf"} loadingText="Generando…" onClick={() => void descargar("pdf")}>
              <Download /> PDF
            </Button>
          </div>
          {periodoIncompleto && <p className="m-0 w-full text-xs text-destructive">Indica «desde» y «hasta» juntos, o deja ambos vacíos para ver el mes en curso.</p>}
        </CardContent>
      </Card>

      {errorDescarga && <EstadoError titulo="No se pudo descargar" mensaje={errorDescarga} />}
      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!error && reporte === null && !periodoIncompleto && <EstadoCargando lineas={4} />}

      {!error && reporte !== null && (
        <>
          {!reporte.financieroDisponible && (
            <Callout tone="warning" titulo="Movimientos financieros no disponibles aún">
              Los movimientos financieros todavía no están disponibles en esta base de datos: ves noches y ocupación, pero los montos aparecen en cero.
            </Callout>
          )}
          {(reporte.advertencias.reservasSinMovimientoFinanciero > 0 || reporte.advertencias.reservasMonedaDistinta > 0 || reporte.advertencias.nochesSolapadasOmitidas > 0) && (
            <Callout tone="info">
              {reporte.advertencias.reservasSinMovimientoFinanciero > 0 && <span>{reporte.advertencias.reservasSinMovimientoFinanciero} reserva(s) sin movimiento financiero registrado (suman noches, no dinero). </span>}
              {reporte.advertencias.reservasMonedaDistinta > 0 && <span>{reporte.advertencias.reservasMonedaDistinta} reserva(s) en otra moneda no se suman (no se convierte tipo de cambio). </span>}
              {reporte.advertencias.nochesSolapadasOmitidas > 0 && <span>{reporte.advertencias.nochesSolapadasOmitidas} noche(s) reclamadas por dos reservas se contaron una sola vez.</span>}
            </Callout>
          )}

          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatCard icon={BedDouble} label="Noches ocupadas" value={String(reporte.totales.nochesOcupadas)} />
            <StatCard icon={Percent} label="Ocupación" value={formatearOcupacion(reporte.totales.ocupacionBasisPoints)} />
            <StatCard icon={Wallet} label="Ingreso bruto" value={formatearMoneda(reporte.totales.ingresoBrutoCentavos, reporte.moneda)} />
            <StatCard icon={Wallet} label="Neto" value={formatearMoneda(reporte.totales.netoCentavos, reporte.moneda)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Por {ETIQUETA_AGRUPACION[agrupar].toLowerCase()}
                <StatusBadge tone="neutral" dot={false} className="text-2xs">
                  {formatFechaSolo(reporte.desde)} → {formatFechaSolo(reporte.hasta)}
                </StatusBadge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DataTable
                etiqueta={`Reporte de ocupación e ingresos por ${ETIQUETA_AGRUPACION[agrupar].toLowerCase()}`}
                columnas={columnas}
                filas={grupos}
                obtenerId={(g) => g.clave}
                paginacion={false}
                vacio={{ titulo: "Sin datos en el periodo", mensaje: "No hay reservas confirmadas ni unidades para este periodo." }}
              />
              <p className="px-4 py-3 text-xs text-muted-foreground">
                Llegadas cuenta cada reserva solo en el periodo de su check-in; noches e ingresos suman únicamente las noches que caen dentro del periodo.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
