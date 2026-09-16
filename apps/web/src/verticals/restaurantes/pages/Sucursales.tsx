// Sucursales (Fase 5) — lista + ficha de edición real (teléfono/dirección/
// coordenadas/slug). Deliberadamente sin "crear sucursal" ni "activar/desactivar":
// ver comentario de cabecera de admin-branches.ts.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card` por sucursal, `Badge` para "Activa/Inactiva",
// `Input`/`Label` para el formulario de edición y `Button` para Editar/Guardar/
// Cancelar. Toda la lógica de carga/edición/guardado de abajo es la MISMA.
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { Pencil } from "lucide-react";
import { fetchAdminBranches, updateBranchDetail } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function SucursalesPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [branches, setBranches] = useState<readonly BranchDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ phone: string; address: string }>({ phone: "", address: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      setBranches(await fetchAdminBranches(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  function startEditing(branch: BranchDetail) {
    setEditing(branch.propertyId);
    setDraft({ phone: branch.phone ?? "", address: branch.address ?? "" });
  }

  async function handleSave(branchId: string) {
    setSaving(true);
    setError(null);
    try {
      await updateBranchDetail(fetch, apiBaseUrl, token, propertyId, branchId, { phone: draft.phone || null, address: draft.address || null });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la sucursal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Sucursales</h1>
      <p className="m-0 text-xs text-muted-foreground">
        Crear una sucursal nueva o activar/desactivarla todavía no está disponible desde el panel — requiere un cambio de plataforma compartido por todas las verticales (ver README de este vertical).
      </p>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {!branches && !error && <EstadoCargando etiqueta="Cargando sucursales…" />}

      <div className="flex flex-col gap-3">
        {branches?.map((b) => (
          <Card key={b.propertyId}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="m-0 font-semibold text-foreground">{b.name}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>/{b.slug} ·</span>
                    <Badge variant={b.status === "active" ? "secondary" : "destructive"}>{b.status === "active" ? "Activa" : "Inactiva"}</Badge>
                  </div>
                </div>
                {editing !== b.propertyId && (
                  <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => startEditing(b)}>
                    <Pencil />
                    Editar
                  </Button>
                )}
              </div>

              {editing === b.propertyId ? (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-telefono-${b.propertyId}`} className="text-xs text-muted-foreground">
                      Teléfono
                    </Label>
                    <Input
                      id={`sucursal-telefono-${b.propertyId}`}
                      value={draft.phone}
                      onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-direccion-${b.propertyId}`} className="text-xs text-muted-foreground">
                      Dirección
                    </Label>
                    <Input
                      id={`sucursal-direccion-${b.propertyId}`}
                      value={draft.address}
                      onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" className="h-9 text-xs" onClick={() => void handleSave(b.propertyId)} disabled={saving}>
                      {saving ? "Guardando…" : "Guardar"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => setEditing(null)} disabled={saving}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-muted-foreground">Teléfono</dt>
                  <dd className="m-0 text-foreground">{b.phone ?? "—"}</dd>
                  <dt className="text-muted-foreground">Dirección</dt>
                  <dd className="m-0 text-foreground">{b.address ?? "—"}</dd>
                </dl>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
