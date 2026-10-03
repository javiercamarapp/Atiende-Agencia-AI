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
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button, Card, CardContent, FormField, Input, PageContainer, PageHeader } from "@atiende/ui";
import { cancelarCfdi, fetchCfdisByProperty } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { newIdempotencyKey } from "../lib/admin-client.ts";
import { CfdiCancelarDialog, CfdiTabla } from "../components/CfdiComprobantes.tsx";
import type { HotelesShellContext } from "../HotelesShell.tsx";

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

      <CfdiTabla
        cfdis={cfdis}
        error={error}
        onReintentar={() => void load()}
        vacio="Este hotel todavía no tiene ningún CFDI timbrado."
        busy={busy}
        orgSlug={orgSlug}
        onCancelar={(id) => {
          setCancelError(null);
          setCancelTargetId(id);
        }}
      />

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
    </PageContainer>
  );
}
