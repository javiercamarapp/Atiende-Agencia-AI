// Lista de CFDI emitidos/recibidos (Fase 9) — GET .../cfdi(?requiereRevisionHumana=)
// (cfdi.ts, `serializeInvoice`). La validación fiscal real (`validarCfdiDespachos`,
// que compone `validarCfdi()` de @atiende/billing con la capa de reglas fiscales
// avanzadas) ya corre en la ingesta; esta pantalla es el primer lugar donde el staff
// puede REVISAR ese resultado (válido/issues/warnings/revisión humana) sin leer la
// base de datos a mano. La ingesta en sí (POST .../cfdi) sigue siendo un flujo
// server-to-server (PAC/timbrado), fuera de alcance de esta fase — mismo criterio
// que Convocatorias.tsx/licitaciones: cerrar el gap de LECTURA real primero.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, FileUp, Upload, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { fetchInvoices, importarCfdiXml } from "../lib/cfdi-client.ts";
import type { InvoiceSummary } from "../lib/cfdi-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const TIPO_LABELS: Record<InvoiceSummary["tipo"], string> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

// Mismo criterio que GESTIONAR_ROLES/CERRAR_ROLES en CierreMensualDetalle.tsx:
// espejo cosmético (para ocultar botones) de RESOLVER_REVISION_ROLES
// (@atiende/domain-despachos/src/roles.ts) — el enforcement real es SIEMPRE
// server-side, en revisiones.ts (assertVerticalRole).
const RESOLVER_ROLES = new Set(["admin", "contador"]);

// Espejo cosmético de INGESTA_CFDI_ROLES (@atiende/domain-despachos/src/roles.ts)
// — mismos dos roles que ya pueden `POST /cfdi`; el enforcement real vuelve a
// vivir SIEMPRE en la ruta (`assertVerticalRole`), esto solo oculta el botón.
const INGESTA_ROLES = new Set(["admin", "contador"]);

function ValidoBadge({ valido }: { valido: boolean }) {
  return valido ? (
    <Badge variant="outline" className="border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400">
      Válido
    </Badge>
  ) : (
    <Badge variant="destructive">Con hallazgos</Badge>
  );
}

