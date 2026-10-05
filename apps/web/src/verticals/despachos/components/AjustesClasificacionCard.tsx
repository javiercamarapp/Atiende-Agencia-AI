// D-P3-13/22 -- ajustes por cliente de la clasificacion contable: umbral de confianza (nunca menor que el piso de 0.5) y autoaceptado de los XML validos que sube el
// cliente desde su portal (encendido por omision). Solo admin escribe; la base repite la regla (CHECK del umbral y RLS de property_config).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, Input, Label, StatusBadge } from "@atiende/ui";
import { Info, SlidersHorizontal } from "lucide-react";
import { fetchAjustesClasificacion, guardarAjustesClasificacion } from "../lib/clasificacion-client.ts";
import type { AjustesClasificacion } from "../lib/clasificacion-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

/** "0,7" / "0.7" -> 0.7; `null` si no es un numero. */
export function leerUmbral(texto: string): number | null {
  const n = Number(texto.trim().replace(",", "."));
  return texto.trim() !== "" && Number.isFinite(n) ? n : null;
}

export function AjustesClasificacionCard({ apiBaseUrl, token, propertyId }: Props) {
  const [ajustes, setAjustes] = useState<AjustesClasificacion | null>(null);
  const [umbral, setUmbral] = useState("");
  const [autoaceptar, setAutoaceptar] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  async function cargar() {
    setErrorCarga(null);
    try {
      const a = await fetchAjustesClasificacion(fetch, apiBaseUrl, token, propertyId);
      setAjustes(a);
      setUmbral(String(a.umbralConfianza));
      setAutoaceptar(a.portalAutoaceptarValidos);
    } catch (err) {
      setErrorCarga(err instanceof Error ? err.message : "No se pudieron cargar los ajustes de clasificación.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token, propertyId]);

  const valor = leerUmbral(umbral);
  const piso = ajustes?.pisoConfianza ?? 0.5;
  const errorUmbral = valor === null ? "Escribe un número, por ejemplo 0.7." : valor < piso ? `No puede ser menor que el piso de confianza (${piso}).` : valor > 1 ? "No puede ser mayor que 1." : null;
  const disponible = ajustes?.estado === "disponible";

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (errorUmbral || valor === null) return;
    setGuardando(true);
    setGuardado(false);
    setError(null);
    try {
      const a = await guardarAjustesClasificacion(fetch, apiBaseUrl, token, propertyId, { umbralConfianza: valor, portalAutoaceptarValidos: autoaceptar });
      setAjustes(a);
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los ajustes.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
          Clasificación contable y portal del cliente
        </CardTitle>
        <CardDescription className="flex items-start gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            Un CFDI cuya categoría tiene menos confianza que el umbral (o un empate) va a la cola de revisión en vez de contabilizarse solo. El piso de confianza es fijo.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {errorCarga && <EstadoError mensaje={errorCarga} onReintentar={() => void cargar()} />}
        {!ajustes && !errorCarga && <EstadoCargando etiqueta="Cargando ajustes…" />}
        {ajustes && !disponible && (
          <p role="status" className="text-sm text-muted-foreground">
            Estos ajustes aún no están disponibles en este ambiente: falta aplicar la migración 026. Mientras tanto rige el umbral por omisión ({ajustes.umbralConfianza}).
          </p>
        )}
        {ajustes && disponible && (
          <form onSubmit={(e) => void guardar(e)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clasif-umbral" className="text-xs text-muted-foreground">
                Umbral de confianza (entre {piso} y 1)
              </Label>
              <Input
                id="clasif-umbral"
                type="text"
                inputMode="decimal"
                value={umbral}
                onChange={(e) => {
                  setUmbral(e.target.value);
                  setGuardado(false);
                }}
                aria-invalid={errorUmbral !== null}
                aria-describedby={errorUmbral ? "clasif-umbral-error" : undefined}
                className="h-9 w-28 text-sm"
              />
              {errorUmbral && (
                <p id="clasif-umbral-error" role="alert" className="text-xs text-destructive">
                  {errorUmbral}
                </p>
              )}
            </div>
            <Checkbox
              checked={autoaceptar}
              onChange={(e) => {
                setAutoaceptar(e.target.checked);
                setGuardado(false);
              }}
              label="Aceptar solos los XML válidos que sube el cliente desde su portal (emisor fuera de la lista 69-B, sin hallazgos y bien clasificado; todo queda en bitácora)"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={guardando || errorUmbral !== null}>
                {guardando ? "Guardando…" : "Guardar"}
              </Button>
              {guardado && <StatusBadge tone="success">Guardado</StatusBadge>}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
