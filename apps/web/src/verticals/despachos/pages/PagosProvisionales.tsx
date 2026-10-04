// D-25 -- Pagos provisionales de ISR e IVA del cliente activo, por FLUJO DE EFECTIVO: CFDI emitidos/recibidos persistidos (D-22) y pagos de
// complemento de pago (REP) persistidos (D-23, migracion 020). Papel de trabajo para el contador: el servidor calcula (nada se calcula en el
// navegador), muestra cada cifra con su linea y cada CFDI excluido con su motivo, guarda el borrador, lo presenta (monto pagado y fecha,
// cierra el vencimiento) y exporta a PDF/Excel. Sin llamadas al SAT. Rutas: apps/api/.../despachos/pagos-provisionales.ts.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Calculator, CheckCircle2, Download, Save, Upload } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EstadoCargando,
  EstadoError,
  FormDialog,
  FormField,
  formatMoney,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
} from "@atiende/ui";
import { dinero, periodoActual } from "../lib/libro-client.ts";
import {
  calcularPapel,
  erroresParametros,
  erroresPresentar,
  ETIQUETA_REGIMEN,
  exportarPapel,
  fetchPapel,
  formularioDesdeRespuesta,
  guardarPapel,
  presentarPapel,
  registrarRep,
} from "../lib/pagos-provisionales-client.ts";
import type { ImpuestoProvisional, ParametrosFormulario, PresentarFormulario, ResultadoImpuesto, ResultadoRep, RespuestaPapel } from "../lib/pagos-provisionales-client.ts";
import { formatFechaSolo, hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Espejo cosmetico de GESTIONAR_PAGOS_PROVISIONALES_ROLES (@atiende/domain-despachos/src/roles.ts); el servidor es la autoridad.
const GESTIONAR_ROLES: ReadonlySet<string> = new Set(["admin", "contador"]);
const MAX_XML_CHARS = 512 * 1024;

const mensajeDe = (err: unknown, porDefecto: string): string => (err instanceof Error ? err.message : porDefecto);

function guardarArchivo(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

function TarjetaImpuesto({ r, titulo }: { readonly r: ResultadoImpuesto; readonly titulo: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{titulo}</CardTitle>
          <CardDescription>{r.estado === "calculado" ? "Determinación del mes" : (r.motivo ?? "Sin cálculo")}</CardDescription>
        </div>
        {r.estado === "calculado" && (r.aCargoCentavos > 0 ? <StatusBadge tone="warning">A cargo {dinero(r.aCargoCentavos)}</StatusBadge> : r.aFavorCentavos > 0 ? <StatusBadge tone="success">A favor {dinero(r.aFavorCentavos)}</StatusBadge> : <StatusBadge tone="info">Sin saldo</StatusBadge>)}
        {r.estado === "faltan_parametros" && <StatusBadge tone="warning">Faltan datos</StatusBadge>}
        {r.estado === "no_soportado" && <StatusBadge tone="info">Sin papel</StatusBadge>}
      </CardHeader>
      {r.estado === "calculado" && (
        <CardContent>
          <DataTable
            etiqueta={`Determinación de ${titulo}`}
            obtenerId={(l) => l.clave}
            filas={r.lineas}
            paginacion={false}
            columnas={[
              { id: "concepto", encabezado: "Concepto", principal: true, celda: (l) => <>{l.concepto}{l.detalle ? <span className="text-xs text-muted-foreground"> ({l.detalle})</span> : null}</> },
              { id: "importe", encabezado: "Importe", alinear: "right", celda: (l) => <span className="font-mono text-xs">{dinero(l.centavos)}</span> },
            ]}
          />
        </CardContent>
      )}
    </Card>
  );
}

export function PagosProvisionalesPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const hoy = hoyFechaSolo();
  const [periodo, setPeriodo] = useState(periodoActual(hoy));
  const [datos, setDatos] = useState<RespuestaPapel | null>(null);
  const [form, setForm] = useState<ParametrosFormulario | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [presentando, setPresentando] = useState<ImpuestoProvisional | null>(null);
  const [pres, setPres] = useState<PresentarFormulario>({ monto: "", fecha: hoy, confirmacion: "" });
  const [errorPresentar, setErrorPresentar] = useState<string | null>(null);
  const [xml, setXml] = useState("");
  const [rep, setRep] = useState<ResultadoRep | null>(null);
  const [errorRep, setErrorRep] = useState<string | null>(null);

  const puedeGestionar = GESTIONAR_ROLES.has(role);
  const periodoValido = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodo);

  const cargar = useCallback(
    async (regimen?: string) => {
      if (!periodoValido) return;
      setCargando(true);
      setError(null);
      try {
        const r = await fetchPapel(fetch, apiBaseUrl, token, propertyId, periodo, regimen);
        setDatos(r);
        setForm(formularioDesdeRespuesta(r));
      } catch (err) {
        setDatos(null);
        setError(mensajeDe(err, "No se pudo cargar el papel de trabajo."));
      } finally {
        setCargando(false);
      }
    },
    [apiBaseUrl, token, propertyId, periodo, periodoValido],
  );

  useEffect(() => {
    setAviso(null);
    setRep(null);
    void cargar();
  }, [cargar]);

  const erroresForm = form ? erroresParametros(form) : {};

  async function calcular(e?: FormEvent) {
    e?.preventDefault();
    if (!form || Object.keys(erroresForm).length > 0) return;
    setTrabajando(true);
    setError(null);
    setAviso(null);
    try {
      setDatos(await calcularPapel(fetch, apiBaseUrl, token, propertyId, periodo, form));
    } catch (err) {
      setError(mensajeDe(err, "No se pudo calcular."));
    } finally {
      setTrabajando(false);
    }
  }

  async function guardar() {
    if (!form || Object.keys(erroresForm).length > 0) return;
    setTrabajando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await guardarPapel(fetch, apiBaseUrl, token, propertyId, periodo, form);
      setDatos(r);
      setAviso(r.guardado?.isr ? "Borrador de ISR e IVA guardado." : "Borrador de IVA guardado; el ISR no se guardó porque faltan datos o el régimen no tiene papel.");
    } catch (err) {
      setError(mensajeDe(err, "No se pudo guardar."));
    } finally {
      setTrabajando(false);
    }
  }

  async function exportar(formato: "pdf" | "xlsx") {
    if (!datos) return;
    setError(null);
    try {
      const { blob, nombre } = await exportarPapel(fetch, apiBaseUrl, token, propertyId, periodo, formato, datos.regimen);
      guardarArchivo(blob, nombre);
    } catch (err) {
      setError(mensajeDe(err, "No se pudo exportar."));
    }
  }

  async function confirmarPresentar(e: FormEvent) {
    e.preventDefault();
    if (!presentando) return;
    const errores = erroresPresentar(pres, presentando, periodo, hoy);
    if (Object.keys(errores).length > 0) {
      setErrorPresentar(Object.values(errores)[0]!);
      return;
    }
    setTrabajando(true);
    setErrorPresentar(null);
    try {
      await presentarPapel(fetch, apiBaseUrl, token, propertyId, periodo, presentando, pres);
      setAviso(`Pago provisional de ${presentando} de ${periodo} marcado como presentado; el vencimiento quedó completado.`);
      setPresentando(null);
      await cargar(datos?.regimen);
    } catch (err) {
      setErrorPresentar(mensajeDe(err, "No se pudo marcar como presentado."));
    } finally {
      setTrabajando(false);
    }
  }

  async function subirRep() {
    setErrorRep(null);
    setRep(null);
    if (xml.trim() === "") return;
    setTrabajando(true);
    try {
      const r = await registrarRep(fetch, apiBaseUrl, token, propertyId, xml);
      setRep(r);
      setXml("");
      if (r.registrados > 0) await cargar(datos?.regimen);
    } catch (err) {
      setErrorRep(mensajeDe(err, "No se pudo registrar el complemento de pago."));
    } finally {
      setTrabajando(false);
    }
  }

  async function leerArchivo(archivo: File | undefined) {
    if (!archivo) return;
    if (archivo.size > MAX_XML_CHARS) {
      setErrorRep("El archivo excede 512 KB: no es un complemento de pago válido.");
      return;
    }
    setXml(await archivo.text());
  }

  const guardadoDe = (imp: ImpuestoProvisional) => datos?.guardados.find((g) => g.impuesto === imp);
  const presentado = (imp: ImpuestoProvisional) => guardadoDe(imp)?.estado === "presentado";
  const necesitaCoeficiente = form?.regimen === "601";
  const usaPerdidas = form?.regimen === "601" || form?.regimen === "612";

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Pagos provisionales"
        descripcion="ISR e IVA del mes por flujo de efectivo, desde los CFDI y los complementos de pago del cliente."
        acciones={
          <>
            <FormField label="Periodo" className="grid-flow-col items-center gap-2">
              <Input id="pp-periodo" type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-44" />
            </FormField>
            {datos && datos.cliente.regimenes.length > 1 && form && (
              <FormField label="Régimen" className="grid-flow-col items-center gap-2">
                <NativeSelect id="pp-regimen" value={form.regimen} onChange={(e) => void cargar(e.target.value)}>
                  {datos.cliente.regimenes.map((r) => (
                    <option key={r} value={r}>
                      {r}
                      {ETIQUETA_REGIMEN[r] ? ` · ${ETIQUETA_REGIMEN[r]}` : ""}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            )}
          </>
        }
      />

      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => void cargar(datos?.regimen)} />}
      {cargando && !datos && <EstadoCargando etiqueta="Calculando el papel de trabajo…" />}

      {datos && form && (
        <>
          <Callout tone="info">
            {datos.cliente.razonSocial} · RFC <span className="font-mono">{datos.cliente.rfc}</span> · Régimen {datos.regimen}
            {ETIQUETA_REGIMEN[datos.regimen] ? ` (${ETIQUETA_REGIMEN[datos.regimen]})` : ""} · {datos.papel.documentosIncluidos} CFDI incluidos.
          </Callout>
          {!datos.guardadoDisponible && (
            <Callout tone="warning">
              Guardar, presentar y registrar complementos de pago todavía no están disponibles en esta base (falta la migración 020). El cálculo se muestra sin contar los CFDI PPD.
            </Callout>
          )}
          {datos.papel.advertencias.map((a) => (
            <Callout key={a} tone="warning">
              {a}
            </Callout>
          ))}

          <form onSubmit={(e) => void calcular(e)} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
            {necesitaCoeficiente && (
              <FormField label="Coeficiente de utilidad" error={erroresForm.coeficienteUtilidad}>
                <Input id="pp-coef" value={form.coeficienteUtilidad} inputMode="decimal" placeholder="0.234567" className="w-36 font-mono" onChange={(e) => setForm({ ...form, coeficienteUtilidad: e.target.value })} />
              </FormField>
            )}
            {usaPerdidas && (
              <FormField label="Pérdidas fiscales pendientes" error={erroresForm.perdidasPendientes}>
                <Input id="pp-perdidas" value={form.perdidasPendientes} inputMode="decimal" placeholder="0.00" className="w-40 text-right font-mono" onChange={(e) => setForm({ ...form, perdidasPendientes: e.target.value })} />
              </FormField>
            )}
            {form.regimen !== "626" && (
              <FormField label="Pagos previos no capturados aquí" error={erroresForm.ajustePagosPrevios}>
                <Input id="pp-previos" value={form.ajustePagosPrevios} inputMode="decimal" placeholder="0.00" className="w-40 text-right font-mono" onChange={(e) => setForm({ ...form, ajustePagosPrevios: e.target.value })} />
              </FormField>
            )}
            <FormField label="Saldo a favor de IVA anterior" error={erroresForm.saldoFavorAnterior}>
              <Input id="pp-saldo-iva" value={form.saldoFavorAnterior} inputMode="decimal" placeholder="0.00" className="w-40 text-right font-mono" onChange={(e) => setForm({ ...form, saldoFavorAnterior: e.target.value })} />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={trabajando || Object.keys(erroresForm).length > 0}>
                <Calculator />
                Calcular
              </Button>
              {puedeGestionar && datos.guardadoDisponible && (
                <Button type="button" size="sm" variant="outline" disabled={trabajando || Object.keys(erroresForm).length > 0 || (presentado("ISR") && presentado("IVA"))} onClick={() => void guardar()}>
                  <Save />
                  Guardar borrador
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" disabled={trabajando} onClick={() => void exportar("pdf")}>
                <Download />
                PDF
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={trabajando} onClick={() => void exportar("xlsx")}>
                <Download />
                Excel
              </Button>
            </div>
          </form>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <TarjetaImpuesto r={datos.papel.isr} titulo="ISR" />
              <EstadoGuardado impuesto="ISR" guardado={guardadoDe("ISR")} puedeGestionar={puedeGestionar && datos.guardadoDisponible} onPresentar={() => { setPres({ monto: "", fecha: hoy, confirmacion: "" }); setErrorPresentar(null); setPresentando("ISR"); }} />
            </div>
            <div className="flex flex-col gap-2">
              <TarjetaImpuesto r={datos.papel.iva} titulo="IVA" />
              <EstadoGuardado impuesto="IVA" guardado={guardadoDe("IVA")} puedeGestionar={puedeGestionar && datos.guardadoDisponible} onPresentar={() => { setPres({ monto: "", fecha: hoy, confirmacion: "" }); setErrorPresentar(null); setPresentando("IVA"); }} />
            </div>
          </div>

          {datos.papel.exclusiones.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>CFDI no incluidos</CardTitle>
                <CardDescription>Cada uno con su motivo; ninguno se cuenta en silencio.</CardDescription>
              </CardHeader>
              <CardContent>
                <DataTable
                  etiqueta="CFDI no incluidos en el papel"
                  obtenerId={(x) => x.motivo}
                  filas={datos.papel.exclusiones}
                  paginacion={false}
                  columnas={[
                    { id: "motivo", encabezado: "Motivo", principal: true, celda: (x) => x.motivo },
                    { id: "cantidad", encabezado: "CFDI", alinear: "right", celda: (x) => x.cantidad },
                    { id: "importe", encabezado: "Importe total", alinear: "right", celda: (x) => <span className="font-mono text-xs">{dinero(x.importeCentavos)}</span> },
                  ]}
                />
              </CardContent>
            </Card>
          )}

          {puedeGestionar && (
            <Card>
              <CardHeader>
                <CardTitle>Registrar complemento de pago (REP)</CardTitle>
                <CardDescription>Un CFDI PPD cuenta como flujo de efectivo solo por los pagos de su complemento, en el mes del pago. Sube el XML del complemento 2.0.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="pp-rep-archivo" className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-ui font-medium hover:bg-canvas">
                    <Upload className="size-[15px]" />
                    Elegir XML
                  </Label>
                  <input id="pp-rep-archivo" type="file" accept=".xml,text/xml,application/xml" className="sr-only" onChange={(e) => void leerArchivo(e.target.files?.[0])} />
                  <span className="text-xs text-muted-foreground">{xml.trim() === "" ? "Ningún archivo" : `${formatMoney(xml.length, 0)} caracteres listos`}</span>
                  <Button type="button" size="sm" disabled={trabajando || xml.trim() === "" || !datos.guardadoDisponible} onClick={() => void subirRep()}>
                    Registrar pagos
                  </Button>
                </div>
                {errorRep && <Callout tone="danger">{errorRep}</Callout>}
                {rep && (
                  <Callout tone={rep.registrados > 0 ? "success" : "warning"}>
                    Complemento {rep.folioFiscalRep}: {rep.registrados} pago(s) registrado(s), {rep.yaExistian} ya existían, {rep.omitidos.length} omitido(s), {rep.rechazados.length} rechazado(s).
                    {[...rep.omitidos, ...rep.rechazados].map((o) => (
                      <span key={`${o.idDocumento}-${o.motivo}`} className="mt-1 block text-xs">
                        {o.idDocumento.slice(0, 8)}…: {o.motivo}
                      </span>
                    ))}
                  </Callout>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <FormDialog
        open={presentando !== null}
        onOpenChange={(abrir) => !abrir && !trabajando && setPresentando(null)}
        titulo={presentando ? `Marcar ${presentando} de ${periodo} como presentado` : "Presentar"}
        subtitulo="Registra lo que se presentó y pagó, y completa el vencimiento. Después ya no se recalcula."
        anchoClase="max-w-lg"
        bloquearCierre={trabajando}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setPresentando(null)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-presentar" loading={trabajando}>
              Marcar presentado
            </Button>
          </>
        }
      >
        {presentando && (
          <form id="form-presentar" onSubmit={(e) => void confirmarPresentar(e)} className="flex flex-col gap-3" noValidate>
            <FormField label="Monto efectivamente pagado (MXN)">
              <Input id="pres-monto" inputMode="decimal" value={pres.monto} placeholder="0.00" className="text-right font-mono" onChange={(e) => setPres({ ...pres, monto: e.target.value })} />
            </FormField>
            <FormField label="Fecha de presentación">
              <Input id="pres-fecha" type="date" max={hoy} value={pres.fecha} onChange={(e) => setPres({ ...pres, fecha: e.target.value })} />
            </FormField>
            <FormField label={`Escribe «${presentando} ${periodo}» para confirmar`}>
              <Input id="pres-confirmacion" value={pres.confirmacion} autoComplete="off" onChange={(e) => setPres({ ...pres, confirmacion: e.target.value })} />
            </FormField>
            {errorPresentar && <Callout tone="danger">{errorPresentar}</Callout>}
          </form>
        )}
      </FormDialog>
    </PageContainer>
  );
}

function EstadoGuardado({ impuesto, guardado, puedeGestionar, onPresentar }: { readonly impuesto: ImpuestoProvisional; readonly guardado: { readonly estado: "borrador" | "presentado"; readonly montoPagadoCentavos: number | null; readonly fechaPresentacion: string | null } | undefined; readonly puedeGestionar: boolean; readonly onPresentar: () => void }) {
  if (!guardado) return <p className="text-xs text-muted-foreground">{impuesto}: sin borrador guardado.</p>;
  if (guardado.estado === "presentado") {
    return (
      <Callout tone="success" icon={<CheckCircle2 className="size-4" />}>
        {impuesto} presentado el {guardado.fechaPresentacion ? formatFechaSolo(guardado.fechaPresentacion) : "—"} · pagado {dinero(guardado.montoPagadoCentavos)}
      </Callout>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="info">Borrador guardado</StatusBadge>
      {puedeGestionar && (
        <Button type="button" size="sm" variant="outline" onClick={onPresentar}>
          Marcar {impuesto} presentado
        </Button>
      )}
    </div>
  );
}
