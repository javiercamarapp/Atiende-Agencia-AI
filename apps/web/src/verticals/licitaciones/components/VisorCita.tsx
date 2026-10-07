// Visor de la cita (paridad3 L-P3-06): al elegir la página de origen de un requisito muestra el texto REAL de esa página
// del documento guardado, con el extracto del requisito resaltado. Solo lectura; si el documento no tiene texto guardado
// lo dice (nunca inventa el contenido).
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError } from "@atiende/ui";
import { fetchDocumentPage } from "../lib/documents-client.ts";
import type { DocumentPageResult } from "../lib/documents-client.ts";

export interface VisorCitaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly documentId: string;
  readonly page: number;
  readonly clause: string | null;
  /** Texto del requisito: se resalta dentro de la página si aparece. */
  readonly extracto: string;
  readonly onClose: () => void;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parte la página en [antes, extracto, después] si el extracto aparece (sin distinguir espacios ni mayúsculas); si no, `null`. */
export function splitAtExtract(pageText: string, extract: string): readonly [string, string, string] | null {
  const needle = normalize(extract).slice(0, 160);
  if (needle.length < 8) return null;
  // Se compara sobre el texto con espacios colapsados, conservando el mapeo a posiciones del original.
  const positions: number[] = [];
  let collapsed = "";
  let lastSpace = true;
  for (let i = 0; i < pageText.length; i += 1) {
    const ch = pageText[i]!;
    const isSpace = /\s/.test(ch);
    if (isSpace && lastSpace) continue;
    collapsed += isSpace ? " " : ch.toLowerCase();
    positions.push(i);
    lastSpace = isSpace;
  }
  const at = collapsed.indexOf(needle);
  if (at === -1) return null;
  const start = positions[at]!;
  const end = (positions[at + needle.length - 1] ?? pageText.length - 1) + 1;
  return [pageText.slice(0, start), pageText.slice(start, end), pageText.slice(end)];
}

export function VisorCita({ apiBaseUrl, token, propertyId, tenderId, documentId, page, clause, extracto, onClose }: VisorCitaProps) {
  const [data, setData] = useState<DocumentPageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchDocumentPage(fetch, apiBaseUrl, token, propertyId, tenderId, documentId, page)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar la cita.");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token, propertyId, tenderId, documentId, page]);

  const parts = data?.page ? splitAtExtract(data.page.text, extracto) : null;

  return (
    <Card role="region" aria-label="Visor de la cita" data-testid="visor-cita">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <CardTitle className="text-base">
          Cita: {data ? (data.document.title ?? data.document.filename ?? "documento") : "documento"} · página {page}
          {clause ? ` · ${clause}` : ""}
        </CardTitle>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label="Cerrar el visor de la cita">
          <X />
          Cerrar
        </Button>
      </CardHeader>
      <CardContent>
        {!data && !error && <EstadoCargando etiqueta="Cargando la página…" />}
        {error && <EstadoError mensaje={error} />}
        {data && !data.page && <p className="text-sm text-muted-foreground">Este documento no tiene texto guardado para la página {page} (no se inventa su contenido).</p>}
        {data?.page && (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-muted/40 p-3 text-sm text-foreground">
            {parts ? (
              <>
                {parts[0]}
                <mark className="rounded bg-primary/15 px-0.5 text-foreground">{parts[1]}</mark>
                {parts[2]}
              </>
            ) : (
              data.page.text
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
