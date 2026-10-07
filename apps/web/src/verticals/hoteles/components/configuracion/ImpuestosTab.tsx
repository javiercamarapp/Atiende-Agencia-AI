// Pestana Impuestos: IVA, ISH, DSA por cuarto-noche y umbral de descuento. Guardar llama a `PUT .../configuracion/impuestos` (owner/gm, con
// bitacora); "Descartar cambios" solo restaura el formulario y nunca escribe. El ISH depende del estado: el aviso del servidor lo recuerda.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, FormField, Input, toast } from "@atiende/ui";
import { fetchImpuestos, guardarImpuestos } from "../../lib/configuracion-client.ts";
import type { Impuestos } from "../../lib/configuracion-client.ts";
import { mensajeDe, numeroODefecto, porcentajeARazon, razonAPorcentaje } from "./comun.ts";
import type { PestanaProps } from "./comun.ts";

interface Campos {
  iva: string;
  ish: string;
  dsa: string;
  umbral: string;
}

function camposDe(i: Impuestos): Campos {
  return { iva: String(razonAPorcentaje(i.ivaRate)), ish: String(razonAPorcentaje(i.ishRate)), dsa: String(i.dsaPerNight), umbral: String(i.discountThreshold) };
}

export function ImpuestosTab({ apiBaseUrl, token, propertyId, puedeEscribir }: PestanaProps) {
  const [actual, setActual] = useState<Impuestos | null>(null);
  const [campos, setCampos] = useState<Campos>({ iva: "", ish: "", dsa: "", umbral: "" });
  const [error, setError] = useState<string | null>(null);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const i = await fetchImpuestos(fetch, apiBaseUrl, token, propertyId);
      setActual(i);
      setCampos(camposDe(i));
    } catch (err) {
      setError(mensajeDe(err, "No se pudieron cargar los impuestos."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const iva = numeroODefecto(campos.iva);
  const ish = numeroODefecto(campos.ish);
  const dsa = numeroODefecto(campos.dsa);
  const umbral = numeroODefecto(campos.umbral);
  const valido = iva !== null && iva >= 0 && iva <= 100 && ish !== null && ish >= 0 && ish <= 100 && dsa !== null && dsa >= 0 && umbral !== null && umbral >= 0;
  const cambio = actual !== null && JSON.stringify(campos) !== JSON.stringify(camposDe(actual));

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!valido || iva === null || ish === null || dsa === null || umbral === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const saved = await guardarImpuestos(fetch, apiBaseUrl, token, propertyId, { ivaRate: porcentajeARazon(iva), ishRate: porcentajeARazon(ish), discountThreshold: umbral, dsaPerNight: dsa });
      setActual(saved);
      setCampos(camposDe(saved));
      toast.success("Impuestos guardados.");
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudieron guardar los impuestos."));
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!actual) return <EstadoCargando etiqueta="Cargando impuestos…" />;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        {!actual.configurado && <Callout tone="warning" titulo="Aún no guardas tus impuestos">Se usan los valores por omisión (IVA 16 %, ISH 3 %). Revísalos y guárdalos para cerrar este paso.</Callout>}
        <Callout tone="info" titulo="El ISH depende del estado">{actual.aviso}</Callout>
        <form onSubmit={(e) => void guardar(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="IVA (%)">
            <Input id="imp-iva" inputMode="decimal" value={campos.iva} onChange={(e) => setCampos({ ...campos, iva: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          <FormField label="ISH (%)">
            <Input id="imp-ish" inputMode="decimal" value={campos.ish} onChange={(e) => setCampos({ ...campos, ish: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          <FormField label="DSA por cuarto-noche (MXN)" hint="Derecho de saneamiento ambiental; varía por municipio. 0 si no aplica.">
            <Input id="imp-dsa" inputMode="decimal" value={campos.dsa} onChange={(e) => setCampos({ ...campos, dsa: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          <FormField label="Umbral de descuento (MXN)" hint="Descuentos sobre este monto requieren autorización.">
            <Input id="imp-umbral" inputMode="decimal" value={campos.umbral} onChange={(e) => setCampos({ ...campos, umbral: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          {errorGuardar && <div className="sm:col-span-2"><EstadoError mensaje={errorGuardar} /></div>}
          {puedeEscribir ? (
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" loading={guardando} disabled={!valido || !cambio || guardando}>
                Guardar impuestos
              </Button>
              <Button type="button" variant="outline" disabled={!cambio || guardando} onClick={() => { setCampos(camposDe(actual)); setErrorGuardar(null); }}>
                Descartar cambios
              </Button>
            </div>
          ) : (
            <p className="m-0 text-xs text-muted-foreground sm:col-span-2">Solo el propietario y el gerente general pueden cambiar los impuestos; tu rol puede consultarlos.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
