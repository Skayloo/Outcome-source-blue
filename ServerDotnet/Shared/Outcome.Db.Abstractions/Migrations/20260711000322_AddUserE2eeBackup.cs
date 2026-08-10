using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddUserE2eeBackup : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "e2ee_backup",
                table: "users",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "e2ee_backup",
                table: "users");
        }
    }
}
