// Servicios del panel de citas — lista + ficha (Fase 5). Fase 8 cierra el gap real
// de paridad con el origen (ServiciosSection.tsx): alta/edición real de un
// servicio (ver services-client.ts). `citas.services` no tiene columnas
// `description`/`requirements` como el origen — quedan fuera de esta fase.
//
// Presentación real (Fase de diseño): los `style={{…}}` con hex (inputStyle/
// primaryButtonStyle/tarjetas artesanales) se cambian por Card/Input/Label/
// Button/Badge/Table de @atiende/ui. El estado, las llamadas y las ramas
// condicionales de arriba no cambian.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Pencil, Plus, Scissors } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  TableRow,
} from "@atiende/ui";
import { createService, fetchServiceDetail, fetchServices, updateService } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { formatMoneyFromCents } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const CHECKBOX_CLASS = "size-4 rounded border-border accent-primary disabled:cursor-not-allowed disabled:opacity-50";

export function ServiciosListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newDuration, setNewDuration] = useState("30");
  const [newPrice, setNewPrice] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    setError(null);
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then(setServices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los servicios."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const duration = Number.parseInt(newDuration, 10);
    if (!newName.trim() || !Number.isFinite(duration) || duration <= 0) return;
    setCreating(true);
    setError(null);
    try {
      const priceCents = newPrice.trim() ? Math.round(Number(newPrice) * 100) : undefined;
      await createService(fetch, apiBaseUrl, token, propertyId, { name: newName.trim(), durationMinutes: duration, priceCents });
      setNewName("");
      setNewDuration("30");
      setNewPrice("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el servicio.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-xl font-semibold text-foreground">Servicios</h1>
      {error && <EstadoError mensaje={error} />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Nuevo servicio</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="citas-nuevo-servicio-nombre">Nombre</Label>
              <Input id="citas-nuevo-servicio-nombre" placeholder="Nombre (ej. Consulta general)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="flex w-28 flex-col gap-1.5">
              <Label htmlFor="citas-nuevo-servicio-duracion">Duración (min)</Label>
              <Input id="citas-nuevo-servicio-duracion" placeholder="Duración (min)" type="number" min={1} value={newDuration} onChange={(e) => setNewDuration(e.target.value)} />
            </div>
            <div className="flex w-36 flex-col gap-1.5">
              <Label htmlFor="citas-nuevo-servicio-precio">Precio (opcional)</Label>
              <Input
                id="citas-nuevo-servicio-precio"
                placeholder="Precio (opcional)"
                type="number"
                min={0}
                step="0.01"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={creating}>
              <Plus aria-hidden />
              {creating ? "Creando…" : "Crear servicio"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {!services && !error && <EstadoCargando etiqueta="Cargando servicios…" />}
      {services && services.length === 0 && <EstadoVacio icon={Scissors} mensaje="Este negocio todavía no tiene servicios activos." />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {services?.map((s) => (
          <Link key={s.id} to={`/citas/${orgSlug}/servicios/${s.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="h-full transition-colors hover:border-foreground/20 hover:bg-muted/40">
              <CardContent className="p-4">
                <p className="font-semibold text-foreground">{s.name}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {s.durationMinutes} min · {formatMoneyFromCents(s.priceCents)}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ServicioFichaPageProps extends CitasShellContext {
  readonly serviceId: string;
}

export function ServicioFichaPage({ apiBaseUrl, token, propertyId, orgSlug, serviceId }: ServicioFichaPageProps) {
  const [service, setService] = useState<ServiceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDuration, setEditDuration] = useState("");
  const [editBufferBefore, setEditBufferBefore] = useState("");
  const [editBufferAfter, setEditBufferAfter] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setError(null);
    fetchServiceDetail(fetch, apiBaseUrl, token, propertyId, serviceId)
      .then((s) => {
        setService(s);
        setEditName(s.name);
        setEditDuration(String(s.durationMinutes));
        setEditBufferBefore(String(s.bufferMinutesBefore));
        setEditBufferAfter(String(s.bufferMinutesAfter));
        setEditPrice(s.priceCents !== null ? String(s.priceCents / 100) : "");
        setEditIsActive(s.isActive);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el servicio."));
  }

  useEffect(() => {
    load();
  }, [apiBaseUrl, token, propertyId, serviceId]);

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    const duration = Number.parseInt(editDuration, 10);
    if (!editName.trim() || !Number.isFinite(duration) || duration <= 0) return;
    setSaving(true);
    setError(null);
    try {
      await updateService(fetch, apiBaseUrl, token, propertyId, serviceId, {
        name: editName.trim(),
        durationMinutes: duration,
        bufferMinutesBefore: Number.parseInt(editBufferBefore, 10) || 0,
        bufferMinutesAfter: Number.parseInt(editBufferAfter, 10) || 0,
        priceCents: editPrice.trim() ? Math.round(Number(editPrice) * 100) : null,
        isActive: editIsActive,
      });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el servicio.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit px-2 text-muted-foreground">
        <Link to={`/citas/${orgSlug}/servicios`}>
          <ArrowLeft aria-hidden />
          Volver a servicios
        </Link>
      </Button>
      {error && <EstadoError mensaje={error} />}
      {!service && !error && <EstadoCargando etiqueta="Cargando servicio…" />}
      {service && !editing && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="font-display text-xl font-semibold text-foreground">{service.name}</h1>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              Editar servicio
            </Button>
          </header>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="w-40 text-muted-foreground">Duración</TableCell>
                    <TableCell className="text-foreground">{service.durationMinutes} min</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Colchón antes</TableCell>
                    <TableCell className="text-foreground">{service.bufferMinutesBefore} min</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Colchón después</TableCell>
                    <TableCell className="text-foreground">{service.bufferMinutesAfter} min</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Precio</TableCell>
                    <TableCell className="text-foreground">{formatMoneyFromCents(service.priceCents)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Estado</TableCell>
                    <TableCell>
                      <Badge variant={service.isActive ? "secondary" : "outline"}>{service.isActive ? "Activo" : "Inactivo"}</Badge>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
      {service && editing && (
        <Card>
          <CardContent className="p-6">
            <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-servicio-nombre">Nombre</Label>
                <Input id="citas-servicio-nombre" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-[120px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="citas-servicio-duracion">Duración (min)</Label>
                  <Input id="citas-servicio-duracion" type="number" min={1} value={editDuration} onChange={(e) => setEditDuration(e.target.value)} />
                </div>
                <div className="flex min-w-[120px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="citas-servicio-colchon-antes">Colchón antes</Label>
                  <Input id="citas-servicio-colchon-antes" type="number" min={0} value={editBufferBefore} onChange={(e) => setEditBufferBefore(e.target.value)} />
                </div>
                <div className="flex min-w-[120px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="citas-servicio-colchon-despues">Colchón después</Label>
                  <Input id="citas-servicio-colchon-despues" type="number" min={0} value={editBufferAfter} onChange={(e) => setEditBufferAfter(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-servicio-precio">Precio (vacío = sin precio fijo)</Label>
                <Input id="citas-servicio-precio" type="number" min={0} step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-foreground">
                <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} className={CHECKBOX_CLASS} />
                Activo
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Guardando…" : "Guardar cambios"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
