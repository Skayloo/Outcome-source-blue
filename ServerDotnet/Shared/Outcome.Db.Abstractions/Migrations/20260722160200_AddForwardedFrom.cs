using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class AddForwardedFrom : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "forwarded_from",
                table: "messages",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "forwarded_from",
                table: "messages");
        }
    }
}
