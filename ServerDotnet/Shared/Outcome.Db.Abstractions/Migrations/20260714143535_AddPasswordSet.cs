using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddPasswordSet : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // TRUE, not false: every account that existed before SSO was created with a password
            // its owner chose. Defaulting to false would have told all of them they are
            // password-less and pushed a backup passphrase at people who don't need one.
            migrationBuilder.AddColumn<bool>(
                name: "password_set",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "password_set",
                table: "users");
        }
    }
}
