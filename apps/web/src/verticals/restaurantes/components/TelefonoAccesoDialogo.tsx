// Celular de acceso del repartidor (docs/LOGIN-CHOFER-WHATSAPP.md): el encargado/admin lo registra aqui; con el entra el repartidor con un codigo
// por WhatsApp. Endpoints reales: PUT|DELETE .../admin/staff/miembros/:userId/telefono-acceso. El servidor decide quien puede; solo aplica a
// repartidores. Nunca se muestra el numero completo guardado (solo los ultimos 4 digitos).
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Input, notify } from "@atiende/ui";
import { guardarTelefonoAcceso, normalizarCelular, quitarTelefonoAcceso } from "../lib/login-telefono-client.ts";

export function TelefonoAccesoDialogo({
  open,
  onOpenChange,
  repartidor,
  telefonoEnmascarado,
  apiBaseUrl,
  token,
  propertyId,
  onCambio,
  fetchImpl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly repartidor: { readonly id: string; readonly fullName: string } | null;
  /** "******1234" si ya tiene celular registrado; null si no. */
  readonly telefonoEnmascarado: string | null;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Tras guardar o quitar: la pagina recarga la lista de celulares. */
  readonly onCambio: () => void;
  readonly fetchImpl?: typeof fetch;
}) {
  const [celular, setCelular] = useState("");
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [quitando, setQuitando] = useState(false);
  useEffect(() => {
    if (open) {
      setCelular("");
      setErrorCampo(null);
      setErrorAccion(null);
    }
  }, [open]);

  async function guardar() {
    if (!repartidor) return;
    const nacional = normalizarCelular(celular);
    if (!nacional) {
      setErrorCampo("Escribe un celular mexicano de 10 dígitos.");
      return;
    }
    setErrorCampo(null);
    setErrorAccion(null);
    setGuardando(true);
    try {
      await guardarTelefonoAcceso(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidor.id, nacional);
      notify.success("Celular de acceso guardado.");
      onCambio();
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo guardar el celular.");
    } finally {
      setGuardando(false);
    }
  }

  async function quitar() {
    if (!repartidor) return;
    setQuitando(true);
    setErrorAccion(null);
    try {
      await quitarTelefonoAcceso(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidor.id);
      notify.success("Se quitó el acceso con celular.");
      onCambio();
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo quitar el celular.");
    } finally {
      setQuitando(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={repartidor ? `Celular de acceso de ${repartidor.fullName}` : "Celular de acceso"}
      subtitulo="Con este celular entra con un código de 6 dígitos que le llega por WhatsApp. Solo repartidores."
      onGuardar={() => void guardar()}
      guardando={guardando}
      textoBotonGuardar={telefonoEnmascarado ? "Cambiar celular" : "Guardar celular"}
      bloquearCierre={guardando || quitando}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 md:w-auto md:flex-row">
          {telefonoEnmascarado && (
            <Button type="button" variant="danger-outline" onClick={() => void quitar()} loading={quitando} disabled={guardando}>
              Quitar acceso con celular
            </Button>
          )}
          <Button type="submit" loading={guardando} disabled={quitando}>
            {telefonoEnmascarado ? "Cambiar celular" : "Guardar celular"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        {errorAccion && <Callout tone="danger">{errorAccion}</Callout>}
        <p className="m-0 text-sm text-muted-foreground">{telefonoEnmascarado ? `Celular registrado: ${telefonoEnmascarado}.` : "Todavía no tiene un celular registrado."}</p>
        <FormField label={telefonoEnmascarado ? "Nuevo celular" : "Celular"} hint="10 dígitos. Debe ser el WhatsApp del repartidor." error={errorCampo ?? undefined} required>
          <Input type="tel" inputMode="tel" autoComplete="off" placeholder="999 123 4567" value={celular} onChange={(e) => setCelular(e.target.value)} />
        </FormField>
      </div>
    </FormDialog>
  );
}
