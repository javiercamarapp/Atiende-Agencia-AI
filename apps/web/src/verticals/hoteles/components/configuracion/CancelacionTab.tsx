// Pestana Politica de cancelacion: horas libres, porcentaje de penalidad y texto para el huesped. Guardar llama a
// `PUT .../configuracion/politica-cancelacion` (owner/gm, con bitacora); es la politica que usa la cancelacion de reservas. "Descartar
// cambios" solo restaura el formulario.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, FormField, Input, Textarea, toast } from "@atiende/ui";
import { fetchPoliticaCancelacion, guardarPoliticaCancelacion } from "../../lib/configuracion-client.ts";
import type { PoliticaCancelacion } from "../../lib/configuracion-client.ts";
import { mensajeDe, numeroODefecto, porcentajeARazon, razonAPorcentaje } from "./comun.ts";
import type { PestanaProps } from "./comun.ts";

interface Campos {
  horas: string;
  penalidad: string;
  texto: string;
}

const camposDe = (p: PoliticaCancelacion): Campos => ({ horas: String(p.freeUntilHours), penalidad: String(razonAPorcentaje(p.penaltyPct)), texto: p.guestText ?? "" });

export function CancelacionTab({ apiBaseUrl, token, propertyId, puedeEscribir }: PestanaProps) {
  const [actual, setActual] = useState<PoliticaCancelacion | null>(null);
  const [campos, setCampos] = useState<Campos>({ horas: "", penalidad: "", texto: "" });
  const [error, setError] = useState<string | null>(null);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const p = await fetchPoliticaCancelacion(fetch, apiBaseUrl, token, propertyId);
      setActual(p);
      setCampos(camposDe(p));
    } catch (err) {
      setError(mensajeDe(err, "No se pudo cargar la política de cancelación."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const horas = numeroODefecto(campos.horas);
  const penalidad = numeroODefecto(campos.penalidad);
  const valido = horas !== null && Number.isInteger(horas) && horas >= 0 && horas <= 8760 && penalidad !== null && penalidad >= 0 && penalidad <= 100 && campos.texto.length <= 1000;
  const cambio = actual !== null && JSON.stringify(campos) !== JSON.stringify(camposDe(actual));

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!valido || horas === null || penalidad === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const saved = await guardarPoliticaCancelacion(fetch, apiBaseUrl, token, propertyId, { freeUntilHours: horas, penaltyPct: porcentajeARazon(penalidad), guestText: campos.texto.trim() === "" ? null : campos.texto.trim() });
      setActual(saved);
      setCampos(camposDe(saved));
      toast.success("Política de cancelación guardada.");
    } catch (err) {
      setErrorGuardar(mensajeDe(err, "No se pudo guardar la política de cancelación."));
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!actual) return <EstadoCargando etiqueta="Cargando política de cancelación…" />;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        {!actual.configurado && <Callout tone="warning" titulo="Aún no defines tu política">Se usan los valores por omisión (24 horas libres, 50 % de penalidad). Guárdala para cerrar este paso.</Callout>}
        <form onSubmit={(e) => void guardar(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Horas libres antes del check-in" hint="Cancelar con al menos este tiempo de anticipación no cobra penalidad.">
            <Input inputMode="numeric" value={campos.horas} onChange={(e) => setCampos({ ...campos, horas: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          <FormField label="Penalidad (%)" hint="Porcentaje del total de la reserva que se cobra al cancelar tarde.">
            <Input inputMode="decimal" value={campos.penalidad} onChange={(e) => setCampos({ ...campos, penalidad: e.target.value })} disabled={!puedeEscribir} />
          </FormField>
          <div className="sm:col-span-2">
            <FormField label="Texto para el huésped" hint="Se muestra al huésped al reservar. Hasta 1000 caracteres.">
              <Textarea rows={3} value={campos.texto} maxLength={1000} onChange={(e) => setCampos({ ...campos, texto: e.target.value })} disabled={!puedeEscribir} />
            </FormField>
          </div>
          {errorGuardar && <div className="sm:col-span-2"><EstadoError mensaje={errorGuardar} /></div>}
          {puedeEscribir ? (
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" loading={guardando} disabled={!valido || !cambio || guardando}>
                Guardar política
              </Button>
              <Button type="button" variant="outline" disabled={!cambio || guardando} onClick={() => { setCampos(camposDe(actual)); setErrorGuardar(null); }}>
                Descartar cambios
              </Button>
            </div>
          ) : (
            <p className="m-0 text-xs text-muted-foreground sm:col-span-2">Solo el propietario y el gerente general pueden cambiar la política; tu rol puede consultarla.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
