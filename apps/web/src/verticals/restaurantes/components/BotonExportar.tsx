// R-17 -- boton "Exportar" de la cabecera de Historial y Clientes: CTA secundario (outline) con menu CSV (Excel) / PDF. Solo se pinta para
// owner/admin (el servidor exige lo mismo con 403). Llama al endpoint real; errores (p. ej. 413 por pasar del tope de filas) se muestran con su mensaje.
import { useState } from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, notify, useT } from "@atiende/ui";
import { restaurantesExportar } from "@atiende/ui/i18n/restaurantes/exportar";
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
  etiqueta,
  variante = "outline",
}: {
  readonly role: string;
  readonly token: string;
  /** URL real del endpoint para el formato elegido, con los filtros vigentes de la pantalla. */
  readonly urlPara: (formato: FormatoExportacion) => string;
  readonly fetchImpl?: typeof fetch;
  readonly etiqueta?: string;
  /** Historial usa el CTA azul del original; Clientes conserva el secundario. */
  readonly variante?: "outline" | "default";
}) {
  const t = useT(restaurantesExportar);
  const [exportando, setExportando] = useState(false);
  if (!puedeExportar(role)) return null;

  async function exportar(formato: FormatoExportacion) {
    setExportando(true);
    try {
      guardarArchivo(await descargarExportacion(fetchImpl ?? fetch, urlPara(formato), token, formato));
      notify.success(t(formato === "csv" ? "restaurantes.exportar.listaCsv" : "restaurantes.exportar.listaPdf"));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t("restaurantes.exportar.error"));
    } finally {
      setExportando(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={variante} size="sm" loading={exportando} disabled={exportando}>
          <Download />
          {etiqueta ?? t("restaurantes.exportar.boton")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void exportar("csv")}>
          <FileSpreadsheet />
          {t("restaurantes.exportar.csv")}

        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportar("pdf")}>
          <FileText />
          {t("restaurantes.exportar.pdf")}

        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
