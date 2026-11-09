// Celular de acceso del repartidor (docs/LOGIN-CHOFER-WHATSAPP.md): el encargado/admin lo registra aqui; con el entra el repartidor con un codigo
// por WhatsApp. Endpoints reales: PUT|DELETE .../admin/staff/miembros/:userId/telefono-acceso. El servidor decide quien puede; solo aplica a
// repartidores. Nunca se muestra el numero completo guardado (solo los ultimos 4 digitos).
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Input, notify, useT } from "@atiende/ui";
import { restaurantesStaff } from "@atiende/ui/i18n/restaurantes/staff";
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
  const t = useT(restaurantesStaff);
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
      setErrorCampo(t("restaurantes.staff.cel.invalido"));
      return;
    }
    setErrorCampo(null);
    setErrorAccion(null);
    setGuardando(true);
    try {
      await guardarTelefonoAcceso(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, repartidor.id, nacional);
      notify.success(t("restaurantes.staff.cel.guardado"));
      onCambio();
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : t("restaurantes.staff.cel.errorGuardar"));
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
      notify.success(t("restaurantes.staff.cel.quitado"));
      onCambio();
      onOpenChange(false);
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : t("restaurantes.staff.cel.errorQuitar"));
    } finally {
      setQuitando(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={repartidor ? t("restaurantes.staff.cel.tituloDe", { nombre: repartidor.fullName }) : t("restaurantes.staff.celularAcceso")}
      subtitulo={t("restaurantes.staff.cel.sub")}
      onGuardar={() => void guardar()}
      guardando={guardando}
      textoBotonGuardar={t(telefonoEnmascarado ? "restaurantes.staff.cel.cambiar" : "restaurantes.staff.cel.guardar")}
      bloquearCierre={guardando || quitando}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 md:w-auto md:flex-row">
          {telefonoEnmascarado && (
            <Button type="button" variant="danger-outline" onClick={() => void quitar()} loading={quitando} disabled={guardando}>
              {t("restaurantes.staff.cel.quitar")}
            </Button>
          )}
          <Button type="submit" loading={guardando} disabled={quitando}>
            {t(telefonoEnmascarado ? "restaurantes.staff.cel.cambiar" : "restaurantes.staff.cel.guardar")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        {errorAccion && <Callout tone="danger">{errorAccion}</Callout>}
        <p className="m-0 text-sm text-muted-foreground">{telefonoEnmascarado ? t("restaurantes.staff.cel.registrado", { telefono: telefonoEnmascarado }) : t("restaurantes.staff.cel.sinRegistro")}</p>
        <FormField label={t(telefonoEnmascarado ? "restaurantes.staff.cel.nuevo" : "restaurantes.staff.cel.celular")} hint={t("restaurantes.staff.cel.ayuda")}
 error={errorCampo ?? undefined} required>
          <Input type="tel" inputMode="tel" autoComplete="off" placeholder="999 123 4567" value={celular} onChange={(e) => setCelular(e.target.value)} />
        </FormField>
      </div>
    </FormDialog>
  );
}
