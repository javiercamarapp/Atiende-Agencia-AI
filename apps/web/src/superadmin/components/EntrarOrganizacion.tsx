// "Entrar" a una organizacion (SA-L-20 / SA-07): abre una sesion de impersonacion de SOLO LECTURA con motivo obligatorio de 20 o mas caracteres.
// Backend real: POST /superadmin/impersonacion/sesiones (core.start_impersonation_session: 15 minutos, bitacora inmutable). Cancelar y Escape
// NUNCA llaman al servidor; un motivo corto no se envia. Tras abrir la sesion se lleva a /superadmin/impersonacion (alli se ve y se termina).
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog, notify } from "@atiende/ui";
import { fetchJson } from "../lib/fetch-json.ts";
import { MOTIVO_IMPERSONACION_MINIMO } from "../lib/organizaciones.ts";

export interface OrganizacionObjetivo {
  readonly id: string;
  readonly nombre: string;
}

export function useEntrarOrganizacion(apiBaseUrl: string, token: string): { readonly entrar: (org: OrganizacionObjetivo) => void; readonly dialogo: ReactNode } {
  const navigate = useNavigate();
  const [objetivo, setObjetivo] = useState<OrganizacionObjetivo | null>(null);

  const confirmar = useCallback(
    async (motivo?: string) => {
      if (!objetivo) return;
      const texto = (motivo ?? "").trim();
      // Defensa en profundidad: el dialogo ya valida, pero nada sale al servidor con un motivo corto.
      if (texto.length < MOTIVO_IMPERSONACION_MINIMO) return;
      try {
        await fetchJson(apiBaseUrl, token, "/superadmin/impersonacion/sesiones", { method: "POST", body: JSON.stringify({ organizationId: objetivo.id, reason: texto }) });
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "No se pudo abrir la sesión de impersonación.");
        throw err;
      }
      notify.success(`Sesión de solo lectura abierta en ${objetivo.nombre} (15 minutos).`);
      setObjetivo(null);
      navigate("/superadmin/impersonacion");
    },
    [apiBaseUrl, token, objetivo, navigate],
  );

  const dialogo = (
    <ConfirmDialog
      open={objetivo !== null}
      onOpenChange={(open) => !open && setObjetivo(null)}
      titulo={objetivo ? `Entrar a ${objetivo.nombre}` : "Entrar"}
      descripcion="Abre una sesión de solo lectura de 15 minutos en esta organización. Queda en la bitácora de impersonación con tu motivo."
      confirmar="Abrir sesión"
      campo={{
        etiqueta: "Motivo",
        multilinea: true,
        minLength: MOTIVO_IMPERSONACION_MINIMO,
        maxLength: 500,
        ayuda: `Obligatorio, mínimo ${MOTIVO_IMPERSONACION_MINIMO} caracteres.`,
        placeholder: "Ej. Revisar por qué el cliente no recibe sus mensajes de WhatsApp.",
      }}
      onConfirm={confirmar}
    />
  );

  return { entrar: setObjetivo, dialogo };
}
