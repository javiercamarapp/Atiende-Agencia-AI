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
import { Check, FileStack, FileUp, ShieldAlert, Upload, X } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  type DataTableColumna,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
} from "@atiende/ui";
import { fetchInvoices, importarCfdiXml } from "../lib/cfdi-client.ts";
import type { DireccionCfdi, InvoiceSummary } from "../lib/cfdi-client.ts";
import { fetchEfosAlertas, resumenEfos } from "../lib/efos-client.ts";
import type { EfosAlerta, EfosAlertasRespuesta } from "../lib/efos-client.ts";
import { aprobarRevision, fetchRevisionesPendientes, rechazarRevision } from "../lib/revisiones-client.ts";
import type { RevisionCfdi } from "../lib/revisiones-client.ts";
import { formatDate, formatDireccionCfdi, formatEstadoSat, formatEstatusCancelacion, formatMoney, tonoEstadoSat } from "../lib/format.ts";
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

  const columnasEfos: DataTableColumna<EfosAlerta>[] = [
    {
      id: "emisor",
      encabezado: "Emisor",
      principal: true,
      valorOrden: (a) => a.emisorNombre ?? a.rfcEmisor,
      celda: (a) => (
        <Link to={`/despachos/${orgSlug}/cfdi/${a.invoiceId}`} className="font-semibold text-foreground hover:underline underline-offset-2">
          {a.emisorNombre ?? a.rfcEmisor}
        </Link>
      ),
    },
    { id: "rfc", encabezado: "RFC", celda: (a) => <span className="font-mono text-xs text-muted-foreground">{a.rfcEmisor}</span> },
    { id: "total", encabezado: "Total", alinear: "right", valorOrden: (a) => a.total, celda: (a) => <span className="tabular-nums">{formatMoney(a.total)}</span> },
    {
      id: "situacion",
      encabezado: "Situación",
      valorOrden: (a) => a.situacion,
      celda: (a) => <StatusBadge tone={a.situacion === "definitivo" ? "danger" : "warning"}>{a.situacion === "definitivo" ? "Definitivo" : "Presunto"}</StatusBadge>,
    },
  ];

  const columnasRevisiones: DataTableColumna<RevisionCfdi>[] = [
    {
      id: "cfdi",
      encabezado: "CFDI",
      principal: true,
      valorOrden: (r) => {
        const inv = invoicesById.get(r.invoiceId);
        return inv ? (inv.emisorNombre ?? inv.rfcEmisor) : r.invoiceId;
      },
      celda: (r) => {
        const inv = invoicesById.get(r.invoiceId);
        return (
          <Link to={`/despachos/${orgSlug}/cfdi/${r.invoiceId}`} className="font-semibold text-foreground hover:underline underline-offset-2">
            {inv ? (inv.emisorNombre ?? inv.rfcEmisor) : r.invoiceId}
          </Link>
        );
      },
    },
    { id: "motivo", encabezado: "Motivo", valorOrden: (r) => r.motivo, celda: (r) => <span className="text-xs text-muted-foreground">{r.motivo}</span> },
    { id: "fecha", encabezado: "Fecha", valorOrden: (r) => r.creadoEn, celda: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.creadoEn)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (r) =>
        RESOLVER_ROLES.has(role) ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
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
          <span className="text-xs text-muted-foreground">Tu rol no puede resolver revisiones (solo admin/contador).</span>
        ),
    },
  ];

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">CFDI</h1>
          <p className="mt-1 text-sm text-muted-foreground">Comprobantes ingestados y validados contra las reglas fiscales del SAT.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="cfdi-filtro-direccion" className="text-xs text-muted-foreground">
              Sentido
            </Label>
            <NativeSelect id="cfdi-filtro-direccion" size="sm" value={direccion} onChange={(e) => setDireccion(e.target.value as "" | DireccionCfdi)} wrapperClassName="w-auto">
              <option value="">Todos</option>
              <option value="emitido">Emitidos</option>
              <option value="recibido">Recibidos</option>
              <option value="indeterminado">Sin clasificar</option>
            </NativeSelect>
          </div>
          <Checkbox checked={soloRevision} onChange={(e) => setSoloRevision(e.target.checked)} label="Solo con revisión humana pendiente" />
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
              <Button type="button" size="sm" variant="outline" onClick={() => setLoteAbierto(true)}>
                <FileStack />
                Importar ZIP o varios XML
              </Button>
            </>
          )}
        </div>
      </header>

      <ImportarLoteDialog
        open={loteAbierto}
        onOpenChange={setLoteAbierto}
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        onTerminado={() => void Promise.all([load(), loadRevisiones()])}
      />

      {/* Avisos de la importación: banderas inline (persisten hasta la siguiente importación; un toast se iría solo). */}
      {importError && (
        <p role="alert" className="text-destructive text-sm">
          {importError}
        </p>
      )}
      {importOk && !importError && (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <FileUp className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {importOk}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 pb-3">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <ShieldAlert className="h-4 w-4" strokeWidth={1.75} />
            Lista 69-B del SAT (EFOS)
          </CardTitle>
          {efos?.lista.periodo && <span className="text-xs text-muted-foreground">Edición {efos.lista.periodo}</span>}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {efosError && (
            <p role="alert" className="text-destructive text-sm">
              {efosError}
            </p>
          )}
          {efos && (
            <p role="status" className={resumenEfos(efos).tono === "alerta" ? "text-sm font-medium text-destructive" : "text-sm text-muted-foreground"}>
              {resumenEfos(efos).mensaje}
            </p>
          )}
          {efos && efos.alertas.length > 0 && (
            <DataTable etiqueta="Alertas EFOS 69-B" columnas={columnasEfos} filas={efos.alertas} obtenerId={(a) => a.invoiceId} />
          )}
        </CardContent>
      </Card>

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
          {revisionesLoading && !revisiones && (
            <EstadoCargando etiqueta="Cargando cola de revisión…" lineas={2} />
          )}
          {revisiones && revisiones.length === 0 && !revisionesLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              No hay CFDI pendientes de revisión humana.
            </p>
          )}

          {revisiones && revisiones.length > 0 && (
            <DataTable etiqueta="Cola de revisión humana" columnas={columnasRevisiones} filas={revisiones} obtenerId={(r) => r.id} />
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
              id: "cancelacion",
              encabezado: "Cancelación",
              celda: (inv) => {
                const c = formatEstatusCancelacion(inv.estatusCancelacion);
                return c ? <StatusBadge tone={c.tono}>{c.texto}</StatusBadge> : <span className="text-muted-foreground">—</span>;
              },
            },
            {
              id: "revision",
              encabezado: "Revisión",
              celda: (inv) => <span className={inv.requiereRevisionHumana ? "text-destructive" : "text-muted-foreground"}>{inv.requiereRevisionHumana ? "Pendiente" : "—"}</span>,
            },
            { id: "fecha", encabezado: "Fecha", celda: (inv) => <span className="text-muted-foreground">{formatDate(inv.creadoEn)}</span> },
          ]}
        />
      )}
    </PageContainer>
  );
}
