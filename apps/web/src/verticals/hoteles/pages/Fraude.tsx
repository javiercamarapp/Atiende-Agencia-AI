// Fraude — cola de fraude interno (Fase 7, H16-014/REQ-REC-014): ejecutar un
// escaneo determinista real y resolver (confirmar/descartar) las alertas generadas.
// El escaneo nunca usa un LLM (ver fraude.ts) — solo los 2 patrones deterministas
// portados a @atiende/domain-hoteles.
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza los
// botones/pills/tarjetas de estilos inline por Button/Tabs/Card/Badge reales — mismo
// criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún cambio de lógica: mismos
// props, mismo estado, mismas llamadas de red, misma condición de cada rama.
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  PageContainer,
  PageHeader,
  StatusBadge,
  statusTone,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from "@atiende/ui";
import { fetchFraudAlerts, resolveFraudAlert, runFraudScan, FRAUD_ALERT_STATUS_LABELS } from "../lib/fraude-client.ts";
import type { FraudAlertStatus, FraudAlertSummary } from "../lib/fraude-client.ts";
import { FRAUDE_ESTADO_TONES } from "../lib/status-tones.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const FILTERS: ReadonlyArray<FraudAlertStatus | "todas"> = ["todas", "pendiente", "confirmado", "descartado"];

export function FraudePage({ apiBaseUrl, token, propertyId }: HotelesShellContext) {
  const [filter, setFilter] = useState<FraudAlertStatus | "todas">("pendiente");
  const [alerts, setAlerts] = useState<readonly FraudAlertSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  async function load() {
    setError(null);
    try {
      setAlerts(await fetchFraudAlerts(fetch, apiBaseUrl, token, propertyId, filter === "todas" ? undefined : filter));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las alertas de fraude.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, filter]);

  async function handleScan() {
    setScanning(true);
    setError(null);
    try {
      const result = await runFraudScan(fetch, apiBaseUrl, token, propertyId);
      notify.success(`Escaneo completo: ${result.generadas} alerta(s) nueva(s), ${result.yaExistentes} ya existían.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo ejecutar el escaneo.");
    } finally {
      setScanning(false);
    }
  }

  async function handleResolve(alert: FraudAlertSummary, decision: "confirmar" | "descartar") {
    // Cancelar (o Escape) en el dialogo resuelve `null` y corta ANTES de tocar `setBusyId` o la red:
    // ninguna alerta se resuelve si el staff cancela. Confirmar un fraude es irreversible: tono de peligro.
    const nota = await pedirTexto({
      titulo: decision === "confirmar" ? "Confirmar el fraude" : "Descartar la alerta",
      descripcion: decision === "confirmar" ? "Se registra la alerta como fraude confirmado. Esta decision no se puede deshacer." : "Se registra la alerta como descartada.",
      tono: decision === "confirmar" ? "danger" : "default",
      confirmar: decision === "confirmar" ? "Confirmar fraude" : "Descartar",
      campo: { etiqueta: `Nota de decisión (${decision})`, requerido: false, multilinea: true, maxLength: 500 },
    });
    if (nota === null) return;
    setBusyId(alert.id);
    setError(null);
    try {
      await resolveFraudAlert(fetch, apiBaseUrl, token, propertyId, alert.id, decision, nota || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resolver la alerta.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Fraude interno"
        descripcion="Alertas deterministas sobre folios y cargos del hotel."
        acciones={
          <Button type="button" onClick={() => void handleScan()} loading={scanning} loadingText="Escaneando…" iconLeft={<ShieldAlert className="size-4" strokeWidth={1.75} />}>
            Ejecutar escaneo
          </Button>
        }
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as FraudAlertStatus | "todas")}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f}>
              {f === "todas" ? "Todas" : FRAUD_ALERT_STATUS_LABELS[f]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={filter} className="flex flex-col gap-4 mt-4">
          {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
          {!alerts && !error && <EstadoCargando etiqueta="Cargando alertas…" />}
          {alerts && alerts.length === 0 && <EstadoVacio mensaje="No hay alertas en este filtro." />}

          <div className="flex flex-col gap-3">
            {alerts?.map((a) => (
              <Card key={a.id}>
                <CardContent className="p-4 flex flex-col gap-2">
                  <div className="flex justify-between gap-2 flex-wrap">
                    <div>
                      <p className="font-medium text-foreground">{a.patron}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{a.razon}</p>
                    </div>
                    <StatusBadge tone={statusTone(FRAUDE_ESTADO_TONES, a.estado)} className="self-start">
                      {FRAUD_ALERT_STATUS_LABELS[a.estado]}
                    </StatusBadge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Folio: {a.folioId} {a.cargoId ? `· Cargo: ${a.cargoId}` : ""} · Roles destinatario: {a.rolesDestinatario.join(", ")}
                  </p>
                  {a.notaDecision && <p className="text-xs text-muted-foreground">Nota: {a.notaDecision}</p>}
                  {a.estado === "pendiente" && (
                    <div className="flex gap-2 mt-1">
                      <Button type="button" variant="destructive" size="sm" onClick={() => void handleResolve(a, "confirmar")} disabled={busyId === a.id}>
                        Confirmar
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleResolve(a, "descartar")} disabled={busyId === a.id}>
                        Descartar
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      {dialogo}
    </PageContainer>
  );
}
