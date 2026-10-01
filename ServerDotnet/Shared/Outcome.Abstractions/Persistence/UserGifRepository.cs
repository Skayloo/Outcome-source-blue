using Outcome.Domain.Entities;

namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>A user's GIF reaction library (see <see cref="UserGif"/>).</summary>
public interface IUserGifRepository
{
    /// <summary>The user's library, newest first.</summary>
    Task<IReadOnlyList<UserGif>> ListAsync(long userId, CancellationToken ct = default);

    Task<int> CountAsync(long userId, CancellationToken ct = default);

    Task<UserGif> AddAsync(UserGif gif, CancellationToken ct = default);

    /// <summary>Remove one of THIS user's GIFs; returns it (for the file delete), or null when it
    /// is not theirs or does not exist.</summary>
    Task<UserGif?> RemoveAsync(long userId, long id, CancellationToken ct = default);

    /// <summary>Whether a bare file path is somebody's library GIF — what lets the file endpoint
    /// serve it unsigned to anyone in a call, guests included, like an avatar.</summary>
    Task<bool> IsGifPathAsync(string path, CancellationToken ct = default);
}
