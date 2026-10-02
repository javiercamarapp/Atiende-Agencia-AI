// Gasto de IA por organizacion y rol (CHAT-07) y tope diario de turnos por rol. Backend real:
//   GET /superadmin/gasto-api/por-rol                          (costo REAL de core.llm_usage_daily, agrupado por organizacion/rol/mes)
//   GET/PUT /superadmin/gasto-api/organizaciones/:id/topes-rol (tope diario de turnos por rol; defaults del sistema y topes propios)
// Las tres rutas exigen step-up con factor MFA activo (fetchConStepUp pide el codigo y reintenta). Cada bloque maneja cargando, error,
// "no disponible aun" (base sin la migracion 0046) y vacio de verdad; nunca muestra cifras inventadas.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { fetchJson } from "../lib/fetch-json.ts";

interface FilaPorRol {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: string;
  readonly month: string;
  readonly costMicroUsd: number;
  readonly callCount: number;
  readonly fallbackCallCount: number;
}

interface RespuestaPorRol {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly filas: readonly FilaPorRol[];
}

interface RespuestaTopes {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly defaults: readonly { readonly role: string; readonly maxTurnosDia: number }[];
  readonly propios: readonly { readonly role: string; readonly maxTurnosDia: number; readonly turnosHoy: number }[];
}

export interface OrganizacionOpcion {
  readonly organizationId: string;
  readonly organizationName: string;
}

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("es-MX", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function FilaTope({ role, porDefecto, propio, turnosHoy, onGuardar }: { readonly role: string; readonly porDefecto: number; readonly propio: number | undefined; readonly turnosHoy: number | undefined; readonly onGuardar: (role: string, valor: number) => Promise<void> }) {
  const [valor, setValor] = useState(String(propio ?? porDefecto));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValor(String(propio ?? porDefecto)), [propio, porDefecto]);

  async function guardar() {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) {
      setError("Entero entre 1 y 100000.");
      return;
    }
    setError(null);
    setGuardando(true);
    try {
      await onGuardar(role, n);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">{role}</TableCell>
      <TableCell className="text-muted-foreground">{porDefecto}</TableCell>
      <TableCell>{turnosHoy ?? 0}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Label htmlFor={`tope-rol-${role}`} className="sr-only">
            Tope diario de {role}
          </Label>
          <Input id={`tope-rol-${role}`} type="number" min="1" max="100000" step="1" value={valor} onChange={(e) => setValor(e.target.value)} className="h-8 w-[110px]" />
          <Button type="button" variant="outline" size="sm" disabled={guardando || Number(valor) === (propio ?? porDefecto)} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : "Guardar"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive mt-1">
            {error}
          </p>
        )}
        <span className="block text-xs text-muted-foreground mt-1">{propio === undefined ? "Usa el tope por defecto" : "Tope propio de la organización"}</span>
      </TableCell>
    </TableRow>
  );
}

