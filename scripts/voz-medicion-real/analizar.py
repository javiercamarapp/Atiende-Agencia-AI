#!/usr/bin/env python3
"""Resume las repeticiones del arnes de voz real: acierto con IC, por escenario, latencia por turno y causas de fallo.
Uso: python3 analizar.py <carpeta con voz-real-<etq>-rep<N>.json> [etq=main] [--md]
Solo biblioteca estandar (Python 3.9+)."""
import glob, json, math, os, random, re, sys

carpeta = sys.argv[1]
etq = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "main"
archivos = sorted(glob.glob(os.path.join(carpeta, f"voz-real-{etq}-rep[0-9]*.json")))
archivos = [a for a in archivos if not a.endswith(".jsonl") and not re.search(r"rep0\.json$", a)]
reps = {}
for a in archivos:
    n = re.search(r"rep(\d+)\.json$", a).group(1)
    try:
        datos = json.load(open(a))
    except ValueError as e:
        sys.exit(f"ERROR: {a} no es JSON valido ({e}); revisalo antes de analizar")
    if not isinstance(datos, list):
        sys.exit(f"ERROR: {a} no contiene una lista de resultados")
    reps[n] = datos
filas = [dict(r, rep=n) for n, rs in reps.items() for r in rs]
if not filas:
    sys.exit(f"No hay resultados en {carpeta} para la etiqueta {etq!r}")


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def pct(xs, p):
    if not xs:
        return None
    a = sorted(xs)
    return a[min(len(a) - 1, int(p * len(a)))]


def f(x):
    return "-" if x is None else f"{x:.0f}"


def bootstrap(por_esc, B=4000, seed=7):
    rnd = random.Random(seed)
    ids = list(por_esc)
    vals = []
    for _ in range(B):
        k = n = 0
        for _ in ids:
            e = por_esc[rnd.choice(ids)]
            k += sum(e)
            n += len(e)
        vals.append(k / n)
    vals.sort()
    return vals[int(0.025 * B)], vals[int(0.975 * B)]


# Una llamada con caida o respuesta vacia del LLM (infra), un juez sin respuesta o una excepcion del arnes NO es evidencia del agente: no cuenta como acierto NI como fallo; se reporta aparte.
invalida = lambda r: bool(r.get("invalida")) or r.get("veredicto") == "INVALIDA" or bool(r.get("infra")) or bool(r.get("excepcion"))
ok = lambda r: r.get("veredicto") == "PASA" and not invalida(r)
todas = filas
inval = [r for r in todas if invalida(r)]
filas = [r for r in todas if not invalida(r)]
modelos = sorted(set(str(r.get("modelo", "?")) for r in todas))
no_oficiales = [r for r in todas if r.get("sinZdr") or r.get("oficial") is False]
print(f"Modelo(s): {', '.join(modelos)}")
if no_oficiales:
    print(f"- **AVISO: {len(no_oficiales)} llamadas NO OFICIALES (VOZ_SIN_ZDR=1, sin retencion cero): no usar como medicion de produccion**")
total_esc = max([r.get("totalEscenarios", 0) for r in todas] + [0])
hay_filtro = any(r.get("filtro") for r in todas)
for n, rs in sorted(reps.items()):
    ids = set(r["id"] for r in rs if not invalida(r))  # un escenario invalido no esta medido
    if total_esc and len(ids) < total_esc and not hay_filtro:
        print(f"- **AVISO: repeticion {n} INCOMPLETA: {len(ids)}/{total_esc} escenarios medidos (cortada por tope, interrumpida o con llamadas invalidas); su tasa no es comparable con una completa**")
if inval:
    print(f"- **{len(inval)} llamadas INVALIDAS por infraestructura (LLM caido/vacio, juez sin respuesta o excepcion del arnes), fuera de la tasa y por reintentar**: {', '.join(sorted(set(r['id'] for r in inval)))}")
tot, pas = len(filas), sum(ok(r) for r in filas)
if tot == 0:
    sys.exit("No hay llamadas validas para calcular la tasa (todas invalidas o ninguna).")
print(f"## Acierto global ({len(reps)} repeticiones, {len(set(r['id'] for r in filas))} escenarios, {tot} llamadas validas)\n")
lo, hi = wilson(pas, tot)
por_esc = {}
for r in filas:
    por_esc.setdefault(r["id"], []).append(1 if ok(r) else 0)
