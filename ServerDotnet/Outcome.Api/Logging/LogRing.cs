using System.Collections.Concurrent;

namespace Outcome.Api.Logging;

/// <summary>A single captured log record, streamed to the admin "Server Logs" view.</summary>
public sealed record LogEntry(DateTime Timestamp, string Level, string Category, string Message);

/// <summary>Bounded in-memory ring of recent log entries + a live pub/sub feed. Singleton, thread-safe.
/// Backs the admin live-log SSE stream: new connections get a backfill snapshot, then live entries.</summary>
public sealed class LogRingBuffer
{
    private const int Capacity = 500;
    private readonly Queue<LogEntry> _buffer = new(Capacity);
    private readonly object _gate = new();
    private readonly List<Action<LogEntry>> _subscribers = new();

    public void Add(LogEntry entry)
    {
        Action<LogEntry>[] subs;
        lock (_gate)
        {
            if (_buffer.Count >= Capacity) _buffer.Dequeue();
            _buffer.Enqueue(entry);
            subs = _subscribers.ToArray();
        }
        // Notify outside the lock so a slow/erroring subscriber can't stall logging.
        foreach (var s in subs)
        {
            try { s(entry); } catch { /* never let a subscriber break logging */ }
        }
    }

    public IReadOnlyList<LogEntry> Snapshot()
    {
        lock (_gate) return _buffer.ToArray();
    }

    public void Subscribe(Action<LogEntry> handler)
    {
        lock (_gate) _subscribers.Add(handler);
    }

    public void Unsubscribe(Action<LogEntry> handler)
    {
        lock (_gate) _subscribers.Remove(handler);
    }
}

/// <summary>ILoggerProvider that mirrors framework log records (Information+) into the ring buffer.</summary>
public sealed class RingBufferLoggerProvider(LogRingBuffer ring) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new RingBufferLogger(categoryName, ring);
    public void Dispose() { }

    private sealed class RingBufferLogger(string category, LogRingBuffer ring) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            // Drop high-volume framework noise (EF Core SQL command spam, connection churn) so the
            // admin log view shows app-relevant events. Warnings/errors from these still pass through.
            if (logLevel < LogLevel.Warning &&
                (category.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal) ||
                 category.StartsWith("Microsoft.AspNetCore.DataProtection", StringComparison.Ordinal)))
                return;
            var message = formatter(state, exception);
            if (exception is not null) message += " | " + exception.GetType().Name + ": " + exception.Message;
            // Shorten the category to its last segment (e.g. "JwtCurrentUserMiddleware").
            var shortCat = category.Contains('.') ? category[(category.LastIndexOf('.') + 1)..] : category;
            ring.Add(new LogEntry(DateTime.UtcNow, logLevel.ToString().ToUpperInvariant(), shortCat, message));
        }
    }
}

/// <summary>Single-use, short-lived tickets that authorize an SSE log-stream connection
/// (EventSource can't send the Authorization header, so the JWT is exchanged for a ticket).
/// When Redis is configured (multi-replica deployments) tickets are stored there, since the
/// POST that issues the ticket and the GET that consumes it can hit different replicas.</summary>
public sealed class LogTicketStore(StackExchange.Redis.IConnectionMultiplexer? redis = null)
{
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<string, DateTime> _tickets = new();

    public string Issue()
    {
        var ticket = Guid.NewGuid().ToString("N");
        if (redis is not null)
        {
            redis.GetDatabase().StringSet("outcome:logticket:" + ticket, 1, Ttl);
        }
        else
        {
            _tickets[ticket] = DateTime.UtcNow.Add(Ttl);
        }
        return ticket;
    }

    /// <summary>Consumes a ticket (single use). Returns true if it was valid and unexpired.</summary>
    public bool Consume(string ticket)
    {
        if (string.IsNullOrEmpty(ticket)) return false;
        if (redis is not null)
            return !redis.GetDatabase().StringGetDelete("outcome:logticket:" + ticket).IsNullOrEmpty;
        if (!_tickets.TryRemove(ticket, out var expiry)) return false;
        return expiry > DateTime.UtcNow;
    }
}
