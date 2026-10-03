// CFDI de hospedaje — listado a nivel property (Fase 5, H5/REQ-BO-001/002),
// landing de la entrada "CFDI" del nav lateral (`GET /hoteles/:propertyId/cfdi`, la
// 1ra de las 4 rutas reales de apps/api/.../hoteles/cfdi.ts). Timbrar un CFDI de
// hospedaje o su complemento de pago es una acción POR FOLIO (exige el desglose de
// cargos/pagos de ESE folio) — este listado solo lee y cancela; el botón "Ir al
// folio" navega a pages/Cfdi.tsx (CfdiPage), que sí cubre timbrar/pagar, igual que ya
// se llega ahí desde el enlace nuevo de Folio.tsx.
//
// Visual (UNI-C gestion): PageHeader, DataTable, FormField y FormDialog para cancelar (Cerrar/Escape nunca
// cancelan el CFDI). Ningún cambio de lógica: mismos props, mismo estado, mismas llamadas de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  DataTable,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { cancelarCfdi, fetchCfdisByProperty, MOTIVO_CANCELACION_LABELS } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { CFDI_ESTADO_TONES } from "../lib/status-tones.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const ESTADO_LABELS: Record<CfdiEmisionSummary["estado"], string> = {
  pendiente: "Pendiente",
  timbrado: "Timbrado",
  en_proceso_cancelacion: "Cancelación en proceso",
  cancelado: "Cancelado",
  rechazado: "Rechazado",
};

const MOTIVOS: readonly MotivoCancelacionSat[] = ["01", "02", "03", "04"];
export function CfdiListadoPage({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const navigate = useNavigate();
  const [cfdis, setCfdis] = useState<readonly CfdiEmisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
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

  function handleFolioJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const folioId = folioJump.trim();
    if (!folioId) return;
    navigate(`/hoteles/${orgSlug}/folios/${folioId}/cfdi`);
  }

  const columnas: readonly DataTableColumna<CfdiEmisionSummary>[] = [
    {
      id: "comprobante",
      encabezado: "Comprobante",
      etiqueta: "Comprobante",
      principal: true,
      celda: (c) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {c.tipo === "hospedaje" ? "Hospedaje" : "Complemento de pago"} · {c.uuidFiscal ?? "sin UUID"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            RFC {c.rfcReceptor} · Uso {c.usoCfdi} · {c.metodoPago} {c.pac ? `· PAC: ${c.pac}` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "folio",
      encabezado: "Folio",
      celda: (c) => (
        <Link to={`/hoteles/${orgSlug}/folios/${c.folioId}/cfdi`} className="text-primary hover:underline underline-offset-2">
          {c.folioId}
        </Link>
      ),
    },
    { id: "subtotal", encabezado: "Subtotal", alinear: "right", celda: (c) => <span className="tabular-nums">{dineroMx(c.subtotal)}</span> },
    { id: "iva", encabezado: "IVA", alinear: "right", celda: (c) => <span className="tabular-nums">{dineroMx(c.iva)}</span> },
    {
      id: "locales",
      encabezado: "ISH / DSA",
      alinear: "right",
      celda: (c) => {
        const partes = [c.impuestosLocales.ishMonto > 0 ? `ISH ${dineroMx(c.impuestosLocales.ishMonto)}` : "", c.impuestosLocales.dsaMonto > 0 ? `DSA ${dineroMx(c.impuestosLocales.dsaMonto)}` : ""].filter(Boolean);
        return <span className="tabular-nums">{partes.length > 0 ? partes.join(" · ") : "—"}</span>;
      },
    },
    { id: "total", encabezado: "Total", alinear: "right", celda: (c) => <strong className="tabular-nums">{dineroMx(c.total)}</strong> },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (c) => <StatusBadge tone={statusTone(CFDI_ESTADO_TONES, c.estado)}>{ESTADO_LABELS[c.estado]}</StatusBadge>,
    },
    { id: "emitido", encabezado: "Emitido", celda: (c) => <span className="text-xs text-muted-foreground">{fechaHoraEsMx(c.creadoEn)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (c) =>
        c.estado === "timbrado" ? (
          <Button type="button" variant="outline" size="sm" className="text-destructive border-destructive/40 hover:border-destructive" onClick={() => {
              setCancelError(null);
              setCancelTargetId(c.id);
            }} disabled={busy}>
            Cancelar CFDI
          </Button>
        ) : null,
    },
  ];

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="CFDI de hospedaje" descripcion="Todos los comprobantes fiscales timbrados en este hotel, de cualquier folio." />

      <Card>
        <CardContent className="p-3">
          <form onSubmit={handleFolioJump} className="flex gap-2 flex-wrap items-end">
            <FormField label="Timbrar/gestionar el CFDI de un folio" className="flex-1 min-w-[200px]">
              <Input placeholder="ID del folio" value={folioJump} onChange={(e) => setFolioJump(e.target.value)} />
            </FormField>
            <Button type="submit" iconRight={<ArrowRight className="size-4" strokeWidth={1.75} />}>
              Ir al folio
            </Button>
          </form>
        </CardContent>
      </Card>

      <DataTable
        etiqueta="CFDI"
        columnas={columnas}
        filas={cfdis ?? []}
        obtenerId={(c) => c.id}
        estado={error ? "error" : !cfdis ? "loading" : cfdis.length === 0 ? "empty" : "ok"}
        error={{ titulo: "Ocurrió un problema", mensaje: error ?? undefined, onReintentar: () => void load() }}
        vacio={{ mensaje: "Este hotel todavía no tiene ningún CFDI timbrado." }}
      />

      <FormDialog
        open={cancelTargetId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setCancelTargetId(null);
        }}
        titulo="Cancelar CFDI"
        subtitulo="La cancelación se envía al PAC y al SAT; no se puede deshacer."
        anchoClase="max-w-2xl"
        bloquearCierre={busy}
        onGuardar={() => void handleCancelar()}
        guardando={busy}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setCancelTargetId(null)} disabled={busy}>
              Cerrar
            </Button>
            <Button type="submit" variant="destructive" loading={busy} loadingText="Cancelando…">
              Confirmar cancelación
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {cancelError && <Callout tone="danger">{cancelError}</Callout>}
          <FormField label="Motivo de cancelación (SAT)">
            <NativeSelect value={cancelMotivo} onChange={(e) => setCancelMotivo(e.target.value as MotivoCancelacionSat)}>
              {MOTIVOS.map((m) => (
                <option key={m} value={m}>
                  {MOTIVO_CANCELACION_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {cancelMotivo === "01" && (
            <FormField label="Folio fiscal del CFDI que lo sustituye (UUID)">
              <Input placeholder="Folio fiscal del CFDI que lo sustituye (UUID)" value={cancelFolioSustitucion} onChange={(e) => setCancelFolioSustitucion(e.target.value)} />
            </FormField>
          )}
        </div>
      </FormDialog>
    </PageContainer>
  );
}
