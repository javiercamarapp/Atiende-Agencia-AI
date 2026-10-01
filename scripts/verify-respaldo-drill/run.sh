#!/usr/bin/env bash
# verify-respaldo-drill/run.sh — gate de CI del respaldo + drill de restauración (PL-05).
# Todo contra Postgres EFÍMERO por socket unix (initdb), sin credenciales ni base real.
#
# Qué demuestra (pass/fail automático, no lectura humana):
#   A. lógica pura (node --test): guardia de destino, redact, retención, comparación de catálogos.
#   B. DRILL POSITIVO: base semilla con las 197+ migraciones reales -> backup.sh -> restore en
#      otra base -> verificación de integridad PASS, y el reporte trae RPO/RTO.
#   C. NEGATIVOS que el drill DEBE detectar (si no los detecta, el gate falla):
#        - archivo del respaldo alterado (sha256)        - catálogo de origen distinto (conteos + RLS)
#   D. restore.sh se niega: destino de Supabase (aun con RESTORE_ALLOW_NON_LOCAL=1), destino remoto
#      sin permiso, destino con esquemas ya presentes.
#   E. backup.sh se niega: origen remoto sin cifrar; y ningún secreto aparece en la salida.
#   F. cifrado gpg ida y vuelta (si hay gpg) y retención (BACKUP_PRUNE) conserva solo lo debido.
# Uso: bash scripts/verify-respaldo-drill/run.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
R="$REPO_ROOT/scripts/respaldo"
# shellcheck source=scripts/respaldo/common.sh
source "$R/common.sh"
ensure_pg_bin
trap 'cleanup_servers; rm -rf "$T"' EXIT
T="$(mktemp -d "${TMPDIR:-/tmp}/verify-respaldo.XXXXXX")"
FAILS=0
PW="Sup3r""S3cret"   # contraseña ficticia armada en ejecución (no literal en URLs)
ok()   { echo "   [PASS] $*"; }
bad()  { echo "   [FAIL] $*"; FAILS=$((FAILS + 1)); }
expect_rc() { # <esperado> <descripcion> <rc-real>
  if [ "$3" -eq "$1" ]; then ok "$2 (rc=$3)"; else bad "$2: se esperaba rc=$1 y fue rc=$3"; fi
}

echo "=== A. lógica pura (node --test) ==="
node --test "$R/tests/lib.test.mjs" >"$T/unit.log" 2>&1; rc=$?
if [ $rc -eq 0 ]; then ok "$(grep -E '^ℹ pass' "$T/unit.log" | head -1) pruebas de lib.mjs"; else bad "node --test falló"; cat "$T/unit.log"; fi

echo "=== B. drill positivo (sintético, migraciones reales) ==="
KEEP="$T/keep"
DRILL_REPORT_DIR="$T/rep-ok" DRILL_KEEP_BACKUP_DIR="$KEEP" bash "$R/drill.sh" --synthetic >"$T/drill-ok.log" 2>&1; rc=$?
expect_rc 0 "drill sintético PASS" $rc
[ $rc -eq 0 ] || tail -30 "$T/drill-ok.log"
GOOD="$(ls -d "$KEEP"/atiende-* 2>/dev/null | head -1)"
[ -n "$GOOD" ] || { bad "no quedó copia del respaldo sintético"; exit 1; }
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const need = ["conteos_por_tabla","rls_activo","politicas_rls","grants","funciones_security_definer","checksums_del_respaldo","restauracion_sin_errores"];
  const have = new Set(r.checks.filter((c) => c.status === "pass").map((c) => c.name));
  const miss = need.filter((n) => !have.has(n));
  const t = r.targets;
  if (miss.length || typeof t.rpo_seconds !== "number" || typeof t.rto_seconds !== "number" || r.targets.representative !== false) {
    console.error("faltan checks/medidas:", miss, t); process.exit(1);
  }' "$T/rep-ok/report.json" && ok "reporte con los 7 checks en PASS y RPO/RTO medidos (marcado no representativo)" || bad "reporte incompleto"

echo "=== C. el drill DETECTA un respaldo dañado ==="
cp -R "$GOOD" "$T/tamper"; printf 'x' >>"$T/tamper/dump.pgdump"
DRILL_REPORT_DIR="$T/rep-tamper" bash "$R/drill.sh" --backup "$T/tamper" >"$T/tamper.log" 2>&1; rc=$?
expect_rc 2 "respaldo alterado => FAIL" $rc
grep -q '"checksums_del_respaldo"' "$T/rep-tamper/report.json" && grep -q '"failed_checks"' "$T/rep-tamper/report.json" \
  && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.failed_checks.includes("checksums_del_respaldo")?0:1)' "$T/rep-tamper/report.json" \
  && ok "falla precisamente checksums_del_respaldo" || bad "no reportó checksums_del_respaldo"

