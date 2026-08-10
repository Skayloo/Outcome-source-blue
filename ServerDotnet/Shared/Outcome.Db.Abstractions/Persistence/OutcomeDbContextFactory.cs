using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Outcome.Infrastructure.Persistence;

/// <summary>
/// Design-time factory so <c>dotnet ef migrations add</c> can build the model without
/// spinning up the full API host. The connection string is a dummy — migrations are
/// generated from the model, not by connecting. Migrations live in THIS assembly.
/// </summary>
public sealed class OutcomeDbContextFactory : IDesignTimeDbContextFactory<OutcomeDbContext>
{
    public OutcomeDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<OutcomeDbContext>()
            .UseNpgsql("Host=localhost;Database=outcome;Username=outcome;Password=outcome",
                o => o.MigrationsAssembly(typeof(OutcomeDbContextFactory).Assembly.GetName().Name))
            .Options;
        return new OutcomeDbContext(options);
    }
}
