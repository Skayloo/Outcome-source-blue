namespace Outcome.Infrastructure.Configuration;

/// <summary>MinIO/S3 object-storage settings, bound from the <c>Minio</c> config section
/// (overridable via <c>OUTCOME_Minio__Endpoint</c> etc.). Regenerate credentials per deployment.</summary>
public sealed class MinioOptions
{
    public string Endpoint { get; set; } = "minio:9000";
    public string AccessKey { get; set; } = "minioadmin";
    public string SecretKey { get; set; } = "minioadmin";
    public string Bucket { get; set; } = "outcome-uploads";
    public bool UseSsl { get; set; } = false;
}
