// Sección 2 de Finanzas: owner statements (listar, ver detalle, invitar al portal; generar solo admin_gestora).
import { useState } from "react";
import { FileSpreadsheet, Mail, Search } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { centavosAPesos, fetchOwnerStatementDetalle, fetchOwnerStatements, invitarPropietarioAlPortal } from "../../lib/finanzas-client.ts";
import type { LineaOwnerStatement, OwnerStatementDetalle, OwnerStatementSummary, PortalInviteEmitida } from "../../lib/finanzas-client.ts";
import { LABEL_CLASES, Linea, NOTA_CLASES, TIPO_LINEA_LABELS } from "./comunes.tsx";
import type { SectionProps } from "./comunes.tsx";
import { GenerarStatementForm } from "./GenerarStatementForm.tsx";

export function OwnerStatementsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [ownerId, setOwnerId] = useState("");
  const [statements, setStatements] = useState<readonly OwnerStatementSummary[] | null>(null);
  const [detalle, setDetalle] = useState<OwnerStatementDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResultado, setUltimoResultado] = useState<string | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [invite, setInvite] = useState<PortalInviteEmitida | null>(null);
  const [errorInvite, setErrorInvite] = useState<string | null>(null);

  async function invitarPropietario() {
    if (!ownerId.trim()) return setErrorInvite("Ingresa primero el id del propietario arriba.");
    setErrorInvite(null);
    setInvite(null);
    setInvitando(true);
    try {
      const resultado = await invitarPropietarioAlPortal(fetch, apiBaseUrl, token, propertyId, ownerId.trim());
      setInvite(resultado);
    } catch (err) {
      setErrorInvite(err instanceof Error ? err.message : "No se pudo invitar a este propietario.");
    } finally {
      setInvitando(false);
    }
  }

  async function cargarStatements(idOwner: string) {
    if (!idOwner.trim()) return setError("Se necesita el id del propietario.");
    setError(null);
    setCargando(true);
    setDetalle(null);
    try {
      const list = await fetchOwnerStatements(fetch, apiBaseUrl, token, propertyId, idOwner.trim());
      setStatements(list);
    } catch (err) {
      setStatements(null);
      setError(err instanceof Error ? err.message : "No se pudieron cargar los statements de este propietario.");
    } finally {
      setCargando(false);
    }
  }

  async function verDetalle(statementId: string) {
    setError(null);
    try {
      const d = await fetchOwnerStatementDetalle(fetch, apiBaseUrl, token, propertyId, statementId);
      setDetalle(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle del statement.");
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-semibold">Owner statements</CardTitle>
        <CardDescription className="text-xs">
          No hay un catálogo de propietarios en el backend todavía — ingresa el id del propietario (mismo que usa el portal del propietario).
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap items-end">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Id del propietario (ownerId)
            <Input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="uuid del propietario" />
          </Label>
          <Button type="button" variant="outline" size="sm" onClick={() => cargarStatements(ownerId)} disabled={cargando}>
            <Search className="w-4 h-4" strokeWidth={1.75} />
            {cargando ? "Consultando…" : "Ver statements"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={invitarPropietario} disabled={invitando}>
            <Mail className="w-4 h-4" strokeWidth={1.75} />
            {invitando ? "Invitando…" : "Invitar a este propietario"}
          </Button>
        </div>

        {errorInvite && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {errorInvite}
          </p>
        )}
        {invite && (
          <p className={NOTA_CLASES}>
            Invitación creada (vence {invite.expiresAt}). Comparte este token con el propietario para que active su cuenta en el portal:{" "}
            <code className="select-all rounded bg-background px-1 py-0.5 font-mono">{invite.inviteToken}</code>
          </p>
        )}

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}

        {statements && statements.length === 0 && (
          <EstadoVacio icon={FileSpreadsheet} titulo="Sin statements" mensaje="Este propietario no tiene ningún statement generado todavía." />
        )}

        {statements && statements.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-9 px-2">Periodo</TableHead>
                <TableHead className="h-9 px-2">Versión</TableHead>
                <TableHead className="h-9 px-2 text-right">Neto</TableHead>
                <TableHead className="h-9 px-2">Generado</TableHead>
                <TableHead className="h-9 px-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="p-2">
                    {s.periodo.inicio} → {s.periodo.fin}
                  </TableCell>
                  <TableCell className="p-2">v{s.version}</TableCell>
                  <TableCell className="p-2 text-right tabular-nums">
                    {centavosAPesos(s.netoCentavos)} {s.moneda}
                  </TableCell>
                  <TableCell className="p-2 text-muted-foreground">{s.generadoEn}</TableCell>
                  <TableCell className="p-2">
                    <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => verDetalle(s.id)}>
                      Ver detalle
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {detalle && (
          <div className="border-t border-border pt-2.5 flex flex-col gap-2">
            <p className="m-0 text-sm font-semibold text-foreground">
              Statement v{detalle.version} — {detalle.periodo.inicio} → {detalle.periodo.fin}
            </p>
            {detalle.motivoVersion && <p className="m-0 text-xs text-muted-foreground">Motivo de esta versión: {detalle.motivoVersion}</p>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Tipo</TableHead>
                  <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detalle.lineas.map((l: LineaOwnerStatement, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="p-2 text-xs">{l.ocupacionId}</TableCell>
                    <TableCell className="p-2 text-xs">{TIPO_LINEA_LABELS[l.tipo] ?? l.tipo}</TableCell>
                    <TableCell className="p-2 text-xs text-right tabular-nums">
                      {centavosAPesos(l.montoCentavos)} {detalle.moneda}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-col gap-0.5 text-sm">
              <Linea label="Ingresos brutos" valorCentavos={detalle.totales.ingresosBrutosCentavos} moneda={detalle.moneda} />
              <Linea label="Comisión de canal" valorCentavos={-detalle.totales.comisionCanalCentavos} moneda={detalle.moneda} />
              <Linea label="Comisión de gestor" valorCentavos={-detalle.totales.comisionGestorCentavos} moneda={detalle.moneda} />
              <Linea label="Gastos" valorCentavos={-detalle.totales.gastosCentavos} moneda={detalle.moneda} />
              <Linea label="Impuestos" valorCentavos={-detalle.totales.impuestosCentavos} moneda={detalle.moneda} />
              <Linea label="Neto" valorCentavos={detalle.totales.netoCentavos} moneda={detalle.moneda} fuerte />
            </div>
          </div>
        )}

        {puedeEscribir && (
          <GenerarStatementForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            ownerId={ownerId}
            hayVersionPrevia={(statements?.length ?? 0) > 0}
            onGenerado={(resultado) => {
              setUltimoResultado(
                resultado.creado
                  ? `Statement nuevo creado: versión ${resultado.version}.`
                  : `Sin cambios: el contenido es idéntico al de la versión ${resultado.version} ya existente (idempotente).`,
              );
              if (ownerId.trim()) cargarStatements(ownerId);
            }}
          />
        )}
        {ultimoResultado && <p className={NOTA_CLASES}>{ultimoResultado}</p>}
      </CardContent>
    </Card>
  );
}
