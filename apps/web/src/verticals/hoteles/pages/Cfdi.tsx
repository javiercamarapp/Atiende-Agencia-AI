// CFDI de hospedaje — Fase 5 (H5/REQ-BO-001/002), UI real para
// apps/api/src/routes/verticals/hoteles/cfdi.ts (hasta esta pieza el backend de CFDI
// no tenía cliente ni página: timbrar la estancia de un huésped era imposible desde
// el panel). Autorización fina real: solo owner/gm/accountant pueden timbrar/pagar/
// cancelar (CFDI_HOSPEDAJE_ROLES, packages/domain-hoteles/src/roles.ts) — este
// componente NO replica esa lista (apps/web nunca depende de un paquete domain-*,
// mismo criterio que folios-client.ts): un staff sin ese rol ve el 403 real del
// servidor reflejado en `error`, igual que ya hace FraudePage con FRAUD_SCAN_ROLES.
//
// El motor de reglas fiscales (breakdown ISH/DSA, validación previa al timbrado)
// corre SIEMPRE en el servidor — este panel nunca calcula ni valida montos, solo
// refleja lo que la ruta ya serializa.
//
// Visual (UNI-C gestion): PageHeader, tabla y dialogo de cancelacion compartidos con CfdiListado
// (components/CfdiComprobantes.tsx), FormField en cada campo y Button con loading. Ningún cambio de
// lógica: mismos props, mismo estado, mismas llamadas de red, misma condición de cada rama.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, Checkbox, DataTable, EstadoCargando, EstadoError, FormField, Input, NativeSelect, PageContainer, PageHeader } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { cancelarCfdi, consultarEstadoCfdi, emitirCfdiHospedaje, emitirCfdiPago, fetchCfdisByFolio } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { fetchFolio } from "../lib/folios-client.ts";
import type { FolioSummary } from "../lib/folios-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { CfdiCancelarDialog, CfdiTabla } from "../components/CfdiComprobantes.tsx";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export interface CfdiPageProps extends HotelesShellContext {
  readonly folioId: string;
}

