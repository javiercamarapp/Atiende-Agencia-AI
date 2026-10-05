// R-17 -- boton "Exportar" de la cabecera de Historial y Clientes: CTA secundario (outline) con menu CSV (Excel) / PDF. Solo se pinta para
// owner/admin (el servidor exige lo mismo con 403). Llama al endpoint real; errores (p. ej. 413 por pasar del tope de filas) se muestran con su mensaje.
import { useState } from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, notify } from "@atiende/ui";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { descargarExportacion, guardarArchivo } from "../lib/exportar-client.ts";
import type { FormatoExportacion } from "../lib/exportar-client.ts";

const ROLES_EXPORTAR: ReadonlySet<string> = new Set(["owner", "admin"]);

export function puedeExportar(role: string): boolean {
  return ROLES_EXPORTAR.has(role);
}

export function BotonExportar({
  role,
  token,
  urlPara,
  fetchImpl,
  etiqueta = "Exportar",
}: {
  readonly role: string;
  readonly token: string;
  /** URL real del endpoint para el formato elegido, con los filtros vigentes de la pantalla. */
  readonly urlPara: (formato: FormatoExportacion) => string;
  readonly fetchImpl?: typeof fetch;
  readonly etiqueta?: string;
}) {
  const [exportando, setExportando] = useState(false);
  if (!puedeExportar(role)) return null;

  async function exportar(formato: FormatoExportacion) {
    setExportando(true);
    try {
      guardarArchivo(await descargarExportacion(fetchImpl ?? fetch, urlPara(formato), token, formato));
      notify.success(formato === "csv" ? "Exportación lista (CSV, ábrelo con Excel)." : "Exportación lista (PDF).");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo exportar.");
    } finally {
      setExportando(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" loading={exportando} disabled={exportando}>
          <Download />
          {etiqueta}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void exportar("csv")}>
          <FileSpreadsheet />
          CSV (Excel)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportar("pdf")}>
          <FileText />
          PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
