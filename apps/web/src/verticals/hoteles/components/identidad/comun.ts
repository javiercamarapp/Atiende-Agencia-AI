// Utilidades compartidas de las pestanas de Identidad (UNI-C gestion).
export interface TabProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const MIN_MOTIVO = 10;
export const validarMotivoMin = (v: string): string | null => (v.trim().length < MIN_MOTIVO ? `Escribe al menos ${MIN_MOTIVO} caracteres.` : null);
