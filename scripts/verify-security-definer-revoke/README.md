# verify-security-definer-revoke

Gate contra Postgres **real** de la regla de `CLAUDE.md` «toda función `security definer` con
`set search_path` fijo y `revoke` de `public`». Antes de este arreglo, 33 funciones SECURITY
DEFINER de `core`, `hoteles`, `licitaciones` y `rentas` conservaban el `EXECUTE` por omisión de
`PUBLIC` (ACL nula), así que cualquier rol del clúster, `anon` incluido, podía invocarlas. Es
defensa en profundidad: la app nunca usa `anon`, pero el privilegio no debía existir.

## El arreglo

Una migración por paquete (espejos en `supabase/migrations/`):

| Paquete | Migración | Espejo |
| --- | --- | --- |
| `packages/domain-restaurantes` | `202_restaurantes_catalogo_publico_policy_por_rol.sql` | `20240101000830_…` |
| `packages/db` | `0091_security_definer_revoke_public.sql` | `20240101000831_…` |
| `packages/domain-hoteles` | `051_hoteles_security_definer_revoke_public.sql` | `20240101000832_…` |
| `packages/domain-licitaciones` | `042_licitaciones_security_definer_revoke_public.sql` | `20240101000833_…` |
| `packages/domain-rentas` | `038_rentas_security_definer_revoke_public.sql` | `20240101000834_…` |

- **Helpers de autorización** (`can_*`, `core.has_property_access`) y
  `hoteles.apply_cfdi_webhook_status`: `revoke all … from public, anon` + `grant execute … to
  authenticated`. La app corre SIEMPRE como `authenticated` (`ManagedPostgresEngine.withAppSession`,
  con o sin `auth.uid()`), y las policies RLS que llaman a estos helpers se evalúan con el rol del
  que consulta, así que `authenticated` necesita el privilegio explícito.
- **Lectura pública heredada de restaurantes** (`branch_detail`, `branch_products`, 014_catalogo_publico_scoped):
  su policy de SELECT era una sola para todos los roles y llamaba a `core.has_property_access`; Postgres exige
  EXECUTE de cada función de las policies que aplican al rol, así que `anon` habría pasado de leer a recibir
  «permission denied». 202 la separa en una policy `to anon` (`auth.uid() is null`, sin helper) y una
  `to authenticated` con la expresión de siempre. Va ANTES del revoke (espejo 830).
- **Funciones de trigger** (`*_set_hash`, `*_guard`, `reservation_log_status_event*`):
  `revoke all … from public, anon` sin grant. Postgres solo exige `EXECUTE` sobre la función al
  **crear** el trigger, no al dispararlo; nadie las llama directo.

## Correr

```
scripts/verify-security-definer-revoke/run.sh
DEFINER_REVOKE_SKIP_FIX=1 scripts/verify-security-definer-revoke/run.sh   # antes del fix: 1-7 fallan
```

En CI lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (tiene los 3 archivos).
El guard estático `npm run verify:sql-privilegios` (`scripts/guard-sql-privilegios/`) cubre lo
mismo sin Postgres, sobre el texto de `supabase/migrations/`.