export function CfdiPage({ apiBaseUrl, token, propertyId, folioId }: CfdiPageProps) {
  const [folio, setFolio] = useState<FolioSummary | null>(null);
  const [cfdis, setCfdis] = useState<readonly CfdiEmisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [rfcReceptor, setRfcReceptor] = useState("");
  const [usoCfdi, setUsoCfdi] = useState("G03");
  const [metodoPago, setMetodoPago] = useState<"PUE" | "PPD">("PUE");
  const [esExtranjero, setEsExtranjero] = useState(false);
  const [esGlobal, setEsGlobal] = useState(false);
  const [esNoShow, setEsNoShow] = useState(false);

  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState<MotivoCancelacionSat>("02");
  const [cancelFolioSustitucion, setCancelFolioSustitucion] = useState("");

  async function load() {
    setError(null);
    try {
      const [folioResult, cfdisResult] = await Promise.all([fetchFolio(fetch, apiBaseUrl, token, propertyId, folioId), fetchCfdisByFolio(fetch, apiBaseUrl, token, propertyId, folioId)]);
      setFolio(folioResult);
      setCfdis(cfdisResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el CFDI de este folio.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, folioId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  async function handleEmitirHospedaje(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (esExtranjero && esGlobal) return setError("Un CFDI no puede ser extranjero y global a la vez.");
    if (!esExtranjero && !esGlobal && (!rfcReceptor.trim() || !usoCfdi.trim())) {
      return setError("RFC receptor y uso de CFDI son obligatorios salvo huésped extranjero/factura global.");
    }
    await withBusy(async () => {
      await emitirCfdiHospedaje(
        fetch,
        apiBaseUrl,
        token,
        propertyId,
        folioId,
        {
          rfcReceptor: esExtranjero || esGlobal ? undefined : rfcReceptor.trim(),
          usoCfdi: esExtranjero || esGlobal ? undefined : usoCfdi.trim(),
          metodoPago,
          esExtranjero,
          esGlobal,
          esNoShow,
        },
        newIdempotencyKey(),
      );
    });
  }

  async function handleEmitirPago(hospedajeCfdiId: string, paymentId: string) {
    await withBusy(() => emitirCfdiPago(fetch, apiBaseUrl, token, propertyId, folioId, paymentId, hospedajeCfdiId, newIdempotencyKey()).then(() => undefined));
  }

  // Hallazgo auditoría — 'en_proceso_cancelacion' era un callejón sin salida (el
  // PAC nunca se volvía a consultar). Botón manual: llama al PAC en vivo vía
  // `POST .../consultar-estado`; el servidor solo actualiza el registro cuando de
  // verdad confirma 'cancelado', así que este botón puede llamarse varias veces
  // sin riesgo mientras el SAT sigue resolviendo.
  async function handleConsultarEstado(cfdiId: string) {
    await withBusy(() => consultarEstadoCfdi(fetch, apiBaseUrl, token, propertyId, cfdiId).then(() => undefined));
  }

  async function handleCancelar() {
    if (!cancelTargetId) return;
    setBusy(true);
    setCancelError(null);
    try {
      await cancelarCfdi(fetch, apiBaseUrl, token, propertyId, cancelTargetId, cancelMotivo, cancelMotivo === "01" ? cancelFolioSustitucion.trim() || undefined : undefined, newIdempotencyKey());
      setCancelTargetId(null);
      setCancelFolioSustitucion("");
      await load();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "No se pudo cancelar el CFDI.");
    } finally {
      setBusy(false);
    }
  }

  if (!folio || !cfdis) {
    if (error) {
      return (
        <EstadoError mensaje={error} onReintentar={() => void load()} />
      );
    }
    return (
      <EstadoCargando etiqueta="Cargando CFDI del folio…" />
    );
  }

  // Fix hallazgo auditoría — un CFDI de hospedaje "cancelado" SÍ debe poder
  // reemitirse con un folio fiscal nuevo (misma regla que ya aplica el backend,
  // ver cfdi.ts): solo un hospedaje VIGENTE (no cancelado) cuenta como "ya
  // emitido" para ocultar el formulario o habilitar el complemento de pago. Un
  // folio puede acumular más de un CFDI 'hospedaje' en su historial (los
  // cancelados), pero a lo más uno vigente a la vez (REQ-BO-002).
  const cfdiHospedaje = cfdis.find((c) => c.tipo === "hospedaje" && c.estado !== "cancelado") ?? null;
  const cfdisPago = cfdis.filter((c) => c.tipo === "pago");
  const puedeTimbrarHospedaje = !cfdiHospedaje;
  // `serializeCfdi` (apps/api/.../cfdi.ts) no expone `paymentId` en la respuesta —
  // este panel no puede saber, solo con GET .../cfdi, a qué pago capturado
  // corresponde CADA complemento ya timbrado. En vez de fingir esa distinción con un
  // filtro que adivinaría mal, se listan TODOS los pagos capturados: la ruta
  // POST .../cfdi/pago YA es idempotente por `paymentId` real
  // (`findCfdiEmisionByPayment`), así que reintentar sobre un pago que ya tiene
  // complemento simplemente devuelve el mismo comprobante (200) sin re-timbrar.
  const pagosCapturados = folio.pagos.filter((p) => p.estado === "capturado");
  const puedeTimbrarPago = cfdiHospedaje?.estado === "timbrado" && cfdiHospedaje.metodoPago === "PPD";

  const columnasPagos: readonly DataTableColumna<FolioSummary["pagos"][number]>[] = [
    { id: "metodo", encabezado: "Pago", principal: true, celda: (p) => <span>{p.metodo}</span> },
    { id: "monto", encabezado: "Monto", alinear: "right", celda: (p) => <span className="tabular-nums">{dineroMx(p.monto)}</span> },
    { id: "ref", encabezado: "Referencia", celda: (p) => <span className="text-muted-foreground">{p.referenciaExterna ? `Ref: ${p.referenciaExterna}` : "—"}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (p) => (
        <Button type="button" variant="outline" size="sm" onClick={() => void handleEmitirPago(cfdiHospedaje!.id, p.id)} disabled={busy}>
          Timbrar complemento de pago
        </Button>
      ),
    },
  ];

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="CFDI de hospedaje" descripcion={`Folio: ${folio.etiqueta} · Saldo: ${dineroMx(folio.saldo)}`} />

      {error && <Callout tone="danger" titulo="Ocurrió un problema">{error}</Callout>}

      <section className="grid gap-2">
        <h2 className="text-sm font-medium text-foreground">Comprobantes emitidos</h2>
        <CfdiTabla
          cfdis={cfdis}
          error={null}
          onReintentar={() => void load()}
          vacio="Este folio todavía no tiene ningún CFDI timbrado."
          busy={busy}
          onCancelar={(id) => {
            setCancelError(null);
            setCancelTargetId(id);
          }}
          onConsultarEstado={(id) => void handleConsultarEstado(id)}
        />
      </section>

      <CfdiCancelarDialog
        open={cancelTargetId !== null}
        onClose={() => setCancelTargetId(null)}
        busy={busy}
        error={cancelError}
        motivo={cancelMotivo}
        onMotivoChange={setCancelMotivo}
        folioSustitucion={cancelFolioSustitucion}
        onFolioSustitucionChange={setCancelFolioSustitucion}
        onConfirmar={() => void handleCancelar()}
      />

      {puedeTimbrarHospedaje && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={handleEmitirHospedaje} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">Timbrar CFDI de hospedaje</h2>
              <Checkbox label="Huésped extranjero (RFC genérico XEXX010101000)" checked={esExtranjero} onChange={(e) => setEsExtranjero(e.target.checked)} disabled={esGlobal} />
              <Checkbox label="Factura global a público en general (RFC XAXX010101000)" checked={esGlobal} onChange={(e) => setEsGlobal(e.target.checked)} disabled={esExtranjero} />
              <Checkbox label="No-show (penalización sin estancia)" checked={esNoShow} onChange={(e) => setEsNoShow(e.target.checked)} />
              {!esExtranjero && !esGlobal && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="RFC receptor" required>
                    <Input placeholder="RFC receptor" value={rfcReceptor} onChange={(e) => setRfcReceptor(e.target.value.toUpperCase())} />
                  </FormField>
                  <FormField label="Uso de CFDI" required>
                    <Input placeholder="Uso de CFDI (p. ej. G03)" value={usoCfdi} onChange={(e) => setUsoCfdi(e.target.value.toUpperCase())} />
                  </FormField>
                </div>
              )}
              <FormField label="Método de pago" className="sm:max-w-sm">
                <NativeSelect value={metodoPago} onChange={(e) => setMetodoPago(e.target.value as "PUE" | "PPD")}>
                  <option value="PUE">PUE · pago en una sola exhibición</option>
                  <option value="PPD">PPD · pago en parcialidades o diferido</option>
                </NativeSelect>
              </FormField>
              <Button type="submit" loading={busy} loadingText="Timbrando…" className="self-start">
                Timbrar CFDI
              </Button>
              <p className="text-xs text-muted-foreground">
                El servidor calcula el desglose real (subtotal, IVA, ISH, DSA) a partir de los cargos facturables del folio y valida el comprobante antes de timbrarlo — este formulario no calcula ni adivina montos.
              </p>
            </form>
          </CardContent>
        </Card>
      )}

      {puedeTimbrarPago && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-foreground">Complementos de pago (CFDI de tipo 'pago')</h2>
          <DataTable
            etiqueta="Pagos capturados"
            columnas={columnasPagos}
            filas={pagosCapturados}
            obtenerId={(p) => p.id}
            vacio={{ mensaje: "Este folio todavía no tiene ningún pago capturado." }}
            paginacion={false}
          />
          <p className="text-xs text-muted-foreground">
            Timbrar el complemento de un pago que ya tiene uno es seguro: el servidor es idempotente por pago y devuelve el mismo comprobante ya emitido, {cfdisPago.length} emitido(s) hasta ahora en este folio.
          </p>
        </section>
      )}
    </PageContainer>
  );
}
