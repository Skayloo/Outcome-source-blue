namespace Outcome.Domain.Errors;

/// <summary>
/// Signals a business/domain failure that maps to a wire error envelope
/// <c>{ "error": Code, "message": Message }</c> with the given HTTP status.
/// Wire codes intentionally mirror the backend this one replaced, so clients written against
/// it keep working. Do not rename a code to tidy it up — a client is switching on the string.
/// </summary>
public sealed class DomainException : Exception
{
    public string Code { get; }
    public int StatusCode { get; }

    public DomainException(string code, int statusCode, string message) : base(message)
    {
        Code = code;
        StatusCode = statusCode;
    }

    public static DomainException Unauthorized(string m = "unauthorized") => new("UNAUTHORIZED", 401, m);
    public static DomainException InvalidCredentials(string m = "invalid credentials") => new("INVALID_CREDENTIALS", 401, m);
    public static DomainException Forbidden(string m = "forbidden") => new("FORBIDDEN", 403, m);

    /// <summary>The content filter rejected the text. Separate from <see cref="Forbidden"/>
    /// because it is a statement about the MESSAGE, not about the sender's right to write here:
    /// clients turn FORBIDDEN into "you cannot write to this person", which is a different and
    /// confusing thing to say about a word.</summary>
    public static DomainException ContentBlocked(string m) => new("CONTENT_BLOCKED", 403, m);
    public static DomainException NotFound(string m = "not found") => new("NOT_FOUND", 404, m);
    public static DomainException BadRequest(string m = "bad request") => new("BAD_REQUEST", 400, m);
    public static DomainException InvalidInput(string m = "invalid input") => new("INVALID_INPUT", 400, m);
    public static DomainException Conflict(string m = "conflict") => new("CONFLICT", 409, m);
    public static DomainException TooLarge(string m = "payload too large") => new("TOO_LARGE", 413, m);
    public static DomainException RateLimited(string m = "too many requests, please slow down") => new("RATE_LIMITED", 429, m);
    public static DomainException Server(string m = "internal server error") => new("SERVER_ERROR", 500, m);
    /// <summary>A dependency we need is down — not the caller's fault, and worth retrying.</summary>
    public static DomainException Unavailable(string m = "service temporarily unavailable") => new("UNAVAILABLE", 503, m);
}
