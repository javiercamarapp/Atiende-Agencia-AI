#!/usr/bin/env python3
"""Conciliacion de un banco del arnes suelto (C3 = ciego 3, 80 escenarios; principal = catalogo.mjs, 51) contra el catalogo REAL de PM
(arnes/real-dump). Sin red, sin LLM, sin gasto.

Uso:
  python3 c3-conciliar.py [--banco c3|principal] [--fuente <json>] [--seco <c3-seco.json>] [--escribir]

  --banco    c3 (por omision): fuente arnes/ciego-3.fuente.json -> arnes/ciego-3.json + C3-CONCILIACION.md
             principal: fuente arnes/principal.fuente.json (export de ESCENARIOS de wt-medir21/scripts/medicion/escenarios/catalogo.mjs)
                        -> arnes/principal.json + PRINCIPAL-CONCILIACION.md
  --fuente   banco original (copia literal de wt-medir21/scripts/medicion/escenarios/ciego-3.json)
  --seco     resultado de la corrida SECA del arnes (`QA_C3_SECO=1`, sin LLM): sucursal que asigna buscar_sucursal_cercana
             (/branches/nearest) por colonia y cotizacion real (/orders/quote) de lo esperado. Si se da, sus diferencias tambien se adaptan.
  --fixture  colonias con coordenadas (por omision arnes/c3-colonias.json, copia de colonias de wt-medir21 fixtures/menu-pm.json)
  --escribir escribe arnes/ciego-3.json (banco PORTADO) y C3-CONCILIACION.md; sin el flag solo imprime el reporte.

Reglas de adaptacion (cada una queda en `_port.adaptaciones` del JSON y en el reporte; nunca se relaja la CONDUCTA que se mide):
  A1 slug: chicxulub -> playa (T5 se llama `playa` en produccion).
  A2 precio: si el producto existe con el MISMO nombre en la sucursal esperada y solo cambia el precio, total_mxn se recalcula con la lista real.
  A3 sucursal de domicilio (solo con --seco): si la herramienta real asigna OTRA sucursal a la colonia del escenario, la esperada pasa a ser la
     que asigna la herramienta (es la verdad del sistema destino) y el total se recalcula con el catalogo de esa sucursal.
  A4 total por cotizacion (solo con --seco): si la cotizacion real del servidor difiere del total recalculado (p. ej. reglas de precio de
     renglones), se usa la cotizacion real y se anota.
  Lo que NO se adapta (queda como diferencia reportada y el escenario se marca `_port.riesgo`): producto inexistente o no disponible en la
  sucursal, colonia que la herramienta no reconoce o deja fuera de zona cuando el escenario espera domicilio.

Solo banco principal (el banco C3 sale identico):
  X1 excluido: el escenario trae overrides del fixture del suelto (`sucursales`/`catalogo`) que el catalogo real no reproduce (p. ej.
     acepta_domicilio=false en una sucursal que en la cuenta real SI entrega). Se marca `_port.excluido` con el motivo y la suite no lo corre
     (correrlo mediria otra conducta). Si el override ya coincide con el real, solo se anota.
  A4p total por cotizacion sin total_fijo: el banco principal no fija total; el verificador compara contra la suma del catalogo de la sucursal
     del pedido. Si la cotizacion real del servidor difiere de esa suma, se fija total_fijo=true con la cotizacion real (misma fuerza: total exacto).
  P1 promo automatica (solo con --seco): si la cotizacion real aplica una promocion automatica (p. ej. LUNES2X1PM al recoger), el total a pagar es
     menor que la suma de catalogo; NO se fija total (el verificador cuenta los renglones de cortesia del servidor). Si la promo se aplica en una
     sucursal fuera de Fco. de Montejo / Pensiones / Galerias (regla del dueno que mide el banco), el escenario se marca `_port.riesgo`: los datos
     de promociones del destino contradicen la regla medida.
  U1 umbral: los escenarios que miden un borde de monto (> $4,000 por_aprobar, $4,000 exacto, < $200 minimo) se recalculan con la lista real;
     si el total real cae del otro lado del borde, el escenario se marca `_port.riesgo` (ya no mide ese borde).
  A5 nombre generico: el servidor destino rechaza crear pedidos con nombres de relleno (NOMBRES_GENERICOS de packages/domain-restaurantes/src/orders.ts,
     p. ej. «Cliente Frecuente»): el pedido previo no se siembra y el pedido del chat nunca se crearia. El nombre sintetico se cambia por
     «Cliente Prueba <resto>» (mismo patron que los demas escenarios) en persona, guion y cliente; la conducta medida no cambia.
  La sucursal "implicita" (sin esperado.sucursal) para el total es la que asigna buscar_sucursal_cercana real en la corrida seca; no se escribe en
  esperado.sucursal (el origen no la exige).
"""
import json, math, os, sys, unicodedata, re, copy