cp -R "$GOOD" "$T/drift"
node -e '
  const fs = require("fs"); const p = process.argv[1] + "/catalog.json"; const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.counts.find((x) => x.table === "organization").rows += 1;          // "origen" tenía una fila más
  c.tables.find((x) => x.rls).rls = false;                              // "origen" no tenía RLS ahí
  fs.writeFileSync(p, JSON.stringify(c));' "$T/drift"
node "$R/cli.mjs" write-manifest "$T/drift" "$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/manifest.json"));delete m.files;delete m.format;console.log(JSON.stringify(m))' "$T/drift")" || bad "no pude regenerar manifest del caso drift"
DRILL_REPORT_DIR="$T/rep-drift" bash "$R/drill.sh" --backup "$T/drift" >"$T/drift.log" 2>&1; rc=$?
expect_rc 2 "catálogo de origen distinto => FAIL" $rc
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));const f=r.failed_checks;process.exit(f.includes("conteos_por_tabla")&&f.includes("rls_activo")?0:1)' "$T/rep-drift/report.json" \
  && ok "falla conteos_por_tabla y rls_activo" || bad "no detectó conteo/RLS distintos"

echo "=== D. restore.sh se niega a restaurar donde no debe ==="
for url in "postgresql://postgres:$PW@db.abcdefgh.supabase.co:5432/postgres" "postgresql://u:$PW@aws-0-us-east-1.pooler.supabase.com:6543/postgres"; do
  RESTORE_DATABASE_URL="$url" RESTORE_ALLOW_NON_LOCAL=1 bash "$R/restore.sh" "$GOOD" >"$T/rs.log" 2>&1; rc=$?
  expect_rc 1 "destino Supabase rechazado aun con RESTORE_ALLOW_NON_LOCAL=1" $rc
  grep -q "host de Supabase" "$T/rs.log" && ok "el rechazo cita el motivo (host de Supabase)" || bad "rechazo sin el motivo esperado"
  grep -q "$PW" "$T/rs.log" && bad "la contraseña apareció en la salida" || ok "sin la contraseña en la salida"
done
RESTORE_DATABASE_URL="postgresql://u:$PW@10.255.255.1/db" bash "$R/restore.sh" "$GOOD" >"$T/rs.log" 2>&1; rc=$?
expect_rc 1 "destino remoto sin RESTORE_ALLOW_NON_LOCAL rechazado" $rc
RESTORE_DATABASE_URL="postgresql://u:$PW@10.255.255.1/db" RESTORE_ALLOW_NON_LOCAL=1 RESTORE_BOOTSTRAP=1 bash "$R/restore.sh" "$GOOD" >"$T/rs.log" 2>&1; rc=$?
expect_rc 1 "RESTORE_BOOTSTRAP=1 rechazado con destino remoto aun con RESTORE_ALLOW_NON_LOCAL=1" $rc
grep -q "RESTORE_BOOTSTRAP=1 solo se permite" "$T/rs.log" && ok "el rechazo cita el motivo (bootstrap solo local)" || bad "rechazo sin el motivo esperado: $(tail -2 "$T/rs.log")"

