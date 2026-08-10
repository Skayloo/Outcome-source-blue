using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Outcome.Domain.Entities;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Storage;
using Outcome.Infrastructure.Configuration;
using Outcome.Infrastructure.Migrations;
using Outcome.Infrastructure.Notifications;
using Outcome.Infrastructure.Persistence;
using Outcome.Infrastructure.Persistence.Repositories;
using Outcome.Infrastructure.Security;
using Outcome.Infrastructure.Storage;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration config)
    {
        services.Configure<ServerOptions>(config.GetSection("Server"));
        services.Configure<DatabaseOptions>(config.GetSection("Database"));
        services.Configure<TlsOptions>(config.GetSection("Tls"));
        services.Configure<UploadOptions>(config.GetSection("Upload"));
        services.Configure<VoiceOptions>(config.GetSection("Voice"));
        services.Configure<EmailOptions>(config.GetSection("Email"));
        services.Configure<OAuthOptions>(config.GetSection("OAuth"));
        services.Configure<MinioOptions>(config.GetSection("Minio"));
        services.Configure<ApnsOptions>(config.GetSection("Apns"));

        var connectionString = ResolveConnectionString(config);
        var directConnectionString = config.GetConnectionString("PostgresDirect") ?? connectionString;

        // Tenancy. A space owns a database; the registry lives in the ROOT one and maps
        // host -> space. Everything below that reads data goes through ICurrentSpace, so a
        // request can only ever see the tenant it arrived at.
        var registry = new SpaceRegistry(connectionString, directConnectionString);
        services.AddSingleton<ISpaceRegistry>(registry);
        services.AddSingleton(registry);
        services.AddSingleton<SpaceProvisioner>();
        services.AddScoped<CurrentSpaceContext>();
        services.AddScoped<ICurrentSpace>(sp => sp.GetRequiredService<CurrentSpaceContext>());

        // EF Core over PostgreSQL — owns the schema via EF Core migrations (in Outcome.Db.Abstractions).
        // The connection string is built PER REQUEST from the resolved space: same schema,
        // different database, no shared rows between tenants.
        services.AddDbContext<OutcomeDbContext>((sp, o) => o.UseNpgsql(
            registry.ConnectionFor(sp.GetRequiredService<ICurrentSpace>().Space),
            npg => npg.MigrationsAssembly(typeof(OutcomeDbContext).Assembly.GetName().Name)));
        services.AddScoped<IUnitOfWork, EfUnitOfWork>();
        services.AddScoped<ISpaceSsoConfig, SpaceSsoConfig>();

        // ASP.NET Core Identity (UserManager/RoleManager + lockout) over EF.
        services.AddIdentityCore<User>(options =>
        {
            options.User.RequireUniqueEmail = true;
            // Identity's default whitelist is a-zA-Z0-9-._@+ — it rejects every Cyrillic name,
            // while AuthRules.ValidateUsername (our actual policy, enforced at both entry points)
            // allows any non-control character. Left on, the two disagree: registration accepts
            // the name, mails the code, and then CreateAsync refuses to insert the row. Empty
            // string turns Identity's character check off; length/control rules still apply.
            options.User.AllowedUserNameCharacters = string.Empty;
            // Hardened password policy (applies to register + change-password; existing
            // accounts are unaffected until they change their password).
            options.Password.RequiredLength = 8;
            options.Password.RequireDigit = true;
            options.Password.RequireLowercase = true;
            options.Password.RequireUppercase = true;
            options.Password.RequireNonAlphanumeric = false; // symbols encouraged, not forced
            options.Password.RequiredUniqueChars = 4;
            options.Lockout.MaxFailedAccessAttempts = 7;
            options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
        })
            .AddRoles<Role>()
            .AddEntityFrameworkStores<OutcomeDbContext>();

        // Argon2id password hashing (memory-hard) replaces the default PBKDF2. Legacy PBKDF2
        // hashes verify + auto-upgrade to Argon2id on next login. Registered AFTER
        // AddIdentityCore so it overrides the default IPasswordHasher<User>.
        services.AddScoped<IPasswordHasher<User>, Argon2PasswordHasher>();

        // Migrations must reach Postgres DIRECTLY, never through PgBouncer: the runner holds a
        // SESSION advisory lock, and transaction pooling shares backend sessions between clients,
        // which silently breaks session-scoped locks (two replicas could migrate concurrently).
        // When the app talks to a pooler, PostgresDirect names the real server; else same string.
        var migrationConnectionString = config.GetConnectionString("PostgresDirect") ?? connectionString;
        services.AddSingleton(sp => new EfMigrationRunner(
            sp.GetRequiredService<IServiceScopeFactory>(), migrationConnectionString, sp.GetRequiredService<ILogger<EfMigrationRunner>>()));

        // Security services.
        services.AddMemoryCache();
        services.AddSingleton<IRateLimiter, SlidingWindowRateLimiter>();
        services.AddScoped<IPartialAuthStore, PartialAuthStore>();
        services.AddScoped<IPendingRegistrationStore, PendingRegistrationStore>();
        services.AddSingleton<IPasswordResetStore, PasswordResetStore>();
        services.AddSingleton<ITotpService, TotpService>();
        services.AddSingleton<IPendingTotpStore, PendingTotpStore>();
        services.AddSingleton<IEmailSender, SmtpEmailSender>();
        services.AddSingleton<IPushSender, ApnsPushSender>();

        // Repositories (scoped — share the request's DbContext).
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IRoleRepository, RoleRepository>();
        services.AddScoped<IPermissionRepository, PermissionRepository>();
        services.AddScoped<ISessionRepository, SessionRepository>();
        services.AddScoped<IDeviceTokenRepository, DeviceTokenRepository>();
        services.AddScoped<ISettingsRepository, SettingsRepository>();
        services.AddScoped<IInviteRepository, InviteRepository>();
        services.AddScoped<IAuditRepository, AuditRepository>();
        services.AddScoped<IAdminMetricsRepository, AdminMetricsRepository>();
        services.AddScoped<IServerRepository, ServerRepository>();
        services.AddScoped<IChannelRepository, ChannelRepository>();
        services.AddScoped<IChannelOverrideRepository, ChannelOverrideRepository>();
        services.AddScoped<IMessageRepository, MessageRepository>();
        services.AddScoped<IAttachmentRepository, AttachmentRepository>();
        services.AddScoped<IReactionRepository, ReactionRepository>();
        services.AddScoped<IDmRepository, DmRepository>();
        services.AddScoped<IChannelMuteRepository, ChannelMuteRepository>();
        services.AddScoped<IReadStateRepository, ReadStateRepository>();
        services.AddScoped<IVoiceListenRepository, VoiceListenRepository>();
        services.AddScoped<IVoiceStateRepository, VoiceStateRepository>();
        services.AddScoped<IEmojiRepository, EmojiRepository>();
        services.AddScoped<ISoundRepository, SoundRepository>();
        services.AddScoped<IFriendRepository, FriendRepository>();
        services.AddScoped<IBugReportRepository, BugReportRepository>();
        services.AddScoped<IBlockRepository, BlockRepository>();
        services.AddScoped<IMessageReportRepository, MessageReportRepository>();
        services.AddScoped<IGuestLinkRepository, GuestLinkRepository>();

        // Scoped, not singleton: room names carry the tenant, so these need the request's space.
        services.AddScoped<Shared.Abstractions.Voice.ILiveKitTokenService, Voice.LiveKitTokenService>();
        services.AddScoped<Shared.Abstractions.Voice.ILiveKitRoomService, Voice.LiveKitRoomService>();
        services.AddSingleton<Shared.Abstractions.Voice.ILiveKitWebhookReceiver, Voice.LiveKitWebhookReceiver>();
        // Latches a channel's E2EE key regime per room session (mid-call link changes must not
        // hand re-joiners a key nobody else in the room is using).

        services.AddSingleton<IFileStorage, MinioFileStorage>();
        // Voice-message normalization (ffmpeg → m4a + waveform). Stateless singleton.
        services.AddSingleton<Media.VoiceTranscoder>();

        return services;
    }

    internal static string ResolveConnectionString(IConfiguration config)
    {
        var cs = config.GetConnectionString("Postgres");
        if (string.IsNullOrWhiteSpace(cs))
            cs = config["Database:ConnectionString"];
        if (string.IsNullOrWhiteSpace(cs))
            throw new InvalidOperationException(
                "PostgreSQL connection string not configured (ConnectionStrings:Postgres or Database:ConnectionString).");
        return cs;
    }
}
