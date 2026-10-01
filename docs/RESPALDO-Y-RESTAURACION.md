# Respaldo y restauración (PL-05)

Runbook del respaldo lógico de la base Supabase y del drill de restauración. Código en
`scripts/respaldo/`, prueba automática en `scripts/verify-respaldo-drill/`, ensayo
semanal en `.github/workflows/respaldo-drill.yml`.

> **Regla de oro.** Nada de este repo ni de su CI se conecta a la base real. El respaldo real
> lo corre Javier desde su máquina con su cuenta. El CI solo ensaya el procedimiento sobre una
> base sintética.

## 1. Qué cubre y qué no

| Cubre | No cubre |
|---|---|
| Datos y definiciones (tablas, RLS, políticas, GRANTs, funciones) de los esquemas `core`, `citas`, `hoteles`, `rentas`, `licitaciones`, `despachos`, `restaurantes` | Esquemas de plataforma (`auth`, `storage`, `realtime`, `vault`...): `BACKUP_EXTRA_SCHEMAS` los agrega, pero no están ensayados |
| Una foto consistente (un solo snapshot de Postgres) con su huella para verificar la restauración | Recuperación a un instante exacto (PITR): el RPO es el intervalo entre respaldos |
| Restaurar a una base NUEVA y local para el drill | Variables de entorno de Vercel, secretos, DNS, archivos de Storage, roles/contraseñas de Postgres |

Es un complemento, no un reemplazo, de los respaldos gestionados de Supabase: revisa en el
panel qué respaldos/PITR incluye el plan del proyecto (no se asume aquí).

## 2. Objetivos (propuestos, pendientes del OK de Javier)

| Objetivo | Valor propuesto | Cómo se mide |
|---|---|---|
| **RPO** (datos que se pueden perder) | 24 h: un respaldo al día | `now - created_at` del respaldo más reciente, al correr el drill (`RPO_TARGET_SECONDS`, default 86400) |
| **RTO** (tiempo para tener los datos restaurados y verificados) | 2 h | Segundos desde que arranca el drill hasta el veredicto, con el desglose de `pg_restore` (`RTO_TARGET_SECONDS`, default 7200) |

El RTO del drill es solo la parte de datos: crear el proyecto nuevo, repuntar variables de
Vercel y probar el flujo (sección 7) se suma a mano. El drill sintético del CI mide una base casi
vacía: sirve para detectar regresiones del procedimiento, **no** para prometer tiempos de
producción (el reporte lo marca como "no representativo"). El número que vale sale del drill
mensual sobre un respaldo real (sección 5).

## 3. Responsables

| Tarea | Responsable | Frecuencia |
|---|---|---|
| Correr `backup.sh` contra producción y guardar el resultado | Javier | Diaria (sección 4.3) |
| Custodiar la llave privada de cifrado (copia fuera de la Mac) | Javier | Una vez; revisar al rotar |
| Drill sobre el último respaldo real y archivar el reporte | Javier | Mensual y tras cada tanda grande de migraciones |
| Drill sintético y gate de casos negativos | CI (workflow `respaldo-drill`) | Semanal y en cada cambio de estos scripts o de `supabase/migrations/` |
| Atender un fallo del workflow o un FAIL del drill | Javier, con ayuda de Claude | Al aviso |

## 4. Respaldo

### 4.1 Requisitos (una vez)

- PostgreSQL client tools de la **misma versión mayor o mayor** que el servidor de Supabase
  (`pg_dump` más viejo que el servidor se niega a correr): `brew install postgresql@17`.
- Cifrado: `brew install age` y `age-keygen -o ~/.llaves/atiende-respaldo.agekey`; la
  llave **pública** (`age1...`) va en `BACKUP_AGE_RECIPIENT`, la **privada** se guarda fuera de
  la Mac y de iCloud en claro. `gpg` también funciona (`BACKUP_ENCRYPT=gpg`).
