# syntax=docker/dockerfile:1
# Backend-only image. The React frontend is a separate container (../frontend).
# Modular-monolith layout (mirrors api_mobstra_analytics): Shared / Identity / Chat + host.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore first (cached layer) using only project files.
COPY Outcome.slnx ./
COPY Shared/Outcome.Abstractions/Outcome.Abstractions.csproj                      Shared/Outcome.Abstractions/
COPY Shared/Outcome.Core/Outcome.Core.csproj                                      Shared/Outcome.Core/
COPY Shared/Outcome.Db.Abstractions/Outcome.Db.Abstractions.csproj                Shared/Outcome.Db.Abstractions/
COPY Shared/Outcome.Domain.Abstractions/Outcome.Domain.Abstractions.csproj        Shared/Outcome.Domain.Abstractions/
COPY Shared/Outcome.Domain.InternalRequests/Outcome.Domain.InternalRequests.csproj Shared/Outcome.Domain.InternalRequests/
COPY Identity/Outcome.Identity.Domain/Outcome.Identity.Domain.csproj              Identity/Outcome.Identity.Domain/
COPY Identity/Outcome.Identity.Dto/Outcome.Identity.Dto.csproj                    Identity/Outcome.Identity.Dto/
COPY Identity/Outcome.Identity.Db/Outcome.Identity.Db.csproj                      Identity/Outcome.Identity.Db/
COPY Identity/Outcome.Identity.Core/Outcome.Identity.Core.csproj                  Identity/Outcome.Identity.Core/
COPY Chat/Outcome.Chat.Domain/Outcome.Chat.Domain.csproj                          Chat/Outcome.Chat.Domain/
COPY Chat/Outcome.Chat.Dto/Outcome.Chat.Dto.csproj                                Chat/Outcome.Chat.Dto/
COPY Chat/Outcome.Chat.Db/Outcome.Chat.Db.csproj                                  Chat/Outcome.Chat.Db/
COPY Chat/Outcome.Chat.Core/Outcome.Chat.Core.csproj                              Chat/Outcome.Chat.Core/
COPY Outcome.Api/Outcome.Api.csproj                                               Outcome.Api/
RUN dotnet restore Outcome.Api/Outcome.Api.csproj

COPY . .
# No debug symbols in the published output — the image is distributed publicly, and PDBs
# map IL back to source lines/locals. The find sweeps any PDBs shipped inside NuGet deps.
RUN dotnet publish Outcome.Api/Outcome.Api.csproj -c Release -o /app /p:UseAppHost=false \
      /p:DebugType=none /p:DebugSymbols=false \
    && find /app -name '*.pdb' -delete

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
# Npgsql lazily loads the Kerberos GSSAPI library during connection negotiation;
# without it replicas can wedge at startup with "libgssapi_krb5.so.2: cannot open".
# curl is used by the container HEALTHCHECK (the aspnet image ships neither curl nor wget).
# ffmpeg normalizes voice messages to m4a/AAC (every platform plays it) and extracts the
# waveform peaks — see VoiceTranscoder. libgssapi/curl as before (Npgsql GSSAPI + healthcheck).
# libheif turns an iPhone's HEIC photos into JPEG (ImageProbe.HeifToJpegAsync): this ffmpeg cannot
# read HEIC, and no browser but Safari draws it. The libde265 plugin is the HEVC decoder itself —
# without it heif-convert answers "Unsupported codec".
RUN apt-get update && apt-get install -y --no-install-recommends libgssapi-krb5-2 curl ffmpeg \
       libheif-examples libheif-plugin-libde265 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app ./

EXPOSE 5000
ENV ASPNETCORE_URLS=http://0.0.0.0:5000
# The .NET base image sets ASPNETCORE_HTTP_PORTS=8080; with URLS above it is only overridden,
# and every start logged "Overriding HTTP_PORTS '8080'…". Cleared, so the one port is ours.
ENV ASPNETCORE_HTTP_PORTS=
# The release this image is (the release scripts pass it); /health and the admin dashboard show
# it. "dev" for a build nobody named.
ARG OUTCOME_VERSION=dev
ENV OUTCOME_VERSION=${OUTCOME_VERSION}
ENTRYPOINT ["dotnet", "Outcome.Api.dll"]
