using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace Outcome.Api.Http;

/// <summary>Newtonsoft.Json settings for the wire contract: snake_case property names, explicit
/// [JsonProperty("...")] names kept verbatim. Per-property NullValueHandling.Ignore drives the
/// omitempty fields (token/partial_token/user/...).</summary>
public static class OutcomeJson
{
    public static readonly JsonSerializerSettings Settings = new()
    {
        ContractResolver = new DefaultContractResolver
        {
            NamingStrategy = new SnakeCaseNamingStrategy { OverrideSpecifiedNames = false },
        },
        NullValueHandling = NullValueHandling.Include,
    };

    public static string Serialize(object? value) => JsonConvert.SerializeObject(value, Settings);
}
