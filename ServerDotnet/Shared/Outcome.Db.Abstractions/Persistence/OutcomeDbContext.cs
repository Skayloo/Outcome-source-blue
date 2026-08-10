using System.Text;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence;

/// <summary>
/// EF Core + ASP.NET Core Identity context. EF Core owns the schema via migrations (in this
/// assembly); per-module FK/index config lives in the module .Db projects and is applied via
/// ApplyConfigurationsFromAssembly. <see cref="User"/>/<see cref="Role"/> are Identity entities; table and
/// column names are mapped to snake_case, but the pre-Identity <c>username</c>/<c>password</c>
/// columns are kept (mapped from <c>UserName</c>/<c>PasswordHash</c>). DB-default timestamps and
/// identity ids are store-generated so EF omits them on insert and reads them back.
/// </summary>
public sealed class OutcomeDbContext(DbContextOptions<OutcomeDbContext> options)
    : IdentityDbContext<User, Role, long>(options)
{
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<Server> Servers => Set<Server>();
    public DbSet<ServerMember> ServerMembers => Set<ServerMember>();
    public DbSet<Channel> Channels => Set<Channel>();
    public DbSet<ChannelOverrideClaim> ChannelOverrideClaims => Set<ChannelOverrideClaim>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<Reaction> Reactions => Set<Reaction>();
    public DbSet<Invite> Invites => Set<Invite>();
    public DbSet<ReadState> ReadStates => Set<ReadState>();
    public DbSet<AuditLogEntry> AuditLog => Set<AuditLogEntry>();
    public DbSet<Setting> Settings => Set<Setting>();
    public DbSet<Emoji> Emojis => Set<Emoji>();
    public DbSet<Sound> Sounds => Set<Sound>();
    public DbSet<VoiceState> VoiceStates => Set<VoiceState>();
    public DbSet<DmParticipant> DmParticipants => Set<DmParticipant>();
    public DbSet<DmOpenState> DmOpenStates => Set<DmOpenState>();
    public DbSet<ChannelMute> ChannelMutes => Set<ChannelMute>();
    public DbSet<VoiceListen> VoiceListens => Set<VoiceListen>();
    public DbSet<LoginAttempt> LoginAttempts => Set<LoginAttempt>();
    public DbSet<Friendship> Friendships => Set<Friendship>();
    public DbSet<BugReport> BugReports => Set<BugReport>();
    public DbSet<UserBlock> UserBlocks => Set<UserBlock>();
    public DbSet<MessageReport> MessageReports => Set<MessageReport>();
    public DbSet<GuestLink> GuestLinks => Set<GuestLink>();
    public DbSet<DeviceToken> DeviceTokens => Set<DeviceToken>();

    protected override void ConfigureConventions(ModelConfigurationBuilder b)
    {
        b.Properties<DateTime>().HaveColumnType("timestamp with time zone");
    }

    protected override void OnModelCreating(ModelBuilder mb)
    {
        // Identity's own model configuration (keys, relationships, indexes) first.
        base.OnModelCreating(mb);

        // Table names (snake_case, matching the historical schema).
        mb.Entity<User>().ToTable("users");
        mb.Entity<Role>().ToTable("roles");
        mb.Entity<IdentityUserClaim<long>>().ToTable("user_claims");
        mb.Entity<IdentityUserRole<long>>().ToTable("user_roles");
        mb.Entity<IdentityUserLogin<long>>().ToTable("user_logins");
        mb.Entity<IdentityUserToken<long>>().ToTable("user_tokens");
        mb.Entity<IdentityRoleClaim<long>>().ToTable("role_claims");
        mb.Entity<Session>().ToTable("sessions");
        mb.Entity<Server>().ToTable("servers");
        mb.Entity<ServerMember>().ToTable("server_members");
        mb.Entity<Channel>().ToTable("channels");
        mb.Entity<ChannelOverrideClaim>().ToTable("channel_override_claims");
        mb.Entity<Message>().ToTable("messages");
        mb.Entity<Attachment>().ToTable("attachments");
        mb.Entity<Reaction>().ToTable("reactions");
        mb.Entity<Invite>().ToTable("invites");
        mb.Entity<ReadState>().ToTable("read_states");
        mb.Entity<AuditLogEntry>().ToTable("audit_log");
        mb.Entity<Setting>().ToTable("settings");
        mb.Entity<Emoji>().ToTable("emoji");
        mb.Entity<Sound>().ToTable("sounds");
        mb.Entity<VoiceState>().ToTable("voice_states");
        mb.Entity<DmParticipant>().ToTable("dm_participants");
        mb.Entity<DmOpenState>().ToTable("dm_open_state");
        mb.Entity<ChannelMute>().ToTable("channel_mutes");
        mb.Entity<VoiceListen>().ToTable("voice_listens");
        mb.Entity<LoginAttempt>().ToTable("login_attempts");
        mb.Entity<Friendship>().ToTable("friendships");
        mb.Entity<BugReport>().ToTable("bug_reports");
        mb.Entity<UserBlock>().ToTable("user_blocks");
        mb.Entity<MessageReport>().ToTable("message_reports");
        mb.Entity<GuestLink>().ToTable("guest_links");
        mb.Entity<DeviceToken>().ToTable("device_tokens");

        // Keys for entities without a single Id.
        mb.Entity<Setting>().HasKey(s => s.Key);
        mb.Entity<ServerMember>().HasKey(m => new { m.ServerId, m.UserId });
        mb.Entity<VoiceState>().HasKey(v => v.UserId);
        mb.Entity<ReadState>().HasKey(r => new { r.UserId, r.ChannelId });
        mb.Entity<DmParticipant>().HasKey(d => new { d.ChannelId, d.UserId });
        mb.Entity<DmOpenState>().HasKey(d => new { d.UserId, d.ChannelId });
        mb.Entity<ChannelMute>().HasKey(m => new { m.UserId, m.ChannelId });
        mb.Entity<VoiceListen>().HasKey(v => new { v.UserId, v.AttachmentId });
        mb.Entity<UserBlock>().HasKey(b => new { b.BlockerId, b.BlockedId });
        // "Is anyone in this pair blocked?" is checked on every DM/call — index the reverse side.
        mb.Entity<UserBlock>().HasIndex(b => b.BlockedId);
        mb.Entity<MessageReport>().HasIndex(r => r.Status);
        // Guests resolve by code on a public endpoint — must be an index, and codes are unique.
        mb.Entity<GuestLink>().HasIndex(g => g.Code).IsUnique();
        mb.Entity<GuestLink>().HasIndex(g => g.ChannelId);

        // Notification previews are on unless the user says otherwise — including for accounts
        // that already existed when the column was added, which is what the DB default decides.
        mb.Entity<User>().Property(u => u.PushPreview).HasDefaultValue(true);

        // String UUID key is assigned by the application.
        mb.Entity<Attachment>().Property(a => a.Id).ValueGeneratedNever();

        // DB-default timestamps — store generated on insert.
        DefaultNow(mb.Entity<User>().Property(u => u.CreatedAt));
        DefaultNow(mb.Entity<Session>().Property(s => s.CreatedAt));
        DefaultNow(mb.Entity<Session>().Property(s => s.LastUsed));
        DefaultNow(mb.Entity<Server>().Property(s => s.CreatedAt));
        DefaultNow(mb.Entity<ServerMember>().Property(m => m.JoinedAt));
        DefaultNow(mb.Entity<Channel>().Property(c => c.CreatedAt));
        DefaultNow(mb.Entity<Message>().Property(m => m.Timestamp));
        DefaultNow(mb.Entity<Attachment>().Property(a => a.UploadedAt));
        DefaultNow(mb.Entity<Invite>().Property(i => i.CreatedAt));
        DefaultNow(mb.Entity<AuditLogEntry>().Property(a => a.CreatedAt));
        DefaultNow(mb.Entity<VoiceState>().Property(v => v.JoinedAt));
        DefaultNow(mb.Entity<DmOpenState>().Property(d => d.OpenedAt));
        DefaultNow(mb.Entity<ChannelMute>().Property(m => m.CreatedAt));
        DefaultNow(mb.Entity<VoiceListen>().Property(v => v.ListenedAt));
        DefaultNow(mb.Entity<LoginAttempt>().Property(l => l.Timestamp));
        DefaultNow(mb.Entity<Emoji>().Property(e => e.CreatedAt));
        DefaultNow(mb.Entity<Sound>().Property(s => s.CreatedAt));
        DefaultNow(mb.Entity<Friendship>().Property(f => f.CreatedAt));
        DefaultNow(mb.Entity<BugReport>().Property(b => b.CreatedAt));
        DefaultNow(mb.Entity<UserBlock>().Property(b => b.CreatedAt));
        DefaultNow(mb.Entity<MessageReport>().Property(r => r.CreatedAt));
        DefaultNow(mb.Entity<GuestLink>().Property(g => g.CreatedAt));
        DefaultNow(mb.Entity<DeviceToken>().Property(d => d.CreatedAt));
        DefaultNow(mb.Entity<DeviceToken>().Property(d => d.LastSeen));
        DefaultNow(mb.Entity<BugReport>().Property(b => b.UpdatedAt));

        // Per-module FK / index / default configuration lives in the module .Db projects.
        mb.ApplyConfigurationsFromAssembly(typeof(Outcome.Identity.Db.Configurations.UserConfiguration).Assembly);
        mb.ApplyConfigurationsFromAssembly(typeof(Outcome.Chat.Db.Configurations.ServerConfiguration).Assembly);

        // Identity claim tables are hit on every permission resolve — index their FK columns.
        mb.Entity<IdentityRoleClaim<long>>().HasIndex(c => c.RoleId);
        mb.Entity<IdentityUserClaim<long>>().HasIndex(c => c.UserId);

        // Map every column name to snake_case (RoleId -> role_id, etc.).
        foreach (var entity in mb.Model.GetEntityTypes())
            foreach (var prop in entity.GetProperties())
                prop.SetColumnName(ToSnake(prop.Name));

        // Keep the original column names for the two pre-Identity columns.
        mb.Entity<User>().Property(u => u.UserName).HasColumnName("username");
        mb.Entity<User>().Property(u => u.PasswordHash).HasColumnName("password");
    }

    private static void DefaultNow<T>(Microsoft.EntityFrameworkCore.Metadata.Builders.PropertyBuilder<T> p) =>
        p.HasDefaultValueSql("now()").ValueGeneratedOnAdd();

    private static string ToSnake(string name)
    {
        var sb = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var ch = name[i];
            if (char.IsUpper(ch))
            {
                if (i > 0) sb.Append('_');
                sb.Append(char.ToLowerInvariant(ch));
            }
            else
            {
                sb.Append(ch);
            }
        }
        return sb.ToString();
    }
}
