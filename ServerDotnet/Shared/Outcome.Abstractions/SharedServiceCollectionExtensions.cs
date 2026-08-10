using System.Reflection;
using FluentValidation;
using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Outcome.Shared.Abstractions.Behaviors;

namespace Outcome.Shared.Abstractions;

public static class SharedServiceCollectionExtensions
{
    /// <summary>
    /// Registers MediatR handlers + FluentValidation validators from the given feature-module
    /// assemblies, plus the shared pipeline behaviors (registered once, applied across all modules).
    /// </summary>
    public static IServiceCollection AddApplicationCore(this IServiceCollection services, params Assembly[] moduleAssemblies)
    {
        services.AddMediatR(cfg => cfg.RegisterServicesFromAssemblies(moduleAssemblies));
        services.AddValidatorsFromAssemblies(moduleAssemblies, includeInternalTypes: true);

        // Outermost → innermost. Validation runs before a transaction is opened.
        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(UnhandledExceptionBehavior<,>));
        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(LoggingBehavior<,>));
        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));
        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(TransactionBehavior<,>));

        return services;
    }
}
