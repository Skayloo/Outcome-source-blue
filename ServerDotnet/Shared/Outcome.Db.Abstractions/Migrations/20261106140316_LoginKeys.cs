using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class LoginKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "auth_hash",
                table: "users",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "auth_iterations",
                table: "users",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "auth_salt",
                table: "users",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "auth_hash",
                table: "users");

            migrationBuilder.DropColumn(
                name: "auth_iterations",
                table: "users");

            migrationBuilder.DropColumn(
                name: "auth_salt",
                table: "users");
        }
    }
}
