// Dashboard de cierre mensual (Fase 9) — lista los períodos ya abiertos de esta
// property (GET .../cierre-mensual/periodos, cierre-mensual.ts) con su estatus y
// avance del checklist, y permite abrir un período nuevo (POST .../periodos, Fase
// 6). Antes de esta fase el motor completo de checklist/validaciones de
// balance/bloqueo de edición YA existía en @atiende/domain-despachos pero era
// alcanzable solo vía curl — este es el primer camino real del staff para operar el
// cierre de un mes. La landing real del panel (ver App.tsx: redirect de
// `/despachos/:orgSlug`), porque el cierre mensual es la tarea operativa más
// recurrente y de mayor riesgo de un despacho (bloquea la facturación del mes
// siguiente si no se corre a tiempo).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { crearPeriodo, fetchPeriodos } from "../lib/cierre-mensual-client.ts";
import type { ClosePeriod } from "../lib/cierre-mensual-client.ts";
import { formatDate, formatPeriodStatus, formatPeriodo } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);

// Mismos tres estatus con la misma carga semántica que las píldoras inline
// originales (azul = abierto, verde = cerrado, rojo = vencido), ahora sobre el
// `Badge` real de @atiende/ui. El verde usa la misma escala neutra de Tailwind
// que ya emplea StatCard para sus notas positivas (no hay token semántico de
// éxito en el preset).
const STATUS_BADGE: Record<ClosePeriod["status"], { variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  open: { variant: "secondary" },
  closed: { variant: "outline", className: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400" },
  overdue: { variant: "destructive" },
};

function StatusBadge({ status }: { status: ClosePeriod["status"] }) {
  const { variant, className } = STATUS_BADGE[status];
  return (
    <Badge variant={variant} className={className}>
      {formatPeriodStatus(status)}
    </Badge>
  );
}

const NOW = new Date();

export function CierreMensualPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const [periodos, setPeriodos] = useState<readonly ClosePeriod[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [anio, setAnio] = useState(String(NOW.getFullYear()));
  const [mes, setMes] = useState(String(NOW.getMonth() + 1));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPeriodos(await fetchPeriodos(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los períodos de cierre.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel -- este proyecto no tiene
    // eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  async function handleAbrir(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const anioNum = Number(anio);
    const mesNum = Number(mes);
    if (!Number.isInteger(anioNum) || anioNum < 2000) {
      setFormError("Año inválido.");
      return;
    }
    if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
      setFormError("Mes inválido (1-12).");
      return;
    }
    setSubmitting(true);
    try {
      await crearPeriodo(fetch, apiBaseUrl, token, propertyId, { anio: anioNum, mes: mesNum });
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo abrir el período.");
    } finally {
      setSubmitting(false);
    }
  }

  const ordenados = periodos ? [...periodos].sort((a, b) => (a.year !== b.year ? b.year - a.year : b.month - a.month)) : [];

  return (
    <div className="flex flex-col gap-4 px-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Cierre mensual</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Checklist de 15 tareas por período: CFDI, bancos, nómina, declaraciones, contabilidad electrónica y reportes.</p>
        </div>
        {GESTIONAR_ROLES.has(role) && (
          <Button variant={showForm ? "outline" : "default"} size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? <X /> : <CalendarPlus />}
            {showForm ? "Cancelar" : "Abrir período"}
          </Button>
        )}
      </header>

      {/* El formulario sigue siendo un panel inline plegable (no un overlay):
          son dos campos y el staff los llena mirando la tabla de períodos que
          tiene debajo. Solo cambia la piel (Card + Input/Label + Button). */}
      {showForm && (
        <Card className="max-w-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Abrir período</CardTitle>
            <CardDescription>Se crea el checklist completo del mes elegido.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAbrir} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cierre-anio">Año *</Label>
                <Input id="cierre-anio" type="number" min="2000" max="2100" value={anio} onChange={(e) => setAnio(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cierre-mes">Mes (1-12) *</Label>
                <Input id="cierre-mes" type="number" min="1" max="12" value={mes} onChange={(e) => setMes(e.target.value)} required />
              </div>
              {formError && (
                <p role="alert" className="text-destructive text-sm">
                  {formError}
                </p>
              )}
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Abriendo…" : "Abrir período"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !periodos && <EstadoCargando etiqueta="Cargando períodos de cierre…" />}

      {periodos && periodos.length === 0 && !loading && (
        <EstadoVacio mensaje="Todavía no hay ningún período de cierre abierto." />
      )}

      {ordenados.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Período</TableHead>
                  <TableHead>Estatus</TableHead>
                  <TableHead>Abierto</TableHead>
                  <TableHead>Cerrado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordenados.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link to={`/despachos/${orgSlug}/cierre-mensual/${p.id}`} className="font-semibold text-foreground hover:underline underline-offset-2">
                        {formatPeriodo(p.year, p.month)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(p.openedAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(p.closedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
