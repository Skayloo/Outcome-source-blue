using Minio;
using Minio.DataModel.Args;
using Minio.DataModel.ILM;

namespace Outcome.Infrastructure.Storage;

/// <summary>
/// Expiry the bucket enforces by itself. A call recording comes in parts (RecordingEndpoints) that
/// are deleted when the upload completes — and an upload that never completes left its parts in
/// the bucket for good: gigabytes per account, in the one bucket every space shares, with nothing
/// to find them by. MinIO deletes them two days after they were written; a real upload completes
/// within minutes. Used by both storage editions, so it holds no cipher.
/// </summary>
public static class StorageLifecycle
{
    /// <summary>Every recording part's key starts with this (and nothing else's does).</summary>
    public const string RecordingPartPrefix = "recpart-";
    // The key shape before 1.31.61; parts still lying around from then go the same way.
    private const string LegacyRecordingPartPrefix = "rec-";

    public static Task ExpireRecordingPartsAsync(IMinioClient client, string bucket, CancellationToken ct)
    {
        static LifecycleRule Rule(string id, string prefix) => new(null, id, new Expiration { Days = 2 }, null,
            new RuleFilter(null, prefix, null), null, null, LifecycleRule.LifecycleRuleStatusEnabled);
        // This replaces the bucket's whole lifecycle configuration: the bucket belongs to the app.
        var config = new LifecycleConfiguration(new List<LifecycleRule>
        {
            Rule("outcome-recording-parts", RecordingPartPrefix),
            Rule("outcome-recording-parts-legacy", LegacyRecordingPartPrefix),
        });
        return client.SetBucketLifecycleAsync(new SetBucketLifecycleArgs().WithBucket(bucket).WithLifecycleConfiguration(config), ct);
    }
}
