using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed record SessionDto(
    long Id, string? Device, string? IpAddress, DateTime CreatedAt, DateTime LastUsed, DateTime ExpiresAt,
    // The session backing the request's own token — the UI marks it "This device" and
    // both revoke paths spare it.
    bool Current);
