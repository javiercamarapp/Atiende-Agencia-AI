// D-P3-16: pestaña «Contabilidad electrónica» del libro. Genera, desde el libro persistido, el catálogo y la balanza (XML conformes al XSD 1.3 del SAT,
// validados contra el esquema oficial en las pruebas) y el XML de pólizas del periodo (PolizasPeriodo 1.3), cada uno con su huella SHA-1. NO se envía
// al SAT ni se firma con e.firma desde Atiende (el envío es humano). Tipo de envío N/C (FechaModBal solo en C) y, para las pólizas, el tipo de
// solicitud y el número de orden o trámite que fija la autoridad: son datos que captura la persona, nunca se inventan.
import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Callout, EstadoError, Input, Label, NativeSelect } from "@atiende/ui";
import { ETIQUETA_TIPO_SOLICITUD, fetchPaquete, fetchPolizasXml } from "../lib/libro-client.ts";
import type { PaqueteContabilidad, PolizasPeriodoXml, TipoSolicitudPolizas } from "../lib/libro-client.ts";

function descargarTexto(nombre: string, contenido: string): void {
  const url = URL.createObjectURL(new Blob([contenido], { type: "application/xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

const NUM_ORDEN = /^[A-Z]{3}\d{7}\/\d{2}$/;
const NUM_TRAMITE = /^[A-Z]{2}\d{12}$/;

export interface ContabilidadElectronicaLibroPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly periodo: string;
  readonly periodoValido: boolean;
}

export function ContabilidadElectronicaLibroPanel({ apiBaseUrl, token, propertyId, periodo, periodoValido }: ContabilidadElectronicaLibroPanelProps) {
  const [tipoEnvio, setTipoEnvio] = useState<"N" | "C">("N");
  const [fechaModBal, setFechaModBal] = useState("");
  const [paquete, setPaquete] = useState<PaqueteContabilidad | null>(null);
  const [paqueteError, setPaqueteError] = useState<string | null>(null);
  const [tipoSolicitud, setTipoSolicitud] = useState<TipoSolicitudPolizas>("AF");
  const [numero, setNumero] = useState("");
  const [polizas, setPolizas] = useState<PolizasPeriodoXml | null>(null);
  const [polizasError, setPolizasError] = useState<string | null>(null);

  const exigeOrden = tipoSolicitud === "AF" || tipoSolicitud === "FC";
  const numeroNormalizado = numero.trim().toUpperCase();
  const numeroValido = exigeOrden ? NUM_ORDEN.test(numeroNormalizado) : NUM_TRAMITE.test(numeroNormalizado);
  const fechaValida = tipoEnvio === "N" || /^\d{4}-\d{2}-\d{2}$/.test(fechaModBal);

  async function generarPaquete() {
    setPaqueteError(null);
    try {
      setPaquete(await fetchPaquete(fetch, apiBaseUrl, token, propertyId, periodo, tipoEnvio === "C" ? { tipoEnvio, fechaModBal } : {}));
    } catch (err) {
      setPaquete(null);
      setPaqueteError(err instanceof Error ? err.message : "No se pudo generar el paquete.");
    }
  }

  async function generarPolizas() {
    setPolizasError(null);
    try {
      setPolizas(await fetchPolizasXml(fetch, apiBaseUrl, token, propertyId, periodo, exigeOrden ? { tipoSolicitud, numOrden: numeroNormalizado } : { tipoSolicitud, numTramite: numeroNormalizado }));
    } catch (err) {
      setPolizas(null);
      setPolizasError(err instanceof Error ? err.message : "No se pudo generar el XML de pólizas.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Genera el catálogo, la balanza de comprobación y las pólizas del mes en XML (contabilidad electrónica 1.3), con su huella SHA-1, desde el libro. No se envía al SAT ni se firma desde Atiende: el envío es de tu equipo.
      </p>

      <section aria-label="Catálogo y balanza" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">Catálogo y balanza</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ce-tipo-envio">Tipo de envío</Label>
            <NativeSelect id="ce-tipo-envio" value={tipoEnvio} onChange={(e) => setTipoEnvio(e.target.value as "N" | "C")}>
              <option value="N">Normal</option>
              <option value="C">Complementaria</option>
            </NativeSelect>
          </div>
          {tipoEnvio === "C" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="ce-fecha-mod">Fecha de modificación de la balanza</Label>
              <Input id="ce-fecha-mod" type="date" value={fechaModBal} onChange={(e) => setFechaModBal(e.target.value)} className="w-44" />
            </div>
          )}
          <Button type="button" size="sm" disabled={!periodoValido || !fechaValida} onClick={() => void generarPaquete()}>
            Generar paquete de {periodo}
          </Button>
        </div>
        {paqueteError && <EstadoError mensaje={paqueteError} />}
        {paquete && (
          <div className="flex flex-col gap-2">
            <Callout tone={paquete.balanza.cuadrada ? "success" : "warning"} role="status">
              Balanza {paquete.balanza.cuadrada ? "cuadrada" : "descuadrada"}: {paquete.resumen.cuentas} cuentas, debe ${paquete.resumen.totalDebe} · haber ${paquete.resumen.totalHaber}. {paquete.nota}
            </Callout>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => descargarTexto(`catalogo-${paquete.periodo}.xml`, paquete.catalogo.xml)}>
                <Download />
                Catálogo XML
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">SHA-1 {paquete.catalogo.sha1}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => descargarTexto(`balanza-${paquete.periodo}.xml`, paquete.balanza.xml)}>
                <Download />
                Balanza XML
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">SHA-1 {paquete.balanza.sha1}</span>
            </div>
          </div>
        )}
      </section>

      <section aria-label="Pólizas del periodo" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">Pólizas del periodo</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ce-tipo-solicitud">Tipo de solicitud</Label>
            <NativeSelect id="ce-tipo-solicitud" value={tipoSolicitud} onChange={(e) => { setTipoSolicitud(e.target.value as TipoSolicitudPolizas); setNumero(""); }}>
              {(Object.keys(ETIQUETA_TIPO_SOLICITUD) as TipoSolicitudPolizas[]).map((t) => (
                <option key={t} value={t}>
                  {ETIQUETA_TIPO_SOLICITUD[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ce-numero">{exigeOrden ? "Número de orden" : "Número de trámite"}</Label>
            <Input id="ce-numero" value={numero} maxLength={14} placeholder={exigeOrden ? "ABC1234567/26" : "AB123456789012"} className="w-44 font-mono uppercase" onChange={(e) => setNumero(e.target.value)} />
          </div>
          <Button type="button" size="sm" disabled={!periodoValido || !numeroValido} onClick={() => void generarPolizas()}>
            Generar pólizas de {periodo}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">El tipo de solicitud y su número los fija la orden o el trámite de la autoridad. El XML lleva las partidas de cada póliza; los datos de complemento (CFDI, cheque, transferencia) no se incluyen todavía.</p>
        {polizasError && <EstadoError mensaje={polizasError} />}
        {polizas && (
          <div className="flex flex-col gap-2">
            <Callout tone="success" role="status">
              {polizas.polizas} póliza(s) de {polizas.periodo}. {polizas.nota}
            </Callout>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => descargarTexto(`polizas-${polizas.periodo}.xml`, polizas.xml)}>
                <Download />
                Pólizas XML
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">SHA-1 {polizas.sha1}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