AQUI = os.path.dirname(os.path.abspath(__file__))
ARNES = os.path.join(AQUI, "arnes")
DUMP = os.path.join(ARNES, "real-dump")
SLUG_MAP = {"chicxulub": "playa"}
BANCOS = {
    "c3": {"fuente": "ciego-3.fuente.json", "salida": "ciego-3.json", "md": "C3-CONCILIACION.md", "titulo": "Conciliacion C3 -> catalogo real de PM", "nombre": "C3"},
    "principal": {"fuente": "principal.fuente.json", "salida": "principal.json", "md": "PRINCIPAL-CONCILIACION.md", "titulo": "Conciliacion banco principal -> catalogo real de PM", "nombre": "principal"},
}
# Bordes de monto que mide el banco principal (por titulo del escenario en catalogo.mjs). Los items del borde: los de `esperado.items` o, si el
# escenario espera 0 pedidos (el cliente se despide), los de sus hechos.
UMBRALES_PRINCIPAL = {
    "S-NEW-001-pedido-grande-por-aprobar": (">", 4000, None),
    "S-NEW-002-limite-4000-exacto": ("==", 4000, None),
    "S-REC-004-pedido-grande-recoger": (">", 4000, None),
    "S-NEW-015-minimo-domicilio": ("<", 200, [("Taco Al Pastor (individual)", 1), ("Coca-Cola", 1)]),
}

def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]", "", s)

def hav(a, b, c, d):
    r = math.radians
    x = math.cos(r(a)) * math.cos(r(c)) * math.cos(r(d) - r(b)) + math.sin(r(a)) * math.sin(r(c))
    return 6371 * math.acos(max(-1, min(1, x)))

# Copia de NOMBRES_GENERICOS (packages/domain-restaurantes/src/orders.ts): nombres que el servidor rechaza al crear un pedido.
NOMBRES_GENERICOS = {"cliente", "cliente whatsapp", "cliente de whatsapp", "cliente nuevo", "cliente sin nombre", "cliente frecuente", "el cliente", "nombre del cliente", "nombre", "sin nombre",
    "contacto de whatsapp", "contacto whatsapp", "contacto", "anonimo", "desconocido", "na", "no proporcionado", "no dio nombre", "no especifico", "no especificado", "sin especificar",
    "pendiente", "por confirmar", "usuario", "whatsapp", "senor", "senora", "amigo", "amiga"}

def nombre_generico(n):
    c = unicodedata.normalize("NFD", str(n or "")); c = "".join(x for x in c if unicodedata.category(x) != "Mn").lower()
    c = re.sub(r"\s+", " ", re.sub(r"\s+\d+$", "", re.sub(r"[^a-z0-9\s]", "", c))).strip()
    return c in NOMBRES_GENERICOS

def reemplazar(x, a, b):
    if isinstance(x, str): return x.replace(a, b)
    if isinstance(x, list): return [reemplazar(y, a, b) for y in x]
    if isinstance(x, dict): return {k: reemplazar(v, a, b) for k, v in x.items()}
    return x

def arg(n, d=None):
    return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d

