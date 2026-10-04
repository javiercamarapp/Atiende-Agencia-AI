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
import { Check, FileStack, ShieldAlert, Upload, X } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormField,
  Input,
  NativeSelect,
  notify,
  PageContainer,
  PageHeader,
  StatusBadge,
  useConfirm,
} from "@atiende/ui";
import { fetchInvoices, importarCfdiXml } from "../lib/cfdi-client.ts";
import type { DireccionCfdi, InvoiceSummary } from "../lib/cfdi-client.ts";
import { fetchEfosAlertas, resumenEfos } from "../lib/efos-client.ts";
import type { EfosAlertasRespuesta } from "../lib/efos-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatDireccionCfdi, formatEstadoSat, formatMoney, tonoEstadoSat } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";
import { ImportarLoteDialog } from "../components/ImportarLoteDialog.tsx";

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
  return valido ? <StatusBadge tone="success">Válido</StatusBadge> : <StatusBadge tone="danger">Con hallazgos</StatusBadge>;
}

export function CfdiPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const { confirmar, dialogo } = useConfirm();
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soloRevision, setSoloRevision] = useState(false);
  // D-22: emitidos vs recibidos segun el RFC de la ficha del cliente ("" = todos).
  const [direccion, setDireccion] = useState<"" | DireccionCfdi>("");

  const [revisiones, setRevisiones] = useState<readonly RevisionCfdi[] | null>(null);
  const [revisionesLoading, setRevisionesLoading] = useState(false);
  const [revisionesError, setRevisionesError] = useState<string | null>(null);
  const [notaDrafts, setNotaDrafts] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // D-04: alertas de la lista 69-B (EFOS) del SAT sobre los CFDI ya ingeridos de la property.
  const [efos, setEfos] = useState<EfosAlertasRespuesta | null>(null);
  const [efosError, setEfosError] = useState<string | null>(null);

  const [importando, setImportando] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const xmlInputRef = useRef<HTMLInputElement | null>(null);
  // D-13: carga masiva (ZIP o varios XML).
  const [loteAbierto, setLoteAbierto] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInvoices(await fetchInvoices(fetch, apiBaseUrl, token, propertyId, { ...(soloRevision ? { requiereRevisionHumana: true } : {}), ...(direccion !== "" ? { direccion } : {}) }));
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
  }, [apiBaseUrl, token, propertyId, soloRevision, direccion]);

  useEffect(() => {
    void loadRevisiones();
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    setEfosError(null);
    fetchEfosAlertas(fetch, apiBaseUrl, token, propertyId).then(setEfos, (err: unknown) => setEfosError(err instanceof Error ? err.message : "No se pudo consultar la lista 69-B."));
  }, [apiBaseUrl, token, propertyId]);

  async function handleResolver(reviewId: string, decision: "aprobar" | "rechazar") {
    if (decision === "rechazar") {
      const ok = await confirmar({
        titulo: "Rechazar CFDI",
        descripcion: "El CFDI queda rechazado en la cola de revisión humana. Esta decisión no se puede deshacer.",
        tono: "danger",
        confirmar: "Rechazar",
      });
      if (!ok) return;
    }
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
      notify.success(decision === "aprobar" ? "Revisión aprobada." : "CFDI rechazado.");
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
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="CFDI"
        descripcion="Comprobantes ingestados y validados contra las reglas fiscales del SAT."
        acciones={
          <>
            <FormField label="Sentido" className="[&>label]:sr-only">
              <NativeSelect id="cfdi-filtro-direccion" value={direccion} onChange={(e) => setDireccion(e.target.value as "" | DireccionCfdi)} wrapperClassName="w-auto">
                <option value="">Todos</option>
                <option value="emitido">Emitidos</option>
                <option value="recibido">Recibidos</option>
                <option value="indeterminado">Sin clasificar</option>
              </NativeSelect>
            </FormField>
            <Checkbox checked={soloRevision} onChange={(e) => setSoloRevision(e.target.checked)} label="Solo con revisión humana pendiente" />
            {INGESTA_ROLES.has(role) && (
              <>
                <input
                  ref={xmlInputRef}
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  className="hidden"
                  aria-label="Archivo XML del CFDI"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportarXml(file);
                  }}
                />
                <Button type="button" size="sm" onClick={() => xmlInputRef.current?.click()} loading={importando}>
                  <Upload />
                  Cargar XML de CFDI
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setLoteAbierto(true)}>
                  <FileStack />
                  Importar ZIP o varios XML
                </Button>
              </>
            )}
          </>
        }
      />

      <ImportarLoteDialog
        open={loteAbierto}
        onOpenChange={setLoteAbierto}
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        onTerminado={() => void Promise.all([load(), loadRevisiones()])}
      />

      {/* Avisos de la importación: banderas inline (persisten hasta la siguiente importación; un toast se iría solo). */}
      {importError && <Callout tone="danger">{importError}</Callout>}
      {importOk && !importError && <Callout tone="success">{importOk}</Callout>}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4" strokeWidth={1.75} />
            Lista 69-B del SAT (EFOS)
          </CardTitle>
          {efos?.lista.periodo && <span className="text-xs text-muted-foreground">Edición {efos.lista.periodo}</span>}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {efosError && <Callout tone="danger">{efosError}</Callout>}
          {efos && <Callout tone={resumenEfos(efos).tono === "alerta" ? "danger" : "neutral"}>{resumenEfos(efos).mensaje}</Callout>}
          {efos && efos.alertas.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {efos.alertas.map((a) => (
                <li key={a.invoiceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                  <span>
                    <Link to={`/despachos/${orgSlug}/cfdi/${a.invoiceId}`} className="font-semibold text-foreground hover:underline underline-offset-2">
                      {a.emisorNombre ?? a.rfcEmisor}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{a.rfcEmisor}</span>
                    <span className="ml-2 tabular-nums text-muted-foreground">{formatMoney(a.total)}</span>
                  </span>
                  <StatusBadge tone={a.situacion === "definitivo" ? "danger" : "warning"}>{a.situacion === "definitivo" ? "Definitivo" : "Presunto"}</StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>Cola de revisión humana</CardTitle>
          {revisiones && <span className="text-xs text-muted-foreground">{revisiones.length} pendiente(s)</span>}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {resolveError && <Callout tone="danger">{resolveError}</Callout>}
          {revisionesError && <Callout tone="danger">{revisionesError}</Callout>}
          {revisionesLoading && !revisiones && <EstadoCargando etiqueta="Cargando cola de revisión…" lineas={2} />}
          {revisiones && revisiones.length === 0 && !revisionesLoading && <EstadoVacio compacto mensaje="No hay CFDI pendientes de revisión humana." />}

          {revisiones && revisiones.length > 0 && (
            <div className="flex flex-col gap-2">
              {revisiones.map((r) => {
                const inv = invoicesById.get(r.invoiceId);
                return (
                  <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-border bg-canvas p-3">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div>
                        <Link to={`/despachos/${orgSlug}/cfdi/${r.invoiceId}`} className="text-sm font-semibold text-foreground hover:underline underline-offset-2">
                          {inv ? (inv.emisorNombre ?? inv.rfcEmisor) : r.invoiceId}
                        </Link>
                        <p className="mt-0.5 text-xs text-muted-foreground">{r.motivo}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDate(r.creadoEn)}</span>
                    </div>
                    {RESOLVER_ROLES.has(role) ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <FormField label="Nota de la revisión (opcional)" className="min-w-40 flex-1">
                          <Input
                            id={`revision-nota-${r.id}`}
                            type="text"
                            placeholder="Nota (opcional)"
                            value={notaDrafts[r.id] ?? ""}
                            onChange={(e) => setNotaDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          />
                        </FormField>
                        <Button type="button" variant="outline" onClick={() => handleResolver(r.id, "aprobar")} loading={resolvingId === r.id}>
                          <Check />
                          Aprobar
                        </Button>
                        <Button type="button" variant="destructive" onClick={() => handleResolver(r.id, "rechazar")} disabled={resolvingId === r.id}>
                          <X />
                          Rechazar
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Tu rol no puede resolver revisiones (solo admin/contador).</p>
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
        <EstadoVacio mensaje={soloRevision ? "No hay CFDI pendientes de revisión humana." : direccion !== "" ? "No hay CFDI con ese sentido. Los CFDI sin ficha de cliente en la cartera quedan «sin clasificar»." : "Todavía no hay ningún CFDI ingestado."} />
      )}

      {invoices && invoices.length > 0 && (
        <DataTable
          etiqueta="CFDI ingestados"
          obtenerId={(inv) => inv.id}
          filas={invoices}
          paginacion={false}
          columnas={[
            {
              id: "folio",
              encabezado: "Folio fiscal",
              principal: true,
              celda: (inv) => (
                <>
                  <Link to={`/despachos/${orgSlug}/cfdi/${inv.id}`} className="font-mono text-xs font-semibold text-foreground hover:underline underline-offset-2">
                    {inv.folioFiscal.slice(0, 13)}…
                  </Link>
                  <div className="text-xs font-normal text-muted-foreground">{inv.rfcReceptor}</div>
                </>
              ),
            },
            { id: "tipo", encabezado: "Tipo", celda: (inv) => <span className="text-muted-foreground">{TIPO_LABELS[inv.tipo] ?? inv.tipo}</span> },
            { id: "emisor", encabezado: "Emisor", celda: (inv) => <span className="text-muted-foreground">{inv.emisorNombre ?? inv.rfcEmisor}</span> },
            { id: "total", encabezado: "Total", celda: (inv) => <span className="tabular-nums text-muted-foreground">{formatMoney(inv.total)}</span> },
            { id: "sentido", encabezado: "Sentido", celda: (inv) => <span className="text-muted-foreground">{formatDireccionCfdi(inv.direccion)}</span> },
            { id: "moneda", encabezado: "Moneda", celda: (inv) => <span className="font-mono text-xs text-muted-foreground">{inv.moneda ?? "—"}</span> },
            { id: "estatus", encabezado: "Estatus", celda: (inv) => <ValidoBadge valido={inv.valido} /> },
            { id: "sat", encabezado: "SAT", celda: (inv) => <StatusBadge tone={tonoEstadoSat(inv.estadoSat)}>{formatEstadoSat(inv.estadoSat)}</StatusBadge> },
            {
              id: "revision",
              encabezado: "Revisión",
              celda: (inv) => <span className={inv.requiereRevisionHumana ? "text-destructive" : "text-muted-foreground"}>{inv.requiereRevisionHumana ? "Pendiente" : "—"}</span>,
            },
            { id: "fecha", encabezado: "Fecha", celda: (inv) => <span className="text-muted-foreground">{formatDate(inv.creadoEn)}</span> },
          ]}
        />
      )}
      {dialogo}
    </PageContainer>
  );
}
