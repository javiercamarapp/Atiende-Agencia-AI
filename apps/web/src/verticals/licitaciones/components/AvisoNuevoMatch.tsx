// Umbral del aviso de "nuevo match" por organizacion (paridad3 L-P3-09). Mismo patron visual que la tarjeta de zona horaria de
// Staff (Card + Label + Input + Button): lo guarda `PATCH .../admin/tenant-config` (solo owner/admin; el servidor es el enforcement
// real) y el cron de descubrimiento lo lee. Vacio = solo las convocatorias elegibles. Sin datos inventados: el valor viene del
// servidor y, si guardar falla, se muestra el error con el motivo.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, Input, Label } from "@atiende/ui";
import { updateTenantConfigNewMatchMinScore } from "../lib/admin-client.ts";

export interface AvisoNuevoMatchProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly orgSlug: string;
  /** La configuracion de la organizacion ya se leyo (la carga la pagina que lo contiene, una sola lectura). */
  readonly cargado: boolean;
  /** La lectura de la configuracion fallo: el motivo y el reintento los muestra la tarjeta de zona horaria (misma lectura); aqui no se pinta un formulario con un valor inventado. */
  readonly error: string | null;
  /** Umbral guardado: entero 0-100, o `null` = solo elegibles. */
  readonly valor: number | null;
}

/** Texto -> umbral. Vacio = `null` (solo elegibles). Lanza con el motivo si no es un entero de 0 a 100. */
export function parsearUmbral(texto: string): number | null {
  const t = texto.trim();
  if (t.length === 0) return null;
  if (!/^\d{1,3}$/.test(t)) throw new Error("El umbral debe ser un número entero de 0 a 100, o dejarse vacío.");
  const n = Number(t);
  if (n < 0 || n > 100) throw new Error("El umbral debe estar entre 0 y 100.");
  return n;
}

export function AvisoNuevoMatch({ apiBaseUrl, token, orgSlug, cargado, error, valor }: AvisoNuevoMatchProps) {
  const [guardado, setGuardado] = useState<number | null>(valor);
  const [texto, setTexto] = useState(valor === null ? "" : String(valor));
  const [guardando, setGuardando] = useState(false);
  const [falla, setFalla] = useState<string | null>(null);
  const [guardadoEn, setGuardadoEn] = useState<number | null>(null);

  useEffect(() => {
    setGuardado(valor);
    setTexto(valor === null ? "" : String(valor));
  }, [valor]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setFalla(null);
    setGuardadoEn(null);
    let umbral: number | null;
    try {
      umbral = parsearUmbral(texto);
    } catch (err) {
      setFalla(err instanceof Error ? err.message : "Umbral inválido.");
      return;
    }
    setGuardando(true);
    try {
      const actualizado = await updateTenantConfigNewMatchMinScore(fetch, apiBaseUrl, token, orgSlug, umbral);
      setGuardado(actualizado.newMatchMinScore);
      setTexto(actualizado.newMatchMinScore === null ? "" : String(actualizado.newMatchMinScore));
      setGuardadoEn(Date.now());
    } catch (err) {
      setFalla(err instanceof Error ? err.message : "No se pudo guardar el umbral.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Aviso de convocatorias nuevas con match</CardTitle>
        <CardDescription>
          Cada día el descubrimiento automático compara las convocatorias nuevas con el perfil de tu empresa. Sin umbral, avisa solo las que cumplen todos tus requisitos (elegibles); con un umbral, avisa las que
          alcanzan esa puntuación (0 a 100) sin incumplir un requisito. Nunca avisa convocatorias sin plazo o con el plazo vencido.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-muted-foreground">No se pudo leer la configuración de la empresa. Usa «Reintentar» en la tarjeta de zona horaria para volver a cargarla.</p>}
        {!cargado && !error && <EstadoCargando lineas={1} etiqueta="Cargando umbral…" />}
        {cargado && !error && (
          <form onSubmit={guardar} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
              <Label htmlFor="tenant-new-match-min-score">Puntuación mínima (0 a 100)</Label>
              <Input id="tenant-new-match-min-score" type="text" inputMode="numeric" placeholder="Vacío: solo convocatorias elegibles" value={texto} onChange={(e) => setTexto(e.target.value)} />
              <p className="text-xs text-muted-foreground">{guardado === null ? "Sin umbral: solo se avisan las convocatorias elegibles." : `Umbral guardado: ${guardado}.`} Deja el campo vacío y guarda para volver a solo elegibles.</p>
            </div>
            <Button type="submit" size="sm" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar"}
            </Button>
          </form>
        )}
        {falla && <p role="alert" className="text-sm text-destructive">{falla}</p>}
        {guardadoEn !== null && !falla && <p className="text-xs text-muted-foreground">Guardado.</p>}
      </CardContent>
    </Card>
  );
}
