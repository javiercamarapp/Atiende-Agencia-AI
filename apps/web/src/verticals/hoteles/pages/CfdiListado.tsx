// CFDI de hospedaje — listado a nivel property (Fase 5, H5/REQ-BO-001/002),
// landing de la entrada "CFDI" del nav lateral (`GET /hoteles/:propertyId/cfdi`, la
// 1ra de las 4 rutas reales de apps/api/.../hoteles/cfdi.ts). Timbrar un CFDI de
// hospedaje o su complemento de pago es una acción POR FOLIO (exige el desglose de
// cargos/pagos de ESE folio) — este listado solo lee y cancela; el botón "Ir al
// folio" navega a pages/Cfdi.tsx (CfdiPage), que sí cubre timbrar/pagar, igual que ya
// se llega ahí desde el enlace nuevo de Folio.tsx.
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// tarjetas/pills/inputs de estilos inline por Card/Badge/Input/Button reales —
// mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún cambio de
// lógica: mismos props, mismo estado, mismas llamadas de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input } from "@atiende/ui";
import { cancelarCfdi, fetchCfdisByProperty, MOTIVO_CANCELACION_LABELS } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ESTADO_LABELS: Record<CfdiEmisionSummary["estado"], string> = {
  pendiente: "Pendiente",
  timbrado: "Timbrado",
  en_proceso_cancelacion: "Cancelación en proceso",
  cancelado: "Cancelado",
  rechazado: "Rechazado",
};

const ESTADO_VARIANT: Record<CfdiEmisionSummary["estado"], "default" | "secondary" | "destructive"> = {
  pendiente: "secondary",
  timbrado: "default",
  en_proceso_cancelacion: "secondary",
  cancelado: "destructive",
  rechazado: "destructive",
};

const MOTIVOS: readonly MotivoCancelacionSat[] = ["01", "02", "03", "04"];
const selectClass =
  "flex h-11 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function CfdiListadoPage({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const navigate = useNavigate();
  const [cfdis, setCfdis] = useState<readonly CfdiEmisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folioJump, setFolioJump] = useState("");

  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState<MotivoCancelacionSat>("02");
  const [cancelFolioSustitucion, setCancelFolioSustitucion] = useState("");

  async function load() {
    setError(null);
    try {
      setCfdis(await fetchCfdisByProperty(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los CFDI de este hotel.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCancelar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancelTargetId) return;
    setBusy(true);
    setError(null);
    try {
      await cancelarCfdi(fetch, apiBaseUrl, token, propertyId, cancelTargetId, cancelMotivo, cancelMotivo === "01" ? cancelFolioSustitucion.trim() || undefined : undefined, newIdempotencyKey());
      setCancelTargetId(null);
      setCancelFolioSustitucion("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar el CFDI.");
    } finally {
      setBusy(false);
    }
  }

  function handleFolioJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const folioId = folioJump.trim();
    if (!folioId) return;
    navigate(`/hoteles/${orgSlug}/folios/${folioId}/cfdi`);
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <header>
        <h1 className="text-xl font-display font-semibold text-foreground">CFDI de hospedaje</h1>
        <p className="mt-1 text-sm text-muted-foreground">Todos los comprobantes fiscales timbrados en este hotel, de cualquier folio.</p>
      </header>

      <Card>
        <CardContent className="p-4">
          <form onSubmit={handleFolioJump} className="flex gap-2 flex-wrap items-center">
            <span className="text-sm text-foreground">Timbrar/gestionar el CFDI de un folio:</span>
            <Input placeholder="ID del folio" value={folioJump} onChange={(e) => setFolioJump(e.target.value)} className="flex-1 min-w-[200px]" />
            <Button type="submit">
              Ir al folio
              <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!cfdis && !error && <EstadoCargando etiqueta="Cargando CFDI…" />}
      {cfdis && cfdis.length === 0 && <EstadoVacio mensaje="Este hotel todavía no tiene ningún CFDI timbrado." />}

      <div className="flex flex-col gap-3">
        {cfdis?.map((c) => (
          <Card key={c.id}>
            <CardContent className="p-4">
              <div className="flex justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-medium text-sm text-foreground">
                    {c.tipo === "hospedaje" ? "Hospedaje" : "Complemento de pago"} · {c.uuidFiscal ?? "sin UUID"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    RFC {c.rfcReceptor} · Uso {c.usoCfdi} · {c.metodoPago} {c.pac ? `· PAC: ${c.pac}` : ""}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Folio: <Link to={`/hoteles/${orgSlug}/folios/${c.folioId}/cfdi`} className="text-primary hover:underline underline-offset-2">{c.folioId}</Link>
                  </p>
                </div>
                <Badge variant={ESTADO_VARIANT[c.estado]} className="self-start">
                  {ESTADO_LABELS[c.estado]}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-foreground">
                Subtotal {formatMoney(c.subtotal)} · IVA {formatMoney(c.iva)}
                {c.impuestosLocales.ishMonto > 0 ? ` · ISH ${formatMoney(c.impuestosLocales.ishMonto)}` : ""}
                {c.impuestosLocales.dsaMonto > 0 ? ` · DSA ${formatMoney(c.impuestosLocales.dsaMonto)}` : ""} · Total <strong>{formatMoney(c.total)}</strong>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">Emitido: {new Date(c.creadoEn).toLocaleString("es-MX")}</p>
              {c.estado === "timbrado" && cancelTargetId !== c.id && (
                <Button type="button" variant="outline" size="sm" className="mt-2.5 text-destructive border-destructive/40 hover:border-destructive" onClick={() => setCancelTargetId(c.id)} disabled={busy}>
                  Cancelar CFDI
                </Button>
              )}
              {cancelTargetId === c.id && (
                <form onSubmit={handleCancelar} className="mt-2.5 flex flex-col gap-2 border border-destructive/30 rounded-lg p-3">
                  <select value={cancelMotivo} onChange={(e) => setCancelMotivo(e.target.value as MotivoCancelacionSat)} className={selectClass}>
                    {MOTIVOS.map((m) => (
                      <option key={m} value={m}>
                        {MOTIVO_CANCELACION_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  {cancelMotivo === "01" && (
                    <Input placeholder="Folio fiscal del CFDI que lo sustituye (UUID)" value={cancelFolioSustitucion} onChange={(e) => setCancelFolioSustitucion(e.target.value)} />
                  )}
                  <div className="flex gap-2">
                    <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                      Confirmar cancelación
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setCancelTargetId(null)} disabled={busy}>
                      Cerrar
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
