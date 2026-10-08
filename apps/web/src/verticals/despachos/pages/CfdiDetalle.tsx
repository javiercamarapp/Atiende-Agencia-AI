// Ficha de un CFDI (Fase 9) — GET .../cfdi/:invoiceId (cfdi.ts, `serializeInvoice`):
// el resultado completo de `validarCfdiDespachos()` (issues/warnings/DIOT), no solo
// el resumen de la lista.
import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, X } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, Label, NativeSelect, PageContainer, StatusBadge, Textarea, notify } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchInvoice, registrarEstadoSat, verificarEstatusSat } from "../lib/cfdi-client.ts";
import type { EstadoSatCfdi, ImpuestoDesglosado, InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatCentavos, formatDate, formatDireccionCfdi, formatEstadoSat, formatEstatusCancelacion, formatFormaPago, formatMetodoPago, formatMoney, formatTasaImpuesto, formatValidacionEfos, tonoEstadoSat } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo criterio que en Cfdi.tsx: espejo cosmético de RESOLVER_REVISION_ROLES
// (@atiende/domain-despachos/src/roles.ts) -- el enforcement real vive en
// revisiones.ts (assertVerticalRole), server-side.
const RESOLVER_ROLES = new Set(["admin", "contador"]);

// Espejo cosmetico de GESTIONAR_CARTERA_ROLES: quien puede capturar el estado SAT del CFDI (el servidor decide).
const ESTADO_SAT_ROLES = new Set(["admin", "contador"]);

const ESTADOS_SAT: readonly EstadoSatCfdi[] = ["pendiente", "vigente", "cancelado", "no_encontrado"];

