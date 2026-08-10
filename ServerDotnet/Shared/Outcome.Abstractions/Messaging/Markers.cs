using MediatR;

namespace Outcome.Shared.Abstractions.Messaging;

/// <summary>Marker for requests that must run inside a database transaction (Unit of Work).</summary>
public interface ITransactionalRequest { }

/// <summary>A write use-case. Runs inside a transaction managed by <c>TransactionBehavior</c>.</summary>
public interface ICommand : IRequest, ITransactionalRequest { }

/// <summary>A write use-case returning <typeparamref name="TResponse"/>.</summary>
public interface ICommand<out TResponse> : IRequest<TResponse>, ITransactionalRequest { }

/// <summary>A read use-case. Runs outside the write transaction.</summary>
public interface IQuery<out TResponse> : IRequest<TResponse> { }
