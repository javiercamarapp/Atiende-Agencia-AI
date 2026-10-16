// L-26 (REQ-044) -- aprobacion DOBLE del expediente en la pantalla de cierre:
//   1/2 tecnico-legal y 2/2 economica, por DOS personas distintas, cada una con step-up TOTP.
//
// Todo lo que decide esta pantalla lo decide el servidor (reglas de dominio + trigger de la base): aqui solo se
// refleja `GET .../expediente/approvals` y se llama `POST .../expediente/approval` con la etapa. Los controles que
// el servidor rechazaria igual (rol sin decision, 2/2 sin la 1/2, misma persona en las dos etapas) se deshabilitan
// con el motivo a la vista, pero el servidor SIEMPRE decide.
//
// Base sin migrar (modo "legacy"): sigue valiendo la aprobacion unica de siempre, con un aviso honesto.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoError, StatusBadge, useConfirm } from "@atiende/ui";
import { approveExpediente, approveExpedienteStage, EXPEDIENTE_STAGE_LABELS } from "../lib/cierre-client.ts";
import type { ExpedienteApprovalsState, ExpedienteStage, ExpedienteStageView } from "../lib/cierre-client.ts";
import { formatDateTime } from "../lib/format.ts";
import { TWO_FACTOR_UNAVAILABLE, fetchTwoFactorStatus, requestStepUpToken, secondFactorFromText } from "../lib/two-factor-client.ts";
import type { TwoFactorStatus } from "../lib/two-factor-client.ts";

const ROLE_LABELS: Readonly<Record<string, string>> = { owner: "Propietario", admin: "Administrador", analyst: "Analista" };

const STAGE_HELP: Readonly<Record<ExpedienteStage, string>> = {
  tecnica_legal: "Revisa el contenido técnico y legal del expediente y su documentación.",
  economica: "Revisa la propuesta económica. La da una persona distinta de quien dio la técnico-legal.",
};

