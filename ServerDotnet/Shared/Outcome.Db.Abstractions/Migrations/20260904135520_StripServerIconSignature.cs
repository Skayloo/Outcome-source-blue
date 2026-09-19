using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <summary>
    /// Cut the expiring signature off every server icon already stored.
    ///
    /// The icon column was filled with what the upload handed the client — a SIGNED url carrying
    /// an expiry and a MAC. Nothing re-signs it on the way out, so a week after it was set the
    /// picture 404'd on every client at once, and re-uploading only bought another week. The
    /// signature is dropped here and refused at the door from now on (SetIconAsync); an unsigned
    /// icon path is served because IsIconAsync vouches for it, exactly as IsAvatarAsync does for
    /// avatars.
    ///
    /// Data only, no schema change — and idempotent: a path with no '?' is left alone.
    /// </summary>
    public partial class StripServerIconSignature : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder) =>
            migrationBuilder.Sql(
                "UPDATE servers SET icon = split_part(icon, '?', 1) WHERE icon LIKE '%?%';");

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Nothing to undo: the signature that was removed had already expired, and one cannot
            // be put back without the key. Re-signing here would also be wrong — the whole point
            // is that this column must not carry one.
        }
    }
}
