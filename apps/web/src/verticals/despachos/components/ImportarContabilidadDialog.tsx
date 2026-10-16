// D-P3-44: "Importar del proveedor anterior" (pestaña Catálogo del libro). Dos flujos REALES contra el servidor, con el mismo patrón:
//   1. elegir el XML (catálogo o balanza de contabilidad electrónica) -> el navegador lo lee como texto y pide la VISTA PREVIA (no escribe nada);
//   2. el servidor valida (UTF-8, sin DTD ni entidades, tope de tamaño, RFC del cliente) y devuelve qué importaría y qué rechaza y por qué;
//   3. "Importar" confirma (con segundo factor reciente) y recién entonces se escribe en el libro.
// Catálogo: mezcla sin borrar nada (misma cuenta = se actualiza). Balanza: registra una póliza de apertura con los saldos iniciales.
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button, Callout, DataTable, FormDialog, Label, StatusBadge } from "@atiende/ui";
import { dinero, importarAperturaXml, importarCatalogoXml } from "../lib/libro-client.ts";
import type { VistaPreviaApertura, VistaPreviaCatalogo } from "../lib/libro-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";

export type ModoImportacion = "catalogo" | "apertura";

export interface ImportarContabilidadDialogProps {
  readonly modo: ModoImportacion;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Se llama tras importar de verdad: la página recarga catálogo, pólizas y balanza. */
  readonly onTerminado: () => void;
}

const MAX_BYTES = 2 * 1024 * 1024;

const TEXTOS: Record<ModoImportacion, { titulo: string; subtitulo: string; ayuda: string; confirmar: string }> = {
  catalogo: {
    titulo: "Importar catálogo del proveedor anterior",
    subtitulo: "XML de catálogo de cuentas de contabilidad electrónica. No se borra ninguna cuenta: la que ya existe se actualiza y las nuevas se agregan.",
    ayuda: "Solo se importan cuentas numéricas de 4 a 10 dígitos; el resto se lista abajo con su motivo.",
    confirmar: "Importar catálogo",
  },
  apertura: {
    titulo: "Importar balanza del proveedor anterior",
    subtitulo: "XML de balanza de comprobación. Se registra una póliza de apertura (diario) con los saldos iniciales del mes, fechada el último día del mes anterior.",
    ayuda: "Primero importa el catálogo: todas las cuentas con saldo deben existir en el del cliente y la balanza debe cuadrar.",
    confirmar: "Registrar apertura",
  },
};

function leerTexto(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(typeof lector.result === "string" ? lector.result : "");
    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.readAsText(archivo, "utf-8");
  });
}