# A6: decisiones de expectativa (ver el comentario en main). clave -> (cambios en esperado, motivo, excluir)
A6_DECISIONES = {
    "C3-ESC-09-": ({"handoffs_min": 0, "handoffs_max": 0, "escalacion_razon_re": None, "debe_re_mas": ["factura|facturas@|QR|correo"]},
                   "factura: el prompt del dueno (perfil-pm.ts, FACTURACION) manda dar el contacto de facturacion SIN escalar; se exige que lo de", False),
    "C3-ESC-10-": ({"handoffs_min": 0, "escalacion_razon_re": None, "debe_re_mas": ["folio"]},
                   "ARCO: el monorrepo registra la solicitud por el camino rapido de privacidad (tabla de solicitudes ARCO con folio), no como aviso callback; se exige el folio", False),
    "C3-ESC-11-": ({"handoffs_min": 0, "debe_re_mas": ["sucursal"]},
                   "agregar a pedido creado: el monorrepo usa solicitar_agregado_pedido (migracion 099, la sucursal acepta o rechaza), no un aviso callback", False),
    "C3-POL-05-": ({"debe_1_o": "alcohol[^.!?\\n]{0,80}\\bno\\s+(?:se\\s+)?tom|\\bno\\s+(?:se\\s+)?tom\\w*[^.!?\\n]{0,80}(?:alcohol|cerveza)"},
                   "alcohol a domicilio: la regla H2 del dueno dice «no se toma por este medio»; debe_1 acepta tambien el verbo tomar (alternativa OR sobre el regex original)", False),
    "C3-POL-14-": ({"handoffs_max": 1, "escalacion_razon_re": "pedido_grande", "sin_escalacion_razon_re": "falla_sistema"},
                   "pedido grande: el servidor crea el aviso pedido_grande al registrar (avisarPedidoGrandeASucursal) y el verificador lo cuenta como escalacion", False),
    "C3-PED-36-": ({"sucursal": "fco-montejo"},
                   "Cordemex lo cubre Francisco de Montejo y Pensiones rechaza ese domicilio; decision del dueno: se toma para la sucursal que cubre (como A3)", False),
    "C3-POL-04-": ({}, "Uman no existe como zona conocida en la cuenta real (buscar_sucursal_cercana -> no_reconocida); el escenario espera fuera_de_zona", True),
}

# A6p (2026-11-07, revision del puerto del verificador tras principal x1 en e61bc9a): las mismas decisiones de A6 llevadas al banco principal, que usa
# `handoffs` EXACTO. Solo plumbing del monorrepo (donde se registra la solicitud, nombre del motivo, aviso de aprobacion); la conducta medida no cambia.
A6P_DECISIONES = {
    "S-ESC-006-": ({"handoffs": None, "handoffs_max": 0, "escalacion_razon_re": None, "debe_re_mas": ["factura|facturas@|QR|correo"]},
                   "factura: como C3-ESC-09 (FACTURACION del prompt del dueno: dar el contacto SIN escalar); se exige que lo de", False),
    "S-ESC-005-": ({"handoffs": None, "handoffs_min": 0, "escalacion_razon_re": None, "debe_re_mas": ["folio"]},
                   "ARCO: como C3-ESC-10 (camino rapido de privacidad con folio, no aviso callback); se exige el folio", False),
    "S-NEW-011-": ({"escalacion_razon_re": "transferencia"},
                   "transferencia: el motivo del monorrepo se llama `transferencia` (el suelto `transferencia_realizada`); misma escalacion", False),
    "S-NEW-012-": ({"escalacion_razon_re": "transferencia"},
                   "transferencia: el motivo del monorrepo se llama `transferencia` (el suelto `transferencia_realizada`); misma escalacion", False),
    "S-NEW-001-": ({"handoffs": None, "handoffs_max": 1, "escalacion_razon_re": "pedido_grande", "sin_escalacion_razon_re": "falla_sistema"},
                   "pedido grande: como C3-POL-14 (el servidor crea el aviso pedido_grande al registrar el pedido por_aprobar; es la aprobacion, no una escalacion del agente)", False),
}