export function GastoApiPorRol({ apiBaseUrl, token, from, to, organizaciones }: { readonly apiBaseUrl: string; readonly token: string; readonly from: string; readonly to: string; readonly organizaciones: readonly OrganizacionOpcion[] }) {
  const [porRol, setPorRol] = useState<RespuestaPorRol | null>(null);
  const [errorPorRol, setErrorPorRol] = useState<string | null>(null);
  const [orgId, setOrgId] = useState("");
  const [topes, setTopes] = useState<RespuestaTopes | null>(null);
  const [cargandoTopes, setCargandoTopes] = useState(false);
  const [errorTopes, setErrorTopes] = useState<string | null>(null);

  const cargarPorRol = useCallback(async () => {
    setErrorPorRol(null);
    setPorRol(null);
    try {
      setPorRol(await fetchJson<RespuestaPorRol>(apiBaseUrl, token, `/superadmin/gasto-api/por-rol?from=${from}&to=${to}`));
    } catch (err) {
      setErrorPorRol(err instanceof Error ? err.message : "No se pudo cargar el gasto por rol.");
    }
  }, [apiBaseUrl, token, from, to]);

  const cargarTopes = useCallback(async () => {
    if (!orgId) return;
    setErrorTopes(null);
    setCargandoTopes(true);
    try {
      setTopes(await fetchJson<RespuestaTopes>(apiBaseUrl, token, `/superadmin/gasto-api/organizaciones/${orgId}/topes-rol`));
    } catch (err) {
      setTopes(null);
      setErrorTopes(err instanceof Error ? err.message : "No se pudieron cargar los topes.");
    } finally {
      setCargandoTopes(false);
    }
  }, [apiBaseUrl, token, orgId]);

  useEffect(() => {
    void cargarPorRol();
  }, [cargarPorRol]);

  useEffect(() => {
    setTopes(null);
    void cargarTopes();
  }, [cargarTopes]);

  async function guardarTope(role: string, maxTurnosDia: number) {
    await fetchJson(apiBaseUrl, token, `/superadmin/gasto-api/organizaciones/${orgId}/topes-rol`, { method: "PUT", body: JSON.stringify({ role, maxTurnosDia }) });
    await cargarTopes();
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Gasto por organización y rol (por mes)</CardTitle>
        </CardHeader>
        <CardContent>
          {errorPorRol ? (
            <EstadoError mensaje={errorPorRol} onReintentar={() => void cargarPorRol()} />
          ) : !porRol ? (
            <EstadoCargando etiqueta="Cargando gasto por rol…" />
          ) : !porRol.disponible ? (
            <EstadoVacio mensaje={`No disponible aún: ${porRol.mensaje ?? "requiere la migración 0046."}`} />
          ) : porRol.filas.length === 0 ? (
            <EstadoVacio mensaje="Sin llamadas al LLM registradas en este rango de fechas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mes</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Costo</TableHead>
                    <TableHead>Llamadas</TableHead>
                    <TableHead>Con respaldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {porRol.filas.map((f) => (
                    <TableRow key={`${f.month}|${f.organizationId}|${f.role}`}>
                      <TableCell>{f.month}</TableCell>
                      <TableCell className="font-medium text-foreground">{f.organizationName}</TableCell>
                      <TableCell className="text-muted-foreground">{f.role}</TableCell>
                      <TableCell className="font-medium text-foreground">{usd(f.costMicroUsd)}</TableCell>
                      <TableCell>{f.callCount}</TableCell>
                      <TableCell>{f.callCount > 0 ? `${((f.fallbackCallCount / f.callCount) * 100).toFixed(1)}%` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tope diario de turnos por rol</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Un turno es una llamada al modelo. Al agotarse el tope de un rol, el Copiloto responde en modo sin IA con las consultas directas.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 max-w-sm">
            <Label htmlFor="topes-rol-organizacion" className="text-xs">
              Organización
            </Label>
            <NativeSelect id="topes-rol-organizacion" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">Elige una organización…</option>
              {organizaciones.map((o) => (
                <option key={o.organizationId} value={o.organizationId}>
                  {o.organizationName}
                </option>
              ))}
            </NativeSelect>
          </div>
          {!orgId ? (
            <EstadoVacio mensaje="Elige una organización para ver y ajustar sus topes diarios por rol." />
          ) : errorTopes ? (
            <EstadoError mensaje={errorTopes} onReintentar={() => void cargarTopes()} />
          ) : cargandoTopes && !topes ? (
            <EstadoCargando etiqueta="Cargando topes…" />
          ) : topes && !topes.disponible ? (
            <EstadoVacio mensaje={`No disponible aún: ${topes.mensaje ?? "requiere la migración 0046."}`} />
          ) : topes ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rol</TableHead>
                    <TableHead>Por defecto</TableHead>
                    <TableHead>Turnos hoy</TableHead>
                    <TableHead>Tope diario</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topes.defaults.map((d) => {
                    const propio = topes.propios.find((p) => p.role === d.role);
                    return <FilaTope key={d.role} role={d.role} porDefecto={d.maxTurnosDia} propio={propio?.maxTurnosDia} turnosHoy={propio?.turnosHoy} onGuardar={guardarTope} />;
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
