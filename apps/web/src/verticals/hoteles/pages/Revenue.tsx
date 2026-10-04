// Revenue management (Fase 9, REQ-REV-003/004/005/007) — wiring del gate real
// shadow/propone/autopilot (`hoteles.revenue_engine_gate`, autoridad final en el
// trigger de Postgres) + historial de backtests walk-forward. GAP REAL de esta
// fase (ver README de la rama y `lib/revenue-client.ts`): no existe ningún motor
// que produzca "recomendaciones" de tarifa (pickup/compset/evento/tipo de cambio
// reales) ni una tabla que las almacene todavía -- esta pantalla nunca simula esa
// pieza. Lo que sí es real end-to-end: consultar/inicializar/transicionar el gate,
// otorgar/revocar la aprobación de "owner" que exige REQ-REV-003 antes de habilitar
// autopilot pleno, y registrar/ver el historial de backtests.
//
// Gate: REVENUE_GATE_MANAGE_ROLES (owner/gm) para transicionar el gate,
// REVENUE_AUTOPILOT_APPROVAL_ROLES (solo owner) para la aprobación de autopilot,
// REVENUE_BACKTEST_ROLES (owner/gm/accountant) para registrar un backtest -- mismo
// criterio "cosmético, nunca la única barrera" que el resto del panel (ver
// Fraude.tsx/Pl.tsx): un rol sin acceso que intente la acción ve el 403/409 real
// del servidor como mensaje de error.
//
// Visual (UNI-C gestion): PageHeader y secciones en components/revenue/* (gate, backtests, recomendaciones, reglas de
// precio, captura de datos) con FormField/FormDialog/DataTable; aprobar una recomendacion y promover a autopilot piden
// confirmacion (Cancelar/Escape nunca ejecutan). Mismas llamadas de red.
import { useEffect, useState } from "react";
import { ConfirmDialog, EstadoCargando, EstadoError, PageContainer, PageHeader, useConfirm } from "@atiende/ui";
import {
  REVENUE_TOOLS_ROLES,
  approveRateRecommendation,
  discardRateRecommendation,
  fetchRateRecommendations,
  fetchRevenueBacktests,
  fetchRevenueGate,
  initRevenueGate,
  setRevenueGateOwnerApproval,
  transitionRevenueGate,
} from "../lib/revenue-client.ts";
import type { RateRecommendation, RevenueBacktestRun, RevenueGate, RevenueGateState } from "../lib/revenue-client.ts";
import { fetchRoomTypes } from "../lib/reservas-client.ts";
import type { RoomTypeOption } from "../lib/reservas-client.ts";
import { BacktestsSection } from "../components/revenue/BacktestsSection.tsx";
import { CapturaDatosSection } from "../components/revenue/CapturaDatosSection.tsx";
import { GateCard } from "../components/revenue/GateCard.tsx";
import { RecomendacionesSection } from "../components/revenue/RecomendacionesSection.tsx";
import { ReglasPrecioSection } from "../components/revenue/ReglasPrecioSection.tsx";
import { RevenueHerramientas } from "./RevenueHerramientas.tsx";
import type { HotelesShellContext } from "../HotelesShell.tsx";

