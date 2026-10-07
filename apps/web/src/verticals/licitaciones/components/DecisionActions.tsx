// Aprobar / Rechazar un dato de empresa (migracion 036; REQ-044/064, WI-04). El hook concentra lo que comparten "Datos de la
// empresa" y "Aprobaciones": step-up con codigo de la app de autenticacion SOLO para tarifas (dialogo de `useConfirm`, igual que el
// cierre del expediente), guardia de doble clic (WI-06: un `ref` bloquea la segunda peticion aunque el estado de React aun no se
// haya repintado) y refresco tras decidir. Cancelar o Escape no escriben nada. El servidor SIEMPRE decide rol, autor distinto del
// aprobador y 404/409; aqui solo se oculta o deshabilita (con su motivo) lo que el servidor rechazaria igual.
import { useEffect, useRef, useState } from "react";
import { Button, useConfirm } from "@atiende/ui";
import { decideCompanyItem } from "../lib/company-data-client.ts";
import type { CompanyDataApprovalStatus, CompanyDataAuthorship, CompanyItemKind } from "../lib/company-data-client.ts";
import { canDecideKind, decisionBlockedReason, requiresStepUp } from "../lib/company-decision.ts";
import { TWO_FACTOR_UNAVAILABLE, fetchTwoFactorStatus, requestStepUpToken, secondFactorFromText } from "../lib/two-factor-client.ts";
import type { TwoFactorStatus } from "../lib/two-factor-client.ts";

const KIND_LABEL: Readonly<Record<CompanyItemKind, string>> = {
  rate: "la tarifa",
  document: "el documento",
  capability: "la capacidad",
  experience: "la experiencia",
  signer: "el firmante",
  profile: "el perfil de la empresa",
  product: "el producto o servicio",
  location: "la ubicación",
  restriction: "la restricción",
  stakeholder: "el socio o representante",
};

export interface UseCompanyDecisionInput {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Vuelve a pedir los datos tras decidir (o tras un 409: otra persona pudo decidir antes). */
  readonly onChanged: () => Promise<void>;
  readonly onError: (message: string | null) => void;
}

export function useCompanyDecision({ apiBaseUrl, token, propertyId, onChanged, onError }: UseCompanyDecisionInput) {
  const { confirmar, pedirTexto, dialogo } = useConfirm();
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus>(TWO_FACTOR_UNAVAILABLE);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void fetchTwoFactorStatus(fetch, apiBaseUrl, token).then((s) => {
      if (!cancelled) setTwoFactor(s);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token]);

  async function decide(kind: CompanyItemKind, id: string, decision: "aprobado" | "rechazado", etiqueta: string): Promise<void> {
    if (inFlight.current) return; // guardia de doble clic (WI-06)
    inFlight.current = true;
    onError(null);
    try {
      const accion = decision === "aprobado" ? "Aprobar" : "Rechazar";
      let stepUpToken: string | null = null;
      if (requiresStepUp(kind) && twoFactor.available && twoFactor.enabled) {
        // Cancelar / Escape resuelven `null`: no se escribe nada.
        const text = await pedirTexto({
          titulo: `Confirma tu identidad para ${accion.toLowerCase()} ${KIND_LABEL[kind]}: ${etiqueta}`,
          descripcion: "Aprobar o rechazar una tarifa es una decisión económica sensible: escribe el código de tu app de autenticación (o un código de respaldo).",
          confirmar: accion,
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
        setBusyKey(`${kind}-${id}`);
        stepUpToken = await requestStepUpToken(fetch, apiBaseUrl, token, "company_rate_approval", factor);
      } else {
        const ok = await confirmar({
          titulo: `${accion} ${KIND_LABEL[kind]}: ${etiqueta}`,
          descripcion:
            decision === "aprobado"
              ? "Quedará registrado con tu nombre. Cualquier edición posterior lo regresa a pendiente y cambia el expediente que ya estuviera aprobado."
              : "Quedará fuera de las propuestas hasta que se edite y otra persona lo apruebe.",
          confirmar: accion,
          tono: decision === "rechazado" ? "danger" : undefined,
        });
        if (!ok) return;
        setBusyKey(`${kind}-${id}`);
      }
      await decideCompanyItem(fetch, apiBaseUrl, token, propertyId, { kind, id, decision, stepUpToken });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "No se pudo registrar la decisión.");
      // El dato pudo cambiar (otra persona decidió, o lo editaron): refresca lo que se muestra.
      await onChanged().catch(() => undefined);
    } finally {
      setBusyKey(null);
      inFlight.current = false;
    }
  }

  return { decide, busyKey, twoFactor, dialogo };
}

export interface DecisionButtonsProps {
  readonly kind: CompanyItemKind;
  readonly id: string;
  readonly etiqueta: string;
  readonly item: CompanyDataAuthorship & { readonly approvalStatus: CompanyDataApprovalStatus };
  readonly role: string;
  readonly userId: string | null;
  readonly decision: ReturnType<typeof useCompanyDecision>;
  /** Otra accion de la pantalla en curso (deshabilita todo). */
  readonly busy: boolean;
}

/** Solo para datos pendientes y roles que pueden decidir. Para el autor: deshabilitado, con el motivo a la vista. */
export function DecisionButtons({ kind, id, etiqueta, item, role, userId, decision, busy }: DecisionButtonsProps) {
  if (item.approvalStatus !== "pendiente_aprobacion" || !canDecideKind(kind, role)) return null;
  const bloqueo = decisionBlockedReason(item, userId);
  const deshabilitado = busy || decision.busyKey !== null || bloqueo !== null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={deshabilitado} title={bloqueo ?? undefined} onClick={() => void decision.decide(kind, id, "aprobado", etiqueta)}>
          Aprobar
        </Button>
        <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={deshabilitado} title={bloqueo ?? undefined} onClick={() => void decision.decide(kind, id, "rechazado", etiqueta)}>
          Rechazar
        </Button>
      </div>
      {bloqueo && <span className="text-xs text-muted-foreground">{bloqueo}</span>}
      {kind === "rate" && decision.twoFactor.available && !decision.twoFactor.enabled && (
        <span className="text-xs text-muted-foreground">Para decidir tarifas activa tu verificación en dos pasos en Seguridad.</span>
      )}
    </div>
  );
}
