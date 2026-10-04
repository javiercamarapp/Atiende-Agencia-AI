// Diálogo "Generar statement" (solo admin_gestora): crea una versión nueva del statement de un propietario. Una versión no se
// borra ni se edita (solo se versiona), así que el envío pasa por una confirmación de dos pasos: cancelar nunca llama al servidor.
import { useState } from "react";
import { FormField, Input, useConfirm } from "@atiende/ui";
import { generarOwnerStatement } from "../../lib/finanzas-client.ts";
import { DialogoFinanzas } from "./comunes.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly hayVersionPrevia: boolean;
  readonly onCerrar: () => void;
  readonly onGenerado: (r: { creado: boolean; version: number }) => void;
}

export function GenerarStatementForm({ apiBaseUrl, token, propertyId, ownerId, hayVersionPrevia, onCerrar, onGenerado }: Props) {
  const { confirmar, dialogo } = useConfirm();
  const [periodoInicio, setPeriodoInicio] = useState("");
  const [periodoFin, setPeriodoFin] = useState("");
  const [motivoVersion, setMotivoVersion] = useState("");
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    setError(null);
    if (!ownerId.trim()) return setError("Ingresa primero el id del propietario en la sección de statements.");
    if (!periodoInicio || !periodoFin) return setError("Periodo inicio y fin son requeridos.");
    if (hayVersionPrevia && !motivoVersion.trim()) return setError("Ya existe una versión previa para este propietario — el motivo de la nueva versión es obligatorio.");
    const acepto = await confirmar({
      titulo: hayVersionPrevia ? "Generar una nueva versión del statement" : "Generar el statement del propietario",
      descripcion: "La versión queda guardada y visible para el propietario en su portal; no se edita ni se borra, solo se corrige con una versión nueva.",
      confirmar: "Generar statement",
      cancelar: "Cancelar",
    });
    if (!acepto) return;
    setGenerando(true);
    try {
      const resultado = await generarOwnerStatement(fetch, apiBaseUrl, token, propertyId, ownerId.trim(), {
        periodoInicio,
        periodoFin,
        motivoVersion: motivoVersion.trim() || undefined,
      });
      onGenerado(resultado);
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el statement.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <>
      <DialogoFinanzas
        titulo="Generar statement"
        subtitulo={ownerId.trim() ? `Propietario ${ownerId.trim()}` : "Falta el id del propietario en la sección de statements."}
        textoGuardar="Generar statement"
        guardando={generando}
        error={error}
        onCerrar={onCerrar}
        onEnviar={() => void enviar()}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Periodo inicio" required>
            <Input type="date" value={periodoInicio} onChange={(e) => setPeriodoInicio(e.target.value)} />
          </FormField>
          <FormField label="Periodo fin" required>
            <Input type="date" value={periodoFin} onChange={(e) => setPeriodoFin(e.target.value)} />
          </FormField>
        </div>
        <FormField
          label="Motivo de nueva versión"
          required={hayVersionPrevia}
          hint={hayVersionPrevia ? "Obligatorio: ya existe al menos una versión." : "Opcional: todavía no hay ninguna versión previa."}
        >
          <Input value={motivoVersion} onChange={(e) => setMotivoVersion(e.target.value)} placeholder="Corrección de gastos de limpieza reportados tarde" />
        </FormField>
      </DialogoFinanzas>
      {dialogo}
    </>
  );
}
