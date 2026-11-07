// Back office: «Útil / No fue útil» del Copiloto de todas las organizaciones (GET /superadmin/copiloto/valoraciones, migracion 0076).
// Solo conteos por vertical y organizacion; ningun texto de pregunta ni de respuesta (la tabla ni siquiera los guarda). Base sin la 0076:
// aviso honesto «no disponible aún», nunca ceros inventados.
import { Callout, ChartCard, DataTable, EstadoError } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchJson } from "../lib/fetch-json.ts";
import { fmtEntero, fmtPct } from "../lib/fichas-client.ts";
import { useCarga } from "../lib/use-carga.ts";

type Motivos = Readonly<Record<"dato_incorrecto" | "incompleta" | "no_entendio" | "otro" | "sin_motivo", number>>;

export interface FilaValoraciones {
  readonly vertical: string;
  readonly organizacionId: string | null;
  readonly organizacion: string | null;
  readonly utiles: number;
  readonly noUtiles: number;
  readonly motivos: Motivos;
}

export interface RespuestaValoraciones {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly dias: number;
  readonly total: { readonly utiles: number; readonly noUtiles: number; readonly motivos: Motivos };
  readonly filas: readonly FilaValoraciones[];
}

const MOTIVO: Readonly<Record<keyof Motivos, string>> = {
  dato_incorrecto: "dato mal",
  incompleta: "incompleta",
  no_entendio: "no entendió",
  otro: "otra cosa",
  sin_motivo: "sin motivo",
};

/** «3 dato mal · 1 incompleta»: solo los motivos con conteo. */
export function textoMotivos(m: Motivos): string {
  const partes = (Object.keys(MOTIVO) as (keyof Motivos)[]).filter((k) => m[k] > 0).map((k) => `${fmtEntero(m[k])} ${MOTIVO[k]}`);
  return partes.length > 0 ? partes.join(" · ") : "—";
}

/** % de «Útil» sobre lo valorado; null sin valoraciones (nunca 0 %). */
export function pctUtil(utiles: number, noUtiles: number): number | null {
  const total = utiles + noUtiles;
  return total > 0 ? Math.round((utiles / total) * 1000) / 10 : null;
}

const COLUMNAS: readonly DataTableColumna<FilaValoraciones>[] = [
  { id: "org", encabezado: "Organización", principal: true, valorOrden: (f) => f.organizacion ?? "", celda: (f) => <span className="font-medium text-foreground">{f.organizacion ?? "Plataforma"}</span> },
  { id: "vertical", encabezado: "Vertical", valorOrden: (f) => f.vertical, celda: (f) => f.vertical },
  { id: "utiles", encabezado: "Útil", alinear: "right", valorOrden: (f) => f.utiles, celda: (f) => fmtEntero(f.utiles) },
  { id: "noUtiles", encabezado: "No fue útil", alinear: "right", valorOrden: (f) => f.noUtiles, celda: (f) => fmtEntero(f.noUtiles) },
  { id: "pct", encabezado: "% útil", alinear: "right", valorOrden: (f) => pctUtil(f.utiles, f.noUtiles), celda: (f) => { const p = pctUtil(f.utiles, f.noUtiles); return p === null ? "—" : fmtPct(p); } },
  { id: "motivos", encabezado: "Motivos de «No fue útil»", celda: (f) => <span className="text-xs text-muted-foreground">{textoMotivos(f.motivos)}</span> },
];

export function ValoracionesCopiloto({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const { carga, recargar } = useCarga<RespuestaValoraciones>(() => fetchJson<RespuestaValoraciones>(apiBaseUrl, token, "/superadmin/copiloto/valoraciones?dias=30"), [apiBaseUrl, token], "No se pudieron cargar las valoraciones.");
  const subtitulo =
    carga.estado === "ok" && carga.data.disponible
      ? (() => {
          const p = pctUtil(carga.data.total.utiles, carga.data.total.noUtiles);
          return `Últimos ${carga.data.dias} días · ${fmtEntero(carga.data.total.utiles + carga.data.total.noUtiles)} valoraciones${p === null ? "" : ` · ${fmtPct(p)} útil`}`;
        })()
      : "Últimos 30 días";
  return (
    <ChartCard titulo="Valoraciones del Copiloto" subtitulo={subtitulo} tamano="S">
      <div data-testid="valoraciones-copiloto">
        {carga.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando valoraciones…</p>}
        {carga.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${carga.mensaje}`} onReintentar={recargar} />}
        {carga.estado === "ok" && !carga.data.disponible && (
          <Callout tone="warning" titulo="No disponible aún">
            {carga.data.mensaje ?? "Falta aplicar la migración 0076."}
          </Callout>
        )}
        {carga.estado === "ok" && carga.data.disponible && (
          <DataTable
            etiqueta="Valoraciones del Copiloto por organización"
            columnas={COLUMNAS}
            filas={carga.data.filas}
            obtenerId={(f) => `${f.vertical}|${f.organizacionId ?? ""}`}
            paginacion={{ tamano: 15 }}
            vacio={{ titulo: "Sin valoraciones", mensaje: "Nadie ha marcado una respuesta como útil o no útil en este periodo." }}
          />
        )}
      </div>
    </ChartCard>
  );
}
