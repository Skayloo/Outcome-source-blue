using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class VoiceEndpoints
{
    public static void MapVoiceEndpoints(this IEndpointRouteBuilder app)
    {

        // LiveKit performs its own ICE/TURN negotiation through the signaling proxy, so the
        // client only needs a well-formed response here (its getVoiceCredentials() must not 404).
        app.MapGet("/api/v1/voice/credentials", (ICurrentUser current) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return new { ice_servers = Array.Empty<object>(), expires_in = 3600 };
        });
    }
}