export function RevenuePage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [gate, setGate] = useState<RevenueGate | null | undefined>(undefined);
  const [backtests, setBacktests] = useState<readonly RevenueBacktestRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAutopilot, setPendingAutopilot] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  // ---- Fase 10 — motor de recomendaciones de tarifa v1. ----
  const [roomTypes, setRoomTypes] = useState<readonly RoomTypeOption[] | null>(null);
  const [recommendations, setRecommendations] = useState<readonly RateRecommendation[] | null>(null);

  function roomTypeName(roomTypeId: string): string {
    return roomTypes?.find((rt) => rt.id === roomTypeId)?.nombre ?? roomTypeId;
  }

  async function loadRecommendations() {
    const { recomendaciones } = await fetchRateRecommendations(fetch, apiBaseUrl, token, propertyId, { limit: 50 });
    setRecommendations(recomendaciones);
  }

  async function load() {
    setError(null);
    try {
      const [g, b, rts] = await Promise.all([
        fetchRevenueGate(fetch, apiBaseUrl, token, propertyId),
        fetchRevenueBacktests(fetch, apiBaseUrl, token, propertyId),
        fetchRoomTypes(fetch, apiBaseUrl, token, propertyId),
      ]);
      setGate(g);
      setBacktests(b);
      setRoomTypes(rts);
      await loadRecommendations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado del motor de revenue.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInit() {
    await withBusy(async () => {
      setGate(await initRevenueGate(fetch, apiBaseUrl, token, propertyId));
    });
  }

  async function handleTransition(to: RevenueGateState) {
    if (to === "autopilot") {
      const ok = await confirmar({
        titulo: "Promover a autopilot",
        descripcion: "El sistema empezará a aplicar las tarifas recomendadas por sí solo, dentro de los límites del gate. Se puede bajar de nuevo con el freno de emergencia.",
        confirmar: "Promover a autopilot",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    await withBusy(async () => {
      setGate(await transitionRevenueGate(fetch, apiBaseUrl, token, propertyId, to));
    });
  }

  async function handleConfirmAutopilotApproval() {
    setPendingAutopilot(false);
    await withBusy(async () => {
      setGate(await setRevenueGateOwnerApproval(fetch, apiBaseUrl, token, propertyId, true));
    });
  }

  async function handleRevokeApproval() {
    await withBusy(async () => {
      setGate(await setRevenueGateOwnerApproval(fetch, apiBaseUrl, token, propertyId, false));
    });
  }

  async function handleApprove(id: string) {
    const rec = recommendations?.find((r) => r.id === id);
    const ok = await confirmar({
      titulo: "Aprobar la recomendación de tarifa",
      descripcion: rec
        ? `${rec.fecha} · ${roomTypeName(rec.roomTypeId)}: de ${rec.currentBarPrice} a ${rec.recommendedPrice}. El sistema la aplicará en su siguiente corrida.`
        : "El sistema la aplicará en su siguiente corrida.",
      confirmar: "Aprobar",
      cancelar: "Volver",
    });
    if (!ok) return;
    await withBusy(async () => {
      await approveRateRecommendation(fetch, apiBaseUrl, token, propertyId, id);
      await loadRecommendations();
    });
  }

  async function handleDiscard(id: string) {
    await withBusy(async () => {
      await discardRateRecommendation(fetch, apiBaseUrl, token, propertyId, id);
      await loadRecommendations();
    });
  }

  if (gate === undefined && !error) {
    return <EstadoCargando etiqueta="Cargando el motor de revenue…" />;
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="Revenue management" descripcion="Gate del motor, backtests, recomendaciones de tarifa y reglas de precio de la property." />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}

      <GateCard gate={gate} busy={busy} onInit={() => void handleInit()} onTransition={(to) => void handleTransition(to)} onAprobarAutopilot={() => setPendingAutopilot(true)} onRevocarAprobacion={() => void handleRevokeApproval()} />

      <BacktestsSection
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        backtests={backtests}
        onRegistrado={async () => setBacktests(await fetchRevenueBacktests(fetch, apiBaseUrl, token, propertyId))}
      />

      <RecomendacionesSection recommendations={recommendations} hayError={error !== null} busy={busy} roomTypeName={roomTypeName} onApprove={(id) => void handleApprove(id)} onDiscard={(id) => void handleDiscard(id)} />

      <ReglasPrecioSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} roomTypes={roomTypes} busy={busy} withBusy={withBusy} />

      <CapturaDatosSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />

      {REVENUE_TOOLS_ROLES.has(role) && <RevenueHerramientas apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />}

      <ConfirmDialog
        open={pendingAutopilot}
        onOpenChange={(open) => {
          if (!open) setPendingAutopilot(false);
        }}
        titulo="Aprobar autopilot pleno"
        descripcion="REQ-REV-003 (P0/GOB) exige una aprobación explícita del rol owner antes de habilitar autopilot pleno para esta property. Esta aprobación queda registrada y es requisito, junto con un backtest vigente que pase, para promover el gate a autopilot."
        confirmar="Aprobar"
        onConfirm={handleConfirmAutopilotApproval}
      />
      {dialogo}
    </PageContainer>
  );
}
