namespace Outcome.Infrastructure.Configuration;

/// <summary>HTTP server settings. Bound from the <c>Server</c> config section.</summary>
public sealed class ServerOptions
{
    public int Port { get; set; } = 8443;
    public string Name { get; set; } = "Outcome Server";
    public string DataDir { get; set; } = "data";
    public string[] AllowedOrigins { get; set; } = ["*"];
    public string[] TrustedProxies { get; set; } = [];
    public string[] AdminAllowedCidrs { get; set; } =
    [
        "127.0.0.0/8", "::1/128",
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
    ];
}

/// <summary>Database settings. The connection string also falls back to ConnectionStrings:Postgres.</summary>
public sealed class DatabaseOptions
{
    public string ConnectionString { get; set; } = "";
}

/// <summary>TLS/certificate settings. Bound from the <c>Tls</c> section.</summary>
public sealed class TlsOptions
{
    public string Mode { get; set; } = "off"; // off | self_signed | acme | manual
    public string CertFile { get; set; } = "";
    public string KeyFile { get; set; } = "";
    public string Domain { get; set; } = "";
}

/// <summary>File upload settings. Bound from the <c>Upload</c> section.</summary>
public sealed class UploadOptions
{
    public int MaxSizeMb { get; set; } = 100;
    public string StorageDir { get; set; } = "data/uploads";
}

/// <summary>Single-sign-on settings. Bound from the <c>OAuth</c> section. A provider is
/// ENABLED simply by giving it a client id + secret — clients ask /auth/oauth/providers
/// and only render buttons for what the server actually holds keys for.</summary>
public sealed class OAuthOptions
{
    /// <summary>Public https origin of this deployment (e.g. https://outcome.bangx.ru) —
    /// the provider redirect_uri is built from it. Required behind a reverse proxy, where
    /// the request's own scheme/host are the internal ones.</summary>
    public string PublicOrigin { get; set; } = "";

    public OAuthProviderOptions Google { get; set; } = new();
    public OAuthProviderOptions Yandex { get; set; } = new();
}

public sealed class OAuthProviderOptions
{
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
    public bool Enabled => ClientId.Length > 0 && ClientSecret.Length > 0;
}

/// <summary>LiveKit voice settings. Bound from the <c>Voice</c> section.</summary>
public sealed class VoiceOptions
{
    public string LiveKitApiKey { get; set; } = "";
    public string LiveKitApiSecret { get; set; } = "";
    public string LiveKitUrl { get; set; } = "ws://localhost:7880";

    /// <summary>Internal URL the backend uses to reach LiveKit (proxy + RoomService). Falls back to LiveKitUrl.</summary>
    public string LiveKitInternalUrl { get; set; } = "";

    public string LiveKitBinary { get; set; } = "";
    public string NodeIp { get; set; } = "";
    public string Quality { get; set; } = "medium"; // low | medium | high
}