export function CfdiPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloRevision, setSoloRevision] = useState(false);

  const [revisiones, setRevisiones] = useState<readonly RevisionCfdi[] | null>(null);
  const [revisionesLoading, setRevisionesLoading] = useState(false);
  const [revisionesError, setRevisionesError] = useState<string | null>(null);
  const [notaDrafts, setNotaDrafts] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [importando, setImportando] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const xmlInputRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInvoices(await fetchInvoices(fetch, apiBaseUrl, token, propertyId, soloRevision ? { requiereRevisionHumana: true } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los CFDI.");
    } finally {
      setLoading(false);
    }
  }

  // Cola de revisión humana (hallazgo ALTA): independiente del filtro
  // "soloRevision" de la tabla de abajo -- GET .../revisiones siempre trae TODAS
  // las pendientes de la property, sin importar qué esté viendo el usuario en la
  // tabla de CFDI.
  async function loadRevisiones() {
    setRevisionesLoading(true);
    setRevisionesError(null);
    try {
      setRevisiones(await fetchRevisionesPendientes(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setRevisionesError(err instanceof Error ? err.message : "No se pudo cargar la cola de revisión.");
    } finally {
      setRevisionesLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, soloRevision]);

  useEffect(() => {
    void loadRevisiones();
  }, [apiBaseUrl, token, propertyId]);

  async function handleResolver(reviewId: string, decision: "aprobar" | "rechazar") {
    setResolveError(null);
    setResolvingId(reviewId);
    try {
      const nota = notaDrafts[reviewId]?.trim() || undefined;
      if (decision === "aprobar") await aprobarRevision(fetch, apiBaseUrl, token, propertyId, reviewId, nota);
      else await rechazarRevision(fetch, apiBaseUrl, token, propertyId, reviewId, nota);
      setNotaDrafts((prev) => {
        const next = { ...prev };
        delete next[reviewId];
        return next;
      });
      await Promise.all([loadRevisiones(), load()]);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "No se pudo resolver la revisión.");
    } finally {
      setResolvingId(null);
    }
  }

  // POST /despachos/:propertyId/cfdi/importar-xml (cierre de gap de auditoría:
  // hasta esta fase la ÚNICA forma de ingestar un CFDI era pegar a mano el JSON
  // de 15+ campos ya desarmado -- ver cabecera de cfdi.ts). Un CFDI real llega
  // como archivo .xml timbrado por el PAC; este botón lee el archivo local con
  // FileReader (nunca sube nada a un tercero) y manda el texto crudo tal cual.
  async function handleImportarXml(file: File) {
    setImportError(null);
    setImportOk(null);
    setImportando(true);
    try {
      const xml = await file.text();
      const invoice = await importarCfdiXml(fetch, apiBaseUrl, token, propertyId, xml);
      setImportOk(`CFDI ${invoice.folioFiscal.slice(0, 13)}… importado correctamente.`);
      await Promise.all([load(), loadRevisiones()]);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "No se pudo importar el CFDI.");
    } finally {
      setImportando(false);
      if (xmlInputRef.current) xmlInputRef.current.value = "";
    }
  }

  const invoicesById = new Map((invoices ?? []).map((inv) => [inv.id, inv] as const));

  return (
    <div className="flex flex-col gap-4 px-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">CFDI</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Comprobantes ingestados y validados contra las reglas fiscales del SAT.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={soloRevision}
              onChange={(e) => setSoloRevision(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Solo con revisión humana pendiente
          </label>
          {INGESTA_ROLES.has(role) && (
            <>
              <input
                ref={xmlInputRef}
                type="file"
                accept=".xml,text/xml,application/xml"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportarXml(file);
                }}
              />
              <Button type="button" size="sm" onClick={() => xmlInputRef.current?.click()} disabled={importando}>
                <Upload />
                {importando ? "Importando…" : "Cargar XML de CFDI"}
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Avisos transitorios de la importación: se dejan como banderas inline
          (no `toast`) porque `apps/web` no monta ningún `<Toaster />` y mandar
          esto a sonner lo haría desaparecer sin que el staff lo vea. */}
      {importError && (
        <p role="alert" className="text-destructive text-sm">
          {importError}
        </p>
      )}
      {importOk && !importError && (
        <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
          <FileUp className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {importOk}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <CardTitle className="text-sm">Cola de revisión humana</CardTitle>
          {revisiones && <span className="text-xs text-muted-foreground">{revisiones.length} pendiente(s)</span>}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {resolveError && (
            <p role="alert" className="text-destructive text-sm">
              {resolveError}
            </p>
          )}
          {revisionesError && (
            <p role="alert" className="text-destructive text-sm">
              {revisionesError}
            </p>
          )}
          {/* Sub-widget anidado: tratamiento de carga/vacío compacto (skeletons y
              una línea) en vez del bloque acolchado de EstadoCargando/EstadoVacio,
              que aquí competiría visualmente con los estados de la tabla de abajo. */}
          {revisionesLoading && !revisiones && (
            <div role="status" aria-busy="true" aria-label="Cargando cola de revisión…" className="space-y-2">
              <span className="sr-only">Cargando cola de revisión…</span>
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="h-4 w-64 rounded" />
            </div>
          )}
          {revisiones && revisiones.length === 0 && !revisionesLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              No hay CFDI pendientes de revisión humana.
            </p>
          )}

          {revisiones && revisiones.length > 0 && (
            <div className="flex flex-col gap-2">
              {revisiones.map((r) => {
                const inv = invoicesById.get(r.invoiceId);
                return (
                  <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <Link to={`/despachos/${orgSlug}/cfdi/${r.invoiceId}`} className="text-[13px] font-semibold text-foreground hover:underline underline-offset-2">
                          {inv ? (inv.emisorNombre ?? inv.rfcEmisor) : r.invoiceId}
                        </Link>
                        <p className="mt-0.5 text-xs text-muted-foreground">{r.motivo}</p>
                      </div>
                      <span className="text-[11px] text-muted-foreground">{formatDate(r.creadoEn)}</span>
                    </div>
                    {RESOLVER_ROLES.has(role) ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={`revision-nota-${r.id}`} className="sr-only">
                          Nota de la revisión
                        </Label>
                        <Input
                          id={`revision-nota-${r.id}`}
                          type="text"
                          placeholder="Nota (opcional)"
                          value={notaDrafts[r.id] ?? ""}
                          onChange={(e) => setNotaDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          className="h-9 min-w-40 flex-1 text-xs"
                        />
                        <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => handleResolver(r.id, "aprobar")} disabled={resolvingId === r.id}>
                          <Check />
                          {resolvingId === r.id ? "…" : "Aprobar"}
                        </Button>
                        <Button type="button" variant="destructive" size="sm" className="h-9" onClick={() => handleResolver(r.id, "rechazar")} disabled={resolvingId === r.id}>
                          <X />
                          {resolvingId === r.id ? "…" : "Rechazar"}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">Tu rol no puede resolver revisiones (solo admin/contador).</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !invoices && <EstadoCargando etiqueta="Cargando CFDI…" />}

      {invoices && invoices.length === 0 && !loading && (
        <EstadoVacio mensaje={soloRevision ? "No hay CFDI pendientes de revisión humana." : "Todavía no hay ningún CFDI ingestado."} />
      )}

      {invoices && invoices.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Folio fiscal</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Emisor</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Estatus</TableHead>
                  <TableHead>Revisión</TableHead>
                  <TableHead>Fecha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link to={`/despachos/${orgSlug}/cfdi/${inv.id}`} className="font-mono text-xs font-semibold text-foreground hover:underline underline-offset-2">
                        {inv.folioFiscal.slice(0, 13)}…
                      </Link>
                      <div className="text-[11px] text-muted-foreground">{inv.rfcReceptor}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{TIPO_LABELS[inv.tipo] ?? inv.tipo}</TableCell>
                    <TableCell className="text-muted-foreground">{inv.emisorNombre ?? inv.rfcEmisor}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{formatMoney(inv.total)}</TableCell>
                    <TableCell>
                      <ValidoBadge valido={inv.valido} />
                    </TableCell>
                    <TableCell className={inv.requiereRevisionHumana ? "text-destructive" : "text-muted-foreground"}>{inv.requiereRevisionHumana ? "Pendiente" : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(inv.creadoEn)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