- Cadena de conexión **directa** o del pooler en modo **sesión** (puerto 5432), de un rol con
  `SELECT` en esos esquemas. El pooler en modo transacción (6543) no sirve: no soporta
  `pg_export_snapshot`. Se pone solo en la variable de entorno, nunca en un archivo del repo ni
  pegada en un chat.

### 4.2 Correr un respaldo

```bash
export BACKUP_DATABASE_URL='postgresql://...'      # no se imprime en ningún log
export BACKUP_DEST="$HOME/respaldos-atiende"       # disco externo, carpeta sincronizada, etc.
export BACKUP_ENCRYPT=age BACKUP_AGE_RECIPIENT='age1...'
export BACKUP_PRUNE=1                              # opcional: aplica retención
bash scripts/respaldo/backup.sh
```

Genera `atiende-<UTC>/` con `dump.pgdump.age`, `catalog.json` y `manifest.json`. La sesión es de
solo lectura. Un origen remoto sin cifrar se rechaza salvo `BACKUP_ALLOW_PLAINTEXT=1` (el dump
trae datos personales de todos los tenants). Si algún esquema de la lista aún no existe en la
base (migraciones pendientes), se omite y queda anotado en `schemas_missing`.

Retención (solo con `BACKUP_PRUNE=1`): se conserva lo que cumpla cualquiera de
`BACKUP_RETENTION_KEEP_LAST` (7) o `BACKUP_RETENTION_DAYS` (30); el más reciente nunca se
borra y solo se tocan carpetas `atiende-*` con `manifest.json`.

### 4.3 Programarlo (propuesta, no instalada)

Un `cron`/`launchd` en la Mac de Javier que exporte las variables desde el llavero y llame a
`backup.sh`. Mientras no esté programado, el RPO real es "desde la última vez que Javier lo
corrió", no 24 h. Instalar la programación es una acción de Javier.

## 5. Drill de restauración

```bash
bash scripts/respaldo/drill.sh --latest "$BACKUP_DEST"     # el respaldo más reciente
bash scripts/respaldo/drill.sh --backup "$BACKUP_DEST/atiende-20261001T031500Z"
RESTORE_AGE_IDENTITY=~/.llaves/atiende-respaldo.agekey bash scripts/respaldo/drill.sh --latest "$BACKUP_DEST"
bash scripts/respaldo/drill.sh --synthetic                 # lo que corre el CI; sin credenciales
```

Levanta un Postgres efímero (solo socket unix, sin puertos), restaura con
`pg_restore --single-transaction --exit-on-error` y deja `drill-report-<UTC>/report.md` y
`report.json`. Salida: `0` PASS, `2` FAIL, `1` error operativo.

### Checklist de verificación (lo que el drill comprueba solo)

| Check | Qué prueba |
|---|---|
| `checksums_del_respaldo` | sha256 de cada archivo contra `manifest.json` (respaldo íntegro) |
| `restauracion_sin_errores` | `pg_restore` terminó sin errores (y revirtió todo si no) |
| `conteos_por_tabla` | filas por tabla idénticas a las del origen **en el mismo snapshot** |
| `rls_activo`, `politicas_rls` | `ENABLE/FORCE ROW LEVEL SECURITY` y número de políticas por tabla |
| `grants` | GRANTs de tabla, columna, secuencia y `EXECUTE` de función |
| `funciones_security_definer` | existencia, `security definer`, `search_path` fijo y `EXECUTE` a PUBLIC |
| `invariante_secdef_sin_search_path`, `invariante_politicas_using_true`, `invariante_anon_con_escritura_en_tablas` | reglas del repo. Una violación nueva tras restaurar es FAIL; una que ya existía en el origen es WARN (FAIL con `DRILL_STRICT_INVARIANTS=1`) |
| RPO / RTO | contra `RPO_TARGET_SECONDS` / `RTO_TARGET_SECONDS` |

Frecuencia: mensual sobre un respaldo real, y tras aplicar migraciones grandes. Archiva
`report.md` (no contiene datos de negocio: solo nombres de objetos y conteos).

