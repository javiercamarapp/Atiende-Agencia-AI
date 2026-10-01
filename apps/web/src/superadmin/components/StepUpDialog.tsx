// Dialogo de step-up MFA: se monta UNA vez en el shell del superadmin y se registra
// como `StepUpPrompter` (ver ../lib/stepup.ts). Pide el codigo de 6 digitos de la app
// autenticadora; un acierto emite el token de step-up (5 min) y reintenta la accion.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label } from "@atiende/ui";
import { registrarStepUpPrompter, verificarMfa } from "../lib/stepup.ts";

interface Pendiente {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export function StepUpDialog() {
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enrolar, setEnrolar] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const ref = useRef<Pendiente | null>(null);
  ref.current = pendiente;

  useEffect(() => {
    registrarStepUpPrompter(
      ({ apiBaseUrl, accessToken }) =>
        new Promise<void>((resolve, reject) => {
          // Una sola verificacion a la vez: una segunda peticion cancela la anterior.
          ref.current?.reject(new Error("reemplazado"));
          setCodigo("");
          setError(null);
          setEnrolar(false);
          setPendiente({ apiBaseUrl, accessToken, resolve, reject });
        }),
    );
    return () => registrarStepUpPrompter(null);
  }, []);

  function cerrar() {
    pendiente?.reject(new Error("cancelado"));
    setPendiente(null);
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pendiente) return;
    if (!/^\d{6}$/u.test(codigo.replace(/\s+/gu, ""))) {
      setError("El código tiene 6 dígitos.");
      return;
    }
    setVerificando(true);
    setError(null);
    try {
      const r = await verificarMfa(pendiente.apiBaseUrl, pendiente.accessToken, codigo.replace(/\s+/gu, ""));
      if (r.ok) {
        const p = pendiente;
        setPendiente(null);
        p.resolve();
        return;
      }
      if (r.code === "conflict" || r.code === "mfa_enrollment_required") setEnrolar(true);
      setError(r.message ?? "No se pudo verificar el código.");
    } finally {
      setVerificando(false);
    }
  }

  return (
    <Dialog open={pendiente !== null} onOpenChange={(open) => !open && cerrar()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Verifica tu identidad</DialogTitle>
          <DialogDescription>Esta acción es sensible. Escribe el código de 6 dígitos de tu app autenticadora.</DialogDescription>
        </DialogHeader>
        <form onSubmit={enviar} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stepup-codigo">Código MFA</Label>
            <Input id="stepup-codigo" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7} value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {enrolar && (
            <p className="text-sm text-muted-foreground">
              ¿Aún no enrolas tu autenticador? <Link to="/superadmin/seguridad" className="underline" onClick={cerrar}>Ve a Seguridad (MFA)</Link>.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={cerrar} disabled={verificando}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full px-6" disabled={verificando}>
              {verificando ? "Verificando…" : "Verificar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
