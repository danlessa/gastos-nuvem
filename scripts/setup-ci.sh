#!/usr/bin/env bash
# Configuração única do CI de danlessa/gastos-nuvem. Rode localmente, com gcloud,
# bq e gh autenticados. Idempotente o bastante para rodar de novo.
#
# 1. Conta de serviço gh-gastos-nuvem, SÓ com leitura da tabela do billing
#    export + permissão de rodar consultas no pedal-hidrografico.
# 2. Provedor OIDC para este repo no pool "github" (criado pelo setup do amora),
#    ou seja, sem chave de longa duração no repo (que é público).
# 3. Variáveis do repo + GitHub Pages por workflow (abiru.to/gastos-nuvem).
#
# Os segredos dos outros provedores são manuais (ver README):
#   gh secret set CLOUDFLARE_API_TOKEN --repo danlessa/gastos-nuvem
#   gh secret set MGC_API_KEY          --repo danlessa/gastos-nuvem
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"  # `sh setup-ci.sh` (dash) não tem pipefail
set -euo pipefail

PROJECT=pedal-hidrografico
REPO=danlessa/gastos-nuvem
SA_NAME=gh-gastos-nuvem
SA=$SA_NAME@$PROJECT.iam.gserviceaccount.com
TABLE=$PROJECT:billing_export.gcp_billing_export_resource_v1_015CF8_384D2A_5CE27E
PROVIDER_ID=github-oidc-gastos-nuvem
CF_ACCOUNT_ID=24a3d6926825c48ffd526e0791c795db

# 1) conta de serviço
gcloud iam service-accounts describe "$SA" --project=$PROJECT >/dev/null 2>&1 ||
  gcloud iam service-accounts create $SA_NAME --project=$PROJECT \
    --display-name="GitHub Actions: painel de gastos (danlessa/gastos-nuvem)"
gcloud projects add-iam-policy-binding $PROJECT --condition=None \
  --member="serviceAccount:$SA" --role=roles/bigquery.jobUser >/dev/null
bq add-iam-policy-binding --member="serviceAccount:$SA" \
  --role=roles/bigquery.dataViewer "$TABLE" >/dev/null

# 2) OIDC deste repo no pool "github"
gcloud iam workload-identity-pools providers describe $PROVIDER_ID \
  --project=$PROJECT --location=global --workload-identity-pool=github >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc $PROVIDER_ID \
    --project=$PROJECT --location=global --workload-identity-pool=github \
    --display-name="GitHub OIDC (gastos-nuvem)" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$REPO'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
POOL=$(gcloud iam workload-identity-pools describe github --project=$PROJECT \
  --location=global --format='value(name)')
gcloud iam service-accounts add-iam-policy-binding "$SA" --project=$PROJECT \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.repository/$REPO" >/dev/null
PROVIDER=$(gcloud iam workload-identity-pools providers describe $PROVIDER_ID \
  --project=$PROJECT --location=global --workload-identity-pool=github --format='value(name)')

# 3) repo
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo $REPO --body "$PROVIDER"
gh variable set GCP_SA --repo $REPO --body "$SA"
gh variable set CLOUDFLARE_ACCOUNT_ID --repo $REPO --body "$CF_ACCOUNT_ID"
gh api "repos/$REPO/pages" >/dev/null 2>&1 ||
  gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null
echo "ok — falta: gh secret set CLOUDFLARE_API_TOKEN / MGC_API_KEY (ver README)"
