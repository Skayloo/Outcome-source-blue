using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <summary>
    /// Cut the expiring signature off every avatar already stored — the same defect as
    /// StripServerIconSignature, in the other column that holds a file path.
    ///
    /// An avatar is served without a signature because the file endpoint recognises it: it
    /// compares the stored value against the request path. The request path never carries a
    /// query, so a stored "?e=...&amp;s=..." never matched, the exemption missed, and the picture
    /// 404'd both with the signature (expired) and without it (unrecognised). Measured on the
    /// live server: two of four avatars.
    ///
    /// Only our own paths are touched — an avatar may be a data: URI, where '?' is legal.
    /// Data only, no schema change, and safe to run twice.
    /// </summary>
    public partial class StripAvatarSignature : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder) =>
            migrationBuilder.Sql(
                "UPDATE users SET avatar = split_part(avatar, '?', 1) " +
                "WHERE avatar LIKE '/api/v1/files/%?%';");

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Nothing to undo: the signature removed had already expired, and it cannot be
            // rebuilt without the key. Putting one back would restore the bug.
        }
    }
}
