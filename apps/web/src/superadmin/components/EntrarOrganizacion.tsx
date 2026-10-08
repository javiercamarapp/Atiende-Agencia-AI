// "Entrar" a la organización de un cliente (SA-L-20 / SA-07, ahora de verdad): abre una SESIÓN DE SOPORTE con motivo obligatorio
// (>= 10 caracteres) y lleva al panel real de esa organización, con un banner permanente de solo lectura y botón «Salir».
// Backend real: POST /superadmin/soporte/entrar (bitácora hash-encadenada ANTES de entregar el acceso; si falla, no se entra),
// luego GET /auth/me con el token de soporte y la sesión persistida bajo la llave de esa vertical (mismo puente que «Ver los otros
// paneles»). Cancelar y Escape NUNCA llaman al servidor; un motivo vacío, nulo o solo espacios no se envía.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog, notify } from "@atiende/ui";
import { fetchJson } from "../lib/fetch-json.ts";
import { MOTIVO_SOPORTE_MAXIMO, MOTIVO_SOPORTE_MINIMO, entrarComoSoporte, motivoSoporteValido } from "../../lib/soporte.ts";

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
      // Defensa en profundidad: el dialogo ya valida, pero nada sale al servidor con un motivo corto, vacio o nulo.
      if (!motivoSoporteValido(motivo)) return;
      try {
        const abierta = await entrarComoSoporte(
          {
            fetchImpl: (...a) => fetch(...a),
            apiBaseUrl,
            storage: window.localStorage,
            entrarFn: (organizationId, reason) =>
              fetchJson(apiBaseUrl, token, "/superadmin/soporte/entrar", { method: "POST", body: JSON.stringify({ organizationId, reason }) }),
          },
          objetivo.id,
          motivo,
        );
        notify.success(`Sesión de soporte abierta en ${objetivo.nombre} (solo lectura).`);
        setObjetivo(null);
        navigate(`/${abierta.vertical}/${abierta.slug}`);
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "No se pudo abrir la sesión de soporte.");
        throw err;
      }
    },
    [apiBaseUrl, token, objetivo, navigate],
  );

  const dialogo = (
    <ConfirmDialog
      open={objetivo !== null}
      onOpenChange={(open) => !open && setObjetivo(null)}
      titulo={objetivo ? `Entrar a ${objetivo.nombre}` : "Entrar"}
      descripcion="Abre una sesión de soporte de 60 minutos en el panel de este cliente, en solo lectura. Queda en la bitácora con tu motivo; para editar tendrás que pedir un permiso aparte."
      confirmar="Entrar al panel"
      campo={{
        etiqueta: "Motivo",
        multilinea: true,
        minLength: MOTIVO_SOPORTE_MINIMO,
        maxLength: MOTIVO_SOPORTE_MAXIMO,
        ayuda: `Obligatorio, mínimo ${MOTIVO_SOPORTE_MINIMO} caracteres.`,
        placeholder: "Ej. Revisar por qué el cliente no recibe sus mensajes de WhatsApp.",
      }}
      onConfirm={confirmar}
    />
  );

  return { entrar: setObjetivo, dialogo };
}
