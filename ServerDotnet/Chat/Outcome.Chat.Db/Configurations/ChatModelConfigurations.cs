using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Outcome.Domain.Entities;

namespace Outcome.Chat.Db.Configurations;

// Foreign keys + indexes + column defaults for the Chat/server/social tables. Table names,
// composite keys, snake_case columns and default timestamps are set centrally in
// OutcomeDbContext.OnModelCreating. Delete behaviors mirror the app's cleanup logic
// (UserRepository.DeleteAsync, server/channel purge cascades).

public sealed class ServerConfiguration : IEntityTypeConfiguration<Server>
{
    public void Configure(EntityTypeBuilder<Server> b)
    {
        b.HasOne<User>().WithMany().HasForeignKey(s => s.OwnerId).OnDelete(DeleteBehavior.NoAction);
        b.Property(s => s.IsPublic).HasDefaultValue(false);
        b.Property(s => s.Description).HasDefaultValue("");
        b.HasIndex(s => s.IsPublic).HasFilter("is_public AND NOT deleted");
        // One space per custom domain (partial unique — nulls don't collide).
        b.HasIndex(s => s.CustomDomain).IsUnique().HasFilter("custom_domain IS NOT NULL AND NOT deleted");
    }
}

public sealed class ServerMemberConfiguration : IEntityTypeConfiguration<ServerMember>
{
    public void Configure(EntityTypeBuilder<ServerMember> b)
    {
        b.HasOne<Server>().WithMany().HasForeignKey(m => m.ServerId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<Role>().WithMany().HasForeignKey(m => m.RoleId).OnDelete(DeleteBehavior.NoAction);
        b.HasIndex(m => m.UserId);
    }
}

public sealed class ChannelConfiguration : IEntityTypeConfiguration<Channel>
{
    public void Configure(EntityTypeBuilder<Channel> b)
    {
        b.HasOne<Server>().WithMany().HasForeignKey(c => c.ServerId).OnDelete(DeleteBehavior.Cascade);
        b.HasIndex(c => c.ServerId);
    }
}

public sealed class ChannelOverrideClaimConfiguration : IEntityTypeConfiguration<ChannelOverrideClaim>
{
    public void Configure(EntityTypeBuilder<ChannelOverrideClaim> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(o => o.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<Role>().WithMany().HasForeignKey(o => o.RoleId).OnDelete(DeleteBehavior.Cascade);
        b.HasIndex(o => o.RoleId);
        b.HasIndex(o => new { o.ChannelId, o.RoleId, o.Permission }).IsUnique();
    }
}

public sealed class MessageConfiguration : IEntityTypeConfiguration<Message>
{
    public void Configure(EntityTypeBuilder<Message> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(m => m.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.NoAction);
        b.HasOne<Message>().WithMany().HasForeignKey(m => m.ReplyTo).OnDelete(DeleteBehavior.SetNull);
        b.HasIndex(m => new { m.ChannelId, m.Id });
    }
}

public sealed class AttachmentConfiguration : IEntityTypeConfiguration<Attachment>
{
    public void Configure(EntityTypeBuilder<Attachment> b)
    {
        b.HasOne<Message>().WithMany().HasForeignKey(a => a.MessageId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class ReactionConfiguration : IEntityTypeConfiguration<Reaction>
{
    public void Configure(EntityTypeBuilder<Reaction> b)
    {
        b.HasOne<Message>().WithMany().HasForeignKey(r => r.MessageId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(r => r.UserId).OnDelete(DeleteBehavior.Cascade);
        // One reaction per (message, user, emoji) — matches the app's add-if-absent guard.
        b.HasIndex(r => new { r.MessageId, r.UserId, r.Emoji }).IsUnique();
    }
}

public sealed class ReadStateConfiguration : IEntityTypeConfiguration<ReadState>
{
    public void Configure(EntityTypeBuilder<ReadState> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(r => r.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(r => r.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class VoiceStateConfiguration : IEntityTypeConfiguration<VoiceState>
{
    public void Configure(EntityTypeBuilder<VoiceState> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(v => v.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(v => v.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class DmParticipantConfiguration : IEntityTypeConfiguration<DmParticipant>
{
    public void Configure(EntityTypeBuilder<DmParticipant> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(d => d.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class DmOpenStateConfiguration : IEntityTypeConfiguration<DmOpenState>
{
    public void Configure(EntityTypeBuilder<DmOpenState> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(d => d.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class VoiceListenConfiguration : IEntityTypeConfiguration<VoiceListen>
{
    public void Configure(EntityTypeBuilder<VoiceListen> b)
    {
        b.HasOne<Attachment>().WithMany().HasForeignKey(v => v.AttachmentId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(v => v.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class ChannelMuteConfiguration : IEntityTypeConfiguration<ChannelMute>
{
    public void Configure(EntityTypeBuilder<ChannelMute> b)
    {
        b.HasOne<Channel>().WithMany().HasForeignKey(m => m.ChannelId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class EmojiConfiguration : IEntityTypeConfiguration<Emoji>
{
    public void Configure(EntityTypeBuilder<Emoji> b)
    {
        b.HasOne<User>().WithMany().HasForeignKey(e => e.UploadedBy).OnDelete(DeleteBehavior.NoAction);
        b.HasIndex(e => e.Shortcode).IsUnique();
    }
}

public sealed class SoundConfiguration : IEntityTypeConfiguration<Sound>
{
    public void Configure(EntityTypeBuilder<Sound> b) =>
        b.HasOne<User>().WithMany().HasForeignKey(s => s.UploadedBy).OnDelete(DeleteBehavior.NoAction);
}

public sealed class FriendshipConfiguration : IEntityTypeConfiguration<Friendship>
{
    public void Configure(EntityTypeBuilder<Friendship> b)
    {
        b.HasOne<User>().WithMany().HasForeignKey(f => f.UserLow).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(f => f.UserHigh).OnDelete(DeleteBehavior.Cascade);
        b.HasIndex(f => new { f.UserLow, f.UserHigh }).IsUnique();
        b.HasIndex(f => f.UserHigh);
    }
}

public sealed class BugReportConfiguration : IEntityTypeConfiguration<BugReport>
{
    public void Configure(EntityTypeBuilder<BugReport> b)
    {
        // Reporter's reports are removed with the account (hard delete cascades cleanly).
        b.HasOne<User>().WithMany().HasForeignKey(r => r.ReporterId).OnDelete(DeleteBehavior.Cascade);
        b.Property(r => r.Status).HasDefaultValue(BugReport.StatusNew);
        b.HasIndex(r => r.ReporterId);
        b.HasIndex(r => r.Status);
    }
}
