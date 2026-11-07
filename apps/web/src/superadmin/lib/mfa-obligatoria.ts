// MFA obligatoria del superadmin (ver apps/api/src/superadmin-seguridad/step-up.ts, `mfaEnrollmentGate`):
// con la MFA obligatoria el API responde 403 `mfa_enrollment_required` en toda ruta /superadmin/* salvo
// estado/enrolar/verificar. El shell consulta el estado y, mientras falte enrolar, manda a la pantalla
// de Seguridad en vez de mostrar paginas que solo recibirian 403.
import { useEffect, useState } from "react";
import { fetchJson } from "./fetch-json.ts";

export const RUTA_SEGURIDAD = "/superadmin/seguridad";

export interface EstadoMfaMinimo {
  readonly disponible?: boolean;
  readonly obligatoria?: boolean;
  readonly inscrito?: boolean;
}

/** `true` solo si el servidor dice que la MFA esta disponible, es obligatoria y este superadmin aun no la activa. */
export function debeEnrolarMfa(estado: EstadoMfaMinimo | null | undefined): boolean {
  return estado?.disponible === true && estado.obligatoria === true && estado.inscrito !== true;
}

/**
 * Consulta `GET /superadmin/mfa/estado` al montar y en cada cambio de ruta (asi, al activar el factor en
 * Seguridad y navegar, la redireccion se levanta). Si la consulta falla no bloquea nada: el API sigue
 * siendo quien corta.
 */
export function useEnrolamientoMfaPendiente(apiBaseUrl: string, token: string, pathname: string): boolean {
  const [pendiente, setPendiente] = useState(false);
  useEffect(() => {
    if (!token) return undefined;
    let vivo = true;
    fetchJson<EstadoMfaMinimo>(apiBaseUrl, token, "/superadmin/mfa/estado")
      .then((estado) => {
        if (vivo) setPendiente(debeEnrolarMfa(estado));
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, pathname]);
  return pendiente;
}
