// Banner PERMANENTE e inconfundible mientras hay una sesión de impersonación
// activa -- requisito no negociable del Bloque C ("la UI muestra un banner
// permanente e inconfundible con botón para terminar"). Fuente de verdad
// SIEMPRE `GET /superadmin/impersonacion/activa` (la sesión SQL real, nunca
// una cookie con TTL de aplicación) -- ver
// apps/api/src/routes/superadmin-impersonacion.ts.
//
// Montado en SuperAdminShell.tsx, dentro de `<main>`, ANTES de `children` --
// visible en TODAS las pantallas del back office mientras la sesión siga
// activa, no solo en /superadmin/impersonacion.
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@atiende/ui";
import { fetchImpersonacionJson, type ImpersonacionSesion } from "../pages/Impersonacion.tsx";

const POLL_MS = 30_000;

function duracionRestante(remainingMs: number): string {
  const totalMin = Math.max(0, Math.ceil(remainingMs / 60_000));
  return `${totalMin} min`;
}

export function ImpersonacionBanner({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [sesion, setSesion] = useState<ImpersonacionSesion | null>(null);
  const [terminando, setTerminando] = useState(false);

  useEffect(() => {
    // `available: false` (base sin migrar, ver 0020_superadmin_impersonacion.sql)
    // es un estado ESTABLE mientras dure la sesión de la pestaña -- no depende
    // de nada que pueda cambiar sin un redeploy (aplicar la migración sí lo
    // cambiaría, pero eso implica de todas formas recargar la app). Seguir
    // sondeando cada 30s en ese estado no gana nada (el panel ya mostró "no
    // disponible" desde el primer poll) y sí genera, en la base real, un
    // 42883 nuevo en el log de Postgres por cada intento -- ver hallazgo no
    // bloqueante de esta revisión. `cancelado` corta el loop en cuanto el
    // primer poll confirma `available: false`, sin esperar a un segundo poll
    // fallido.
    let cancelado = false;
    let intervalId: number | undefined;

    async function consultar() {
      try {
        const r = await fetchImpersonacionJson<{ available: boolean; session: ImpersonacionSesion | null }>(apiBaseUrl, token, "/superadmin/impersonacion/activa");
        if (cancelado) return;
        setSesion(r.available ? r.session : null);
        if (!r.available && intervalId !== undefined) {
          window.clearInterval(intervalId);
          intervalId = undefined;
        }
      } catch {
        // Best-effort: un fallo de red al consultar el banner nunca debe tumbar
        // el resto del panel -- simplemente no se muestra hasta el próximo poll.
      }
    }

    void consultar();
    intervalId = window.setInterval(() => void consultar(), POLL_MS);
    return () => {
      cancelado = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [apiBaseUrl, token]);

  async function terminar() {
    if (!sesion) return;
    setTerminando(true);
    try {
      await fetchImpersonacionJson(apiBaseUrl, token, `/superadmin/impersonacion/sesiones/${sesion.id}/terminar`, { method: "POST" });
      setSesion(null);
    } catch {
      // El estado real se re-verifica en el próximo poll -- no se asume éxito
      // en silencio si la petición falló.
    } finally {
      setTerminando(false);
    }
  }

  if (!sesion || !sesion.activa) return null;

  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="w-4 h-4 text-destructive shrink-0" strokeWidth={1.75} />
        <span className="text-destructive font-medium shrink-0">Impersonando (solo lectura)</span>
        <span className="text-muted-foreground truncate">
          organización <span className="font-mono">{sesion.organizationId}</span> · {duracionRestante(sesion.remainingMs)} restantes
        </span>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => void terminar()} disabled={terminando}>
        {terminando ? "Terminando…" : "Terminar impersonación"}
      </Button>
    </div>
  );
}
