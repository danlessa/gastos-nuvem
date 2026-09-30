#!/usr/bin/env python3
"""Coleta os custos diários de GCP, Cloudflare R2 e Magalu Cloud e gera o JSON
do painel (abiru.to/gastos-nuvem).

Duas etapas:

1. **collect** — para cada provedor, busca uma janela recente (por padrão desde
   o 1º dia do mês anterior, para pegar ajustes/créditos atrasados) e a grava
   por cima do histórico bruto em ``data/raw/<provedor>.json``. O histórico é
   versionado no git porque o R2 só guarda ~90 dias de métricas.
2. **build** — aplica ``mapping.toml`` sobre o histórico bruto, converte tudo
   para USD (PTAX do BCB) e escreve ``site/data/costs.json``.

Só usa a biblioteca padrão. Credenciais (todas opcionais — provedor sem
credencial é pulado com aviso e mantém o histórico que já existe):

- GCP: ``GCP_ACCESS_TOKEN`` ou ``gcloud auth print-access-token``.
- Cloudflare: ``CLOUDFLARE_API_TOKEN`` (Account Analytics: Read) +
  ``CLOUDFLARE_ACCOUNT_ID``; localmente cai no login OAuth do wrangler.
- Magalu: ``MGC_API_KEY`` (chave com a aplicação *tally-consumption-api*).

Uso::

    python3 collect.py                    # janela padrão + build
    python3 collect.py --since 2026-06-01 # backfill
    python3 collect.py --only r2,fx       # só alguns provedores
    python3 collect.py --build-only       # só regenera o JSON do site
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "site" / "data" / "costs.json"
MAPPING = ROOT / "mapping.toml"

# ── GCP ──────────────────────────────────────────────────────────────────────
GCP_PROJECT = os.environ.get("GCP_BILLING_PROJECT", "pedal-hidrografico")
GCP_TABLE = os.environ.get(
    "GCP_BILLING_TABLE",
    "pedal-hidrografico.billing_export.gcp_billing_export_resource_v1_015CF8_384D2A_5CE27E",
)
GCP_LOCATION = os.environ.get("GCP_BILLING_LOCATION", "southamerica-east1")

# ── Cloudflare R2 — preços de lista (Standard), USD ──────────────────────────
# https://developers.cloudflare.com/r2/pricing/  (1 GB = 2^30 bytes)
R2_PRICE = {"storage": 0.015, "A": 4.50 / 1e6, "B": 0.36 / 1e6}  # GB-mês / op
R2_FREE = {"storage": 10.0, "A": 1e6, "B": 10e6}  # por mês, por conta
R2_RETENTION_DAYS = 89  # o GraphQL recusa consultas além de ~12w6d
R2_CLASS_A = {
    "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
    "CompleteMultipartUpload", "CreateMultipartUpload", "ListMultipartUploads",
    "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption",
    "PutBucketCors", "PutBucketLifecycleConfiguration",
    "LifecycleStorageTierTransition",
}
R2_FREE_OPS = {"DeleteObject", "DeleteBucket", "AbortMultipartUpload"}
R2_SERVICE = {"storage": "R2 armazenamento", "A": "R2 operações classe A", "B": "R2 operações classe B"}

# ── Magalu ───────────────────────────────────────────────────────────────────
MGC_URL = "https://api.magalu.cloud/consumption/usage"

# ── PTAX (BRL por USD, cotação de venda) ─────────────────────────────────────
PTAX_URL = (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
    "CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)"
)


def load_dotenv() -> None:
    """Lê ``.env`` (KEY=valor) sem sobrescrever o ambiente — só para uso local."""
    p = ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http_json(url: str, *, data: dict | None = None, headers: dict | None = None, timeout: int = 120):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "gastos-nuvem (+https://abiru.to/gastos-nuvem)")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} em {url.split('?')[0]}: {e.read()[:400].decode(errors='replace')}") from None


def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def month_start(d: date) -> date:
    return d.replace(day=1)


# ── histórico bruto ──────────────────────────────────────────────────────────
# Linha bruta: [data, projeto, serviço, recurso, valor, moeda]


def load_raw(name: str) -> dict:
    p = RAW / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return {"rows": [], "updated_at": None}


def save_raw(name: str, doc: dict) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    doc["rows"].sort(key=lambda r: tuple(str(x) for x in r[:4]))
    lines = ",\n".join(json.dumps(r, ensure_ascii=False) for r in doc["rows"])
    meta = {k: v for k, v in doc.items() if k != "rows"}
    head = json.dumps(meta, ensure_ascii=False)[:-1]
    sep = ", " if meta else ""
    (RAW / f"{name}.json").write_text(f'{head}{sep}"rows": [\n{lines}\n]}}\n')


def merge_raw(name: str, rows: list, start: date, end: date) -> None:
    """Substitui as linhas de [start, end] pelas recém-coletadas."""
    doc = load_raw(name)
    s, e = start.isoformat(), end.isoformat()
    kept = [r for r in doc["rows"] if not (s <= r[0] <= e)]
    doc["rows"] = kept + rows
    doc["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # "covered_from": desde quando o provedor foi consultado (dias sem custo
    # não geram linhas, então a primeira linha não diz isso)
    doc["covered_from"] = min(filter(None, [doc.get("covered_from"), s]))
    doc["first"] = min((r[0] for r in doc["rows"]), default=None)
    doc["last"] = max((r[0] for r in doc["rows"]), default=None)
    save_raw(name, doc)
    log(f"  {name}: {len(rows)} linhas em {s}..{e}; histórico com {len(doc['rows'])}")


# ── GCP ──────────────────────────────────────────────────────────────────────


def gcp_token() -> str:
    tok = os.environ.get("GCP_ACCESS_TOKEN")
    if tok:
        return tok
    out = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True)
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError("sem credencial GCP (GCP_ACCESS_TOKEN ou gcloud auth)")
    return out.stdout.strip()


def collect_gcp(start: date, end: date) -> list:
    tok = gcp_token()
    hdr = {"Authorization": f"Bearer {tok}"}
    # Custo líquido = custo + créditos (free tier, descontos). Recurso = os dois
    # últimos segmentos do global_name (buckets/telhas, services/phidro, …).
    sql = f"""
      SELECT
        CAST(DATE(usage_start_time) AS STRING) AS d,
        IFNULL(project.id, '') AS p,
        service.description AS s,
        IFNULL(REGEXP_EXTRACT(resource.global_name, r'[^/]+/[^/]+$'), '') AS r,
        SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net,
        ANY_VALUE(currency) AS cur
      FROM `{GCP_TABLE}`
      WHERE DATE(_PARTITIONTIME) >= @start
        AND DATE(usage_start_time) BETWEEN @start AND @end
      GROUP BY d, p, s, r
      HAVING ABS(net) >= 0.000001
    """
    params = [
        {"name": n, "parameterType": {"type": "DATE"}, "parameterValue": {"value": v.isoformat()}}
        for n, v in (("start", start), ("end", end))
    ]
    base = f"https://bigquery.googleapis.com/bigquery/v2/projects/{GCP_PROJECT}"
    res = http_json(
        f"{base}/queries",
        data={
            "query": sql, "useLegacySql": False, "location": GCP_LOCATION,
            "queryParameters": params, "parameterMode": "NAMED",
            "timeoutMs": 60000, "maxResults": 10000,
        },
        headers=hdr,
    )
    job = res["jobReference"]["jobId"]
    rows = res.get("rows", [])
    complete = res.get("jobComplete", False)
    page = res.get("pageToken")
    while not complete or page:
        q = {"location": GCP_LOCATION, "maxResults": 10000, "timeoutMs": 60000}
        if page:
            q["pageToken"] = page
        res = http_json(f"{base}/queries/{job}?{urllib.parse.urlencode(q)}", headers=hdr)
        complete = res.get("jobComplete", False)
        if complete:
            rows += res.get("rows", [])
            page = res.get("pageToken")
    out = []
    for r in rows:
        d, p, s, rr, net, cur = (c["v"] for c in r["f"])
        out.append([d, p, s, rr, round(float(net), 6), cur])
    return out


# ── Cloudflare R2 ────────────────────────────────────────────────────────────


def cf_credentials() -> tuple[str, str]:
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not tok:
        cfg = Path.home() / ".config" / ".wrangler" / "config" / "default.toml"
        if cfg.exists():
            tok = tomllib.loads(cfg.read_text()).get("oauth_token")
    if not tok:
        raise RuntimeError("sem credencial Cloudflare (CLOUDFLARE_API_TOKEN)")
    acc = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not acc:
        res = http_json("https://api.cloudflare.com/client/v4/accounts", headers={"Authorization": f"Bearer {tok}"})
        if not res.get("success") or not res.get("result"):
            raise RuntimeError("não consegui descobrir a conta Cloudflare — defina CLOUDFLARE_ACCOUNT_ID")
        acc = res["result"][0]["id"]
    return tok, acc


R2_QUERY = """
query($a: String!, $s: Date!, $e: Date!) {
  viewer { accounts(filter: {accountTag: $a}) {
    storage: r2StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}) {
      max { payloadSize metadataSize }
      dimensions { date bucketName }
    }
    ops: r2OperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}) {
      sum { requests }
      dimensions { date bucketName actionType }
    }
  } }
}"""


def r2_class(action: str) -> str | None:
    if action in R2_FREE_OPS:
        return None
    if action in R2_CLASS_A or action.startswith(("Put", "List", "Create", "Complete", "Upload", "Copy")):
        return "A"
    return "B"


def collect_r2(start: date, end: date) -> list:
    tok, acc = cf_credentials()
    hdr = {"Authorization": f"Bearer {tok}"}
    # O free tier é mensal e por conta, então sempre calculamos meses inteiros
    # (desde o dia 1 ou do limite de retenção) e devolvemos só [start, end].
    oldest = datetime.now(timezone.utc).date() - timedelta(days=R2_RETENTION_DAYS)
    # units[classe][data][bucket] = GB-mês (storage) ou nº de operações
    units: dict = {k: defaultdict(lambda: defaultdict(float)) for k in R2_PRICE}
    m = month_start(start)
    while m <= end:
        last = date(m.year, m.month, calendar.monthrange(m.year, m.month)[1])
        qs, qe = max(m, oldest), min(last, end)
        if qs <= qe:
            res = http_json(
                "https://api.cloudflare.com/client/v4/graphql",
                data={"query": R2_QUERY, "variables": {"a": acc, "s": qs.isoformat(), "e": qe.isoformat()}},
                headers=hdr,
            )
            if res.get("errors"):
                raise RuntimeError(f"GraphQL R2: {res['errors']}")
            a = res["data"]["viewer"]["accounts"][0]
            ndays = calendar.monthrange(m.year, m.month)[1]
            for g in a["storage"]:
                d, b = g["dimensions"]["date"], g["dimensions"]["bucketName"]
                gb = (g["max"]["payloadSize"] + g["max"]["metadataSize"]) / 2**30
                # GB-mês = média dos picos diários → cada dia contribui pico/ndias
                units["storage"][d][b] += gb / ndays
            for g in a["ops"]:
                c = r2_class(g["dimensions"]["actionType"])
                if c:
                    units[c][g["dimensions"]["date"]][g["dimensions"]["bucketName"]] += g["sum"]["requests"]
        m = last + timedelta(days=1)

    out = []
    for cls, by_day in units.items():
        cum_units, cum_cost, month = 0.0, 0.0, None
        for d in sorted(by_day):
            if d[:7] != month:
                month, cum_units, cum_cost = d[:7], 0.0, 0.0
            day_units = sum(by_day[d].values())
            cum_units += day_units
            new_cum_cost = max(0.0, cum_units - R2_FREE[cls]) * R2_PRICE[cls]
            day_cost = new_cum_cost - cum_cost
            cum_cost = new_cum_cost
            if d < start.isoformat() or day_cost <= 0 or day_units <= 0:
                continue
            for b, u in by_day[d].items():
                c = day_cost * u / day_units
                if c >= 1e-6:
                    out.append([d, "cloudflare", R2_SERVICE[cls], b, round(c, 6), "USD"])
    return out


# ── Magalu Cloud ─────────────────────────────────────────────────────────────


def collect_magalu(start: date, end: date) -> list:
    key = os.environ.get("MGC_API_KEY")
    if not key:
        raise RuntimeError("sem MGC_API_KEY (chave com a aplicação tally-consumption-api)")
    agg: dict = defaultdict(float)
    cur_of: dict = {}
    offset = 0
    while True:
        q = urllib.parse.urlencode({
            "start_date": start.isoformat(), "end_date": end.isoformat(),
            "limit": 1000, "offset": offset, "order": "asc",
        })
        res = http_json(f"{MGC_URL}?{q}", headers={"x-api-key": key, "Accept": "application/json"})
        results = res.get("results") or []
        for r in results:
            d = (r.get("ChargePeriodStart") or "")[:10]
            if not d:
                continue
            cost = r.get("EffectiveCost") or r.get("BilledCost") or "0"
            k = (
                d,
                r.get("RegionName") or r.get("RegionId") or "",
                r.get("ServiceName") or r.get("ServiceCategory") or "",
                r.get("ResourceName") or r.get("ResourceId") or r.get("SkuId") or "",
            )
            agg[k] += float(cost)
            cur_of[k] = r.get("BillingCurrency") or "BRL"
        total = ((res.get("meta") or {}).get("page") or {}).get("total", 0)
        offset += len(results)
        if not results or offset >= total:
            break
    return [[*k, round(v, 6), cur_of[k]] for k, v in agg.items() if abs(v) >= 1e-6]


# ── câmbio ───────────────────────────────────────────────────────────────────


def collect_fx(start: date, end: date) -> dict:
    # Pega alguns dias antes para ter com o que preencher fins de semana/feriados.
    a = start - timedelta(days=10)
    q = {
        "@dataInicial": f"'{a:%m-%d-%Y}'", "@dataFinalCotacao": f"'{end:%m-%d-%Y}'",
        "$format": "json", "$select": "cotacaoVenda,dataHoraCotacao",
    }
    res = http_json(f"{PTAX_URL}?{urllib.parse.urlencode(q, safe=chr(39) + '@$')}")
    by_day = {}
    for v in res["value"]:  # vem em ordem; a última cotação do dia vence
        by_day[v["dataHoraCotacao"][:10]] = v["cotacaoVenda"]
    return by_day


def update_fx(start: date, end: date) -> None:
    doc = load_raw("fx")
    rates = dict(doc.get("rates", {}))
    rates.update(collect_fx(start, end))
    doc = {"rates": dict(sorted(rates.items())), "source": "BCB PTAX, cotação de venda (BRL por USD)",
           "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "fx.json").write_text(json.dumps(doc, indent=0, ensure_ascii=False) + "\n")
    log(f"  fx: {len(rates)} cotações")


def fx_filled(first: str, last: str) -> dict:
    rates = load_raw("fx").get("rates", {})
    out, cur = {}, None
    known = sorted(rates)
    # valor inicial: a última cotação antes de `first`, ou a primeira que houver
    prior = [d for d in known if d <= first]
    cur = rates[prior[-1]] if prior else (rates[known[0]] if known else None)
    for d in daterange(date.fromisoformat(first), date.fromisoformat(last)):
        cur = rates.get(d.isoformat(), cur)
        out[d.isoformat()] = cur
    return out


# ── build ────────────────────────────────────────────────────────────────────

PROVIDERS = {
    "gcp": {"label": "Google Cloud", "short": "GCP", "collect": collect_gcp},
    "r2": {"label": "Cloudflare R2", "short": "R2", "collect": collect_r2},
    "magalu": {"label": "Magalu Cloud", "short": "Magalu", "collect": collect_magalu},
}


def build() -> None:
    cfg = tomllib.loads(MAPPING.read_text())
    rules = [(re.compile(r["match"]), r["usecase"]) for r in cfg["rules"]]
    usecases = cfg["usecases"]
    for _, u in rules:
        if u not in usecases:
            raise SystemExit(f"mapping.toml: regra aponta para uso inexistente {u!r}")

    raw = {p: load_raw(p) for p in PROVIDERS}
    all_days = [r[0] for doc in raw.values() for r in doc["rows"]]
    if not all_days:
        raise SystemExit("sem dados brutos — rode a coleta primeiro")
    first, last = min(all_days), max(all_days)
    fx = fx_filled(first, last)
    if any(v is None for v in fx.values()):
        raise SystemExit("faltam cotações PTAX — rode com --only fx")

    rows, unmapped = [], defaultdict(float)
    for prov, doc in raw.items():
        for d, proj, svc, res, amount, cur in doc["rows"]:
            key = f"{prov}|{proj}|{svc}|{res}"
            uc = next(u for rx, u in rules if rx.search(key))
            usd = amount if cur == "USD" else amount / fx[d] if cur == "BRL" else None
            if usd is None:
                raise SystemExit(f"moeda não suportada: {cur}")
            if uc == "nao-mapeado":
                unmapped[key] += usd
            rows.append([d, prov, uc, svc, res or svc, round(usd, 6)])
    for k, v in sorted(unmapped.items(), key=lambda kv: -kv[1]):
        log(f"  aviso: não mapeado US$ {v:.2f}  {k}")

    doc = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "first": first,
        "last": last,
        "fx": fx,
        "providers": {
            p: {"label": v["label"], "short": v["short"], "updated_at": raw[p].get("updated_at"),
                "covered_from": raw[p].get("covered_from"),
                "first": raw[p].get("first"), "last": raw[p].get("last")}
            for p, v in PROVIDERS.items()
        },
        "scopes": cfg["scopes"],
        "usecases": usecases,
        "rows": sorted(rows),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    total = sum(r[5] for r in rows)
    log(f"build: {len(rows)} linhas, {first}..{last}, total US$ {total:.2f} → {OUT.relative_to(ROOT)}")


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    today = datetime.now(timezone.utc).date()
    default_since = month_start(month_start(today) - timedelta(days=1))
    ap.add_argument("--since", type=date.fromisoformat, default=default_since,
                    help=f"início da janela (padrão: {default_since})")
    ap.add_argument("--until", type=date.fromisoformat, default=today)
    ap.add_argument("--only", default="gcp,r2,magalu,fx", help="provedores a coletar")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--strict", action="store_true", help="falha se algum provedor falhar")
    args = ap.parse_args()

    failed = []
    if not args.build_only:
        only = [s.strip() for s in args.only.split(",") if s.strip()]
        log(f"coletando {', '.join(only)} de {args.since} a {args.until}")
        if "fx" in only:
            try:
                update_fx(args.since, args.until)
            except Exception as e:  # noqa: BLE001
                log(f"  fx: FALHOU — {e}")
                failed.append("fx")
        for p in only:
            if p == "fx":
                continue
            start = args.since
            if p == "r2":  # não apagar histórico que o GraphQL já esqueceu
                start = max(start, today - timedelta(days=R2_RETENTION_DAYS))
            try:
                rows = PROVIDERS[p]["collect"](start, args.until)
                merge_raw(p, rows, start, args.until)
            except Exception as e:  # noqa: BLE001
                log(f"  {p}: PULADO — {e}")
                failed.append(p)
    build()
    if failed and args.strict:
        raise SystemExit(f"falharam: {', '.join(failed)}")


if __name__ == "__main__":
    main()
