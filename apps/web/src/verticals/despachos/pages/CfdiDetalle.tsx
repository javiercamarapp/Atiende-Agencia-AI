// Ficha de un CFDI (Fase 9) — GET .../cfdi/:invoiceId (cfdi.ts, `serializeInvoice`):
// el resultado completo de `validarCfdiDespachos()` (issues/warnings/DIOT), no solo
// el resumen de la lista.
import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  Label,
  Skeleton,
} from "@atiende/ui";
import { fetchInvoice } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo criterio que en Cfdi.tsx: espejo cosmético de RESOLVER_REVISION_ROLES
// (@atiende/domain-despachos/src/roles.ts) -- el enforcement real vive en
// revisiones.ts (assertVerticalRole), server-side.
const RESOLVER_ROLES = new Set(["admin", "contador"]);

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
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
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

  if (!invoiceId) return <p role="alert" className="text-destructive text-sm">CFDI no especificado.</p>;
  if (loading && !invoice) return <EstadoCargando etiqueta="Cargando CFDI…" />;
  if (error) return <EstadoError mensaje={error} />;
  if (!invoice) return null;

  return (
    <div className="flex max-w-3xl flex-col gap-4 px-1">
      <div>
        <Link to={`/despachos/${orgSlug}/cfdi`} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          CFDI
        </Link>
      </div>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold text-foreground">{invoice.folioFiscal}</h1>
        <div className="flex items-center gap-2">
          {invoice.valido ? (
            <Badge variant="outline" className="border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400">
              Válido
            </Badge>
          ) : (
            <Badge variant="destructive">Con hallazgos</Badge>
          )}
          {invoice.requiereRevisionHumana && <Badge variant="secondary">Requiere revisión humana</Badge>}
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
            {/* Sub-widget anidado dentro de la ficha: tratamiento de carga
                compacto (una línea de skeleton) en vez del bloque acolchado de
                EstadoCargando, que ya se usa para la ficha completa arriba. */}
            {revisionLoading && !revision && (
              <div role="status" aria-busy="true" aria-label="Cargando estado de revisión…">
                <span className="sr-only">Cargando estado de revisión…</span>
                <Skeleton className="h-4 w-56 rounded" />
              </div>
            )}

            {!revisionLoading && !revision && !revisionError && (
              <p role="status" className="text-sm text-green-700 dark:text-green-400">
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
                    <textarea
                      id="revision-nota"
                      placeholder="Nota de la decisión (opcional)"
                      value={nota}
                      onChange={(e) => setNota(e.target.value)}
                      rows={2}
                      className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
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
          <ul className="m-0 list-disc pl-5 text-sm text-amber-700 dark:text-amber-500">
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
    </div>
  );
}
