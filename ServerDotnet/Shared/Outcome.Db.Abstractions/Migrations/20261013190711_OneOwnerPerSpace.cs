using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class OneOwnerPerSpace : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // A space has ONE owner: the account that set it up (the owner's decision, 2026-10-13).
            // Until now the Owner could make other Owners, and a root Admin could seed one; any such
            // extra owner becomes an Admin. The one kept is the first live owner — the setup wizard's
            // (or the seeded) account is created before anybody else in its space's database.
            migrationBuilder.Sql(@"
UPDATE users SET role_id = 2
WHERE role_id = 1
  AND id <> (SELECT min(id) FROM users WHERE role_id = 1 AND NOT deleted);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {

        }
    }
}
