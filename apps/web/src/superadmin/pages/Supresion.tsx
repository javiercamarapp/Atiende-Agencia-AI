// Lista de supresion de plataforma (SA-L-46): conteos por motivo y origen (SIN valores ni hashes) y
// "Agregar no contactar" (step-up MFA). Backend real: apps/api/src/routes/superadmin-supresion.ts
// (ver docs/SUPRESION.md). Base sin migrar: aviso honesto y sin controles que no funcionarian.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BellOff } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, PageContainer, PageHeader, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";

interface Conteo {
  readonly clave: string;
  readonly total: number;
}

interface Grupo {
  readonly tipo: "telefono" | "correo";
  readonly motivo: string;
  readonly origen: string;
  readonly total: number;
  readonly ultimoEnMs: number | null;
}

interface Respuesta {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly total: number;
  readonly porMotivo: readonly Conteo[];
  readonly porOrigen: readonly Conteo[];
  readonly grupos: readonly Grupo[];
}

export const MOTIVO_ETIQUETA: Readonly<Record<string, string>> = {
  baja: "Baja (BAJA / STOP)",
  queja: "Queja",
  rebote: "Rebote",
  solicitud_arco: "Solicitud ARCO",
  no_contactar: "No contactar (manual)",
};

async function llamar<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
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

function fecha(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

export function SuperAdminSupresionPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<"telefono" | "correo">("telefono");
  const [valor, setValor] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setDatos(await llamar<Respuesta>(apiBaseUrl, token, "/superadmin/supresion"));
    } catch {
      setError("No se pudo cargar la lista de supresión.");
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function abrirDialogo() {
    setTipo("telefono");
    setValor("");
    setFormError(null);
    setAbierto(true);
  }

  async function agregar(e: FormEvent) {
    e.preventDefault();
    if (valor.trim() === "") {
      setFormError("Escribe el teléfono o el correo.");
      return;
    }
    setGuardando(true);
    setFormError(null);
    try {
      const r = await llamar<{ registrada: boolean; yaExistia: boolean }>(apiBaseUrl, token, "/superadmin/supresion/no-contactar", { method: "POST", body: JSON.stringify({ tipo, valor }) });
      setAbierto(false);
      setValor("");
      setAviso(r.registrada ? "Contacto agregado: ya no recibirá avisos proactivos de ninguna vertical." : "Ese contacto ya estaba en la lista de no contactar.");
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo agregar el contacto.");
    } finally {
      setGuardando(false);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Cargando supresión…" />;

  return (
    <PageContainer>
      <PageHeader
        titulo="Supresión de contactos"
        descripcion="Contactos que no deben recibir recordatorios ni avisos proactivos de ninguna vertical. Siguen recibiendo solo las confirmaciones de lo que ellos mismos piden (su cita, reserva o pedido). Solo se guardan huellas (hash), nunca el teléfono ni el correo; aquí ves conteos, no valores."
        acciones={
          datos.disponible ? (
            <Button className="rounded-full gap-1.5" onClick={abrirDialogo}>
              <BellOff className="w-4 h-4" strokeWidth={1.75} />
              Agregar no contactar
            </Button>
          ) : undefined
        }
      />

      {!datos.disponible && (
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          {datos.mensaje ?? "Falta aplicar la migración 0042_supresion_contacto_plataforma."} Mientras tanto los avisos siguen enviándose como antes.
        </Callout>
      )}
      {aviso && (
        <Callout tone="success" titulo="Listo" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}

      {datos.disponible && (
        <>
          <StatCard icon={BellOff} label="Contactos suprimidos" value={String(datos.total)} />
          {datos.grupos.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay contactos suprimidos." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Por motivo</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Motivo</TableHead>
                        <TableHead className="text-right">Contactos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.porMotivo.map((m) => (
                        <TableRow key={m.clave}>
                          <TableCell>{MOTIVO_ETIQUETA[m.clave] ?? m.clave}</TableCell>
                          <TableCell className="text-right">{m.total}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Por origen</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Origen</TableHead>
                        <TableHead className="text-right">Contactos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.porOrigen.map((o) => (
                        <TableRow key={o.clave}>
                          <TableCell className="font-mono text-xs">{o.clave}</TableCell>
                          <TableCell className="text-right">{o.total}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle>Detalle</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Motivo</TableHead>
                          <TableHead>Origen</TableHead>
                          <TableHead className="text-right">Contactos</TableHead>
                          <TableHead>Último</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {datos.grupos.map((g) => (
                          <TableRow key={`${g.tipo}:${g.motivo}:${g.origen}`}>
                            <TableCell>{g.tipo === "telefono" ? "Teléfono" : "Correo"}</TableCell>
                            <TableCell>{MOTIVO_ETIQUETA[g.motivo] ?? g.motivo}</TableCell>
                            <TableCell className="font-mono text-xs">{g.origen}</TableCell>
                            <TableCell className="text-right">{g.total}</TableCell>
                            <TableCell>{fecha(g.ultimoEnMs)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      <FormDialog
        open={abierto}
        onOpenChange={(open) => !open && setAbierto(false)}
        titulo="Agregar no contactar"
        subtitulo="Pide tu código MFA. El valor se convierte en huella y no se guarda."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAbierto(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-no-contactar" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Agregando…" : "Agregar"}
            </Button>
          </>
        }
      >
        <form id="form-no-contactar" onSubmit={agregar} className="flex flex-col gap-3">
          <FormField label="Tipo">
            <NativeSelect id="no-contactar-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as "telefono" | "correo")}>
              <option value="telefono">Teléfono</option>
              <option value="correo">Correo</option>
            </NativeSelect>
          </FormField>
          <FormField label={tipo === "telefono" ? "Teléfono (10 dígitos o internacional)" : "Correo"} required>
            <Input id="no-contactar-valor" value={valor} onChange={(e) => setValor(e.target.value)} inputMode={tipo === "telefono" ? "tel" : "email"} autoComplete="off" placeholder={tipo === "telefono" ? "55 1234 5678" : "persona@ejemplo.com"} />
          </FormField>
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