## 6. Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `backup.sh`: no conecta | URL equivocada, pooler en modo transacción, IP bloqueada | Usar conexión directa o pooler en sesión; comprobar con `psql` |
| `backup.sh`: `pg_dump: server version mismatch` | cliente más viejo que el servidor | Instalar el `postgresql@N` correcto y ponerlo primero en `PATH` |
| `backup.sh`: se niega por cifrado | origen remoto sin `BACKUP_ENCRYPT` | Configurar age/gpg |
| Drill: `checksums_del_respaldo` FAIL | archivo truncado, alterado o copia incompleta | Descartar ese respaldo, usar el anterior y revisar el destino (espacio, sincronización) |
| Drill: `restauracion_sin_errores` FAIL | rol o extensión que el dump necesita y la base efímera no tiene (p. ej. una extensión nueva) | Leer el error de `pg_restore`; agregar la extensión/rol a `scripts/respaldo/platform-bootstrap.sql` si es solo de entorno |
| Drill: `conteos_por_tabla` / `rls_activo` / `grants` / `funciones_*` FAIL | restauración incompleta o dump que no refleja el origen | Es un hallazgo real: no confiar en ese respaldo; repetir el respaldo y abrir incidente |
| Drill: RPO incumplido | respaldo viejo | Correr un respaldo ya; revisar la programación |
| Drill: RTO incumplido | base creció, disco lento | Repartir el tiempo por fase en el reporte; replantear el objetivo o la estrategia (restauración paralela) |
| Workflow semanal en rojo | una migración o un cambio de scripts rompió la restauración | Abrir el log del job; el fallo es del procedimiento, no de producción |
| Se perdió la llave privada | respaldos cifrados irrecuperables | No hay remedio: por eso la copia fuera de la Mac es parte del procedimiento |

## 7. Recuperación real (incidente)

`restore.sh` solo restaura a una base **local** o, con `RESTORE_ALLOW_NON_LOCAL=1`, a una base
nueva y vacía en otra máquina; **rechaza siempre un host de Supabase** (para que una
equivocación no pueda pisar producción). Por eso restaurar a un proyecto Supabase nuevo es un
paso manual y supervisado que **no está ensayado por el CI**:

1. Declarar el incidente, congelar escrituras si es posible y anotar la hora (inicia el reloj del RTO).
2. Elegir el respaldo más reciente que pase `verify-manifest` y un drill reciente.
3. Crear un proyecto Supabase NUEVO y vacío; aplicar la plataforma que no está en el dump (roles,
   extensiones: `scripts/respaldo/platform-bootstrap.sql` es la referencia mínima).
4. Restaurar con `pg_restore --no-owner --single-transaction --exit-on-error -d <proyecto-nuevo> dump.pgdump`
   (descifrar antes con `age -d -i <llave>`), desde la máquina de Javier y solo contra el proyecto
   nuevo.
5. Correr la huella contra el proyecto nuevo y compararla con `catalog.json` del respaldo
   (misma consulta que usa el drill: `scripts/respaldo/catalog-snapshot.sql`).
6. Repuntar variables de Vercel a la base nueva, rotar las llaves de servicio y verificar a mano:
   `/health`, login de un usuario, un flujo por vertical y que los crons escriben.
7. Aplicar las migraciones posteriores al respaldo, si las hubiera, y anotar el RPO/RTO reales.

## 8. Limitaciones conocidas

- Solo se ensayó contra PostgreSQL con extensiones en el esquema `public`; si Supabase las pone en
  `extensions`, la base efímera necesitará ese esquema (ver el fallo de `restauracion_sin_errores`).
- El cifrado con `age` no está cubierto por el gate de CI (se prueba `gpg`); el código de `age` es
  el mismo camino pero no corre en CI.
- No se respaldan contraseñas ni roles de Postgres, Storage, ni secretos de Vercel.
- Los conteos son exactos porque catálogo y dump comparten snapshot; no hay verificación
  fila por fila del contenido.
