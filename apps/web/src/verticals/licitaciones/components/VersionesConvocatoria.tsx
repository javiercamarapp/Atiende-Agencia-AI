// paridad3 L-P3-14 -- pestana "Versiones" de la convocatoria: historial de versiones (REQ-153) con el diff por campo y por requisito de cada una y
// las secciones de propuesta que ese cambio invalida (REQ-155), mas las fuentes que traen esta convocatoria (REQ-152) con los conflictos de
// campos que cada fuente enlazada reporta. Solo lectura: ningun boton escribe nada.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, StatusBadge } from "@atiende/ui";
import { CAMPO_LABEL, DIFF_LABEL, fetchTenderSources, fetchTenderVersions, valorTexto } from "../lib/versiones-client.ts";
import type { TenderSourceLink, TenderVersionEntry } from "../lib/versiones-client.ts";
import { formatDateTime } from "../lib/format.ts";

export interface VersionesConvocatoriaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
}

function CambiosDeVersion({ version }: { version: TenderVersionEntry }) {
  const campos = version.diff.fields.filter((f) => f.status !== "sin_cambio");
  const requisitos = version.diff.requirements.filter((r) => r.status !== "sin_cambio");
  if (!version.diff.hasChanges) {
    return <p className="text-sm text-muted-foreground">{version.version === 1 ? "Versión inicial: es la primera captura de las bases." : "Sin cambios respecto de la versión anterior."}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {campos.map((f) => (
        <div key={f.field} className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge dot={false}>{DIFF_LABEL[f.status]}</StatusBadge>
          <span className="font-semibold text-foreground">{CAMPO_LABEL[f.field] ?? f.field}</span>
          <span className="text-muted-foreground">
            {valorTexto(f.previous)} → {valorTexto(f.current)}
          </span>
        </div>
      ))}
      {requisitos.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge dot={false}>{DIFF_LABEL[r.status]}</StatusBadge>
          <span className="font-semibold text-foreground">Requisito</span>
          <span className="min-w-0 break-words text-muted-foreground">{(r.current ?? r.previous)?.text ?? r.key}</span>
        </div>
      ))}
      {version.diff.affectedSectionKeys.length > 0 && (
        <p className="text-xs text-muted-foreground">Secciones de la propuesta marcadas para revisión por este cambio: {version.diff.affectedSectionKeys.join(", ")}.</p>
      )}
    </div>
  );
}

export function VersionesConvocatoria({ apiBaseUrl, token, propertyId, tenderId }: VersionesConvocatoriaProps) {
  const [versions, setVersions] = useState<readonly TenderVersionEntry[] | null>(null);
  const [sources, setSources] = useState<readonly TenderSourceLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, s] = await Promise.all([fetchTenderVersions(fetch, apiBaseUrl, token, propertyId, tenderId), fetchTenderSources(fetch, apiBaseUrl, token, propertyId, tenderId)]);
      setVersions(v);
      setSources(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las versiones.");
    }
  }, [apiBaseUrl, token, propertyId, tenderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EstadoError mensaje={error} onReintentar={() => void load()} />;
  if (!versions || !sources) return <EstadoCargando lineas={3} etiqueta="Cargando versiones…" />;

  const conflictos = sources.filter((s) => !s.primary && s.conflicts.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fuentes de esta convocatoria</CardTitle>
          <CardDescription>La misma convocatoria puede llegar por más de una fuente: se enlaza como una sola y conserva el valor de la fuente primaria.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {sources.map((s) => (
            <div key={`${s.source}:${s.externalId}`} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge dot={false}>{s.primary ? "Primaria" : "Enlazada"}</StatusBadge>
              <span className="font-semibold text-foreground">{s.source}</span>
              <span className="min-w-0 break-all text-muted-foreground">{s.externalId}</span>
              {s.lastSeenAt && <span className="text-xs text-muted-foreground">visto {formatDateTime(s.lastSeenAt)}</span>}
            </div>
          ))}
          {conflictos.map((s) => (
            <div key={`c-${s.source}:${s.externalId}`} className="rounded-xl border border-border bg-muted p-3">
              <p className="text-sm font-semibold text-foreground">{s.source} difiere en:</p>
              <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                {s.conflicts.map((c) => (
                  <li key={c.field}>
                    <span className="font-semibold text-foreground">{CAMPO_LABEL[c.field] ?? c.field}</span>: {valorTexto(c.current)} (primaria) · {valorTexto(c.alternative)} ({s.source})
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historial de versiones</CardTitle>
          <CardDescription>Cada cambio en las bases o en los requisitos crea una versión nueva, de la más reciente a la más antigua. Solo lectura.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {versions.length === 0 && <EstadoVacio mensaje="Esta convocatoria todavía no tiene versiones registradas." />}
          {[...versions].reverse().map((v) => (
            <div key={v.version} className="rounded-xl border border-border p-3">
              <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                Versión {v.version}
                <span className="text-xs font-normal text-muted-foreground">{formatDateTime(v.createdAt)}</span>
              </p>
              <CambiosDeVersion version={v} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
