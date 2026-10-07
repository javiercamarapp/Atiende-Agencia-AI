// Conflictos persistidos entre requisitos (paridad3 L-P3-06): el mismo tema con plazo u obligatoriedad distintos entre
// documentos de las bases. Un conflicto abierto bloquea el checklist del expediente hasta que una persona lo resuelve con
// notas (quién y cuándo queda registrado). Ninguna de las dos lecturas se aplica en silencio.
import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoVacio, Label, StatusBadge, statusTone, Textarea } from "@atiende/ui";
import { resolveRequirementConflict } from "../lib/requirements-client.ts";
import type { PersistedRequirementConflict } from "../lib/requirements-client.ts";
import { CONFLICTO_REQUISITO_TONES } from "../lib/status-tones.ts";
import { formatDateTime } from "../lib/format.ts";

const KIND_LABEL: Record<string, string> = {
  deadline_mismatch: "Plazos distintos",
  obligatoriedad_mismatch: "Obligatoriedad contradictoria",
  duplicate_ambiguous: "Requisito duplicado y ambiguo",
};

export interface ConflictosRequisitosProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly canWrite: boolean;
  readonly disponible: boolean;
  readonly conflicts: readonly PersistedRequirementConflict[];
  readonly onResolved: () => Promise<void>;
}

export function ConflictosRequisitos({ apiBaseUrl, token, propertyId, tenderId, canWrite, disponible, conflicts, onResolved }: ConflictosRequisitosProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!disponible) {
    return <EstadoVacio mensaje="No disponible aún: los conflictos persistidos requieren la migración 037. Mientras tanto, se muestran solo al extraer." />;
  }

  async function handleResolve(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (notes.trim().length === 0) {
      setError("Escribe las notas de resolución: son obligatorias.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await resolveRequirementConflict(fetch, apiBaseUrl, token, propertyId, tenderId, id, notes.trim());
      setOpenId(null);
      setNotes("");
      await onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo resolver el conflicto.");
    } finally {
      setBusy(false);
    }
  }

  const abiertos = conflicts.filter((c) => c.status === "abierto");
  const resueltos = conflicts.filter((c) => c.status === "resuelto");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conflictos abiertos ({abiertos.length})</CardTitle>
          <CardDescription>Mientras haya uno abierto, el checklist de integridad del expediente queda en rojo (consistencia cruzada).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {abiertos.length === 0 && <EstadoVacio mensaje="No hay conflictos abiertos entre los documentos de las bases." />}
          {abiertos.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-xl border border-border p-3" data-testid="conflicto-abierto">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={statusTone(CONFLICTO_REQUISITO_TONES, c.status)}>{KIND_LABEL[c.kind] ?? c.kind}</StatusBadge>
                {c.topicKey && <span className="text-xs text-muted-foreground">Tema: {c.topicKey}</span>}
              </div>
              <p className="text-sm text-foreground">{c.description}</p>
              {error && openId === c.id && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {canWrite && openId !== c.id && (
                <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => { setOpenId(c.id); setNotes(""); setError(null); }}>
                  Resolver
                </Button>
              )}
              {canWrite && openId === c.id && (
                <form onSubmit={(e) => void handleResolve(e, c.id)} className="flex flex-col gap-2">
                  <Label htmlFor={`conflicto-notas-${c.id}`}>Notas de resolución (obligatorias)</Label>
                  <Textarea id={`conflicto-notas-${c.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} placeholder="Qué documento prevalece y por qué (p. ej. el acta de junta modifica el plazo)." />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy}>
                      {busy ? "Guardando…" : "Marcar como resuelto"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpenId(null)}>
                      Cancelar
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {resueltos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resueltos ({resueltos.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {resueltos.map((c) => (
              <div key={c.id} className="flex flex-col gap-1 rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={statusTone(CONFLICTO_REQUISITO_TONES, c.status)}>{KIND_LABEL[c.kind] ?? c.kind}</StatusBadge>
                  {c.resolvedAt && <span className="text-xs text-muted-foreground">{formatDateTime(c.resolvedAt)}</span>}
                </div>
                <p className="text-sm text-muted-foreground">{c.description}</p>
                {c.resolutionNotes && <p className="text-sm text-foreground">Notas: {c.resolutionNotes}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