start_ephemeral_pg; E_DIR="$EPH_DIR"; E_PORT="$EPH_PORT"
PSQL_E=(psql -X -q -h "$E_DIR" -p "$E_PORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL_E[@]}" -d postgres -c "create database tiny" >/dev/null
TINY_URL="postgresql://postgres:$PW@localhost/tiny?host=$E_DIR&port=$E_PORT"
RESTORE_DATABASE_URL="$TINY_URL" RESTORE_BOOTSTRAP=1 bash "$R/restore.sh" "$GOOD" >"$T/rs1.log" 2>&1; rc=$?
expect_rc 0 "restore.sh a base nueva vacía funciona" $rc
RESTORE_DATABASE_URL="$TINY_URL" bash "$R/restore.sh" "$GOOD" >"$T/rs2.log" 2>&1; rc=$?
expect_rc 1 "segunda restauración sobre esquemas ya presentes rechazada" $rc
grep -q "ya tiene esquemas" "$T/rs2.log" && ok "mensaje explica por qué" || bad "mensaje inesperado: $(tail -2 "$T/rs2.log")"

echo "=== E. backup.sh: guardias y secretos ==="
BACKUP_DATABASE_URL="postgresql://postgres:$PW@10.255.255.1/postgres" BACKUP_DEST="$T/bk-remoto" bash "$R/backup.sh" >"$T/bk.log" 2>&1; rc=$?
expect_rc 1 "origen remoto sin cifrar rechazado" $rc
grep -q "sin cifrado" "$T/bk.log" && ok "mensaje pide cifrado" || bad "mensaje inesperado"
[ ! -d "$T/bk-remoto" ] && ok "no se creó nada en el destino" || bad "se creó el destino antes de validar"

# base pequeña con un esquema real de la lista (sin migraciones) para las pruebas rápidas
"${PSQL_E[@]}" -d postgres -c "create database src" >/dev/null
"${PSQL_E[@]}" -d src -c "create schema core; create table core.t(x int); insert into core.t select generate_series(1,50);" >/dev/null
SRC_URL="postgresql://postgres:$PW@localhost/src?host=$E_DIR&port=$E_PORT"
BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-plain" bash "$R/backup.sh" >"$T/bk-plain.log" 2>&1; rc=$?
expect_rc 0 "backup.sh sobre origen local" $rc
grep -q "$PW" "$T/bk-plain.log" && bad "la contraseña apareció en la salida de backup.sh" || ok "sin contraseña en la salida de backup.sh"
grep -rq "$PW" "$T/bk-plain" && bad "la contraseña quedó escrita en el respaldo" || ok "sin contraseña dentro del respaldo"
OUT="$(ls -d "$T"/bk-plain/atiende-*)"
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/manifest.json"));process.exit(m.schemas.join()==="core"&&m.schemas_missing.length===6&&/^\d{4}-/.test(m.created_at)?0:1)' "$OUT" \
  && ok "base atrasada: solo respalda 'core' y declara los 6 esquemas ausentes" || bad "manifest inesperado"
DRILL_REPORT_DIR="$T/rep-tiny" bash "$R/drill.sh" --latest "$T/bk-plain" >"$T/tiny.log" 2>&1; rc=$?
expect_rc 0 "drill --latest sobre ese respaldo" $rc

echo "=== F. cifrado gpg y retención ==="
if command -v gpg >/dev/null 2>&1; then
  export GNUPGHOME="$T/gnupg"; mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-gen-key "drill@example.invalid" default default never >/dev/null 2>&1
  BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-gpg" BACKUP_ENCRYPT=gpg BACKUP_GPG_RECIPIENT="drill@example.invalid" bash "$R/backup.sh" >"$T/gpg.log" 2>&1; rc=$?
  expect_rc 0 "backup cifrado con gpg" $rc
  G="$(ls -d "$T"/bk-gpg/atiende-*)"
  [ -f "$G/dump.pgdump.gpg" ] && [ ! -f "$G/dump.pgdump" ] && ok "solo queda el .gpg (sin texto plano)" || bad "layout cifrado inesperado"
  grep -aq "PGDMP" "$G/dump.pgdump.gpg" && bad "el .gpg contiene el dump en claro" || ok "el .gpg no contiene el dump en claro"
  DRILL_REPORT_DIR="$T/rep-gpg" bash "$R/drill.sh" --backup "$G" >"$T/gpg-drill.log" 2>&1; rc=$?
  expect_rc 0 "drill descifra y restaura el respaldo gpg" $rc
else
  echo "   [SKIP] gpg no disponible"
fi
BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-ret" bash "$R/backup.sh" >/dev/null 2>&1; sleep 1
BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-ret" bash "$R/backup.sh" >/dev/null 2>&1; sleep 1
BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-ret" BACKUP_PRUNE=1 BACKUP_RETENTION_KEEP_LAST=1 BACKUP_RETENTION_DAYS=0 bash "$R/backup.sh" >/dev/null 2>&1
N="$(ls -d "$T"/bk-ret/atiende-* | wc -l | tr -d ' ')"
[ "$N" = 1 ] && ok "retención keep-last=1 dejó 1 de 3 respaldos" || bad "retención dejó $N respaldos"
mkdir -p "$T/bk-ret/otra-cosa"; touch "$T/bk-ret/otra-cosa/x"
BACKUP_DATABASE_URL="$SRC_URL" BACKUP_DEST="$T/bk-ret" BACKUP_PRUNE=1 BACKUP_RETENTION_KEEP_LAST=1 BACKUP_RETENTION_DAYS=0 bash "$R/backup.sh" >/dev/null 2>&1
[ -f "$T/bk-ret/otra-cosa/x" ] && ok "la retención no toca carpetas ajenas" || bad "la retención borró una carpeta ajena"

echo
if [ $FAILS -ne 0 ]; then echo "=== verify-respaldo-drill: GATE FALLIDO ($FAILS) ==="; exit 1; fi
echo "=== verify-respaldo-drill: TODO OK ==="