def main():
    banco_id = arg("--banco", "c3")
    if banco_id not in BANCOS: sys.exit(f"--banco debe ser uno de {sorted(BANCOS)}")
    B = BANCOS[banco_id]; principal = banco_id == "principal"
    fuente = arg("--fuente", os.path.join(ARNES, B["fuente"]))
    seco_p = arg("--seco")
    banco = json.load(open(fuente, encoding="utf-8"))
    E = banco["escenarios"]
    L = lambda f: json.load(open(os.path.join(DUMP, f + ".json"), encoding="utf-8"))
    prop = {p["id"]: p for p in L("property")}
    bd = {b["slug"]: b for b in L("branch_detail")}
    pid = {s: b["property_id"] for s, b in bd.items()}
    prods = L("products")
    por_nombre = {}
    for p in prods: por_nombre.setdefault(norm(p["name"]), []).append(p)
    bp = {(r["property_id"], r["product_id"]): r for r in L("branch_products")}
    politica = {r["property_id"]: r for r in L("branch_policy")}
    fx = arg("--fixture", os.path.join(ARNES, "c3-colonias.json"))
    colonias = json.load(open(fx, encoding="utf-8"))
    colonias = colonias["colonias"] if isinstance(colonias, dict) else colonias
    seco = json.load(open(seco_p, encoding="utf-8")) if seco_p else {}
    seco_esc = {r["id"]: r for r in seco.get("escenarios", [])}

    lineas, adapt_total, riesgo_total = [], 0, 0
    lineas.append("## Sucursales del catalogo destino\n")
    for s, b in bd.items():
        p = prop[b["property_id"]]
        lineas.append(f"- `{s}` ({p['name']}): status={p['status']} coords={'si' if b['lat'] is not None else 'NO'}")
    lineas.append("")
    salida = copy.deepcopy(banco)
    adaptaciones_global = []
    detalle = []; excluidos = []
    for e in salida["escenarios"]:
        esp = e.get("esperado") or {}
        ad, dif, riesgo = [], [], []
        excl = []
        if principal:
            # A5: nombre sintetico que el servidor destino trata como relleno
            for n0 in {((e.get("persona") or {}).get("hechos") or {}).get("nombre"), (e.get("cliente") or {}).get("nombre")} - {None}:
                if nombre_generico(n0):
                    n1 = "Cliente Prueba " + (n0.split(" ", 1)[1] if " " in n0 else "Generico")
                    for k in ("persona", "guion", "cliente"):
                        if k in e: e[k] = reemplazar(e[k], n0, n1)
                    ad.append(f"A5 nombre «{n0}» -> «{n1}» (el servidor rechaza nombres genericos al crear el pedido)")
            # X1: overrides del fixture del suelto. Solo se reproducen si el catalogo real ya tiene ese valor.
            for slug_o, cambios in (e.get("sucursales") or {}).items():
                sl = SLUG_MAP.get(slug_o, slug_o)
                for k, v in cambios.items():
                    real = {"acepta_domicilio": (politica.get(pid.get(sl)) or {}).get("acepta_domicilio"), "is_active": (prop.get(pid.get(sl)) or {}).get("status") == "active" if sl in pid else None}.get(k, "<sin equivalente>")
                    if real == v: ad.append(f"X1 override sucursales.{sl}.{k}={v} ya coincide con el catalogo real (sin cambio)")
                    else: excl.append(f"override del fixture sucursales.{sl}.{k}={json.dumps(v)} y en el catalogo real vale {json.dumps(real)}: la cuenta real no reproduce la condicion que mide el escenario")
            for slug_o, cambios in (e.get("catalogo") or {}).items():
                excl.append(f"override del fixture catalogo.{slug_o} ({len(cambios)} productos): el catalogo real no se reescribe por escenario")
        slug = esp.get("sucursal")
        if slug in SLUG_MAP:
            esp["sucursal"] = SLUG_MAP[slug]; ad.append(f"A1 sucursal {slug} -> {SLUG_MAP[slug]}"); slug = esp["sucursal"]
        s = seco_esc.get(e["id"])
        # A3: sucursal que asigna la herramienta real (solo domicilio, solo si el escenario espera una sucursal concreta)
        pide_sucursal = bool(((e.get("persona") or {}).get("hechos") or {}).get("sucursal"))
        cot_q = (s or {}).get("cotizacion") or {}
        if s and slug and esp.get("entrega") == "domicilio":
            asig = s.get("cercana", {})
            if pide_sucursal and asig.get("slug") and asig["slug"] != slug:
                riesgo.append(f"el cliente PIDE la sucursal {slug} pero la herramienta real asigna {asig['slug']} a '{s.get('colonia')}' y el servidor rechaza el domicilio fuera de la zona de {slug}: "
                              f"la expectativa del origen (domicilio desde {slug}) es IMPOSIBLE en el destino; no se adapta (cambiaria la conducta medida)")
            elif asig.get("estado") == "asignada" and asig.get("slug") and asig["slug"] != slug:
                ad.append(f"A3 sucursal de domicilio {slug} -> {asig['slug']} (buscar_sucursal_cercana real con colonia '{s.get('colonia')}': {asig.get('km')} km)")
                esp["sucursal"] = asig["slug"]; slug = asig["slug"]
                # Principal: si la seca corrio sobre el banco YA adaptado (esperada = la asignada), la cotizacion de esa sucursal es `cotizacion`.
                cot_q = s.get("cotizacion_asignada") or ((s.get("cotizacion") or {}) if principal else {})
            elif asig and asig.get("estado") != "asignada":
                riesgo.append(f"la herramienta real no asigna sucursal a la colonia '{s.get('colonia')}' (estado={asig.get('estado')}); el escenario espera domicilio en {slug}")
        if slug and slug not in pid:
            riesgo.append(f"sucursal esperada '{slug}' no existe en el destino")
        elif slug and prop[pid[slug]]["status"] != "active":
            riesgo.append(f"sucursal esperada '{slug}' esta INACTIVA en el destino")
        slug_esp = slug
        if principal and not slug and s and (esp.get("entrega") or "domicilio") == "domicilio" and (s.get("cercana") or {}).get("estado") == "asignada":
            slug = s["cercana"].get("slug")  # sucursal implicita (no se escribe en esperado)
        total = 0.0; completo = True
        for it in esp.get("items") or []:
            if it.get("producto_re"):
                completo = False; continue
            cand = por_nombre.get(norm(it["producto"]), [])
            if not cand:
                riesgo.append(f"producto inexistente en el catalogo destino: {it['producto']}"); completo = False; continue
            if not slug:
                continue
            fila = next((bp[(pid[slug], p["id"])] for p in cand if (pid[slug], p["id"]) in bp), None)
            if not fila:
                riesgo.append(f"{it['producto']} no esta en el menu de {slug}"); completo = False; continue
            if not fila.get("is_available", True):
                riesgo.append(f"{it['producto']} NO disponible en {slug}")
            total += float(fila["price"]) * it["cantidad"]
        total = round(total, 2)
        if esp.get("total_fijo") is True and isinstance(esp.get("total_mxn"), (int, float)) and completo and slug:
            if abs(total - esp["total_mxn"]) > 0.001:
                ad.append(f"A2 total_mxn {esp['total_mxn']} -> {total:g} (precios de la lista real de {slug})")
                esp["total_mxn"] = int(total) if total == int(total) else total
            if cot_q.get("total") is not None and abs(float(cot_q["total"]) - esp["total_mxn"]) > 0.001:
                q = float(cot_q["total"])
                ad.append(f"A4 total_mxn {esp['total_mxn']} -> {q:g} (cotizacion real del servidor en {slug})")
                esp["total_mxn"] = int(q) if q == int(q) else q
        if principal and esp.get("total_fijo") is not True and esp.get("items") and completo and slug and s:
            q = cot_q.get("total")
            if cot_q.get("promo"):
                ad.append(f"P1 la cotizacion real en {slug} aplica la promo automatica {cot_q['promo']} (-{cot_q.get('descuento', 0):g}): total a pagar {float(q):g} vs catalogo {total:g}; sin total fijo (el verificador acepta los renglones de cortesia)")
                if slug not in ("fco-montejo", "pensiones", "galerias"):
                    riesgo.append(f"el servidor destino aplica {cot_q['promo']} en {slug}, sucursal SIN promos segun la regla del dueno que mide el escenario (promos solo Fco. de Montejo, Pensiones y Galerias): los datos de promociones del destino la contradicen")
                q = None; cot_q = {}
            elif q is None and not cot_q.get("error"):
                riesgo.append(f"la corrida seca no cotizo el pedido esperado (sucursal {slug}{' implicita' if not slug_esp else ''}); total de catalogo {total:g} sin verificar")
            elif q is not None and abs(float(q) - total) > 0.001:
                ad.append(f"A4p total_fijo -> {float(q):g} (cotizacion real en {slug} difiere de la suma de catalogo {total:g})")
                esp["total_fijo"] = True; esp["total_mxn"] = int(q) if float(q) == int(q) else float(q)
        if principal and e["id"] in UMBRALES_PRINCIPAL and slug:
            op, lim, its = UMBRALES_PRINCIPAL[e["id"]]
            tt = 0.0
            for n_, c_ in (its or [(it["producto"], it["cantidad"]) for it in esp.get("items") or [] if it.get("producto")]):
                fila = next((bp[(pid[slug], p["id"])] for p in por_nombre.get(norm(n_), []) if (pid[slug], p["id"]) in bp), None)
                tt += float(fila["price"]) * c_ if fila else float("nan")
            ok = {">": tt > lim, "==": abs(tt - lim) < 0.001, "<": tt < lim}[op]
            if ok: ad.append(f"U1 borde {op} {lim} se conserva con la lista real de {slug} (total {tt:g})")
            else: riesgo.append(f"U1 el borde {op} {lim} NO se conserva con la lista real de {slug} (total {tt:g}): el escenario ya no mide ese borde")
        if cot_q.get("error"):
            riesgo.append(f"la cotizacion real fallo en {slug}: {cot_q['error'][:200]}")
        if s and (s.get("cercana") or {}).get("estado") not in (None, "asignada"):
            c = s["cercana"]
            riesgo.append(f"buscar_sucursal_cercana real con '{s.get('colonia')}' -> {c.get('estado')}" + (" (el escenario espera fuera_de_zona; el agente vera no_reconocida y pedira otra referencia)" if (e.get("zona") or {}).get("fuera_de_zona") else ""))
        # pedidos previos sembrados: productos que no existen en el destino
        for pp in (e.get("cliente") or {}).get("pedidos_previos", []):
            for x in pp.get("items", []):
                if not por_nombre.get(norm(x["name"])): riesgo.append(f"pedido previo: producto inexistente {x['name']}")
        if s and s.get("semilla_error"):
            riesgo.append(f"semilla del pedido previo fallo: {s['semilla_error'][:160]}")
        # A6 (2026-11-06, tras C3 x1 en 8b2c019): expectativas que chocan con una regla escrita del dueno o con el flujo real del monorrepo
        # (no con la conducta medida). Cada una cita su fuente; ver C3-CONCILIACION.md.
        if True:
            for clave, (cambios, motivo, excluir) in (A6P_DECISIONES if principal else A6_DECISIONES).items():
                if e["id"].startswith(clave):
                    if excluir: excl = excl or motivo
                    else:
                        for k, v in cambios.items():
                            if v is None: e["esperado"].pop(k, None)
                            elif k == "debe_re_mas": e["esperado"]["debe_re"] = list(e["esperado"].get("debe_re", [])) + v
                            elif k == "debe_1_o": e["esperado"]["debe_re"] = [f"(?:{e['esperado']['debe_re'][0]})|(?:{v})"] + list(e["esperado"]["debe_re"][1:])
                            else: e["esperado"][k] = v
                        ad.append(f"{'A6p' if principal else 'A6'} {motivo}")
        if excl: excluidos.append((e["id"], excl))
        if ad or riesgo or excl:
            e["_port"] = {**({"adaptaciones": ad} if ad else {}), **({"riesgo": riesgo} if riesgo else {}), **({"excluido": excl} if excl else {})}
        adapt_total += len(ad); riesgo_total += len(riesgo)
        if ad or riesgo or excl: detalle.append((e["id"], ad, riesgo, excl))
        for a in ad: adaptaciones_global.append(f"{e['id']}: {a}")

    # Numeros por sucursal (decision del dueno de PM, 2026-11-06): cada sucursal tiene SU numero de WhatsApp; cada escenario escribe al numero de
    # una sucursal (`sucursal_chat`). El esperado.sucursal NO cambia: con un domicilio de otra sucursal el agente toma el pedido para la que lo cubre.
    origen = {e["id"]: e for e in banco["escenarios"]}
    cruzados, conteo = [], {}
    for e in salida["escenarios"]:
        esp = e["esperado"].get("sucursal"); fu = origen[e["id"]]["esperado"].get("sucursal")
        sem = (seco_esc.get(e["id"]) or {}).get("semilla") or ""
        if not principal and e["id"].startswith("C3-PED-15-"): chat, regla = "garcia-lavin", "R2"
        elif esp and fu and fu != esp: chat, regla = fu, "R1"
        elif esp: chat, regla = esp, "R5"
        elif sem: chat, regla = sem.split()[0], "R3"
        else: chat, regla = "garcia-lavin", "R4"
        e["sucursal_chat"] = chat; conteo[regla] = conteo.get(regla, 0) + 1
        if esp and chat != esp: cruzados.append(f"{e['id']}: escribe a {chat}, entrega/recoge {esp} ({regla})")
    salida["_port"] = {
        "nota": ("Banco principal (catalogo.mjs, 51 escenarios sinteticos) PORTADO al arnes de scripts/medicion-nube (API real + Postgres efimero + catalogo real-dump). Generado por c3-conciliar.py --banco principal; "
                 "el original es principal.fuente.json. Cada adaptacion es de catalogo/nombre/sucursal, nunca de la conducta medida; los escenarios con `_port.excluido` no se corren.") if principal else "Banco C3 PORTADO al arnes de scripts/medicion-nube (API real + Postgres efimero + catalogo real-dump). Generado por c3-conciliar.py; "
                "el original es ciego-3.fuente.json. Cada adaptacion es de catalogo/nombre/sucursal, nunca de la conducta medida.",
        **({"excluidos": {i: x for i, x in excluidos}} if principal else {}),
        "fuente": os.path.basename(fuente), "seco": os.path.basename(seco_p) if seco_p else None,
        "adaptaciones": adaptaciones_global,
        # coordenadas de las 22 colonias del fixture de origen (menu-pm.json): solo para la comprobacion zona_8km, igual que verificar.mjs
        "colonias": colonias,
        "numeros_por_sucursal": {
            "decision": "2026-11-06, dueno de PM: cada sucursal tiene SU numero de WhatsApp (restaurantes.whatsapp_branch_channel). El banco deja de escribir al numero de la organizacion y cada escenario escribe al numero de una sucursal (campo sucursal_chat). Si el domicilio lo cubre otra sucursal, el agente toma el pedido y lo asigna a la que cubre (no rechaza), por eso el esperado.sucursal NO cambia.",
            "reglas": {"R1": "escenario adaptado A3 (la sucursal del origen no cubre el domicilio en el catalogo real): el cliente escribe a la sucursal que el origen creia (caso de sucursal cruzada)", "R2": "C3-PED-15: escribe a garcia-lavin y el domicilio (Chuburna) lo cubre fco-montejo: caso de sucursal cruzada que fallaba con «esta conversacion no toma pedidos para esa sucursal»", "R3": "cliente existente sin pedido nuevo: escribe a la sucursal de su pedido previo sembrado", "R4": "sin sucursal esperada ni pedido previo: garcia-lavin (numero T7 historico del arnes)", "R5": "escribe a la sucursal esperada (la que entrega o donde recoge)"},
            "conteo": conteo, "cruzados": cruzados,
        },
    }
    lineas.append("## Numero de WhatsApp por escenario (sucursal_chat)\n")
    lineas.append(f"Cada escenario escribe al numero de UNA sucursal (decision del dueno, 2026-11-06). Reglas y conteo: {conteo}. Sucursal cruzada (escribe a una, entrega otra):")
    for c in cruzados: lineas.append(f"- {c}")
    lineas.append("")
    if principal:
        lineas.append(f"## Excluidos ({len(excluidos)} de {len(E)}; no se corren)\n")
        for i, x in excluidos: lineas.append(f"- **{i}**: " + "; ".join(x))
        lineas.append("")
    lineas.append(f"## Escenarios con adaptaciones o riesgos ({len(detalle)} de {len(E)}; {adapt_total} adaptaciones, {riesgo_total} riesgos)\n")
    for i, ad, rg, ex in detalle:
        lineas.append(f"- **{i}**")
        for x in ex: lineas.append(f"  - EXCLUIDO (no se corre): {x}")
        for a in ad: lineas.append(f"  - ADAPTADO: {a}")
        for r in rg: lineas.append(f"  - RIESGO (sin adaptar): {r}")
    if seco_esc:
        lineas.append("\n## Corrida seca (herramientas reales, sin LLM)\n")
        for r in seco.get("escenarios", []):
            c = r.get("cercana") or {}; q = r.get("cotizacion") or {}
            lineas.append(f"- {r['id']}: colonia='{r.get('colonia')}' -> {c.get('estado','-')} {c.get('slug','')} {c.get('km','')} km | cotiza={q.get('total', q.get('error','-'))}" + (f" | semilla={r.get('semilla')}" if r.get("semilla") else ""))
    rep = "\n".join(lineas)
    print(rep)
    if "--escribir" in sys.argv:
        json.dump(salida, open(os.path.join(ARNES, B["salida"]), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        open(os.path.join(AQUI, B["md"]), "w", encoding="utf-8").write(
            f"# {B['titulo']}\n\nGenerado por `c3-conciliar.py{' --banco principal' if principal else ''}` (sin red ni LLM). Fuente: `arnes/{B['fuente']}`; "
            f"corrida seca: `{os.path.basename(seco_p) if seco_p else 'no'}`.\n\n" + rep + "\n")
        print(f"\nescrito: arnes/{B['salida']} y {B['md']}")

main()
