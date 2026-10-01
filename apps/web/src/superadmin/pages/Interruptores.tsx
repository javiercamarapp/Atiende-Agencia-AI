// Interruptores de plataforma (kill switches): detener un agente LLM, un cron o todo el
// LLM / todos los crons, con motivo obligatorio. Backend real:
// apps/api/src/routes/superadmin-interruptores.ts (ver docs/SUPERADMIN_INTERRUPTORES.md).
// Un interruptor puede tardar hasta 10 s en aplicarse en TODAS las instancias del
// servidor (cache del guard); se avisa en pantalla, no se promete "al instante".
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Power } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, FormDialog, Label, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";

type Scope = "global" | "agente" | "cron";

interface Interruptor {
  readonly scope: Scope;
  readonly target: string;
  readonly bloqueado: boolean;
  readonly motivo: string;
  readonly actualizadoPor: string | null;
  readonly actualizadoEnMs: number;
}

interface Respuesta {
  readonly disponible: boolean;
  readonly catalogo: { readonly globales: readonly string[]; readonly agentes: readonly string[]; readonly crons: readonly string[] };
  readonly interruptores: readonly Interruptor[];
}

interface Cambio {
  readonly scope: Scope;
  readonly target: string;
  readonly bloquear: boolean;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

export function SuperAdminInterruptoresPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambio, setCambio] = useState<Cambio | null>(null);
  const [motivo, setMotivo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function cargar() {
    setError(null);
    try {
      setDatos(await fetchJson<Respuesta>(apiBaseUrl, token, "/superadmin/interruptores"));
    } catch {
      setError("No se pudieron cargar los interruptores.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  function abrir(c: Cambio) {
    setCambio(c);
    setMotivo("");
    setFormError(null);
  }

  async function aplicar(e: FormEvent) {
    e.preventDefault();
    if (!cambio) return;
    if (motivo.trim().length < 20) {
      setFormError("El motivo debe tener al menos 20 caracteres.");
      return;
    }
    setGuardando(true);
    setFormError(null);
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/interruptores", { method: "PUT", body: JSON.stringify({ scope: cambio.scope, target: cambio.target, bloqueado: cambio.bloquear, motivo }) });
      setCambio(null);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo aplicar el cambio.");
    } finally {
      setGuardando(false);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando interruptores…" />;

  const estadoDe = (scope: Scope, target: string) => datos.interruptores.find((i) => i.scope === scope && i.target === target);

  const fila = (scope: Scope, target: string, etiqueta: string) => {
    const i = estadoDe(scope, target);
    const bloqueado = i?.bloqueado === true;
    return (
      <TableRow key={`${scope}:${target}`}>
        <TableCell className="font-mono text-xs">{etiqueta}</TableCell>
        <TableCell>{bloqueado ? <StatusBadge tone="danger">Detenido</StatusBadge> : <StatusBadge tone="success">Activo</StatusBadge>}</TableCell>
        <TableCell className="max-w-[320px] truncate text-muted-foreground" title={i?.motivo ?? ""}>
          {i ? i.motivo : "—"}
        </TableCell>
        <TableCell>
          <Button variant={bloqueado ? "default" : "outline"} size="sm" className="gap-1.5" onClick={() => abrir({ scope, target, bloquear: !bloqueado })}>
            <Power className="w-3.5 h-3.5" strokeWidth={1.75} />
            {bloqueado ? "Reactivar" : "Detener"}
          </Button>
        </TableCell>
      </TableRow>
    );
  };

  const tabla = (titulo: string, filas: ReactNode) => (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Clave</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Último motivo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>{filas}</TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div>
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Power className="w-5 h-5" strokeWidth={1.75} />
          Interruptores de plataforma
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Detén un agente de WhatsApp, un cron o todo el LLM ante un incidente. Cada cambio exige motivo, pide tu código MFA y queda en la bitácora. Puede tardar hasta 10 segundos en aplicarse en todas las instancias del servidor.
        </p>
      </div>

      {!datos.disponible && (
        <p role="alert" className="text-sm text-muted-foreground">
          Los interruptores todavía no están disponibles en esta base (migración 0025 pendiente de aplicar). Nada está detenido.
        </p>
      )}

      {datos.disponible && (
        <>
          {tabla(
            "Globales",
            datos.catalogo.globales.map((t) => fila("global", t, t === "llm" ? "Todo el LLM (todos los agentes)" : "Todos los crons")),
          )}
          {tabla(
            "Agentes",
            datos.catalogo.agentes.map((t) => fila("agente", t, t)),
          )}
          {tabla(
            "Crons",
            datos.catalogo.crons.map((t) => fila("cron", t, t)),
          )}
        </>
      )}

      <FormDialog
        open={cambio !== null}
        onOpenChange={(open) => !open && setCambio(null)}
        titulo={cambio?.bloquear ? "Detener" : "Reactivar"}
        subtitulo={cambio ? `${cambio.scope}: ${cambio.target}` : undefined}
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setCambio(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-interruptor" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Aplicando…" : cambio?.bloquear ? "Detener" : "Reactivar"}
            </Button>
          </>
        }
      >
        <form id="form-interruptor" onSubmit={aplicar} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interruptor-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <Textarea
              id="interruptor-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              placeholder="Ej. El proveedor de WhatsApp reporta caída; se detiene el dispatcher hasta confirmar."
              required
            />
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      </FormDialog>
    </PageContainer>
  );
}

