// Sondeo ligero de los agregados por validar para el banner persistente del panel (cualquier pantalla): consulta cada 15 s, se pausa con la pestana oculta y reintenta con
// backoff (use-sondeo-pedidos). Solo cuenta lo pendiente; el detalle lo pinta la pantalla de Agregados. Sin permiso o con la base sin migrar devuelve 0 sin ruido.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgregados } from "./agregados-client.ts";
import { useSondeoPedidos } from "./use-sondeo-pedidos.ts";

export const SONDEO_AGREGADOS_MS = 15_000;

export interface PendientesAgregados {
  readonly pendientes: number;
  /** `true` si la ultima consulta fallo (se conserva el ultimo conteo bueno). */
  readonly error: boolean;
  readonly refrescar: () => void;
}

export function useAgregadosPendientes(opciones: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly orgSlug: string; readonly activo: boolean }): PendientesAgregados {
  const { apiBaseUrl, token, propertyId, orgSlug, activo } = opciones;
  const [pendientes, setPendientes] = useState(0);
  const [error, setError] = useState(false);
  const fetchImpl = useMemo<typeof fetch>(() => (input, init) => globalThis.fetch(input, init), []);
  const vivo = useRef(true);
  const consulta = useCallback(async () => {
    try {
      const r = await fetchAgregados(fetchImpl, apiBaseUrl, token, propertyId, "pendientes");
      if (!vivo.current) return;
      setPendientes(r.disponible ? r.pendientes : 0);
      setError(false);
    } catch (e) {
      if (vivo.current) setError(true);
      throw e;
    }
  }, [apiBaseUrl, fetchImpl, propertyId, token]);
  useEffect(() => {
    vivo.current = true;
    // Primera consulta inmediata (el sondeo solo programa la siguiente).
    if (activo) void consulta().catch(() => undefined);
    return () => {
      vivo.current = false;
    };
  }, [activo, consulta]);
  const sondeo = useSondeoPedidos({ clave: `agregados:${orgSlug}:${propertyId}`, activo, consulta, baseMs: SONDEO_AGREGADOS_MS });
  return { pendientes, error, refrescar: sondeo.refrescar };
}
