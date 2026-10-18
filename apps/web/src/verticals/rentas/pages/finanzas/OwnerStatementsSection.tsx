// Sección 2 de Finanzas: owner statements (listar, ver detalle, invitar al portal; generar solo admin_gestora).
// Invitar al portal emite un token de acceso a los statements del propietario: pasa por confirmación de dos pasos.
import { useState } from "react";
import { Mail, Plus, Search } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoError, FormField, Input, notify, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchOwnerStatementDetalle, fetchOwnerStatements, invitarPropietarioAlPortal } from "../../lib/finanzas-client.ts";
import type { LineaOwnerStatement, OwnerStatementDetalle, OwnerStatementSummary, PortalInviteEmitida } from "../../lib/finanzas-client.ts";
import { dineroDeCentavos } from "../../lib/pricing-client.ts";
import { fechaHoraEsMx, formatFechaSolo } from "../../../../lib/formato-fecha.ts";
import { Linea, TIPO_LINEA_LABELS } from "./comunes.tsx";
import type { SectionProps } from "./comunes.tsx";
import { GenerarStatementForm } from "./GenerarStatementForm.tsx";

const periodoTexto = (p: { inicio: string; fin: string }) => `${formatFechaSolo(p.inicio)} → ${formatFechaSolo(p.fin)}`;

export function OwnerStatementsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const { confirmar, dialogo } = useConfirm();
  const [ownerId, setOwnerId] = useState("");
  const [statements, setStatements] = useState<readonly OwnerStatementSummary[] | null>(null);
  const [detalle, setDetalle] = useState<OwnerStatementDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [invite, setInvite] = useState<PortalInviteEmitida | null>(null);
  const [errorInvite, setErrorInvite] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);

  async function invitarPropietario() {
    if (!ownerId.trim()) return setErrorInvite("Ingresa primero el id del propietario arriba.");
    setErrorInvite(null);
    const acepto = await confirmar({
      titulo: "Invitar a este propietario al portal",
      descripcion: "Se genera un token de activación con acceso a sus statements. Se muestra una sola vez y debes compartirlo solo con el propietario.",
      confirmar: "Generar invitación",
      cancelar: "Cancelar",
    });
    if (!acepto) return;
    setInvite(null);
    setInvitando(true);
    try {
      setInvite(await invitarPropietarioAlPortal(fetch, apiBaseUrl, token, propertyId, ownerId.trim()));
      notify.success("Invitación al portal creada.");
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
      setStatements(await fetchOwnerStatements(fetch, apiBaseUrl, token, propertyId, idOwner.trim()));
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
      setDetalle(await fetchOwnerStatementDetalle(fetch, apiBaseUrl, token, propertyId, statementId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle del statement.");
    }
  }

  const columnas: readonly DataTableColumna<OwnerStatementSummary>[] = [
    { id: "periodo", encabezado: "Periodo", principal: true, celda: (s) => <span className="font-medium text-foreground">{periodoTexto(s.periodo)}</span> },
    { id: "version", encabezado: "Versión", celda: (s) => `v${s.version}` },
    { id: "neto", encabezado: "Neto", alinear: "right", celda: (s) => <span className="tabular-nums">{dineroDeCentavos(s.netoCentavos, s.moneda)}</span> },
    { id: "generado", encabezado: "Generado", celda: (s) => <span className="text-muted-foreground">{fechaHoraEsMx(s.generadoEn)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (s) => (
        <Button type="button" variant="outline" size="sm" aria-label={`Ver el detalle del statement v${s.version} de ${periodoTexto(s.periodo)}`} onClick={() => void verDetalle(s.id)}>
          Ver detalle
        </Button>
      ),
    },
  ];

  const columnasLineas: readonly DataTableColumna<{ readonly linea: LineaOwnerStatement; readonly n: number }>[] = [
    { id: "reserva", encabezado: "Reserva", principal: true, celda: ({ linea }) => <span className="text-xs">{linea.ocupacionId}</span> },
    { id: "tipo", encabezado: "Tipo", celda: ({ linea }) => TIPO_LINEA_LABELS[linea.tipo] ?? linea.tipo },
    { id: "monto", encabezado: "Monto", alinear: "right", celda: ({ linea }) => <span className="tabular-nums">{dineroDeCentavos(linea.montoCentavos, detalle?.moneda ?? "MXN")}</span> },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Owner statements</CardTitle>
          <CardDescription>No hay un catálogo de propietarios en el backend todavía: ingresa el id del propietario (el mismo que usa su portal).</CardDescription>
        </div>
        {puedeEscribir && (
          <Button type="button" size="sm" onClick={() => setGenerando(true)}>
            <Plus /> Generar statement
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <FormField label="Id del propietario (ownerId)" className="min-w-[220px] flex-1">
            <Input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="uuid del propietario" />
          </FormField>
          <Button type="button" variant="outline" size="sm" onClick={() => void cargarStatements(ownerId)} loading={cargando} loadingText="Consultando…">
            <Search /> Ver statements
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void invitarPropietario()} loading={invitando} loadingText="Invitando…">
            <Mail /> Invitar a este propietario
          </Button>
        </div>

        {errorInvite && <Callout tone="danger" titulo="No se pudo invitar" onDismiss={() => setErrorInvite(null)}>{errorInvite}</Callout>}
        {invite && (
          <Callout tone="success" titulo="Invitación creada" onDismiss={() => setInvite(null)}>
            Vence {fechaHoraEsMx(invite.expiresAt)}. Comparte este token con el propietario para que active su cuenta en el portal:{" "}
            <code className="select-all rounded bg-canvas px-1 py-0.5 font-mono text-xs">{invite.inviteToken}</code>
          </Callout>
        )}

        {error && <EstadoError compacto titulo="No se pudo completar" mensaje={error} />}

        {(statements !== null || cargando) && (
          <DataTable
            etiqueta="Statements del propietario"
            columnas={columnas}
            filas={statements ?? []}
            obtenerId={(s) => s.id}
            estado={cargando ? "loading" : undefined}
            paginacion={false}
            vacio={{ titulo: "Sin statements", mensaje: "Este propietario no tiene ningún statement generado todavía." }}
          />
        )}

        {detalle && (
          <div className="flex flex-col gap-2 border-t border-border pt-2.5">
            <p className="m-0 text-sm font-semibold text-foreground">
              Statement v{detalle.version} — {periodoTexto(detalle.periodo)}
            </p>
            {detalle.motivoVersion && <p className="m-0 text-xs text-muted-foreground">Motivo de esta versión: {detalle.motivoVersion}</p>}
            <DataTable
              etiqueta="Líneas del statement"
              columnas={columnasLineas}
              filas={detalle.lineas.map((linea, n) => ({ linea, n }))}
              obtenerId={({ linea, n }) => `${linea.ocupacionId}-${linea.tipo}-${n}`}
              paginacion={false}
              vacio={{ titulo: "Sin líneas", mensaje: "Este statement no tiene líneas." }}
            />
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
      </CardContent>

      {generando && (
        <GenerarStatementForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          ownerId={ownerId}
          hayVersionPrevia={(statements?.length ?? 0) > 0}
          onCerrar={() => setGenerando(false)}
          onGenerado={(resultado) => {
            notify.success(resultado.creado ? `Statement nuevo creado: versión ${resultado.version}.` : `Sin cambios: el contenido es idéntico al de la versión ${resultado.version} ya existente (idempotente).`);
            if (ownerId.trim()) void cargarStatements(ownerId);
          }}
        />
      )}
      {dialogo}
    </Card>
  );
}

