{{/*
Expand the name of the chart.
*/}}
{{- define "tracery-hub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name. Truncated at 63 chars because
some Kubernetes name fields are limited to this (by the DNS naming spec).
*/}}
{{- define "tracery-hub.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version, for the chart label.
*/}}
{{- define "tracery-hub.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "tracery-hub.labels" -}}
helm.sh/chart: {{ include "tracery-hub.chart" . }}
{{ include "tracery-hub.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "tracery-hub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracery-hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Image reference, honoring image.tag falling back to .Chart.AppVersion.
*/}}
{{- define "tracery-hub.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{/*
Name of the Secret holding TRACERY_API_KEYS_FILE's content, or "" when
neither an existingSecret nor inline keys are configured.
*/}}
{{- define "tracery-hub.apiKeysSecretName" -}}
{{- if .Values.apiKeys.existingSecret }}
{{- .Values.apiKeys.existingSecret }}
{{- else if gt (len .Values.apiKeys.keys) 0 }}
{{- printf "%s-keys" (include "tracery-hub.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding TRACERY_POSTGRES_URL, or "" when neither an
existingSecret nor an inline url are configured.
*/}}
{{- define "tracery-hub.postgresSecretName" -}}
{{- if .Values.postgres.existingSecret }}
{{- .Values.postgres.existingSecret }}
{{- else if .Values.postgres.url }}
{{- printf "%s-postgres" (include "tracery-hub.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding TRACERY_METRICS_TOKEN, or "" when unset.
*/}}
{{- define "tracery-hub.metricsSecretName" -}}
{{- if .Values.metrics.existingSecret }}
{{- .Values.metrics.existingSecret }}
{{- else if .Values.metrics.token }}
{{- printf "%s-metrics" (include "tracery-hub.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the PVC mounted at /data, or "" when persistence is disabled.
*/}}
{{- define "tracery-hub.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- printf "%s-data" (include "tracery-hub.fullname" .) }}
{{- end }}
{{- end }}
