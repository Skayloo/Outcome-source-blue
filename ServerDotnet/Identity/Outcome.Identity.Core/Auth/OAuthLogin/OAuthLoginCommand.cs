using MediatR;

namespace Outcome.Application.Auth;

/// <summary>Sign in (or sign up) with an identity already verified by an external
/// OAuth provider. Email arrives from the provider's token/userinfo endpoint, never
/// from the user, so it is trusted the way a confirmed email is.</summary>
public sealed record OAuthLoginCommand(
    string Provider,
    string Email,
    string DisplayName,
    string Ip) : IRequest<AuthResult>;
