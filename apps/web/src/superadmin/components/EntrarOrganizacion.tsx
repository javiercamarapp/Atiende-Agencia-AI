// "Entrar" a una organizacion (SA-L-20 / SA-07): abre una sesion de impersonacion de SOLO LECTURA con motivo obligatorio de 20 o mas caracteres.
// Backend real: POST /superadmin/impersonacion/sesiones (core.start_impersonation_session: 15 minutos, bitacora inmutable). Cancelar y Escape
// NUNCA llaman al servidor; un motivo corto no se envia. Tras abrir la sesion se lleva a /superadmin/impersonacion (alli se ve y se termina).
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog, notify, useT } from "@atiende/ui";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminOrganizaciones } from "@atiende/ui/i18n/superadmin/organizaciones";
import { fetchJson } from "../lib/fetch-json.ts";
import { MOTIVO_IMPERSONACION_MINIMO } from "../lib/organizaciones.ts";

export interface OrganizacionObjetivo {
  readonly id: string;
  readonly nombre: string;
}

export function useEntrarOrganizacion(apiBaseUrl: string, token: string): { readonly entrar: (org: OrganizacionObjetivo) => void; readonly dialogo: ReactNode } {
  const t = useT(superadminComun, superadminOrganizaciones);
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
        notify.error(err instanceof Error ? err.message : t("superadmin.organizaciones.entrar.error"));
        throw err;
      }
      notify.success(t("superadmin.organizaciones.entrar.abierta", { nombre: objetivo.nombre }));
      setObjetivo(null);
      navigate("/superadmin/impersonacion");
    },
    [apiBaseUrl, token, objetivo, navigate, t],
  );

  const dialogo = (
    <ConfirmDialog
      open={objetivo !== null}
      onOpenChange={(open) => !open && setObjetivo(null)}
      titulo={objetivo ? t("superadmin.comun.entrarA", { nombre: objetivo.nombre }) : t("superadmin.comun.entrar")}
      descripcion={t("superadmin.organizaciones.entrar.descripcion")}
      confirmar={t("superadmin.organizaciones.entrar.confirmar")}
      campo={{
        etiqueta: t("superadmin.comun.col.motivo"),
        multilinea: true,
        minLength: MOTIVO_IMPERSONACION_MINIMO,
        maxLength: 500,
        ayuda: t("superadmin.comun.motivoAyuda", { n: MOTIVO_IMPERSONACION_MINIMO }),
        placeholder: t("superadmin.organizaciones.entrar.placeholder"),
      }}
      onConfirm={confirmar}
    />
  );

  return { entrar: setObjetivo, dialogo };
}
