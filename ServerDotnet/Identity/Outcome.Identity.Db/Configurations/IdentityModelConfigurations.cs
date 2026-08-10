using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Outcome.Domain.Entities;

namespace Outcome.Identity.Db.Configurations;

// Foreign keys + indexes for the Identity module's tables. Table names, keys, snake_case
// columns and DB-default timestamps are set centrally in OutcomeDbContext.OnModelCreating;
// these classes add the relationships (with delete behavior) and indexes EF Core needs to
// generate the schema. Applied via ApplyConfigurationsFromAssembly.

public sealed class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> b)
    {
        // Custom role_id column → roles (a role can't be deleted while users hold it).
        b.HasOne<Role>().WithMany().HasForeignKey(u => u.RoleId).OnDelete(DeleteBehavior.NoAction);
    }
}

public sealed class SessionConfiguration : IEntityTypeConfiguration<Session>
{
    public void Configure(EntityTypeBuilder<Session> b)
    {
        b.HasOne<User>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        b.HasIndex(s => s.Token).IsUnique();
        b.HasIndex(s => s.UserId);
    }
}

public sealed class DeviceTokenConfiguration : IEntityTypeConfiguration<DeviceToken>
{
    public void Configure(EntityTypeBuilder<DeviceToken> b)
    {
        b.HasOne<User>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
        // Unique on the token, not on (user, token): a phone handed to someone else must move
        // to the new account rather than push both people's messages to it.
        b.HasIndex(d => d.Token).IsUnique();
        b.HasIndex(d => d.UserId);
        // Rows that predate the column are message tokens; without this default they would
        // land on the empty string and quietly stop matching any query.
        b.Property(d => d.Kind).HasDefaultValue("alert");
    }
}

public sealed class InviteConfiguration : IEntityTypeConfiguration<Invite>
{
    public void Configure(EntityTypeBuilder<Invite> b)
    {
        b.HasOne<Server>().WithMany().HasForeignKey(i => i.ServerId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<User>().WithMany().HasForeignKey(i => i.CreatedBy).OnDelete(DeleteBehavior.NoAction);
        b.HasOne<User>().WithMany().HasForeignKey(i => i.RedeemedBy).OnDelete(DeleteBehavior.NoAction);
        b.HasIndex(i => i.Code).IsUnique();
        b.HasIndex(i => i.ServerId);
    }
}
