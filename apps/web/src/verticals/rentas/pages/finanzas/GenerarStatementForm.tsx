// Formulario "Generar statement" (solo admin_gestora): crea una versión nueva del statement de un propietario.
import { useState } from "react";
import type { FormEvent } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@atiende/ui";
import { generarOwnerStatement } from "../../lib/finanzas-client.ts";
import { LABEL_CLASES } from "./comunes.tsx";

export function GenerarStatementForm({
  apiBaseUrl,
  token,
  propertyId,
  ownerId,
  hayVersionPrevia,
  onGenerado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ownerId: string;
  hayVersionPrevia: boolean;
  onGenerado: (r: { creado: boolean; version: number }) => void;
}) {
  const [periodoInicio, setPeriodoInicio] = useState("");
  const [periodoFin, setPeriodoFin] = useState("");
  const [motivoVersion, setMotivoVersion] = useState("");
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!ownerId.trim()) return setError("Ingresa primero el id del propietario arriba.");
    if (!periodoInicio || !periodoFin) return setError("Periodo inicio y fin son requeridos.");
    if (hayVersionPrevia && !motivoVersion.trim()) return setError("Ya existe una versión previa para este propietario — el motivo de la nueva versión es obligatorio.");
    setGenerando(true);
    try {
      const resultado = await generarOwnerStatement(fetch, apiBaseUrl, token, propertyId, ownerId.trim(), {
        periodoInicio,
        periodoFin,
        motivoVersion: motivoVersion.trim() || undefined,
      });
      onGenerado(resultado);
      setMotivoVersion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el statement.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Generar statement</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Periodo inicio
              <Input type="date" value={periodoInicio} onChange={(e) => setPeriodoInicio(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Periodo fin
              <Input type="date" value={periodoFin} onChange={(e) => setPeriodoFin(e.target.value)} required />
            </Label>
          </div>
          <Label className={LABEL_CLASES}>
            Motivo de nueva versión {hayVersionPrevia ? "(obligatorio: ya existe al menos una versión)" : "(opcional — todavía no hay ninguna versión previa)"}
            <Input value={motivoVersion} onChange={(e) => setMotivoVersion(e.target.value)} placeholder="Corrección de gastos de limpieza reportados tarde" />
          </Label>
          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={generando} className="self-start">
            {generando ? "Generando…" : "Generar statement"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
