{{- define "outcome.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "outcome.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "outcome.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "outcome.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "outcome.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "outcome.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}{{ include "outcome.fullname" . }}-secrets{{- end -}}
{{- end -}}

{{/* Service DNS names for the bundled components (or the external overrides). */}}
{{- define "outcome.postgresHost" -}}
{{- if .Values.postgres.enabled -}}{{ include "outcome.fullname" . }}-postgres{{- else -}}{{ .Values.postgres.external.host }}{{- end -}}
{{- end -}}

{{- define "outcome.redisUrl" -}}
{{- if .Values.redis.enabled -}}{{ include "outcome.fullname" . }}-redis:6379{{- else -}}{{ .Values.redis.external.url }}{{- end -}}
{{- end -}}

{{- define "outcome.minioEndpoint" -}}
{{- if .Values.minio.enabled -}}{{ include "outcome.fullname" . }}-minio:9000{{- else -}}{{ .Values.minio.external.endpoint }}{{- end -}}
{{- end -}}

{{- define "outcome.livekitInternalUrl" -}}ws://{{ include "outcome.fullname" . }}-livekit:7880{{- end -}}

{{- define "outcome.serverImage" -}}{{ .Values.server.image.repository }}:{{ .Values.server.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "outcome.frontendImage" -}}{{ .Values.frontend.image.repository }}:{{ .Values.frontend.image.tag | default .Chart.AppVersion }}{{- end -}}
