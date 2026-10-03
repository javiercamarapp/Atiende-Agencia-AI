// D-30 -- orquestacion del step-up (segundo factor reciente) para las acciones sensibles de despachos.
//
// `conStepUp` envuelve UNA accion: consulta si el usuario tiene 2FA y, segun el caso,
//   - 2FA no disponible en la base (migracion pendiente) o no se pudo consultar -> ejecuta la accion tal cual (el servidor
//     tampoco exige nada: queda el control por rol);
//   - 2FA disponible pero SIN TOTP dado de alta -> NO ejecuta la accion (no hay bypass: el servidor respondera 403
//     `step_up_enrollment_required`) y muestra el aviso con enlace al alta;
//   - 2FA activo -> pide el codigo en un dialogo; solo con un token valido ejecuta la accion con `x-step-up-token`.
// Cancelar el dialogo rechaza con `StepUpCanceladoError`: la accion NUNCA se ejecuta.
// El servidor SIEMPRE decide; esto solo conduce el flujo y evita llamadas que sabemos que se rechazarian.
import { TWO_FACTOR_UNAVAILABLE, fetchTwoFactorStatus } from "./two-factor-client.ts";
import type { TwoFactorStatus } from "./two-factor-client.ts";

export class StepUpCanceladoError extends Error {
  constructor() {
    super("Cancelaste la verificación: no se realizó la acción.");
  }
}

export class StepUpSinEnrolarError extends Error {
  constructor() {
    super("Esta acción exige verificación en dos pasos. Actívala en Seguridad de la cuenta y vuelve a intentarlo.");
  }
}

export class StepUpNoDisponibleError extends Error {
  constructor() {
    super("No se pudo pedir la verificación en dos pasos. Recarga la página e inténtalo de nuevo.");
  }
}

export interface StepUpSolicitud {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** `false` = el usuario no tiene TOTP activo: el dialogo solo informa y enlaza al alta. */
  readonly enrolado: boolean;
}

/** Resuelve con el token de step-up; rechaza con `StepUpCanceladoError` o `StepUpSinEnrolarError`. */
export type StepUpPrompter = (solicitud: StepUpSolicitud) => Promise<string>;

let prompter: StepUpPrompter | null = null;

/** El shell de despachos registra aqui su dialogo (y lo retira al desmontarse). */
export function registrarStepUpPrompter(p: StepUpPrompter | null): void {
  prompter = p;
}

export interface ContextoStepUp {
  readonly fetchImpl: typeof fetch;
  readonly apiBaseUrl: string;
  readonly token: string;
}

export async function conStepUp<T>(ctx: ContextoStepUp, accion: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const estado: TwoFactorStatus = await fetchTwoFactorStatus(ctx.fetchImpl, ctx.apiBaseUrl, ctx.token).catch(() => TWO_FACTOR_UNAVAILABLE);
  if (!estado.available) return accion({});
  if (!prompter) throw new StepUpNoDisponibleError();
  const stepUpToken = await prompter({ apiBaseUrl: ctx.apiBaseUrl, token: ctx.token, enrolado: estado.enabled });
  return accion({ "x-step-up-token": stepUpToken });
}