export interface AprobacionExpedienteProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly orgSlug: string;
  /** Rol de vertical de la persona (cosmetico: el servidor decide). */
  readonly canApprove: boolean;
  /** AE-11: la persona editó contenido de alguna sección: no puede aprobar el expediente (cosmético; el servidor decide). */
  readonly authoredByViewer?: boolean;
  readonly role: string;
  /** `null` mientras no hay respuesta (o si fallo: ver `stateError`). */
  readonly state: ExpedienteApprovalsState | null;
  readonly stateError: string | null;
  /** Vuelve a pedir el estado (y lo que dependa de el, p. ej. el paquete) tras una aprobacion. */
  readonly onChanged: () => Promise<void>;
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function AprobacionExpediente({ apiBaseUrl, token, propertyId, tenderId, orgSlug, canApprove, authoredByViewer = false, role, state, stateError, onChanged }: AprobacionExpedienteProps) {
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus>(TWO_FACTOR_UNAVAILABLE);
  const [busyStage, setBusyStage] = useState<ExpedienteStage | "single" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchTwoFactorStatus(fetch, apiBaseUrl, token).then((s) => {
      if (!cancelled) setTwoFactor(s);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token]);

  const needsEnrollment = twoFactor.available && !twoFactor.enabled;

  async function approveStage(stage: ExpedienteStage) {
    setError(null);
    setOkMessage(null);
    const label = EXPEDIENTE_STAGE_LABELS[stage];
    let stepUpToken: string | null = null;
    if (twoFactor.available && twoFactor.enabled) {
      // Cancelar / Escape resuelven `null`: no se escribe nada.
      const text = await pedirTexto({
        titulo: `Confirma tu identidad para aprobar: ${label}`,
        descripcion: "La aprobación del expediente es una decisión sensible: escribe el código de tu app de autenticación (o un código de respaldo).",
        confirmar: "Aprobar",
        campo: {
          etiqueta: "Código de verificación en dos pasos",
          placeholder: "6 dígitos, o un código de respaldo",
          requerido: true,
          validar: (v) => (secondFactorFromText(v) ? null : "Escribe el código de 6 dígitos o un código de respaldo."),
        },
      });
      if (text === null) return;
      const factor = secondFactorFromText(text);
      if (!factor) return;
      setBusyStage(stage);
      try {
        stepUpToken = await requestStepUpToken(fetch, apiBaseUrl, token, "expediente_approval", factor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo confirmar tu identidad.");
        setBusyStage(null);
        return;
      }
    } else {
      const ok = await confirmar({
        titulo: `Aprobar: ${label}`,
        descripcion: "La aprobación queda registrada con tu nombre y se invalida si cambia cualquier insumo del expediente.",
        confirmar: "Aprobar",
      });
      if (!ok) return;
      setBusyStage(stage);
    }
    try {
      await approveExpedienteStage(fetch, apiBaseUrl, token, propertyId, tenderId, { stage, stepUpToken });
      setOkMessage(`${label}: aprobada.`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar la aprobación.");
      // El estado pudo haber cambiado (otra persona aprobó, cambiaron los insumos): refresca lo que se muestra.
      await onChanged().catch(() => undefined);
    } finally {
      setBusyStage(null);
    }
  }

  async function approveSingle() {
    setError(null);
    setOkMessage(null);
    const ok = await confirmar({
      titulo: "Aprobar el expediente",
      descripcion: "Aprobación única: la doble aprobación aún no está disponible en esta base. Se invalida si cambia cualquier insumo.",
      confirmar: "Aprobar expediente",
    });
    if (!ok) return;
    setBusyStage("single");
    try {
      await approveExpediente(fetch, apiBaseUrl, token, propertyId, tenderId);
      setOkMessage("Expediente aprobado.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo aprobar el expediente.");
    } finally {
      setBusyStage(null);
    }
  }

  function stagePanel(view: ExpedienteStageView, all: readonly ExpedienteStageView[]) {
    const label = EXPEDIENTE_STAGE_LABELS[view.stage];
    const other = all.find((v) => v.stage !== view.stage);
    const approved = view.approval !== null;
    const needsTecnicaFirst = view.stage === "economica" && all.find((v) => v.stage === "tecnica_legal")?.approval === null;
    const otherByYou = other?.approval?.byYou === true;
    let blockedReason: string | null = null;
    if (!canApprove) blockedReason = `Tu rol (${role}) no puede aprobar: solo propietario, administrador o analista.`;
    else if (authoredByViewer) blockedReason = "Editaste contenido de este expediente: debe aprobarlo otra persona (el autor no aprueba su propio contenido).";
    else if (needsTecnicaFirst) blockedReason = "Falta la aprobación técnico-legal (1/2).";
    else if (otherByYou) blockedReason = "Ya diste la otra aprobación de este expediente: debe darla otra persona.";
    else if (needsEnrollment) blockedReason = "Para aprobar necesitas activar la verificación en dos pasos.";

    return (
      <div key={view.stage} className="flex flex-col gap-2 rounded-xl border border-border p-3" data-testid={`etapa-${view.stage}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">{STAGE_HELP[view.stage]}</p>
          </div>
          <StatusBadge tone={approved ? "success" : "warning"} className="whitespace-nowrap">
            {approved ? "Aprobada" : "Pendiente"}
          </StatusBadge>
        </div>
        {view.approval && (
          <p className="text-xs text-muted-foreground">
            Aprobó {roleLabel(view.approval.approvedByRole)}
            {view.approval.byYou ? " (tú)" : ""} · {formatDateTime(view.approval.approvedAt)}
          </p>
        )}
        {!approved && (
          <div className="flex flex-col gap-1.5">
            <Button type="button" size="sm" className="self-start" disabled={busyStage !== null || blockedReason !== null} onClick={() => void approveStage(view.stage)}>
              <CheckCircle2 />
              {busyStage === view.stage ? "Aprobando…" : `Aprobar ${label.toLowerCase()}`}
            </Button>
            {blockedReason && (
              <p className="text-xs text-muted-foreground">
                {blockedReason}
                {needsEnrollment && canApprove && !needsTecnicaFirst && !otherByYou && (
                  <>
                    {" "}
                    <Link to={`/licitaciones/${orgSlug}/seguridad`} className="font-semibold text-foreground underline underline-offset-2">
                      Actívala en Seguridad
                    </Link>
                    .
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Aprobación del expediente
          {state && state.mode === "doble" && (
            <StatusBadge tone={state.complete ? "success" : "warning"} className="whitespace-nowrap">
              {state.complete ? "2/2 completa" : `${2 - state.missing.length}/2`}
            </StatusBadge>
          )}
        </CardTitle>
        <CardDescription>
          Único gate real hacia «listo»: técnico-legal (1/2) y económica (2/2), dadas por dos personas distintas, cada una con verificación en dos pasos. El hash de insumos aprobado se recalcula en vivo y cualquier cambio de insumos invalida ambas. Quien haya redactado contenido de cualquier sección no puede aprobar.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {stateError && <EstadoError mensaje={stateError} onReintentar={() => void onChanged()} />}

        {!stateError && state === null && <p className="text-sm text-muted-foreground">Cargando el estado de las aprobaciones…</p>}

        {state?.mode === "sin_propuesta" && <p className="text-sm text-muted-foreground">Todavía no hay expediente: genera primero la propuesta técnica y económica.</p>}

        {state?.mode === "doble" && (
          <>
            {state.complete ? (
              <p className="text-xs font-medium text-success">Las dos aprobaciones están vigentes para los insumos actuales: ya puedes ensamblar el paquete.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Faltan: {state.missing.map((m) => EXPEDIENTE_STAGE_LABELS[m]).join(" y ")}.</p>
            )}
            <div className="flex flex-col gap-2">{state.stages.map((v) => stagePanel(v, state.stages))}</div>
          </>
        )}

        {state?.mode === "legacy" && (
          <>
            <p className="rounded-xl border border-warning/30 bg-warning-tint p-3 text-xs font-medium text-foreground">
              La doble aprobación aún no está disponible: requiere la migración 033 en la base de datos. Mientras tanto rige la aprobación única de siempre.
            </p>
            {state.singleApproval ? (
              <p className="text-xs font-medium text-success">
                Aprobado por {roleLabel(state.singleApproval.approvedByRole)}
                {state.singleApproval.byYou ? " (tú)" : ""} · {formatDateTime(state.singleApproval.approvedAt)}.
              </p>
            ) : canApprove && !authoredByViewer ? (
              <Button type="button" size="sm" className="self-start" disabled={busyStage !== null} onClick={() => void approveSingle()}>
                <CheckCircle2 />
                {busyStage === "single" ? "Aprobando…" : "Aprobar expediente completo"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {authoredByViewer && canApprove ? "Editaste contenido de este expediente: debe aprobarlo otra persona." : `Tu rol (${role}) no puede aprobar el expediente -- solo propietario, administrador o analista.`}
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {okMessage && (
          <p role="status" className="text-xs font-medium text-success">
            {okMessage}
          </p>
        )}
      </CardContent>
      {dialogo}
    </Card>
  );
}
