// Procedencia de un dato de empresa (REQ-142): "Capturó: Ana · 2026-03-01 10:00 UTC (manual)". Para los datos que EXIGEN procedencia
// (los del perfil completo) un dato sin ella se muestra como bloqueado: no se usa en propuestas ni en el matching hasta capturarlo desde aqui.
import { StatusBadge } from "@atiende/ui";
import type { CompanyDataAuthorship } from "../lib/company-data-client.ts";

const FUENTE: Readonly<Record<string, string>> = { manual: "captura manual", importado: "importado", asistente: "asistente" };

/** "2026-03-01T10:00:00.000Z" o "2026-03-01 10:00:00+00" -> "2026-03-01 10:00 UTC". Sin `toLocale*`. */
export function procedenciaFecha(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(at);
  return m ? `${m[1]} ${m[2]} UTC` : at.slice(0, 10);
}

export function ProcedenciaLinea({ item, userId, exige = false }: { item: CompanyDataAuthorship; userId: string | null; exige?: boolean }) {
  const p = item.procedencia;
  if (!p) {
    if (!exige) return null;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <StatusBadge tone="danger" dot={false}>
          Sin procedencia
        </StatusBadge>
        <span>No se usa en propuestas ni en el matching: este dato no se capturó desde la aplicación. Edítalo aquí para registrar quién lo capturó.</span>
      </div>
    );
  }
  const quien = p.by === userId ? "tú" : (p.byName ?? "otra persona del equipo");
  return (
    <div className="text-xs text-muted-foreground" data-testid="procedencia">
      Capturó: {quien} · {procedenciaFecha(p.at)} ({FUENTE[p.source] ?? p.source})
    </div>
  );
}