export function ImportarContabilidadDialog({ modo, open, onOpenChange, apiBaseUrl, token, propertyId, onTerminado }: ImportarContabilidadDialogProps) {
  const textos = TEXTOS[modo];
  const [xml, setXml] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [vista, setVista] = useState<VistaPreviaCatalogo | VistaPreviaApertura | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reiniciar() {
    setXml(null);
    setNombre("");
    setVista(null);
    setError(null);
    setListo(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function llamar(texto: string, confirmar: boolean): Promise<VistaPreviaCatalogo | VistaPreviaApertura> {
    return modo === "catalogo" ? importarCatalogoXml(fetch, apiBaseUrl, token, propertyId, texto, confirmar) : importarAperturaXml(fetch, apiBaseUrl, token, propertyId, texto, confirmar);
  }

  async function elegir(archivo: File | undefined) {
    reiniciar();
    if (!archivo) return;
    if (archivo.size > MAX_BYTES) {
      setError("El archivo pesa más de 2 MB: no es un XML de contabilidad electrónica.");
      return;
    }
    setNombre(archivo.name);
    setTrabajando(true);
    try {
      const texto = await leerTexto(archivo);
      setXml(texto);
      setVista(await llamar(texto, false));
    } catch (err) {
      setXml(null);
      setError(err instanceof Error ? err.message : "No se pudo revisar el archivo.");
    } finally {
      setTrabajando(false);
    }
  }

  async function confirmar() {
    if (!xml) return;
    setError(null);
    setTrabajando(true);
    try {
      const r = await llamar(xml, true);
      setVista(r);
      setListo(
        modo === "catalogo"
          ? `Catálogo importado: ${(r as VistaPreviaCatalogo).agregadas ?? 0} cuenta(s) nueva(s) y ${(r as VistaPreviaCatalogo).actualizadas} actualizada(s).`
          : `Póliza de apertura registrada (diario, folio ${(r as VistaPreviaApertura).folio ?? "—"}).`,
      );
      onTerminado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la importación.");
    } finally {
      setTrabajando(false);
    }
  }

  const catalogo = modo === "catalogo" ? (vista as VistaPreviaCatalogo | null) : null;
  const apertura = modo === "apertura" ? (vista as VistaPreviaApertura | null) : null;
  const puedeConfirmar = !listo && !trabajando && vista !== null && (modo === "apertura" || (catalogo?.aceptadas ?? 0) > 0);

  return (
    <FormDialog
      open={open}
      onOpenChange={(abrir) => {
        if (!abrir && trabajando) return;
        if (!abrir) reiniciar();
        onOpenChange(abrir);
      }}
      titulo={textos.titulo}
      subtitulo={textos.subtitulo}
      anchoClase="max-w-3xl"
      bloquearCierre={trabajando}
      footer={
        <>
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={trabajando}>
            {listo ? "Cerrar" : "Cancelar"}
          </Button>
          {!listo && (
            <Button type="button" className="rounded-full px-6" onClick={() => void confirmar()} disabled={!puedeConfirmar}>
              <Upload />
              {trabajando && vista ? "Importando…" : textos.confirmar}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`importar-${modo}-archivo`}>Archivo XML</Label>
          <input
            id={`importar-${modo}-archivo`}
            ref={inputRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            disabled={trabajando || listo !== null}
            className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
            onChange={(e) => void elegir(e.target.files?.[0])}
          />
          <p className="text-xs text-muted-foreground">{textos.ayuda} Máximo 2 MB; el archivo debe ser de este mismo cliente (se compara el RFC).</p>
          {nombre && !error && <p className="text-xs text-muted-foreground">{trabajando && !vista ? `Revisando ${nombre}…` : nombre}</p>}
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {listo && (
          <Callout tone="success" role="status">
            {listo}
          </Callout>
        )}

        {catalogo && (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
              <span>Periodo {catalogo.periodo}:</span>
              <StatusBadge tone="success">{catalogo.nuevas} nuevas</StatusBadge>
              <StatusBadge tone="info">{catalogo.actualizadas} se actualizan</StatusBadge>
              <StatusBadge tone={catalogo.rechazadasTotal > 0 ? "danger" : "neutral"}>{catalogo.rechazadasTotal} rechazadas</StatusBadge>
              {catalogo.sinCodigoAgrupador > 0 && <StatusBadge tone="warning">{catalogo.sinCodigoAgrupador} sin código SAT</StatusBadge>}
            </p>
            {catalogo.advertencias.map((a) => (
              <Callout key={a} tone="warning">
                {a}
              </Callout>
            ))}
            {catalogo.rechazadas.length > 0 && (
              <DataTable
                etiqueta="Cuentas que no se importan"
                obtenerId={(r) => r.numCta + r.motivo}
                filas={catalogo.rechazadas}
                paginacion={{ tamano: 8 }}
                columnas={[
                  { id: "cuenta", encabezado: "Cuenta", principal: true, celda: (r) => <span className="font-mono text-xs">{r.numCta}</span> },
                  { id: "motivo", encabezado: "Motivo", celda: (r) => <span className="text-xs text-muted-foreground">{r.motivo}</span> },
                ]}
              />
            )}
            {catalogo.rechazadasTotal > catalogo.rechazadas.length && <p className="text-xs text-muted-foreground">Se muestran las primeras {catalogo.rechazadas.length} de {catalogo.rechazadasTotal}.</p>}
          </div>
        )}

        {apertura && (
          <Callout tone="info" role="status">
            Balanza de {apertura.periodo} ({apertura.tipoEnvio === "C" ? "complementaria" : "normal"}): se registrará la póliza «{apertura.concepto}» del {formatFechaSolo(apertura.fecha)} con {apertura.partidas} partidas por {dinero(apertura.totalCentavos)} en cada lado.
          </Callout>
        )}
      </div>
    </FormDialog>
  );
}
