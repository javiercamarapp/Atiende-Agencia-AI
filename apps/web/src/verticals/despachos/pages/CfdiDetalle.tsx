// Ficha de un CFDI (Fase 9) — GET .../cfdi/:invoiceId (cfdi.ts, `serializeInvoice`):
// el resultado completo de `validarCfdiDespachos()` (issues/warnings/DIOT), no solo
// el resumen de la lista.
import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, FormField, NativeSelect, PageContainer, PageHeader, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, notify, useConfirm } from "@atiende/ui";
import { fetchInvoice, registrarEstadoSat, verificarEstatusSat } from "../lib/cfdi-client.ts";
import type { EstadoSatCfdi, InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatCentavos, formatDate, formatDireccionCfdi, formatEstadoSat, formatFormaPago, formatMetodoPago, formatMoney, formatTasaImpuesto, tonoEstadoSat } from "../lib/format.ts";
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
  const { confirmar, dialogo } = useConfirm();
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
    if (decision === "rechazar") {
      const ok = await confirmar({
        titulo: "Rechazar CFDI",
        descripcion: "El CFDI queda rechazado en la cola de revisión humana. Esta decisión no se puede deshacer.",
        tono: "danger",
        confirmar: "Rechazar",
      });
      if (!ok) return;
    }
    setResolviendo(true);
    setRevisionError(null);
    try {
      const notaTrim = nota.trim() || undefined;
      if (decision === "aprobar") await aprobarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      else await rechazarRevision(fetch, apiBaseUrl, token, propertyId, revision.id, notaTrim);
      setNota("");
      notify.success(decision === "aprobar" ? "Revisión aprobada." : "CFDI rechazado.");
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
      setInvoice((prev) => (prev ? { ...prev, estadoSat: r.estadoSat, estadoSatVerificadoEn: r.estadoSatVerificadoEn } : prev));
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

  if (!invoiceId) return <EstadoError mensaje="CFDI no especificado." />;
  if (loading && !invoice) return <EstadoCargando etiqueta="Cargando CFDI…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!invoice) return null;

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        atras={{ etiqueta: "CFDI", to: `/despachos/${orgSlug}/cfdi` }}
        titulo="Detalle del CFDI"
        descripcion={<span className="font-mono">{invoice.folioFiscal}</span>}
        meta={
          <>
            {invoice.valido ? <StatusBadge tone="success">Válido</StatusBadge> : <StatusBadge tone="danger">Con hallazgos</StatusBadge>}
            {invoice.requiereRevisionHumana && <StatusBadge tone="warning">Requiere revisión humana</StatusBadge>}
          </>
        }
      />

      {invoice.requiereRevisionHumana && (
        <Card className="border-destructive/30 bg-destructive-tint">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
              Revisión humana
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {revisionError && <Callout tone="danger">{revisionError}</Callout>}
            {revisionLoading && !revision && <EstadoCargando etiqueta="Cargando estado de revisión…" lineas={1} />}

            {!revisionLoading && !revision && !revisionError && <Callout tone="success">Esta revisión ya fue resuelta (aprobada o rechazada).</Callout>}

            {revision && (
              <>
                <p className="text-sm text-foreground">{revision.motivo}</p>
                {RESOLVER_ROLES.has(role) ? (
                  <div className="flex flex-col gap-2">
                    <FormField label="Nota de la decisión (opcional)">
                      <Textarea id="revision-nota" placeholder="Nota de la decisión (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} rows={2} />
                    </FormField>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" onClick={() => handleResolver("aprobar")} loading={resolviendo}>
                        <Check />
                        Aprobar
                      </Button>
                      <Button type="button" variant="destructive" onClick={() => handleResolver("rechazar")} disabled={resolviendo}>
                        <X />
                        Rechazar
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
        <CardHeader>
          <CardTitle>Datos fiscales del comprobante</CardTitle>
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
          <CardHeader>
            <CardTitle>Impuestos desglosados</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Impuesto</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Tasa o cuota</TableHead>
                  <TableHead>Base</TableHead>
                  <TableHead>Importe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.impuestos.map((i, idx) => (
                  <TableRow key={`${i.naturaleza}-${i.impuesto}-${i.tasaOCuota ?? "exento"}-${idx}`}>
                    <TableCell>{i.nombre}</TableCell>
                    <TableCell>{i.naturaleza === "traslado" ? "Trasladado" : "Retenido"}</TableCell>
                    <TableCell>{i.tipoFactor === "Exento" ? "Exento" : i.tipoFactor === "Cuota" ? i.tasaOCuota ?? "—" : formatTasaImpuesto(i.tasaOCuota)}</TableCell>
                    <TableCell className="tabular-nums">{formatCentavos(i.baseCentavos)}</TableCell>
                    <TableCell className="tabular-nums">{formatCentavos(i.importeCentavos)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>Estado ante el SAT</CardTitle>
          <StatusBadge tone={tonoEstadoSat(invoice.estadoSat)}>{formatEstadoSat(invoice.estadoSat)}</StatusBadge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {invoice.estadoSatVerificadoEn ? `Última verificación: ${formatDate(invoice.estadoSatVerificadoEn)}.` : "Todavía no se ha verificado ante el SAT. Usa «Verificar en el SAT» o registra el estado a mano; además el sistema lo consulta una vez por semana."}
          </p>
          {ESTADO_SAT_ROLES.has(role) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" loading={verificandoSat} loadingText="Consultando al SAT…" disabled={guardandoSat || invoice.estadoSat === "cancelado"} onClick={() => void handleVerificarSat()}>
                Verificar en el SAT
              </Button>
              <FormField label="Registrar estado" className="grid-flow-col items-center gap-2">
                <NativeSelect
                  id="cfdi-estado-sat"
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
              </FormField>
              {invoice.estadoSat === "cancelado" && <span className="text-xs text-muted-foreground">Un CFDI cancelado ya no cambia de estado.</span>}
            </div>
          )}
          {errorSat && <Callout tone="danger">{errorSat}</Callout>}
        </CardContent>
      </Card>

      {invoice.issues.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-foreground">Hallazgos</h2>
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
          <h2 className="mb-2 text-sm font-medium text-foreground">Advertencias</h2>
          <ul className="m-0 list-disc pl-5 text-sm text-warning">
            {invoice.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-medium text-foreground">DIOT</h2>
        <p className="text-sm text-foreground">
          {invoice.diot.reportable ? `Reportable — ${invoice.diot.proveedoresReportables.length} proveedor(es)` : "No reportable"}
        </p>
      </div>
      {dialogo}
    </PageContainer>
  );
}
