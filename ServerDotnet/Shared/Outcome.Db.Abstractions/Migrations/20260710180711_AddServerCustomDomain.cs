using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddServerCustomDomain : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "custom_domain",
                table: "servers",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_servers_custom_domain",
                table: "servers",
                column: "custom_domain",
                unique: true,
                filter: "custom_domain IS NOT NULL AND NOT deleted");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_servers_custom_domain",
                table: "servers");

            migrationBuilder.DropColumn(
                name: "custom_domain",
                table: "servers");
        }
    }
}