const CATEGORIA_LABELS: Record<InvoiceSummary["categoria"], string> = {
  gasto_operativo: "Gasto operativo",
  activo_fijo: "Activo fijo",
  inversion: "Inversión",
  honorarios: "Honorarios",
  nomina: "Nómina",
  sin_clasificar: "Sin clasificar",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

export function CfdiDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const [invoice, setInvoice] = useState<InvoiceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hallazgo de auditoría severidad ALTA: el backend de revisiones
  // (GET/POST .../revisiones*, revisiones.ts) existía completo pero esta pantalla
  // solo pintaba el texto estático "Requiere revisión humana", sin cliente ni
  // botón. `GET .../revisiones` solo trae las PENDIENTES (repo.listPendingReviews,
  // sin filtro de estado) -- no hay endpoint para revisiones ya resueltas salvo por
  // id conocido, así que "no aparece en la cola" se interpreta como "ya resuelta".
  const [revision, setRevision] = useState<RevisionCfdi | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [resolviendo, setResolviendo] = useState(false);
  const [guardandoSat, setGuardandoSat] = useState(false);
  const [verificandoSat, setVerificandoSat] = useState(false);
  const [errorSat, setErrorSat] = useState<string | null>(null);

  useEffect(() => {
    if (!invoiceId) return;
    let cancelado = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const inv = await fetchInvoice(fetch, apiBaseUrl, token, propertyId, invoiceId);
        if (!cancelado) setInvoice(inv);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el CFDI.");
      } finally {
        if (!cancelado) setLoading(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, invoiceId]);

  async function loadRevision() {
    if (!invoiceId) return;
    setRevisionLoading(true);
    setRevisionError(null);
    try {
      const pendientes = await fetchRevisionesPendientes(fetch, apiBaseUrl, token, propertyId);
      setRevision(pendientes.find((r) => r.invoiceId === invoiceId) ?? null);
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : "No se pudo cargar el estado de revisión.");
    } finally {
      setRevisionLoading(false);
    }
  }

  useEffect(() => {
    void loadRevision();
  }, [apiBaseUrl, token, propertyId, invoiceId]);

  async function handleResolver(decision: "aprobar" | "rechazar") {
    if (!revision) return;
    setResolviendo(true);
    setRevisionError(null);
    try {
      const notaTrim = nota.trim() || undefined;
      if (decision === "aprobar") await aprobarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      else await rechazarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      setNota("");
      await loadRevision();
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : "No se pudo resolver la revisión.");
    } finally {
      setResolviendo(false);
    }
  }

  async function handleEstadoSat(estado: EstadoSatCfdi) {
    if (!invoiceId) return;
    setGuardandoSat(true);
    setErrorSat(null);
    try {
      const actualizado = await registrarEstadoSat(fetch, apiBaseUrl, token, propertyId, invoiceId, estado);
      setInvoice((prev) => (prev ? { ...prev, estadoSat: actualizado.estadoSat, estadoSatVerificadoEn: actualizado.estadoSatVerificadoEn } : prev));
    } catch (err) {
      setErrorSat(err instanceof Error ? err.message : "No se pudo registrar el estado SAT.");
    } finally {
      setGuardandoSat(false);
    }
  }

  // D-27: consulta REAL al servicio publico del SAT. Si el SAT no responde, el estado no cambia (jamas pasa a "vigente" por error).
  async function handleVerificarSat() {
    if (!invoiceId) return;
    setVerificandoSat(true);
    setErrorSat(null);
    try {
      const r = await verificarEstatusSat(fetch, apiBaseUrl, token, propertyId, invoiceId);
      setInvoice((prev) => (prev ? { ...prev, estadoSat: r.estadoSat, estadoSatVerificadoEn: r.estadoSatVerificadoEn, ...(r.consultado ? { esCancelable: r.esCancelable, estatusCancelacion: r.estatusCancelacion, codigoEstatus: r.codigoEstatus ?? null, validacionEfos: r.validacionEfos ?? null } : {}) } : prev));
      if (!r.consultado) {
        if (r.motivo === "ya_cancelado") notify.info("Este CFDI ya está cancelado ante el SAT; no cambia de estado.");
        else notify.warning("El SAT no respondió. El estado no cambió; inténtalo de nuevo en unos minutos.");
      } else if (r.estadoSat === "cancelado") {
        notify.warning("El SAT reporta este CFDI como cancelado.", { description: r.estatusCancelacion ?? undefined });
      } else {
        notify.success(r.estadoSat === "vigente" ? "El SAT confirma que el CFDI está vigente." : "El SAT no encontró este CFDI.");
      }
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "No se pudo verificar en el SAT.";
      setErrorSat(mensaje);
      notify.error("No se pudo verificar en el SAT", { description: mensaje });
    } finally {
      setVerificandoSat(false);
    }
  }

  if (!invoiceId) return <p role="alert" className="text-destructive text-sm">CFDI no especificado.</p>;
  if (loading && !invoice) return <EstadoCargando etiqueta="Cargando CFDI…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!invoice) return null;

  const columnasImpuestos: DataTableColumna<ImpuestoDesglosado & { clave: string }>[] = [
    { id: "impuesto", encabezado: "Impuesto", principal: true, valorOrden: (i) => i.nombre, celda: (i) => i.nombre },
    { id: "tipo", encabezado: "Tipo", valorOrden: (i) => i.naturaleza, celda: (i) => (i.naturaleza === "traslado" ? "Trasladado" : "Retenido") },
    {
      id: "tasa",
      encabezado: "Tasa o cuota",
      celda: (i) => (i.tipoFactor === "Exento" ? "Exento" : i.tipoFactor === "Cuota" ? i.tasaOCuota ?? "—" : formatTasaImpuesto(i.tasaOCuota)),
    },
    { id: "base", encabezado: "Base", alinear: "right", valorOrden: (i) => i.baseCentavos, celda: (i) => <span className="tabular-nums">{formatCentavos(i.baseCentavos)}</span> },
    { id: "importe", encabezado: "Importe", alinear: "right", valorOrden: (i) => i.importeCentavos, celda: (i) => <span className="tabular-nums">{formatCentavos(i.importeCentavos)}</span> },
  ];

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <div>
        <Link to={`/despachos/${orgSlug}/cfdi`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          CFDI
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold text-foreground">{invoice.folioFiscal}</h1>
        <div className="flex items-center gap-2">
          {invoice.valido ? (
            <StatusBadge tone="success">Válido</StatusBadge>
          ) : (
            <StatusBadge tone="danger">Con hallazgos</StatusBadge>
          )}
          {invoice.requiereRevisionHumana && <StatusBadge tone="warning">Requiere revisión humana</StatusBadge>}
        </div>
      </header>

      {invoice.requiereRevisionHumana && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
              Revisión humana
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {revisionError && (
              <p role="alert" className="text-destructive text-sm">
                {revisionError}
              </p>
            )}
                        {revisionLoading && !revision && (
              <EstadoCargando etiqueta="Cargando estado de revisión…" lineas={1} />
            )}

            {!revisionLoading && !revision && !revisionError && (
              <p role="status" className="text-sm text-success">
                Esta revisión ya fue resuelta (aprobada o rechazada).
              </p>
            )}

            {revision && (
              <>
                <p className="text-sm text-foreground">{revision.motivo}</p>
                {RESOLVER_ROLES.has(role) ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="revision-nota" className="sr-only">
                      Nota de la decisión
                    </Label>
                    <Textarea
                      id="revision-nota"
                      placeholder="Nota de la decisión (opcional)"
                      value={nota}
                      onChange={(e) => setNota(e.target.value)}
                      rows={2} />
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => handleResolver("aprobar")} disabled={resolviendo}>
                        <Check />
                        {resolviendo ? "…" : "Aprobar"}
                      </Button>
                      <Button type="button" variant="destructive" size="sm" onClick={() => handleResolver("rechazar")} disabled={resolviendo}>
                        <X />
                        {resolviendo ? "…" : "Rechazar"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Tu rol no puede resolver revisiones (solo admin/contador).</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid gap-4 p-4 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
          <Field label="RFC emisor" value={invoice.rfcEmisor} />
          <Field label="Emisor" value={invoice.emisorNombre ?? "—"} />
          <Field label="RFC receptor" value={invoice.rfcReceptor} />
          <Field label="Subtotal" value={formatMoney(invoice.subtotal)} />
          <Field label="IVA" value={formatMoney(invoice.iva)} />
          <Field label="Descuento" value={formatMoney(invoice.descuento)} />
          <Field label="Total" value={formatMoney(invoice.total)} />
          <Field label="Categoría" value={CATEGORIA_LABELS[invoice.categoria] ?? invoice.categoria} />
          <Field label="Ingestado" value={formatDate(invoice.creadoEn)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Datos fiscales del comprobante</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          <Field label="Sentido" value={formatDireccionCfdi(invoice.direccion)} />
          <Field label="Método de pago" value={formatMetodoPago(invoice.metodoPago)} />
          <Field label="Forma de pago" value={formatFormaPago(invoice.formaPago)} />
          <Field label="Uso del CFDI" value={invoice.usoCfdi ?? "—"} />
          <Field label="Moneda" value={invoice.moneda ?? "—"} />
          <Field label="Tipo de cambio" value={invoice.tipoCambio === null || invoice.tipoCambio === undefined ? "—" : String(invoice.tipoCambio)} />
          <Field label="ISR retenido" value={formatCentavos(invoice.montosCentavos?.isrRetenido)} />
          <Field label="IVA retenido" value={formatCentavos(invoice.montosCentavos?.ivaRetenido)} />
          <Field label="IEPS" value={formatCentavos(invoice.montosCentavos?.ieps)} />
        </CardContent>
      </Card>

      {invoice.impuestos && invoice.impuestos.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Impuestos desglosados</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              etiqueta="Impuestos desglosados del CFDI"
              columnas={columnasImpuestos}
              filas={invoice.impuestos.map((i, idx) => ({ ...i, clave: `${i.naturaleza}-${i.impuesto}-${i.tasaOCuota ?? "exento"}-${idx}` }))}
              obtenerId={(i) => i.clave}
              paginacion={false}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <CardTitle className="text-sm">Estado ante el SAT</CardTitle>
          <StatusBadge tone={tonoEstadoSat(invoice.estadoSat)}>{formatEstadoSat(invoice.estadoSat)}</StatusBadge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {invoice.estadoSatVerificadoEn ? `Última verificación: ${formatDate(invoice.estadoSatVerificadoEn)}.` : "Todavía no se ha verificado ante el SAT. Usa «Verificar en el SAT» o registra el estado a mano; además el sistema lo consulta a diario hasta que se resuelve."}
          </p>
          {(invoice.estatusCancelacion || invoice.esCancelable || invoice.validacionEfos) && (
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" aria-label="Detalle de cancelación ante el SAT">
              {invoice.estatusCancelacion && (
                <div>
                  <dt className="text-xs text-muted-foreground">Estatus de cancelación</dt>
                  <dd>
                    <StatusBadge tone={formatEstatusCancelacion(invoice.estatusCancelacion)?.tono ?? "neutral"}>{formatEstatusCancelacion(invoice.estatusCancelacion)?.texto ?? invoice.estatusCancelacion}</StatusBadge>
                    {/^en proceso/i.test(invoice.estatusCancelacion) && <span className="ml-2 text-xs text-muted-foreground">El receptor tiene 72 horas para aceptar o rechazar.</span>}
                  </dd>
                </div>
              )}
              {invoice.esCancelable && (
                <div>
                  <dt className="text-xs text-muted-foreground">¿Se puede cancelar?</dt>
                  <dd className="text-foreground">{invoice.esCancelable}</dd>
                </div>
              )}
              {formatValidacionEfos(invoice.validacionEfos) && (
                <div>
                  <dt className="text-xs text-muted-foreground">Validación EFOS del SAT</dt>
                  <dd className="text-foreground">{formatValidacionEfos(invoice.validacionEfos)}</dd>
                </div>
              )}
            </dl>
          )}
          {ESTADO_SAT_ROLES.has(role) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" loading={verificandoSat} loadingText="Consultando al SAT…" disabled={guardandoSat || invoice.estadoSat === "cancelado"} onClick={() => void handleVerificarSat()}>
                Verificar en el SAT
              </Button>
              <Label htmlFor="cfdi-estado-sat" className="text-xs text-muted-foreground">
                Registrar estado
              </Label>
              <NativeSelect
                id="cfdi-estado-sat"
                size="sm"
                value={invoice.estadoSat ?? "pendiente"}
                disabled={guardandoSat || invoice.estadoSat === "cancelado"}
                onChange={(e) => void handleEstadoSat(e.target.value as EstadoSatCfdi)}
                wrapperClassName="w-auto"
              >
                {ESTADOS_SAT.map((e) => (
                  <option key={e} value={e}>
                    {formatEstadoSat(e)}
                  </option>
                ))}
              </NativeSelect>
              {invoice.estadoSat === "cancelado" && <span className="text-xs text-muted-foreground">Un CFDI cancelado ya no cambia de estado.</span>}
            </div>
          )}
          {errorSat && (
            <p role="alert" className="text-sm text-destructive">
              {errorSat}
            </p>
          )}
        </CardContent>
      </Card>

      {invoice.issues.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Hallazgos</h2>
          <ul className="m-0 list-disc pl-5 text-sm text-destructive">
            {invoice.issues.map((i, idx) => (
              <li key={`${i.codigo}-${idx}`}>
                <strong>{i.codigo}</strong>: {i.mensaje}
              </li>
            ))}
          </ul>
        </div>
      )}

      {invoice.warnings.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Advertencias</h2>
          <ul className="m-0 list-disc pl-5 text-sm text-warning">
            {invoice.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-foreground">DIOT</h2>
        <p className="text-sm text-foreground">
          {invoice.diot.reportable ? `Reportable — ${invoice.diot.proveedoresReportables.length} proveedor(es)` : "No reportable"}
        </p>
      </div>
    </PageContainer>
  );
}
