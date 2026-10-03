// D-30 -- dialogo de segundo factor para las acciones sensibles de despachos. Se monta UNA vez en `DespachosShell` y se
// registra como `StepUpPrompter` (../lib/step-up.ts). Pide el codigo de 6 digitos de la app de autenticacion (o un codigo
// de respaldo); un acierto emite el token de step-up (5 min, alcance `despachos_sensitive`) y la accion pendiente se ejecuta.
// Cancelar (boton, Esc o clic fuera) rechaza la solicitud: la accion NUNCA se ejecuta. Sin TOTP dado de alta no hay bypass:
// solo se informa y se enlaza al alta en Seguridad de la cuenta.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, FormField, Input } from "@atiende/ui";
import { StepUpCanceladoError, StepUpSinEnrolarError, registrarStepUpPrompter } from "../lib/step-up.ts";
import type { StepUpSolicitud } from "../lib/step-up.ts";
import { requestStepUpToken, secondFactorFromText } from "../lib/two-factor-client.ts";

interface Pendiente extends StepUpSolicitud {
  readonly resolve: (stepUpToken: string) => void;
  readonly reject: (err: Error) => void;
}

export function StepUpDialog({ orgSlug }: { readonly orgSlug: string }) {
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verificando, setVerificando] = useState(false);
  const ref = useRef<Pendiente | null>(null);
  ref.current = pendiente;

  useEffect(() => {
    registrarStepUpPrompter(
      (solicitud) =>
        new Promise<string>((resolve, reject) => {
          // Una sola verificacion a la vez: una segunda solicitud cancela la anterior.
          ref.current?.reject(new StepUpCanceladoError());
          setCodigo("");
          setError(null);
          setPendiente({ ...solicitud, resolve, reject });
        }),
    );
    return () => {
      registrarStepUpPrompter(null);
      ref.current?.reject(new StepUpCanceladoError());
    };
  }, []);

  function cerrar() {
    if (!pendiente) return;
    pendiente.reject(pendiente.enrolado ? new StepUpCanceladoError() : new StepUpSinEnrolarError());
    setPendiente(null);
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pendiente || !pendiente.enrolado) return;
    const factor = secondFactorFromText(codigo);
    if (!factor) {
      setError("Escribe el código de 6 dígitos de tu app (o un código de respaldo).");
      return;
    }
    setVerificando(true);
    setError(null);
    try {
      const stepUpToken = await requestStepUpToken(fetch, pendiente.apiBaseUrl, pendiente.token, factor);
      const p = pendiente;
      setPendiente(null);
      p.resolve(stepUpToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo verificar el código.");
    } finally {
      setVerificando(false);
    }
  }

  return (
    <Dialog open={pendiente !== null} onOpenChange={(open) => !open && cerrar()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Verifica tu identidad</DialogTitle>
          <DialogDescription>
            {pendiente?.enrolado === false
              ? "Esta acción exige verificación en dos pasos y tu cuenta todavía no la tiene activa."
              : "Esta acción es sensible. Escribe el código de 6 dígitos de tu app de autenticación."}
          </DialogDescription>
        </DialogHeader>
        {pendiente?.enrolado === false ? (
          <div className="flex flex-col gap-3">
            <p className="text-ui text-muted-foreground">
              Actívala en{" "}
              <Link to={`/despachos/${orgSlug}/seguridad`} className="underline underline-offset-2" onClick={cerrar}>
                Seguridad de la cuenta
              </Link>{" "}
              y vuelve a intentarlo.
            </p>
            <div className="flex justify-end">
              <Button type="button" size="xs" variant="outline" onClick={cerrar}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3" noValidate>
            <FormField label="Código de verificación">
              <Input id="despachos-stepup-codigo" inputMode="numeric" autoComplete="one-time-code" autoFocus value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
            </FormField>
            {error && (
              <p role="alert" className="text-ui text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" size="xs" variant="outline" onClick={cerrar} disabled={verificando}>
                Cancelar
              </Button>
              <Button type="submit" size="xs" loading={verificando} disabled={verificando}>
                Verificar
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