blo, bhi = bootstrap(por_esc)
print(f"- ACIERTO ESTRICTO (checks deterministas + juez PASA): **{pas}/{tot} = {100*pas/tot:.1f} %**; IC95 Wilson sobre llamadas {100*lo:.1f}-{100*hi:.1f} %; IC95 bootstrap por escenario {100*blo:.1f}-{100*bhi:.1f} %")
con_hard = [r for r in filas if "hard" in r]  # las excepciones no traen "hard": no cuentan como si no hubieran fallado
hard_ok = sum(1 for r in con_hard if not r["hard"])
juez_ok = sum(1 for r in filas if r.get("juez") == "PASA")
nh = len(con_hard)
print(f"- Solo checks deterministas: {hard_ok}/{nh} = {100*hard_ok/nh if nh else 0:.1f} %  |  solo juez: {juez_ok}/{tot} = {100*juez_ok/tot:.1f} %")
for n, rs in sorted(reps.items()):
    vs = [r for r in rs if not invalida(r)]
    k = sum(ok(r) for r in vs)
    print(f"- Repeticion {n}: {k}/{len(vs)} = {100*k/len(vs) if vs else 0:.1f} %")
estables = sum(1 for v in por_esc.values() if all(v))
print(f"- Escenarios que pasan en TODAS las repeticiones: {estables}/{len(por_esc)}; los que fallan al menos una vez: {len(por_esc)-estables}")
excep = [r for r in todas if r.get("excepcion")]
if excep:
    print(f"- Excepciones del arnes (INVALIDAS, fuera de la tasa): {len(excep)}")

print("\n## Por escenario\n")
print("| Escenario | Pasa | Causas de fallo (juez) | Motivo (ultimo fallo) |")
print("|---|---|---|---|")
for i in sorted(por_esc):
    rs = [r for r in filas if r["id"] == i]
    k = sum(ok(r) for r in rs)
    causas = ",".join(sorted(set(r.get("causa", "?") for r in rs if not ok(r)))) or "-"
    ult = next((r for r in reversed(rs) if not ok(r)), None)
    mot = (ult.get("motivo") or "")[:110].replace("|", "/") + (" HARD: " + "; ".join(ult["hard"])[:80].replace("|", "/") if ult and ult.get("hard") else "") if ult else ""
    t = rs[0]["titulo"][:52]
    print(f"| {i} {t} | {k}/{len(rs)} | {causas} | {mot} |")

print("\n## Causas de fallo\n")
c = {}
for r in filas:
    if not ok(r):
        c[r.get("causa", "?")] = c.get(r.get("causa", "?"), 0) + 1
for k2, v in sorted(c.items(), key=lambda x: -x[1]):
    print(f"- {k2}: {v}")
print(f"- Llamadas con eventos de infraestructura del LLM (caida/vacia), excluidas arriba: {len(inval)}")

print("\n## Latencia por turno (texto del cliente -> agente; SIN STT ni TTS)\n")
pf = [x for r in filas for x in r.get("msPrimeraFrase", [])]
mt = [x for r in filas for x in r.get("msTurno", [])]
conh = [(x, h) for r in filas for x, h in zip(r.get("msPrimeraFrase", []), r.get("conHerramienta", []))]
print("| Medida | n | p50 ms | p95 ms |")
print("|---|---|---|---|")
print(f"| Primera frase del agente | {len(pf)} | {f(pct(pf,.5))} | {f(pct(pf,.95))} |")
print(f"| Turno completo (hasta la ultima frase) | {len(mt)} | {f(pct(mt,.5))} | {f(pct(mt,.95))} |")
sin = [x for r in filas for x, h in zip(r.get("msTurno", []), r.get("conHerramienta", [])) if not h]
con = [x for r in filas for x, h in zip(r.get("msTurno", []), r.get("conHerramienta", [])) if h]
print(f"| Turno completo SIN herramienta | {len(sin)} | {f(pct(sin,.5))} | {f(pct(sin,.95))} |")
print(f"| Turno completo CON herramienta | {len(con)} | {f(pct(con,.5))} | {f(pct(con,.95))} |")
tl = [x for r in filas for x in r.get("toolLatMs", [])]
print(f"| Herramienta (HTTP local) | {len(tl)} | {f(pct(tl,.5))} | {f(pct(tl,.95))} |")
pw = [x for r in filas for x in r.get("palabrasAgente", [])]
print(f"\nPalabras por turno del agente: p50 {f(pct(pw,.5))}, p95 {f(pct(pw,.95))}; turnos de mas de 45 palabras: {sum(1 for x in pw if x>45)}/{len(pw)}")

print("\n## Costo\n")
ag = sum(r.get("llmUsd", 0) for r in todas)
print(f"- LLM del agente (usage.cost de OpenRouter, suma de las {len(todas)} llamadas, validas e invalidas): ${ag:.2f}  (${ag/max(len(todas),1):.3f} por llamada)")
for a in sorted(glob.glob(os.path.join(carpeta, f"voz-real-{etq}-rep*.json.gasto.jsonl"))):
    for l in open(a):
        j = json.loads(l)
        print(f"- corrida rep{j['rep']}: agente ${j.get('agenteUsd',0):.3f} + cliente/juez ${j.get('clienteJuezUsd',0):.3f} = ${j.get('cuentaPropiaUsd',0):.3f}; delta /key ${j['deltaUsd']:.3f}; cortado={j['cortado']}")
